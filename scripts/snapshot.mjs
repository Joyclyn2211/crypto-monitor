#!/usr/bin/env node
// snapshot.mjs — daily data snapshot for crypto-monitor
// Run locally:  node scripts/snapshot.mjs
// Run in CI:    same command (Node 18+ built-in fetch, zero external deps)

import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../snapshot.json");

// ─── Watchlist ────────────────────────────────────────────────────────────────
const GROUPS = [
  {
    label: "Major",
    tokens: [
      { symbol:"BTC",     name:"Bitcoin",           id:"bitcoin" },
      { symbol:"ETH",     name:"Ethereum",          id:"ethereum" },
      { symbol:"BNB",     name:"BNB",               id:"binancecoin" },
      { symbol:"SOL",     name:"Solana",            id:"solana" },
    ]
  },
  {
    label: "AI Agents",
    tokens: [
      { symbol:"TAO",     name:"Bittensor",         id:"bittensor" },
      { symbol:"FET",     name:"Fetch.ai",          id:"fetch-ai" },
      { symbol:"NEAR",    name:"NEAR Protocol",     id:"near" },
      { symbol:"RENDER",  name:"Render",            id:"render-token" },
      { symbol:"VIRTUAL", name:"Virtuals Protocol", id:"virtual-protocol" },
      // TODO: Add PING / x402 here once it has a reliable CoinGecko id
    ]
  },
  {
    label: "DeFi Blue Chips",
    tokens: [
      { symbol:"UNI",  name:"Uniswap",   id:"uniswap" },
      { symbol:"AAVE", name:"Aave",      id:"aave" },
      { symbol:"CRV",  name:"Curve DAO", id:"curve-dao-token" },
    ]
  }
];

const ALL_IDS = GROUPS.flatMap(g => g.tokens.map(t => t.id));

// ─── News keyword buckets ─────────────────────────────────────────────────────
const TAGS = {
  x402:  ["0x402","x402","http 402","402 payment","stablecoin payment","payment protocol","micropayment","pay-per-call","coinbase pay"],
  ai:    ["ai agent","artificial intelligence","bittensor","fetch.ai","fetch ai","near protocol","render network","virtual protocol","virtuals","autonomous agent","large language model","llm","machine learning"],
  defi:  ["defi","decentralized finance","uniswap","aave","curve","compound","liquidity","yield farming","tvl","total value locked","dex","amm","lending protocol","staking","liquid staking","lido","eigenlayer","restaking"],
  macro: ["federal reserve","fed rate","interest rate","inflation","cpi","sec","cftc","regulation","regulatory","congress","senate","bitcoin etf","etf approval","tariff","gdp","recession","treasury","boj","ecb","monetary policy","enforcement action","lawsuit","ban","legal tender","cbdc"],
};

function classifyArticle(item) {
  const text = ((item.title||"")+" "+(item.body||"")+" "+(item.tags||"")).toLowerCase();
  if (TAGS.x402.some(k=>text.includes(k)))  return "x402";
  if (TAGS.ai.some(k=>text.includes(k)))    return "ai";
  if (TAGS.defi.some(k=>text.includes(k)))  return "defi";
  if (TAGS.macro.some(k=>text.includes(k))) return "macro";
  return "general";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt   = (n, d=2) => n==null ? null : parseFloat(n.toFixed(d));
const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));

function rangePct(price, low, high) {
  if (high <= low) return 50;
  return clamp(((price-low)/(high-low))*100, 2, 98);
}

function computeTone(dataMap) {
  const vals = GROUPS[0].tokens
    .map(t => dataMap[t.id]?.price_change_percentage_24h ?? null)
    .filter(v => v !== null);
  if (!vals.length) return { avg:0, label:"Unknown" };
  const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
  return { avg: fmt(avg), label: avg>1?"Risk-on":avg<-1?"Risk-off":"Mixed" };
}

function computeRead(dataMap, tone) {
  const all = ALL_IDS.map(id=>dataMap[id]).filter(Boolean);
  if (!all.length) return "No data available.";
  const sorted = [...all].sort((a,b)=>
    (b.price_change_percentage_24h??0)-(a.price_change_percentage_24h??0));
  const best=sorted[0], worst=sorted[sorted.length-1];
  const bSym=best?.symbol?.toUpperCase()??"—", wSym=worst?.symbol?.toUpperCase()??"—";
  const bPct=fmt(best?.price_change_percentage_24h??0);
  const wPct=fmt(worst?.price_change_percentage_24h??0);
  const nearTop    = all.filter(t=>rangePct(t.current_price,t.low_24h,t.high_24h)>80);
  const nearBottom = all.filter(t=>rangePct(t.current_price,t.low_24h,t.high_24h)<20);
  const avg = tone.avg>=0?`+${tone.avg}`:`${tone.avg}`;
  let s1 = `The market is showing a ${tone.label.toLowerCase()} tone with the four majors averaging ${avg}% over 24 hours.`;
  let s2 = `${bSym} leads the watchlist (${bPct>=0?"+":""}${bPct}%), while ${wSym} is the biggest decliner (${wPct}%).`;
  let s3 = "";
  if (nearTop.length) {
    const syms = nearTop.map(t=>t.symbol.toUpperCase()).join(", ");
    s3 = `${syms} ${nearTop.length===1?"is":"are"} trading near the top of the 24h range — watch for resistance.`;
  } else if (nearBottom.length) {
    const syms = nearBottom.map(t=>t.symbol.toUpperCase()).join(", ");
    s3 = `${syms} ${nearBottom.length===1?"is":"are"} near the 24h low — potential support zone.`;
  }
  return [s1,s2,s3].filter(Boolean).join(" ");
}

