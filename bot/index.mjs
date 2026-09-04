import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const API = "https://data-api.binance.vision";
const ROOT = process.cwd();
const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const CHART_FILE = path.join(ROOT, "bot", "latest-chart.png");

const SLOT_MS = 25 * 60 * 1000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "binance-square-bot/1.0" }
      });

      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1500);
    }
  }
}

function num(v) {
  return Number(v);
}

function money(v) {
  const n = Number(v);

  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(5)}`;
}

function compact(v) {
  const n = Number(v);

  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;

  return `$${n.toFixed(0)}`;
}

function sma(values, period) {
  if (values.length < period) return null;

  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let result = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];

    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function loadHistory() {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });

  if (!fs.existsSync(HISTORY_FILE)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });

  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(history.slice(-1000), null, 2)
  );
}

async function getSpotCoins() {
  const [exchangeInfo, tickers] = await Promise.all([
    getJson(`${API}/api/v3/exchangeInfo?permissions=["SPOT"]`),
    getJson(`${API}/api/v3/ticker/24hr`)
  ]);

  const tradingSymbols = new Set(
    exchangeInfo.symbols
      .filter(s =>
        s.status === "TRADING" &&
        s.quoteAsset === "USDT" &&
        (
          s.isSpotTradingAllowed === true ||
          s.permissions?.includes("SPOT")
        )
      )
      .map(s => s.symbol)
  );

  return tickers
    .filter(t =>
      tradingSymbols.has(t.symbol) &&
      t.symbol.endsWith("USDT") &&
      !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol) &&
      Number(t.quoteVolume) >= 5_000_000
    )
    .map(t => ({
      symbol: t.symbol,
      asset: t.symbol.replace("USDT", ""),
      price: num(t.lastPrice),
      change: num(t.priceChangePercent),
      volume: num(t.quoteVolume),
      high: num(t.highPrice),
      low: num(t.lowPrice)
    }));
}

function chooseCoin(coins, history) {
  const today = new Date().toISOString().slice(0, 10);

  const usedToday = new Set(
    history
      .filter(x => x.date === today && x.type === "analysis")
      .map(x => x.asset)
  );

  const candidates = coins
    .filter(c => !usedToday.has(c.asset))
    .sort((a, b) => {
      const scoreA =
        Math.max(a.change, 0) *
        Math.log10(Math.max(a.volume, 1));

      const scoreB =
        Math.max(b.change, 0) *
        Math.log10(Math.max(b.volume, 1));

      return scoreB - scoreA;
    });

  if (candidates.length > 0) {
    return candidates[0];
  }

  return [...coins].sort((a, b) => b.change - a.change)[0];
}

async function getKlines(symbol) {
  const data = await getJson(
    `${API}/api/v3/klines?symbol=${symbol}&interval=1h&limit=72`
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

function analysisText(coin, candles) {
  const closes = candles.map(x => x.close);

  const price = closes.at(-1);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);

  const rsi14 = rsi(closes, 14);

  const high72 = Math.max(...candles.map(x => x.high));
  const low72 = Math.min(...candles.map(x => x.low));

  const last20 = candles.slice(-20);

  const support = Math.min(...last20.map(x => x.low));
  const resistance = Math.max(...last20.map(x => x.high));

  let trend = "NEUTRAL";

  if (price > ema20 && ema20 > ema50) {
    trend = "BULLISH";
  } else if (price < ema20 && ema20 < ema50) {
    trend = "BEARISH";
  }

  let momentum = "Neutral";

  if (rsi14 >= 60) momentum = "Strong";
  else if (rsi14 >= 52) momentum = "Positive";
  else if (rsi14 <= 40) momentum = "Weak";
  else if (rsi14 <= 48) momentum = "Negative";

  const trendEmoji =
    trend === "BULLISH" ? "🟢" :
    trend === "BEARISH" ? "🔴" : "🟡";

  const momentumEmoji =
    momentum === "Strong" || momentum === "Positive" ? "📈" : "📉";

  const changeEmoji = coin.change >= 0 ? "🟢" : "🔴";

  const text = `📊 $${coin.asset} Technical Analysis

💰 Price: ${money(price)}
${changeEmoji} 24H Change: ${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}%
📊 24H Volume: ${compact(coin.volume)}

🔎 Market Structure
${trendEmoji} Trend: ${trend}
${momentumEmoji} Momentum: ${momentum}
⚡ RSI(14): ${rsi14.toFixed(1)}

📈 Moving Averages
• EMA20: ${money(ema20)}
• EMA50: ${money(ema50)}
• SMA20: ${money(sma20)}
• SMA50: ${money(sma50)}

📍 Key Levels
🟢 Support 1: ${money(support)}
🟢 72H Support: ${money(low72)}
🔴 Resistance 1: ${money(resistance)}
🔴 72H Resistance: ${money(high72)}

👀 What to watch
Watch the reaction around ${money(support)}–${money(resistance)} and whether volume expands during the next breakout attempt.

🐂 Bullish Scenario
A breakout above ${money(resistance)} with stronger volume could improve the short-term structure. 🚀

🐻 Bearish Scenario
A break below ${money(support)} could increase selling pressure and weaken momentum. ⚠️

🧠 This is market analysis, not financial advice.

🤔 What level are you watching next for $${coin.asset}?

