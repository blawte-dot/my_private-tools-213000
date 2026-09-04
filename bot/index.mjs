import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BINANCE = "https://data-api.binance.vision";
const ROOT = process.cwd();

const HISTORY = path.join(ROOT, "data", "history.json");

const MIN_VOLUME = 5_000_000;
const SLOT_MS = 25 * 60 * 1000;

async function api(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "binance-square-bot/1.0"
    }
  });

  if (!r.ok) {
    throw new Error(`Binance API error ${r.status}`);
  }

  return r.json();
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function fmtPrice(v) {
  const x = n(v);

  if (x >= 1000) return x.toLocaleString(undefined, {
    maximumFractionDigits: 2
  });

  if (x >= 1) return x.toFixed(4);

  if (x >= 0.01) return x.toFixed(5);

  return x.toPrecision(5);
}

function fmtMoney(v) {
  const x = n(v);

  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(1)}K`;

  return `$${x.toFixed(2)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function currentSlot() {
  return Math.floor(Date.now() / SLOT_MS);
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY, "utf8"));
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });

  fs.writeFileSync(
    HISTORY,
    JSON.stringify(history.slice(-1000), null, 2)
  );
}

function alreadyPosted(history, slot) {
  return history.some(x => x.slot === slot);
}

function usedCoinsToday(history) {
  const d = today();

  return new Set(
    history
      .filter(x => x.date === d)
      .map(x => x.symbol)
      .filter(Boolean)
  );
}

async function getSpotCoins() {
  const [exchange, tickers] = await Promise.all([
    api(`${BINANCE}/api/v3/exchangeInfo`),
    api(`${BINANCE}/api/v3/ticker/24hr`)
  ]);

  const tradable = new Set(
    exchange.symbols
      .filter(s =>
        s.status === "TRADING" &&
        s.quoteAsset === "USDT" &&
        s.isSpotTradingAllowed === true
      )
      .map(s => s.symbol)
  );

  return tickers
    .filter(t =>
      tradable.has(t.symbol) &&
      n(t.quoteVolume) >= MIN_VOLUME &&
      !t.symbol.includes("UP") &&
      !t.symbol.includes("DOWN") &&
      !t.symbol.includes("BULL") &&
      !t.symbol.includes("BEAR")
    )
    .map(t => ({
      symbol: t.symbol,
      asset: t.symbol.replace(/USDT$/, ""),
      price: n(t.lastPrice),
      change: n(t.priceChangePercent),
      volume: n(t.quoteVolume),
      high: n(t.highPrice),
      low: n(t.lowPrice),
      trades: n(t.count)
    }));
}

async function getCandles(symbol) {
  const data = await api(
    `${BINANCE}/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=72`
  );

  return data.map(k => ({
    time: n(k[0]),
    open: n(k[1]),
    high: n(k[2]),
    low: n(k[3]),
    close: n(k[4]),
    volume: n(k[5])
  }));
}

