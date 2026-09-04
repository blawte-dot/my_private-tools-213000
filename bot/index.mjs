import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BINANCE_API = "https://data-api.binance.vision";
const HISTORY_FILE = join(process.cwd(), "data", "history.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Binance-Square-Bot/1.0" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.json();
}

function loadHistory() {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    return JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveHistory(history) {
  mkdirSync(dirname(HISTORY_FILE), { recursive: true });
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatPrice(value) {
  const n = number(value);

  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  if (n >= 0.0001) return n.toFixed(7);
  return n.toPrecision(5);
}

function formatMoney(value) {
  const n = number(value);

  if (n >= 1_000_000_000) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1e3).toFixed(2)}K`;

  return `$${n.toFixed(0)}`;
}

function pct(value) {
  const n = number(value);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function sma(values, period) {
  if (values.length < period) return null;

  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function unique(array) {
  return [...new Set(array)];
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function hourUTC() {
  return new Date().getUTCHours();
}

function contentTypeForHour(hour) {
  /*
   * Rough target:
   * ~5 news/macro posts
   * remaining posts distributed across analysis, education,
   * projects, trends, market updates and bull/bear.
   */

  const newsHours = new Set([2, 6, 10, 14, 18]);

  if (newsHours.has(hour)) return "news";

  const types = [
    "analysis",
    "analysis",
    "trending",
    "project",
    "education",
    "market",
    "bullbear",
    "volume",
    "watch",
    "comparison",
  ];

  return types[hour % types.length];
}

function chooseHook(type, symbol) {
  const hooks = {
    analysis: [
      `📊 ${symbol} is showing a setup worth watching`,
      `⚡ ${symbol}: the chart is getting interesting`,
      `🔎 ${symbol} technical check`,
    ],
    trending: [
      `🔥 ${symbol} is getting attention`,
      `🚀 ${symbol} is moving onto the radar`,
      `👀 Why is everyone watching ${symbol}?`,
    ],
    project: [
      `🧠 What is ${symbol} actually building?`,
      `🔍 ${symbol}: project breakdown`,
      `📚 Beyond the price: ${symbol}`,
    ],
    education: [
      `🎓 A quick crypto lesson using ${symbol}`,
      `📖 What this ${symbol} move teaches us`,
      `🧠 Crypto education: reading ${symbol}`,
    ],
    market: [
      `🌐 Crypto market update`,
      `📈 What the market is telling us`,
      `🗓️ Today's crypto market watch`,
    ],
    bullbear: [
      `🐂🐻 ${symbol}: bull case vs bear case`,
      `⚔️ ${symbol}: who has the stronger setup?`,
      `📊 ${symbol}: bullish or bearish?`,
    ],
    volume: [
      `📦 ${symbol}: volume deserves attention`,
      `🔊 ${symbol} volume is telling a story`,
      `📈 Price is moving — but what about volume?`,
    ],
    watch: [
      `👀 ${symbol}: key levels to watch`,
      `🎯 ${symbol}: the levels that matter`,
      `⏳ ${symbol}: what could happen next?`,
    ],
    comparison: [
      `⚖️ A closer look at ${symbol}`,
      `📊 ${symbol}: strength, weakness and risk`,
      `🔬 Breaking down ${symbol}`,
    ],
    news: [
      `📰 Crypto market news worth watching`,
      `🚨 A new catalyst is affecting crypto`,
      `🌍 Macro markets are back in focus`,
    ],
  };

  const list = hooks[type] || hooks.analysis;
  return list[hourUTC() % list.length];
}

async function getMarket() {
  const exchangeInfo = await getJson(
    `${BINANCE_API}/api/v3/exchangeInfo`
  );

  const allowedSymbols = new Set(
    exchangeInfo.symbols
      .filter((s) =>
        s.status === "TRADING" &&
        s.quoteAsset === "USDT" &&
        (
          s.isSpotTradingAllowed === true ||
          s.permissions?.includes("SPOT")
        )
      )
      .map((s) => s.symbol)
  );

  const tickers = await getJson(
    `${BINANCE_API}/api/v3/ticker/24hr`
  );

  return tickers
    .filter((t) => allowedSymbols.has(t.symbol))
    .filter((t) => number(t.quoteVolume) >= 5_000_000)
    .map((t) => ({
      symbol: t.symbol.replace(/USDT$/, ""),
      pair: t.symbol,
      price: number(t.lastPrice),
      change: number(t.priceChangePercent),
      volume: number(t.quoteVolume),
      high: number(t.highPrice),
      low: number(t.lowPrice),
      trades: number(t.count),
    }));
}