#Crypto #Binance #${coin.asset} #TechnicalAnalysis`;

  return {
    text,
    stats: {
      price,
      ema20,
      ema50,
      sma20,
      sma50,
      rsi14,
      support,
      resistance,
      high72,
      low72
    }
  };
}

function topMoversPost(coins) {
  const movers = [...coins]
    .sort((a, b) => b.change - a.change)
    .slice(0, 5);

  const lines = movers.map((c, i) => {
    return `${i + 1}. 🟢 $${c.asset} **+${c.change.toFixed(2)}%**
   📊 Volume: ${compact(c.volume)}`;
  });

  const lead = movers[0];

  return `🔥 Binance Spot — Top Gainers

📈 The strongest Binance Spot movers right now:

${lines.join("\n\n")}

👀 Strong percentage gains can attract attention, but momentum should be evaluated together with volume, liquidity and market structure.

⚡ The leading mover is $${lead.asset} at +${lead.change.toFixed(2)}%.

🤔 Which mover has the most interesting setup to you?

#Crypto #Binance #Altcoins #MarketUpdate`;
}

function marketUpdatePost(coins) {
  const btc = coins.find(x => x.asset === "BTC");
  const eth = coins.find(x => x.asset === "ETH");

  const top = [...coins]
    .sort((a, b) => b.change - a.change)[0];

  return `🌐 Binance Spot Market Update

₿ $BTC: ${btc ? `${btc.change >= 0 ? "🟢" : "🔴"} ${btc.change >= 0 ? "+" : ""}${btc.change.toFixed(2)}%` : "N/A"}

♦️ $ETH: ${eth ? `${eth.change >= 0 ? "🟢" : "🔴"} ${eth.change >= 0 ? "+" : ""}${eth.change.toFixed(2)}%` : "N/A"}

🔥 Top mover: $${top.asset}
${top.change >= 0 ? "📈" : "📉"} 24H: ${top.change >= 0 ? "+" : ""}${top.change.toFixed(2)}%
💰 Volume: ${compact(top.volume)}

🔎 Market conditions can change quickly, so volume and price structure remain important when evaluating momentum.

👀 What are you watching most closely today?

#Crypto #Binance #Bitcoin #MarketUpdate`;
}

function educationPost() {
  return `📚 Crypto Education

🔎 Why can a breakout fail even when price moves above resistance?

Because price alone isn't enough.

📊 Traders often look for confirmation from:

🟢 Trading volume
🟢 Liquidity
🟢 Retests
📈 Higher-timeframe structure
⚡ Momentum

⚠️ A breakout with weak participation can quickly become a false breakout.

🧠 The goal is to evaluate the whole structure rather than one candle.

🤔 What confirmation do you usually look for before trusting a breakout?

#CryptoEducation #Binance #Trading #TechnicalAnalysis`;
}

function findPoster() {
  const locations = [
    ".agents/skills/binance/square-post/scripts/post-image.mjs",
    "agent/skills/binance/square-post/scripts/post-image.mjs",
    ".agents/skills/square-post/scripts/post-image.mjs",
    "agent/skills/square-post/scripts/post-image.mjs"
  ];

  for (const location of locations) {
    const full = path.join(ROOT, location);

    if (fs.existsSync(full)) return full;
  }

  throw new Error("Binance Square post-image.mjs was not found.");
}

function publish(text, imagePath = null) {
  const poster = findPoster();

  const args = [
    poster,
    "--text",
    text
  ];

  if (imagePath && fs.existsSync(imagePath)) {
    args.push("--images", imagePath);
  }

  console.log("Publishing to Binance Square...");

  execFileSync(
    "node",
    args,
    {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit"
    }
  );
}

async function createChart(symbol) {
  try {
    execFileSync(
      "node",
      [
        path.join(ROOT, "bot", "chart.mjs"),
        symbol,
        CHART_FILE
      ],
      {
        cwd: ROOT,
        stdio: "inherit"
      }
    );

    return fs.existsSync(CHART_FILE) ? CHART_FILE : null;
  } catch (e) {
    console.log("Chart generation failed. Publishing without image.");
    return null;
  }
}

async function main() {
  console.log("================================");
  console.log("Binance Square Auto Bot");
  console.log("================================");

  const history = loadHistory();

  const slot = Math.floor(Date.now() / SLOT_MS);

  if (history.some(x => x.slot === slot)) {
    console.log("This 25-minute slot was already published.");
    return;
  }

  const coins = await getSpotCoins();

  if (!coins.length) {
    throw new Error("No eligible Binance Spot USDT coins found.");
  }

  const slotInCycle = ((slot % 5) + 5) % 5;

  let type;
  let text;
  let asset = null;
  let image = null;

  if (slotInCycle < 4) {
    type = "analysis";

    const coin = chooseCoin(coins, history);

    if (!coin) {
      throw new Error("Could not select a coin.");
    }

    asset = coin.asset;

    const candles = await getKlines(coin.symbol);

    const result = analysisText(coin, candles);

    text = result.text;

    image = await createChart(coin.symbol);
  } else {
    type = "other";

    const cycle = Math.floor(slot / 5);

    if (cycle % 2 === 0) {
      text = topMoversPost(coins);
    } else {
      text = educationPost();
    }
  }

  publish(text, image);

  const entry = {
    slot,
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toISOString(),
    type,
    asset
  };

  history.push(entry);
  saveHistory(history);

  if (image && fs.existsSync(image)) {
    fs.unlinkSync(image);
  }

  console.log("Published successfully.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
