import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BINANCE = "https://data-api.binance.vision";
const ROOT = process.cwd();
const HISTORY_FILE = path.join(ROOT, "data", "history.json");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function get(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "binance-square-bot/1.0",
      ...(options.headers || {})
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function money(v) {
  const n = num(v);
  if (n >= 1_000_000_000) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(4)}`;
}

function price(v) {
  const n = num(v);
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toPrecision(5);
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-500), null, 2));
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function usedToday(history) {
  const today = todayUTC();
  return new Set(
    history
      .filter(x => x.date === today)
      .map(x => x.symbol)
      .filter(Boolean)
  );
}

function sma(values, period) {
  if (values.length < period) return null;
  const a = values.slice(-period);
  return a.reduce((x, y) => x + y, 0) / period;
}

async function getMarket() {
  const [info, tickers] = await Promise.all([
    get(`${BINANCE}/api/v3/exchangeInfo`),
    get(`${BINANCE}/api/v3/ticker/24hr`)
  ]);

  const spot = new Set(
    info.symbols
      .filter(s =>
        s.status === "TRADING" &&
        s.quoteAsset === "USDT" &&
        s.isSpotTradingAllowed === true
      )
      .map(s => s.symbol)
  );

  return tickers
    .filter(t =>
      spot.has(t.symbol) &&
      !t.symbol.endsWith("UPUSDT") &&
      !t.symbol.endsWith("DOWNUSDT") &&
      num(t.quoteVolume) >= 5_000_000
    )
    .map(t => ({
      symbol: t.symbol,
      asset: t.symbol.replace("USDT", ""),
      price: num(t.lastPrice),
      change: num(t.priceChangePercent),
      volume: num(t.quoteVolume),
      high: num(t.highPrice),
      low: num(t.lowPrice),
      trades: num(t.count)
    }));
}

async function getKlines(symbol) {
  const data = await get(
    `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=1h&limit=48`
  );

  return data.map(k => ({
    time: k[0],
    open: num(k[1]),
    high: num(k[2]),
    low: num(k[3]),
    close: num(k[4]),
    volume: num(k[5])
  }));
}

function scoreCoin(c) {
  const momentum = Math.max(c.change, 0);
  const volumeScore = Math.log10(Math.max(c.volume, 1));
  return momentum * volumeScore;
}

function chooseCoin(coins, history) {
  const used = usedToday(history);

  const candidates = coins
    .filter(c => c.change > 1)
    .sort((a, b) => scoreCoin(b) - scoreCoin(a));

  const fresh = candidates.find(c => !used.has(c.asset));
  return fresh || candidates[0];
}

function trend(closes) {
  const s8 = sma(closes, 8);
  const s20 = sma(closes, 20);

  if (s8 > s20) return "bullish";
  if (s8 < s20) return "bearish";
  return "neutral";
}

async function createChart(symbol) {
  const chart = path.join(ROOT, "bot", "chart.mjs");
  const output = path.join(ROOT, "bot", `${symbol}-${Date.now()}.png`);

  execFileSync(
    process.execPath,
    [chart, symbol, output],
    { stdio: "inherit" }
  );

  return output;
}

function postText(c, candles) {
  const closes = candles.map(x => x.close);
  const sma8 = sma(closes, 8);
  const sma20 = sma(closes, 20);
  const hi = Math.max(...candles.map(x => x.high));
  const lo = Math.min(...candles.map(x => x.low));
  const t = trend(closes);

  const direction =
    t === "bullish"
      ? "Short-term momentum is bullish"
      : t === "bearish"
        ? "Short-term momentum is weakening"
        : "Short-term momentum is mixed";

  const resistance = hi;
  const support = lo;

  return `📊 $${c.asset} — 48H Technical Watch

Price: $${price(c.price)}
24H change: ${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}%
24H volume: ${money(c.volume)}

${direction}.

48H range:
• High: $${price(resistance)}
• Low: $${price(support)}

Moving averages:
• SMA 8H: $${price(sma8)}
• SMA 20H: $${price(sma20)}

🔎 Key levels
Support: $${price(support)}
Resistance: $${price(resistance)}

🐂 Bull case:
A sustained move above resistance with strong volume could strengthen the current momentum.

🐻 Bear case:
A loss of support could signal a deeper pullback and weaker short-term structure.

This is market analysis, not financial advice.

What level would you watch next for $${c.asset}?

#Crypto #Binance #${c.asset} #TechnicalAnalysis`;
}

function postMarketUpdate(coins) {
  const top = [...coins].sort((a, b) => b.change - a.change).slice(0, 5);

  return `🔥 Binance Spot — Top Movers

${top.map((x, i) =>
  `${i + 1}. $${x.asset}: ${x.change >= 0 ? "+" : ""}${x.change.toFixed(2)}% | Volume ${money(x.volume)}`
).join("\n")}

The strongest movers are showing elevated momentum, but percentage gains alone do not confirm a sustainable trend.

Always check volume, liquidity and market structure before drawing conclusions.

Which mover are you watching today?

#Crypto #Binance #MarketUpdate #Altcoins`;
}

function postEducation() {
  return `📚 Crypto Education: Why volume matters

Price tells you where the market moved.

Volume tells you how much activity supported that move.

A breakout with expanding volume can be more meaningful than the same breakout on weak volume. But volume by itself is not a guarantee that a move will continue.

A useful checklist:

• Price direction
• Volume trend
• Support/resistance
• Liquidity
• Higher-timeframe structure

Which indicator do you rely on most when confirming a breakout?

#CryptoEducation #Binance #Trading #Crypto`;
}

async function main() {
  const history = loadHistory();
  const coins = await getMarket();

  if (!coins.length) throw new Error("No Binance Spot USDT markets found.");

  const coin = chooseCoin(coins, history);
  const candles = await getKlines(coin.symbol);

  const hour = new Date().getUTCHours();

  let text;
  let image = null;

  // Rotate content so the account does not publish the same type every hour.
  if (hour % 6 === 0) {
    text = postMarketUpdate(coins);
  } else if (hour % 7 === 0) {
    text = postEducation();
  } else {
    text = postText(coin, candles);
    image = await createChart(coin.symbol);
  }

  // Locate the official Binance Square posting script.
  const candidates = [
    ".agents/skills/binance/square-post/scripts/post-image.mjs",
    "agent/skills/binance/square-post/scripts/post-image.mjs",
    ".agents/skills/square-post/scripts/post-image.mjs",
    "agent/skills/square-post/scripts/post-image.mjs"
  ];

  const poster = candidates
    .map(x => path.join(ROOT, x))
    .find(fs.existsSync);

  if (!poster) {
    throw new Error("Official Binance Square post-image.mjs was not found.");
  }

  const args = ["--text", text];

  if (image && fs.existsSync(image)) {
    args.push("--images", image);
  }

  execFileSync(process.execPath, [poster, ...args], {
    stdio: "inherit",
    env: process.env
  });

  history.push({
    date: todayUTC(),
    timestamp: new Date().toISOString(),
    symbol: coin.asset,
    type: image ? "technical-analysis" : "market-content"
  });

  saveHistory(history);

  if (image) {
    try {
      fs.unlinkSync(image);
    } catch {}
  }

  await sleep(500);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
