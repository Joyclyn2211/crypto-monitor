#!/usr/bin/env node
// snapshot.mjs — daily data + AI analysis snapshot for crypto-monitor
// Run locally:  ANTHROPIC_API_KEY=sk-... node scripts/snapshot.mjs
// Run in CI:    same (Node 18+, zero external deps — uses built-in fetch)

import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../snapshot.json");

// ─── Config ───────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL      = process.env.CLAUDE_MODEL || "claude-opus-4-5";
// ↑ Change CLAUDE_MODEL env var in GitHub Actions secrets/vars to switch models

// ─── Watchlist ────────────────────────────────────────────────────────────────
const GROUPS = [
  {
    label: "主力币种",
    tokens: [
      { symbol:"BTC",     name:"Bitcoin",           id:"bitcoin" },
      { symbol:"ETH",     name:"Ethereum",          id:"ethereum" },
      { symbol:"BNB",     name:"BNB",               id:"binancecoin" },
      { symbol:"SOL",     name:"Solana",            id:"solana" },
    ]
  },
  {
    label: "AI代理赛道",
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
    label: "DeFi蓝筹",
    tokens: [
      { symbol:"UNI",  name:"Uniswap",   id:"uniswap" },
      { symbol:"AAVE", name:"Aave",      id:"aave" },
      { symbol:"CRV",  name:"Curve DAO", id:"curve-dao-token" },
    ]
  }
];

const ALL_IDS = GROUPS.flatMap(g => g.tokens.map(t => t.id));

// ─── News keyword buckets ─────────────────────────────────────────────────────
const TAG_KEYS = {
  x402:  ["0x402","x402","http 402","402 payment","payment protocol","micropayment","pay-per-call","coinbase pay"],
  ai:    ["ai agent","artificial intelligence","bittensor","fetch.ai","fetch ai","near protocol","render network","virtual protocol","virtuals","autonomous agent","large language model","llm","machine learning","generative ai"],
  defi:  ["defi","decentralized finance","uniswap","aave","curve","compound","liquidity","yield farming","tvl","total value locked","dex","amm","lending protocol","staking","liquid staking","lido","eigenlayer","restaking"],
  macro: ["federal reserve","fed rate","interest rate","inflation","cpi","sec ","cftc","regulation","regulatory","congress","senate","bitcoin etf","etf approval","tariff","gdp","recession","treasury","boj","ecb","monetary policy","enforcement action","lawsuit","ban","legal tender","cbdc"],
};

function classifyArticle(item) {
  const text = ((item.title||"")+" "+(item.body||"")+" "+(item.tags||"")).toLowerCase();
  if (TAG_KEYS.x402.some(k=>text.includes(k)))  return "x402";
  if (TAG_KEYS.ai.some(k=>text.includes(k)))    return "ai";
  if (TAG_KEYS.defi.some(k=>text.includes(k)))  return "defi";
  if (TAG_KEYS.macro.some(k=>text.includes(k))) return "macro";
  return "general";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt   = (n, d=2) => n==null ? null : parseFloat(n.toFixed(d));
const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));
function rangePct(price, low, high) {
  if (high <= low) return 50;
  return clamp(((price-low)/(high-low))*100, 2, 98);
}
function sectorAvg(group, dataMap) {
  const vals = group.tokens
    .map(t => dataMap[t.id]?.price_change_percentage_24h ?? null)
    .filter(v => v !== null);
  return vals.length ? parseFloat((vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2)) : null;
}

function computeTone(dataMap) {
  const avg = sectorAvg(GROUPS[0], dataMap);
  if (avg == null) return { avg: 0, label:"未知" };
  const label = avg > 1 ? "风险偏好 (Risk-on)" : avg < -1 ? "风险规避 (Risk-off)" : "混合信号 (Mixed)";
  return { avg, label };
}