async function getKlines(symbol) {
  const data = await getJson(
    `${BINANCE_API}/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=48`
  );

  return data.map((k) => ({
    openTime: k[0],
    open: number(k[1]),
    high: number(k[2]),
    low: number(k[3]),
    close: number(k[4]),
    volume: number(k[5]),
    quoteVolume: number(k[7]),
  }));
}

function scoreCoin(coin, candles, history) {
  const closes = candles.map((c) => c.close);

  const sma8 = sma(closes, 8);
  const sma20 = sma(closes, 20);

  const recent = candles.slice(-24);

  const recentHigh = Math.max(...recent.map((c) => c.high));
  const recentLow = Math.min(...recent.map((c) => c.low));

  const averageVolume =
    candles.length >= 20
      ? candles.slice(-20).reduce((a, b) => a + b.quoteVolume, 0) / 20
      : 0;

  const currentVolume = candles.at(-1)?.quoteVolume || 0;

  const volumeRatio =
    averageVolume > 0 ? currentVolume / averageVolume : 1;

  let score = 0;

  score += coin.change * 3;
  score += Math.log10(Math.max(coin.volume, 1)) * 2;

  if (sma8 && sma20) {
    if (sma8 > sma20) score += 8;
    else score -= 4;
  }

  if (volumeRatio > 1.5) score += 10;
  if (volumeRatio > 2.5) score += 8;

  if (coin.price >= recentHigh * 0.98) score += 8;

  if (coin.change > 35) score -= 12;
  if (coin.change > 60) score -= 20;
  if (coin.change < -10) score -= 8;

  const today = todayUTC();

  const usedToday = history.some(
    (item) =>
      item.date === today &&
      item.symbol === coin.symbol &&
      item.type !== "news"
  );

  if (usedToday) score -= 1000;

  return {
    ...coin,
    candles,
    sma8,
    sma20,
    recentHigh,
    recentLow,
    volumeRatio,
    score,
  };
}

async function chooseCoin(market, history) {
  const candidates = market
    .filter((c) => c.change > 1)
    .sort((a, b) => b.change - a.change)
    .slice(0, 20);

  const analyzed = [];

  for (const coin of candidates) {
    try {
      const candles = await getKlines(coin.symbol);
      analyzed.push(scoreCoin(coin, candles, history));
      await sleep(80);
    } catch {
      // Ignore one broken symbol and continue.
    }
  }

  if (!analyzed.length) {
    throw new Error("No analyzable Binance Spot coins found.");
  }

  analyzed.sort((a, b) => b.score - a.score);

  return analyzed[0];
}

function technicalText(coin) {
  const direction =
    coin.sma8 && coin.sma20
      ? coin.sma8 > coin.sma20
        ? "short-term momentum is above the 20-hour average"
        : "short-term momentum is below the 20-hour average"
      : "short-term trend data is still developing";

  return [
    `Price: $${formatPrice(coin.price)}`,
    `24h change: ${pct(coin.change)}`,
    `24h volume: ${formatMoney(coin.volume)}`,
    `24h range: $${formatPrice(coin.low)} – $${formatPrice(coin.high)}`,
    `Recent 24h range: $${formatPrice(coin.recentLow)} – $${formatPrice(coin.recentHigh)}`,
    `SMA 8h: ${coin.sma8 ? `$${formatPrice(coin.sma8)}` : "N/A"}`,
    `SMA 20h: ${coin.sma20 ? `$${formatPrice(coin.sma20)}` : "N/A"}`,
    `Volume ratio vs recent average: ${coin.volumeRatio.toFixed(2)}x`,
    `Trend read: ${direction}.`,
  ].join("\n");
}

function analysisPost(coin, type) {
  const hook = chooseHook(type, `$${coin.symbol}`);

  const bullish =
    coin.price >= coin.sma8
      ? `A sustained move above $${formatPrice(coin.high)} could keep momentum strong.`
      : `A recovery above the short-term averages would improve the setup.`;

  const bearish =
    coin.price > coin.recentLow * 1.05
      ? `Losing the recent support zone around $${formatPrice(coin.recentLow)} would weaken the structure.`
      : `Failure to reclaim nearby resistance could keep sellers active.`;

  return `${hook}

$${coin.symbol} is one of the Binance Spot names worth watching right now.

${technicalText(coin)}

📈 Bull case:
${bullish}

⚠️ Risk case:
${bearish}

🎯 Key level:
$${formatPrice(coin.recentHigh)} resistance
$${formatPrice(coin.recentLow)} support

The setup is interesting because price, momentum and volume are moving together — but volatility remains high.

What level would you watch next for $${coin.symbol}?

#${coin.symbol} #Binance #Crypto #TechnicalAnalysis

Not financial advice. Crypto markets are volatile.`;
}