function sma(values, period) {
  if (values.length < period) return null;

  const a = values.slice(-period);

  return a.reduce((sum, value) => sum + value, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier + result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain =
      ((avgGain * (period - 1)) + gain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function chooseCoin(coins, history) {
  const used = usedCoinsToday(history);

  const scored = coins
    .map(c => {
      const momentum = Math.max(c.change, 0);
      const volume = Math.log10(Math.max(c.volume, 1));

      return {
        ...c,
        score: momentum * volume
      };
    })
    .sort((a, b) => b.score - a.score);

  const unused = scored.filter(c => !used.has(c.asset));

  return unused[0] || scored[0];
}

function marketDirection(closes) {
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const last = closes.at(-1);

  if (last > e20 && e20 > e50) return "BULLISH";
  if (last < e20 && e20 < e50) return "BEARISH";

  return "MIXED";
}

function technicalPost(coin, candles) {
  const closes = candles.map(x => x.close);

  const last = closes.at(-1);

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  const rsi14 = rsi(closes, 14);

  const high24 = Math.max(...candles.slice(-24).map(x => x.high));
  const low24 = Math.min(...candles.slice(-24).map(x => x.low));

  const high72 = Math.max(...candles.map(x => x.high));
  const low72 = Math.min(...candles.map(x => x.low));

  const direction = marketDirection(closes);

  let rsiText = "neutral";

  if (rsi14 >= 70) rsiText = "overbought";
  else if (rsi14 <= 30) rsiText = "oversold";

  const aboveEma20 = last > ema20;

  const momentum =
    direction === "BULLISH"
      ? "bullish"
      : direction === "BEARISH"
        ? "bearish"
        : "mixed";

  return `📊 $${coin.asset} Technical Analysis

Price: $${fmtPrice(last)}
24H: ${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}%
24H Volume: ${fmtMoney(coin.volume)}

📈 Market structure
Trend: ${direction}
Momentum: ${momentum}
RSI(14): ${rsi14?.toFixed(1)} — ${rsiText}

Moving averages:
• EMA20: $${fmtPrice(ema20)}
• EMA50: $${fmtPrice(ema50)}
• SMA20: $${fmtPrice(sma20)}
• SMA50: $${fmtPrice(sma50)}

📍 Key levels
24H High: $${fmtPrice(high24)}
24H Low: $${fmtPrice(low24)}
72H Resistance: $${fmtPrice(high72)}
72H Support: $${fmtPrice(low72)}

🔎 What to watch

${aboveEma20
  ? `$${coin.asset} is currently above EMA20, keeping short-term momentum constructive.`
  : `$${coin.asset} is currently below EMA20, so short-term momentum remains under pressure.`}

🐂 Bull scenario:
A move above the recent resistance with stronger volume could confirm improving momentum.

🐻 Bear scenario:
A break below the recent support could weaken the current structure.

This is market analysis, not financial advice.

What level are you watching next for $${coin.asset}?

#Crypto #Binance #${coin.asset} #TechnicalAnalysis`;
}

function topMoversPost(coins) {
  const gainers = [...coins]
    .filter(x => x.change > 0)
    .sort((a, b) => b.change - a.change)
    .slice(0, 7);

  return `🔥 Binance Spot — Top Gainers

${gainers.map((x, i) =>
  `${i + 1}. $${x.asset}  +${x.change.toFixed(2)}%
   Volume: ${fmtMoney(x.volume)}`
).join("\n\n")}

Strong percentage gains can attract attention, but momentum should be evaluated together with volume, liquidity and market structure.

Which $TOKEN is showing the most interesting setup to you?

#Crypto #Binance #Altcoins #MarketUpdate`;
}

function educationPost() {
  return `📚 Crypto Education

Why can a breakout fail even when the price moves above resistance?

Because price alone is not enough.

Traders often look for confirmation from:

• Trading volume
• Liquidity
• Retests
• Higher-timeframe structure
• Momentum indicators

A breakout with weak participation can quickly turn into a false breakout.

The important question is not only "Did price break resistance?"

It is also:

"Did the market support the move?"

What confirmation do you usually look for?

#CryptoEducation #Binance #Trading #TechnicalAnalysis`;
}

async function createChart(symbol) {
  const script = path.join(ROOT, "bot", "chart.mjs");

  const output = path.join(
    ROOT,
    "bot",
    `${symbol}-${Date.now()}.png`
  );

  execFileSync(
    process.execPath,
    [script, symbol, output],
    { stdio: "inherit" }
  );

  return output;
}

function findPoster() {
  const possible = [
    ".agents/skills/binance/square-post/scripts/post-image.mjs",
    "agent/skills/binance/square-post/scripts/post-image.mjs",
    ".agents/skills/square-post/scripts/post-image.mjs",
    "agent/skills/square-post/scripts/post-image.mjs"
  ];

  return possible
    .map(x => path.join(ROOT, x))
    .find(fs.existsSync);
}

async function main() {
  const history = loadHistory();

  const slot = currentSlot();

  if (alreadyPosted(history, slot)) {
    console.log("Already published in this 25-minute slot.");
    return;
  }

  const coins = await getSpotCoins();

  if (!coins.length) {
    throw new Error("No suitable Binance Spot markets found.");
  }

  const coin = chooseCoin(coins, history);

  const candles = await getCandles(coin.symbol);

  /*
    80% technical analysis
    20% other crypto content

    4 analysis slots
    1 other-content slot
  */

  const mode = slot % 5;

  let text;
  let image = null;
  let type;

  if (mode < 4) {
    text = technicalPost(coin, candles);

    image = await createChart(coin.asset);

    type = "technical-analysis";
  } else {
    const contentType = Math.floor(slot / 5) % 2;

    if (contentType === 0) {
      text = topMoversPost(coins);
      type = "market-update";
    } else {
      text = educationPost();
      type = "education";
    }
  }

  const poster = findPoster();

  if (!poster) {
    throw new Error(
      "Binance Square post-image.mjs was not found."
    );
  }

  const args = [
    "--text",
    text
  ];

  if (image) {
    args.push(
      "--images",
      image
    );
  }

  console.log(`Publishing ${type}...`);

  execFileSync(
    process.execPath,
    [poster, ...args],
    {
      stdio: "inherit",
      env: process.env
    }
  );

  history.push({
    slot,
    date: today(),
    timestamp: new Date().toISOString(),
    symbol: coin.asset,
    type
  });

  saveHistory(history);

  if (image && fs.existsSync(image)) {
    fs.unlinkSync(image);
  }

  console.log("Published successfully.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