// ─── Fetch with retry ─────────────────────────────────────────────────────────
async function fetchWithRetry(url, opts={}, retries=3, delayMs=3000) {
  for (let i=0; i<retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status===429) {
        console.warn(`  Rate limited. Waiting ${delayMs*2}ms…`);
        await delay(delayMs*2); continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return await res.json();
    } catch(err) {
      if (i===retries-1) throw err;
      console.warn(`  Attempt ${i+1} failed: ${err.message}. Retrying in ${delayMs}ms…`);
      await delay(delayMs);
    }
  }
}
const delay = ms => new Promise(r=>setTimeout(r,ms));

// ─── Anthropic API (raw fetch — no SDK, no npm install needed) ────────────────
async function callClaude(prompt) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type":    "application/json",
        "x-api-key":       ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: 3500,
        system: `你是专业的加密货币市场分析师，为中文读者撰写每日市场简报。
分析要求：精准引用今日数据、结合新闻解读、有前瞻性。
返回格式：严格JSON，不使用Markdown代码块，不添加任何额外文字。`,
        messages: [{ role:"user", content: prompt }],
      }),
    },
    3, 5000
  );

  let text = (res.content?.[0]?.text || "").trim();
  // Strip markdown fences if model wraps output
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(text);
}

// ─── Build analysis prompt ────────────────────────────────────────────────────
function buildPrompt(dataMap, newsItems, tone, localTime) {
  // Price table
  const priceLines = ALL_IDS.map(id => {
    const d = dataMap[id];
    if (!d) return null;
    const pct  = d.price_change_percentage_24h;
    const sign = pct >= 0 ? "+" : "";
    const rp   = rangePct(d.current_price, d.low_24h, d.high_24h);
    const pos  = rp>=80?"接近日高":rp>=55?"偏强区间":rp>=40?"中性":rp>=20?"偏弱":"接近日低";
    return `  ${d.symbol.toUpperCase()}(${d.name}): $${d.current_price.toLocaleString("en-US")} | 24h: ${sign}${pct?.toFixed(2)}% | 区间位置: ${pos}(${Math.round(rp)}%)`;
  }).filter(Boolean).join("\n");

  // Sector averages
  const majAvg  = sectorAvg(GROUPS[0], dataMap);
  const aiAvg   = sectorAvg(GROUPS[1], dataMap);
  const defiAvg = sectorAvg(GROUPS[2], dataMap);

  // Sorted tokens for quick reference
  const allWithData = ALL_IDS.map(id=>dataMap[id]).filter(Boolean)
    .sort((a,b)=>(b.price_change_percentage_24h??0)-(a.price_change_percentage_24h??0));
  const topToken  = allWithData[0];
  const botToken  = allWithData[allWithData.length-1];

  // News by category
  const byTag = { macro:[], defi:[], ai:[], x402:[], general:[] };
  for (const n of newsItems) (byTag[n._tag]||byTag.general).push(n);
  const fmtNews = (arr, max=8) => arr.length
    ? arr.slice(0,max).map(n=>`  - "${n.title}" (${n.source})`).join("\n")
    : "  （今日暂无相关新闻）";

  return `今天是 ${localTime}，请基于以下实时数据生成每日加密市场分析。

════════ 今日市场数据 ════════

各标的价格（24小时涨跌幅 & 区间位置）：
${priceLines}

板块均值：
  主力币种 (BTC/ETH/BNB/SOL): ${majAvg != null ? (majAvg>=0?"+":"")+majAvg+"%" : "N/A"}
  AI代理板块 (TAO/FET/NEAR/RENDER/VIRTUAL): ${aiAvg != null ? (aiAvg>=0?"+":"")+aiAvg+"%" : "N/A"}
  DeFi蓝筹 (UNI/AAVE/CRV): ${defiAvg != null ? (defiAvg>=0?"+":"")+defiAvg+"%" : "N/A"}

整体情绪：${tone.label}（主力均值 ${tone.avg>=0?"+":""}${tone.avg}%）
全仓最涨：${topToken?.symbol?.toUpperCase()} (${topToken?.price_change_percentage_24h>=0?"+":""}${topToken?.price_change_percentage_24h?.toFixed(2)}%)
全仓最跌：${botToken?.symbol?.toUpperCase()} (${botToken?.price_change_percentage_24h?.toFixed(2)}%)

════════ 今日新闻（按主题分类）════════

【宏观/政治/监管】(${byTag.macro.length}条):
${fmtNews(byTag.macro)}

【DeFi协议动态】(${byTag.defi.length}条):
${fmtNews(byTag.defi)}

【AI代理赛道】(${byTag.ai.length}条):
${fmtNews(byTag.ai)}

【0x402/支付协议】(${byTag.x402.length}条):
${fmtNews(byTag.x402)}

【其他加密新闻】(最多5条):
${fmtNews(byTag.general, 5)}

════════ 分析任务 ════════

为以下5个板块生成专业简体中文市场分析，要求：
① 必须引用今日具体数字（价格、涨跌幅、板块均值），不得使用泛泛描述
② 宏观/DeFi/AI/0x402板块须结合今日新闻标题进行具体解读
③ 每板块narrative为2-3个HTML段落（每段2-3句），共约150-250字
④ summary不超过20字，要具体（如"AI板块-12%，叙事受挫"而非"市场下跌"）
⑤ 语气：专业分析师视角，有见地，有前瞻，非新闻播报
⑥ 今日数据若为负数，分析应如实反映空头压力，不回避

各板块分析重点：
- market_trends: 今日整体情绪 + 板块轮动特征 + 价格结构判断（谁处于日高/日低意味着什么）+ 后市应关注的信号
- macro_policy: 今日宏观/监管新闻深度解读 + 对加密市场短中期影响 + 投资者需要特别关注的宏观因素
- defi_analysis: DeFi板块 vs 大盘表现原因分析 + UNI/AAVE/CRV各自走势解读 + DeFi赛道当前机会与风险
- ai_agents: AI赛道整体 vs 大盘 + 5大标的分化分析（哪些跑赢/跑输及原因）+ 叙事驱动与风险评估
- x402: 基于今日新闻解读0x402协议生态进展（若无新闻则分析在当前市场环境下协议的战略意义）+ 值得关注的信号

返回格式（严格JSON，无任何代码块或额外文字）：
{
  "market_trends": {
    "summary": "不超过20字的具体概括",
    "narrative": "<p class=\\"analysis-para\\">段落一</p><p class=\\"analysis-para\\">段落二</p><p class=\\"analysis-para\\">段落三（可选）</p>"
  },
  "macro_policy":  { "summary": "...", "narrative": "..." },
  "defi_analysis": { "summary": "...", "narrative": "..." },
  "ai_agents":     { "summary": "...", "narrative": "..." },
  "x402":          { "summary": "...", "narrative": "..." }
}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // ── 1. Beijing timestamp ──────────────────────────────────────────────────
  const now = new Date();
  const localMs = now.getTime() + (8*60 - now.getTimezoneOffset()) * 60_000;
  const ld = new Date(localMs);
  const pad = n => String(n).padStart(2,"0");
  const local_time =
    `${ld.getUTCFullYear()}-${pad(ld.getUTCMonth()+1)}-${pad(ld.getUTCDate())} `+
    `${pad(ld.getUTCHours())}:${pad(ld.getUTCMinutes())} CST`;

  // ── 2. Prices ─────────────────────────────────────────────────────────────
  console.log("📡 正在获取 CoinGecko 价格数据…");
  const priceUrl =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd`+
    `&ids=${ALL_IDS.join(",")}&price_change_percentage=24h&sparkline=false`;

  const priceList = await fetchWithRetry(priceUrl);
  const dataMap = {};
  for (const c of priceList) dataMap[c.id] = c;
  const tone = computeTone(dataMap);

  // ── 3. News ───────────────────────────────────────────────────────────────
  console.log("📰 正在获取 CryptoCompare 新闻…");
  const newsUrl = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest";
  let newsItems = [];
  try {
    const newsData = await fetchWithRetry(newsUrl);
    if (newsData?.Data) {
      newsItems = newsData.Data.slice(0, 80).map(item => ({
        title:        item.title,
        url:          item.url,
        source:       item.source_info?.name || item.source || "",
        published_on: item.published_on,
        tags:         item.tags || "",
        _tag:         classifyArticle(item),
      }));
      const dist = newsItems.reduce((a,n)=>{a[n._tag]=(a[n._tag]||0)+1;return a},{});
      console.log(`  ✓ ${newsItems.length}条 | 分布:`, JSON.stringify(dist));
    }
  } catch(err) {
    console.warn("  ⚠ 新闻获取失败（非致命）:", err.message);
  }

  // ── 4. AI Analysis ────────────────────────────────────────────────────────
  let analysis = null;
  if (ANTHROPIC_API_KEY) {
    console.log(`\n🤖 正在调用 Claude (${CLAUDE_MODEL}) 生成每日分析…`);
    try {
      const prompt = buildPrompt(dataMap, newsItems, tone, local_time);
      analysis = await callClaude(prompt);

      // Validate structure
      const requiredKeys = ["market_trends","macro_policy","defi_analysis","ai_agents","x402"];
      for (const k of requiredKeys) {
        if (!analysis[k]?.summary || !analysis[k]?.narrative) {
          throw new Error(`Missing or invalid key: ${k}`);
        }
      }
      console.log("  ✓ 分析生成完成");
      for (const [k,v] of Object.entries(analysis)) {
        console.log(`  [${k}] ${v.summary}`);
      }
    } catch(err) {
      console.error("  ✗ AI分析生成失败（将跳过，使用模板分析）:", err.message);
      analysis = null;
    }
  } else {
    console.log("ℹ  ANTHROPIC_API_KEY 未设置，跳过AI分析（使用前端模板分析）。");
    console.log("   在 GitHub 仓库的 Settings → Secrets → ANTHROPIC_API_KEY 添加密钥可启用每日AI分析。");
  }

  // ── 5. Build token summary ────────────────────────────────────────────────
  const tokens = ALL_IDS.map(id => {
    const d = dataMap[id];
    if (!d) return { id, error:"not found" };
    return {
      id:                           d.id,
      symbol:                       d.symbol,
      name:                         d.name,
      current_price:                d.current_price,
      price_change_percentage_24h:  fmt(d.price_change_percentage_24h),
      low_24h:                      d.low_24h,
      high_24h:                     d.high_24h,
    };
  });

  // ── 6. Write snapshot.json ────────────────────────────────────────────────
  const snapshot = {
    timestamp:   now.toISOString(),
    local_time,
    tone:        tone.label,
    tone_avg:    tone.avg,
    // analysis: null if no API key, or { market_trends, macro_policy, defi_analysis, ai_agents, x402 }
    // each section: { summary: string, narrative: HTML string }
    analysis,
    tokens,
    news: newsItems.map(({title,url,source,published_on,tags,_tag})=>
      ({title,url,source,published_on,tags,_tag})),
  };

  writeFileSync(OUT, JSON.stringify(snapshot, null, 2));

  console.log(`\n✅ snapshot.json 写入完成`);
  console.log(`   时间:   ${local_time}`);
  console.log(`   情绪:   ${tone.label} (${tone.avg>=0?"+":""}${tone.avg}%)`);
  console.log(`   代币:   ${tokens.filter(t=>!t.error).length}/${tokens.length} 获取成功`);
  console.log(`   新闻:   ${newsItems.length}条`);
  console.log(`   AI分析: ${analysis ? "✓ 已生成" : "✗ 未生成（无API密钥）"}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