function bullBearPost(coin) {
  return `🐂🐻 $${coin.symbol}: Bull vs Bear

Current price: $${formatPrice(coin.price)}
24h move: ${pct(coin.change)}
24h volume: ${formatMoney(coin.volume)}

🐂 Bull case:
• Price is holding a strong recent range.
• Momentum can strengthen if resistance breaks.
• Higher-than-normal volume can support continuation.

🐻 Bear case:
• A sharp rally can attract profit-taking.
• Losing recent support would weaken momentum.
• High volatility increases downside risk.

🎯 Levels:
Resistance: $${formatPrice(coin.recentHigh)}
Support: $${formatPrice(coin.recentLow)}

Which side has the stronger argument for $${coin.symbol} right now?

#${coin.symbol} #Crypto #Binance #BullVsBear

Not financial advice.`;
}

function volumePost(coin) {
  const unusual =
    coin.volumeRatio >= 2
      ? `🔥 The latest hourly volume is around ${coin.volumeRatio.toFixed(1)}x the recent average.`
      : `Volume is around ${coin.volumeRatio.toFixed(1)}x the recent average.`;

  return `🔊 $${coin.symbol}: Volume is telling a story

Price: $${formatPrice(coin.price)}
24h: ${pct(coin.change)}
24h volume: ${formatMoney(coin.volume)}

${unusual}

When price rises together with expanding volume, the move deserves more attention. But volume alone does not guarantee continuation.

📍 Recent high: $${formatPrice(coin.recentHigh)}
📍 Recent low: $${formatPrice(coin.recentLow)}

Would you treat this volume as confirmation or a warning of volatility?

#${coin.symbol} #Crypto #Volume #Binance

Not financial advice.`;
}

function educationPost(coin) {
  return `🎓 Quick crypto lesson using $${coin.symbol}

One of the simplest things to watch is the relationship between price and volume.

📈 Price up + volume expanding:
The move has stronger participation.

⚠️ Price up + volume falling:
Momentum may be less convincing.

📉 Price down + volume expanding:
Selling pressure deserves attention.

For $${coin.symbol} right now:
24h price change: ${pct(coin.change)}
24h volume: ${formatMoney(coin.volume)}
Hourly volume vs recent average: ${coin.volumeRatio.toFixed(2)}x

The lesson: never judge a breakout from price alone.

Do you normally check volume before deciding whether a move is convincing?

#${coin.symbol} #CryptoEducation #Binance #Trading

Educational content only, not financial advice.`;
}

function projectPost(coin) {
  const descriptions = {
    BTC: "Bitcoin is a decentralized monetary network designed to transfer and store value without a central issuer.",
    ETH: "Ethereum is a programmable blockchain used for smart contracts, decentralized applications and tokenized assets.",
    BNB: "BNB is the native asset of the BNB Chain ecosystem and is also used across Binance-related services.",
    SOL: "Solana is a high-throughput blockchain designed for applications requiring fast and relatively low-cost transactions.",
    XRP: "XRP is the native asset of the XRP Ledger, a blockchain focused on fast settlement and payments.",
    DOGE: "Dogecoin is a payment-focused cryptocurrency that grew from a meme into a widely recognized digital asset.",
    ADA: "Cardano is a proof-of-stake blockchain focused on smart contracts and decentralized applications.",
    LINK: "Chainlink provides decentralized oracle infrastructure that helps smart contracts access external data.",
    AVAX: "Avalanche is a smart-contract platform built around scalable blockchain networks and application-specific deployments.",
    DOT: "Polkadot is designed to connect different blockchain networks through a shared ecosystem.",
  };

  const description =
    descriptions[coin.symbol] ||
    `$${coin.symbol} is a crypto project currently trading on Binance Spot. Its market activity should be evaluated alongside the project's actual utility, adoption, token economics and risks.`;

  return `🧠 Beyond the price: $${coin.symbol}

What is it?

${description}

📊 Current market snapshot:
Price: $${formatPrice(coin.price)}
24h: ${pct(coin.change)}
24h volume: ${formatMoney(coin.volume)}

🔍 What matters when studying a project:
• Real-world utility
• Network adoption
• Developer activity
• Token supply and distribution
• Liquidity
• Competition
• Security and regulatory risks

A strong price chart does not automatically mean a strong project. Fundamentals and token economics matter too.

What is the most important fundamental you check before researching a crypto project?

#${coin.symbol} #Crypto #Binance #CryptoEducation

Not financial advice.`;
}

