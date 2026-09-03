import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://data-api.binance.vision";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.json();
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function fmtPrice(value) {
  if (value >= 1000) return value.toLocaleString("en-US", {
    maximumFractionDigits: 0
  });

  if (value >= 1) return value.toLocaleString("en-US", {
    maximumFractionDigits: 4
  });

  if (value >= 0.01) return value.toLocaleString("en-US", {
    maximumFractionDigits: 5
  });

  return value.toLocaleString("en-US", {
    maximumFractionDigits: 8
  });
}

function fmtVolume(value) {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function cleanSymbol(symbol) {
  return symbol.replace(/USDT$/, "");
}

function chooseHashTags(symbol, hour) {
  const sets = [
    ["#Binance", "#CryptoAnalysis", "#MarketUpdate", `#${symbol}`],
    ["#Crypto", "#Binance", "#TechnicalAnalysis", `#${symbol}`],
    ["#Altcoins", "#CryptoMarket", "#Binance", `#${symbol}`],
    ["#Trading", "#CryptoAnalysis", "#Binance", `#${symbol}`],
    ["#MarketWatch", "#Crypto", "#Binance", `#${symbol}`],
    ["#CryptoTrends", "#TechnicalAnalysis", "#Binance", `#${symbol}`]
  ];

  return sets[hour % sets.length].join(" ");
}

function chooseHook(hour, symbol) {
  const hooks = [
    `$${symbol} is moving — but the key question is whether this momentum can hold.`,
    `Watching $${symbol} closely right now 👀`,
    `$${symbol} just caught attention on the Binance market.`,
    `A fresh momentum setup is developing around $${symbol}.`,
    `$${symbol} is one of the more interesting movers right now.`,
    `The $${symbol} chart deserves a closer look today.`,
    `Momentum is picking up around $${symbol}.`,
    `Is $${symbol} starting a bigger move?`
  ];

  return hooks[hour % hooks.length];
}

function chooseQuestion(hour, symbol) {
  const questions = [
    `Do you think $${symbol} can continue this move?`,
    `Would you watch the breakout or wait for a pullback?`,
    `What level would make you more confident about $${symbol}?`,
    `Is this momentum sustainable, or does it look overheated?`,
    `What are you watching next on $${symbol}?`,
    `Would you consider this strength convincing yet?`,
    `Could $${symbol} surprise the market from here?`,
    `Bullish continuation or possible cooldown?`
  ];

  return questions[hour % questions.length];
}

async function getMarketData() {
  const exchangeInfo = await getJson(
    `${BASE}/api/v3/exchangeInfo`
  );

  const spotSymbols = new Set(
    exchangeInfo.symbols
      .filter((s) =>
        s.status === "TRADING" &&
        s.quoteAsset === "USDT" &&
        s.isSpotTradingAllowed === true
      )
      .map((s) => s.symbol)
  );

  const tickers = await getJson(
    `${BASE}/api/v3/ticker/24hr`
  );

  const candidates = tickers
    .filter((t) =>
      spotSymbols.has(t.symbol) &&
      Number(t.lastPrice) > 0 &&
      Number(t.quoteVolume) >= 5_000_000 &&
      Number(t.priceChangePercent) > 1
    )
    .map((t) => ({
      symbol: t.symbol,
      price: Number(t.lastPrice),
      change: Number(t.priceChangePercent),
      volume: Number(t.quoteVolume),
      high24: Number(t.highPrice),
      low24: Number(t.lowPrice)
    }))
    .sort((a, b) => {
      const scoreA = a.change * Math.log10(Math.max(a.volume, 1));
      const scoreB = b.change * Math.log10(Math.max(b.volume, 1));
      return scoreB - scoreA;
    })
    .slice(0, 10);

  if (!candidates.length) {
    throw new Error("No suitable Binance Spot candidates found.");
  }

  const analyzed = [];

  for (const coin of candidates) {
    try {
      const klines = await getJson(
        `${BASE}/api/v3/klines?symbol=${coin.symbol}&interval=1h&limit=24`
      );

      const closes = klines.map((k) => Number(k[4]));
      const highs = klines.map((k) => Number(k[2]));
      const lows = klines.map((k) => Number(k[3]));

      const sma8 = average(closes.slice(-8));
      const sma20 = average(closes.slice(-20));

      const recentHigh = Math.max(...highs);
      const recentLow = Math.min(...lows);

      let trendBonus = 0;

      if (sma8 > sma20) trendBonus += 4;
      else trendBonus -= 2;

      const distanceFromHigh =
        ((coin.price - recentHigh) / recentHigh) * 100;

      const distanceFromLow =
        ((coin.price - recentLow) / recentLow) * 100;

      let score =
        coin.change +
        Math.log10(Math.max(coin.volume, 1)) +
        trendBonus;

      if (coin.change > 35) score -= 4;
      if (coin.change > 60) score -= 7;

      analyzed.push({
        ...coin,
        sma8,
        sma20,
        recentHigh,
        recentLow,
        distanceFromHigh,
        distanceFromLow,
        score
      });
    } catch {
      // Ignore a single bad candidate.
    }

    await sleep(100);
  }

  if (!analyzed.length) {
    throw new Error("Technical analysis failed for all candidates.");
  }

  analyzed.sort((a, b) => b.score - a.score);

  return analyzed[0];
}

function buildPost(coin) {
  const now = new Date();
  const hour = now.getUTCHours();

  const symbol = cleanSymbol(coin.symbol);
  const hook = chooseHook(hour, symbol);
  const question = chooseQuestion(hour, symbol);
  const hashtags = chooseHashTags(symbol, hour);

  const direction =
    coin.sma8 >= coin.sma20
      ? "short-term momentum is currently leaning bullish"
      : "short-term momentum is showing some weakness";

  const rangePosition =
    coin.price >= coin.sma20
      ? "Price is holding above the recent short-term average."
      : "Price is trading below the recent short-term average.";

  return `${hook}

$${symbol} snapshot:
• Price: $${fmtPrice(coin.price)}
• 24h change: ${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}%
• 24h volume: ${fmtVolume(coin.volume)}
• 24h high: $${fmtPrice(coin.high24)}
• 24h low: $${fmtPrice(coin.low24)}

Technical view:
• 1h SMA(8): $${fmtPrice(coin.sma8)}
• 1h SMA(20): $${fmtPrice(coin.sma20)}
• Recent 24h 1h high: $${fmtPrice(coin.recentHigh)}
• Recent 24h 1h low: $${fmtPrice(coin.recentLow)}

${direction}. ${rangePosition}

Bullish scenario:
A move through the recent high with sustained volume would strengthen the momentum case.

Risk scenario:
A loss of the recent range low could signal that the current momentum is fading.

${question}

${hashtags}

Not financial advice. Crypto markets are volatile and this is market analysis only.`;
}

function findPostScript() {
  const here = dirname(fileURLToPath(import.meta.url));

  const candidates = [
    join(here, "..", ".agents", "skills", "square-post", "scripts", "post-text.mjs"),
    join(here, "..", "agent", "skills", "square-post", "scripts", "post-text.mjs"),
    join(process.cwd(), ".agents", "skills", "square-post", "scripts", "post-text.mjs"),
    join(process.cwd(), "agent", "skills", "square-post", "scripts", "post-text.mjs")
  ];

  const found = candidates.find(existsSync);

  if (!found) {
    throw new Error("Binance Square post-text.mjs was not found.");
  }

  return found;
}

async function main() {
  if (!process.env.BINANCE_SQUARE_OPENAPI_KEY) {
    throw new Error("BINANCE_SQUARE_OPENAPI_KEY is missing.");
  }

  console.log("Scanning Binance Spot market...");

  const coin = await getMarketData();

  console.log(`Selected: ${coin.symbol}`);
  console.log(`24h change: ${coin.change.toFixed(2)}%`);
  console.log(`Volume: ${fmtVolume(coin.volume)}`);

  const post = buildPost(coin);

  console.log("Publishing one Binance Square post...");

  const script = findPostScript();

  execFileSync(
    process.execPath,
    [script, "--text", post],
    {
      stdio: "inherit",
      cwd: dirname(script),
      env: process.env
    }
  );

  console.log("Post published successfully.");
}

main().catch((error) => {
  console.error("BOT ERROR:", error.message);
  process.exit(1);
});