// ─── Fetch with retry ─────────────────────────────────────────────────────────
async function fetchWithRetry(url, retries=3, delayMs=3000) {
  for (let i=0; i<retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        console.warn(`Rate limited. Waiting ${delayMs*2}ms before retry ${i+1}…`);
        await new Promise(r=>setTimeout(r, delayMs*2));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries-1) throw err;
      console.warn(`Attempt ${i+1} failed: ${err.message}. Retrying in ${delayMs}ms…`);
      await new Promise(r=>setTimeout(r, delayMs));
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // ── 1. Prices from CoinGecko ──────────────────────────────────────────────
  console.log("Fetching prices from CoinGecko…");
  const priceUrl =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd`+
    `&ids=${ALL_IDS.join(",")}&price_change_percentage=24h&sparkline=false`;

  let priceList;
  try {
    priceList = await fetchWithRetry(priceUrl);
  } catch (err) {
    console.error("Price fetch failed:", err.message);
    process.exit(1);
  }

  const dataMap = {};
  for (const coin of priceList) dataMap[coin.id] = coin;

  // ── 2. News from CryptoCompare ────────────────────────────────────────────
  console.log("Fetching news from CryptoCompare…");
  const newsUrl = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest";
  let newsItems = [];
  try {
    const newsData = await fetchWithRetry(newsUrl);
    if (newsData?.Data) {
      newsItems = newsData.Data.slice(0, 60).map(item => ({
        title:        item.title,
        url:          item.url,
        source:       item.source_info?.name || item.source || "",
        published_on: item.published_on,
        tags:         item.tags || "",
        _tag:         classifyArticle(item),
      }));
      console.log(`  Fetched ${newsItems.length} articles`);
      // Log distribution
      const dist = newsItems.reduce((a,n)=>{ a[n._tag]=(a[n._tag]||0)+1; return a; }, {});
      console.log("  Distribution:", JSON.stringify(dist));
    }
  } catch (err) {
    console.warn("News fetch failed (non-fatal):", err.message);
  }

  // ── 3. Timestamp (Beijing, UTC+8) ─────────────────────────────────────────
  const now = new Date();
  const beijingOffset = 8 * 60;
  const localMs = now.getTime() + (beijingOffset - now.getTimezoneOffset()) * 60_000;
  const localDate = new Date(localMs);
  const pad = n => String(n).padStart(2,"0");
  const local_time =
    `${localDate.getUTCFullYear()}-${pad(localDate.getUTCMonth()+1)}-${pad(localDate.getUTCDate())} `+
    `${pad(localDate.getUTCHours())}:${pad(localDate.getUTCMinutes())} CST`;

  // ── 4. Compute analytics ──────────────────────────────────────────────────
  const tone = computeTone(dataMap);
  const today_read = computeRead(dataMap, tone);

  const tokens = ALL_IDS.map(id => {
    const d = dataMap[id];
    if (!d) return { id, error:"not found" };
    return {
      id:                          d.id,
      symbol:                      d.symbol,
      name:                        d.name,
      current_price:               d.current_price,
      price_change_percentage_24h: fmt(d.price_change_percentage_24h),
      low_24h:                     d.low_24h,
      high_24h:                    d.high_24h,
    };
  });

  // ── 5. Write snapshot.json ────────────────────────────────────────────────
  const snapshot = {
    timestamp:  now.toISOString(),
    local_time,
    tone:       tone.label,
    tone_avg:   tone.avg,
    today_read,
    tokens,
    news:       newsItems,
    // ── Hook for future AI narrative ──────────────────────────────────────
    // Uncomment and create scripts/ai-narrative.mjs after adding ANTHROPIC_API_KEY secret:
    // ai_summary: null,
  };

  writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
  console.log(`\n✓ snapshot.json written`);
  console.log(`  Time:     ${local_time}`);
  console.log(`  Tone:     ${tone.label} (${tone.avg>=0?"+":""}${tone.avg}%)`);
  console.log(`  Tokens:   ${tokens.filter(t=>!t.error).length}/${tokens.length} fetched`);
  console.log(`  News:     ${newsItems.length} articles (DeFi: ${newsItems.filter(n=>n._tag==="defi").length}, AI: ${newsItems.filter(n=>n._tag==="ai").length}, 0x402: ${newsItems.filter(n=>n._tag==="x402").length}, Macro: ${newsItems.filter(n=>n._tag==="macro").length})`);
}

main();