function marketPost(coin) {
  return `🌐 Crypto market update

One Binance Spot market signal worth watching today is $${coin.symbol}.

$${coin.symbol}: $${formatPrice(coin.price)}
24h: ${pct(coin.change)}
24h volume: ${formatMoney(coin.volume)}

📊 Market read:
The current move is being accompanied by ${coin.volumeRatio >= 1.5 ? "above-average recent volume" : "moderate volume"}.

🎯 Watch:
• Resistance: $${formatPrice(coin.recentHigh)}
• Support: $${formatPrice(coin.recentLow)}
• Short-term average: $${formatPrice(coin.sma8 || coin.price)}

Crypto remains highly reactive to liquidity, rates, ETF flows, risk sentiment and Bitcoin's direction.

What market factor do you think matters most right now?

#Crypto #Binance #${coin.symbol} #MarketUpdate

Not financial advice.`;
}

function trendingPost(coin) {
  return `🔥 Trending watch: $${coin.symbol}

$${coin.symbol} is standing out among active Binance Spot markets.

Price: $${formatPrice(coin.price)}
24h change: ${pct(coin.change)}
24h volume: ${formatMoney(coin.volume)}
24h high: $${formatPrice(coin.high)}
24h low: $${formatPrice(coin.low)}

Why it is interesting:
📈 Strong 24h movement
💧 Meaningful trading activity
📊 A measurable technical range

But rapid risers can reverse quickly. Momentum is not the same thing as confirmation.

Would you keep $${coin.symbol} on your watchlist or wait for a pullback?

#${coin.symbol} #Trending #Binance #Crypto

Not financial advice.`;
}

function watchPost(coin) {
  return `👀 $${coin.symbol}: Key levels to watch

Current: $${formatPrice(coin.price)}
24h: ${pct(coin.change)}

🎯 Resistance:
$${formatPrice(coin.recentHigh)}

🛡️ Support:
$${formatPrice(coin.recentLow)}

📊 Short-term averages:
SMA 8h: $${formatPrice(coin.sma8 || coin.price)}
SMA 20h: $${formatPrice(coin.sma20 || coin.price)}

A break above resistance with stronger volume would make the move more convincing.

A loss of support would increase the risk of a deeper pullback.

Which level matters more to you on $${coin.symbol}: the breakout or the support?

#${coin.symbol} #Binance #Crypto #TechnicalAnalysis

Not financial advice.`;
}

function comparisonPost(coin) {
  return `⚖️ $${coin.symbol}: Strength vs weakness

STRENGTHS
• ${pct(coin.change)} 24h move
• ${formatMoney(coin.volume)} 24h volume
• Recent range is clearly defined
• ${coin.volumeRatio.toFixed(2)}x recent hourly volume ratio

WEAKNESSES
• Fast moves can become overextended
• Resistance can trigger profit-taking
• Crypto volatility remains elevated

📍 Current price: $${formatPrice(coin.price)}
📍 High: $${formatPrice(coin.recentHigh)}
📍 Low: $${formatPrice(coin.recentLow)}

The interesting question is not simply "up or down?" — it is whether momentum can hold.

What would make you more confident in $${coin.symbol}?

#${coin.symbol} #Crypto #Binance #MarketAnalysis

Not financial advice.`;
}

async function findNews() {
  /*
   * We deliberately do not invent news.
   * The bot only publishes a "news" slot when it can obtain
   * a real, recent crypto-relevant headline from RSS.
   */

  const feeds = [
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://cointelegraph.com/rss",
  ];

  for (const feed of feeds) {
    try {
      const response = await fetch(feed, {
        headers: { "User-Agent": "Binance-Square-Bot/1.0" },
      });

      if (!response.ok) continue;

      const xml = await response.text();

      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
        .slice(0, 10)
        .map((match) => match[1]);

      for (const item of items) {
        const titleMatch = item.match(
          /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/i
        );

        const linkMatch = item.match(
          /<link>(.*?)<\/link>/i
        );

        const title = (titleMatch?.[1] || titleMatch?.[2] || "")
          .replace(/<[^>]+>/g, "")
          .trim();

        const link = (linkMatch?.[1] || "").trim();

        if (!title) continue;

        const lower = title.toLowerCase();

        const relevant =
          lower.includes("bitcoin") ||
          lower.includes("ethereum") ||
          lower.includes("crypto") ||
          lower.includes("binance") ||
          lower.includes("solana") ||
          lower.includes("xrp") ||
          lower.includes("etf") ||
          lower.includes("fed") ||
          lower.includes("rate") ||
          lower.includes("inflation") ||
          lower.includes("treasury") ||
          lower.includes("sec");

        const excluded =
          lower.includes("war") ||
          lower.includes("military") ||
          lower.includes("missile") ||
          lower.includes("weapon") ||
          lower.includes("iran") ||
          lower.includes("israel") ||
          lower.includes("ukraine");

        if (relevant && !excluded) {
          return { title, link };
        }
      }
    } catch {
      // Try next feed.
    }
  }

  return null;
}

function newsPost(news) {
  return `📰 Crypto news worth watching

${news.title}

Why it matters:
This headline could influence crypto through market sentiment, liquidity, regulation or expectations around digital assets.

The key is to watch the market reaction rather than assume the headline automatically means bullish or bearish.

🔗 Source:
${news.link}

How do you think the market will react to this development?

#Crypto #Bitcoin #Binance #CryptoNews

News discussion only. Not financial advice.`;
}

function buildPost(type, coin, news) {
  if (type === "news" && news) {
    return newsPost(news);
  }

  if (type === "bullbear") return bullBearPost(coin);
  if (type === "volume") return volumePost(coin);
  if (type === "education") return educationPost(coin);
  if (type === "project") return projectPost(coin);
  if (type === "market") return marketPost(coin);
  if (type === "trending") return trendingPost(coin);
  if (type === "watch") return watchPost(coin);
  if (type === "comparison") return comparisonPost(coin);

  return analysisPost(coin, type);
}

function findPostScript() {
  const possible = [
    join(process.cwd(), ".agents/skills/square-post/scripts/post-text.mjs"),
    join(process.cwd(), "agent/skills/square-post/scripts/post-text.mjs"),
    join(process.cwd(), "../.agents/skills/square-post/scripts/post-text.mjs"),
    join(process.cwd(), "../agent/skills/square-post/scripts/post-text.mjs"),
  ];

  return possible.find(existsSync);
}

function publish(text) {
  const script = findPostScript();

  if (!script) {
    throw new Error(
      "Binance Square post-text.mjs was not found. The workflow must install the Square Skill first."
    );
  }

  if (!process.env.BINANCE_SQUARE_OPENAPI_KEY) {
    throw new Error("BINANCE_SQUARE_OPENAPI_KEY is missing.");
  }

  execFileSync(
    process.execPath,
    [script, text],
    {
      stdio: "inherit",
      env: process.env,
    }
  );
}

function trimPost(text) {
  const MAX = 3800;

  if (text.length <= MAX) return text;

  return (
    text.slice(0, MAX - 120) +
    "\n\n📌 More details can be tracked through the market data.\n\n" +
    "#Crypto #Binance\n\nNot financial advice."
  );
}

async function main() {
  console.log("🚀 Binance Square Bot starting...");

  const history = loadHistory();

  const typeRequested = contentTypeForHour(hourUTC());

  console.log(`Content slot: ${typeRequested}`);

  const market = await getMarket();

  if (!market.length) {
    throw new Error("No Binance Spot USDT markets found.");
  }

  const coin = await chooseCoin(market, history);

  console.log(
    `Selected: ${coin.symbol} | ${pct(coin.change)} | ${formatMoney(coin.volume)}`
  );

  let news = null;

  if (typeRequested === "news") {
    news = await findNews();

    if (news) {
      console.log(`News: ${news.title}`);
    } else {
      console.log("No suitable news found. Falling back to market analysis.");
    }
  }

  const actualType =
    typeRequested === "news" && !news
      ? "market"
      : typeRequested;

  let post = buildPost(actualType, coin, news);

  post = trimPost(post);

  console.log("\n----- POST -----\n");
  console.log(post);
  console.log("\n----------------\n");

  publish(post);

  const record = {
    date: todayUTC(),
    timestamp: new Date().toISOString(),
    hourUTC: hourUTC(),
    type: actualType,
    symbol: coin.symbol,
    price: coin.price,
    change24h: coin.change,
    volume24h: coin.volume,
    newsTitle: news?.title || null,
  };

  history.push(record);

  const cleanHistory = history.slice(-500);

  saveHistory(cleanHistory);

  console.log("✅ Published successfully.");
}

main().catch((error) => {
  console.error("❌ Bot failed:");
  console.error(error.message);
  process.exit(1);
});
