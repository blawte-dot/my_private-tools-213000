import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const API = "https://data-api.binance.vision";
const ROOT = process.cwd();

const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const IMAGE_FILE = path.join(ROOT, "bot", "post-image.png");

const SLOT_MS = 25 * 60 * 1000;

async function getJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "binance-square-bot/1.0" }
      });

      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }

      return await res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

function money(v) {
  const n = Number(v);

  if (n >= 1000) {
    return `$${n.toLocaleString("en-US", {
      maximumFractionDigits: 2
    })}`;
  }

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

  let result =
    values
      .slice(0, period)
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

    avgGain =
      ((avgGain * (period - 1)) + gain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function loadHistory() {
  fs.mkdirSync(path.dirname(HISTORY_FILE), {
    recursive: true
  });

  if (!fs.existsSync(HISTORY_FILE)) return [];

  try {
    const data = JSON.parse(
      fs.readFileSync(HISTORY_FILE, "utf8")
    );

    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), {
    recursive: true
  });

  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(history.slice(-1000), null, 2)
  );
}

async function getSpotCoins() {
  const [exchangeInfo, tickers] = await Promise.all([
    getJson(
      `${API}/api/v3/exchangeInfo?permissions=["SPOT"]`
    ),
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
      price: Number(t.lastPrice),
      change: Number(t.priceChangePercent),
      volume: Number(t.quoteVolume),
      high: Number(t.highPrice),
      low: Number(t.lowPrice)
    }));
}

function chooseCoin(coins, history) {
  const today = new Date()
    .toISOString()
    .slice(0, 10);

  const usedToday = new Set(
    history
      .filter(x =>
        x.date === today &&
        x.type === "analysis"
      )
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

  return candidates[0] ||
    [...coins].sort((a, b) =>
      b.change - a.change
    )[0];
}

async function getKlines(symbol) {
  const data = await getJson(
    `${API}/api/v3/klines?symbol=${symbol}&interval=1h&limit=72`
  );

  return data.map(k => ({
    time: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5])
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

  const high72 = Math.max(
    ...candles.map(x => x.high)
  );

  const low72 = Math.min(
    ...candles.map(x => x.low)
  );

  const last20 = candles.slice(-20);

  const support = Math.min(
    ...last20.map(x => x.low)
  );

  const resistance = Math.max(
    ...last20.map(x => x.high)
  );

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
    trend === "BULLISH"
      ? "🟢"
      : trend === "BEARISH"
        ? "🔴"
        : "🟡";

  const momentumEmoji =
    momentum === "Strong" ||
    momentum === "Positive"
      ? "📈"
      : "📉";

  const changeEmoji =
    coin.change >= 0 ? "🟢" : "🔴";

  return `📊 $${coin.asset} Technical Analysis

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
A break below ${money(support)} could increase selling pressure. ⚠️

🧠 This is market analysis, not financial advice.

🤔 What level are you watching next for $${coin.asset}?

#Crypto #Binance #${coin.asset} #TechnicalAnalysis`;
}

function topMoversPost(coins) {
  const movers = [...coins]
    .sort((a, b) => b.change - a.change)
    .slice(0, 5);

  const lines = movers.map((c, i) => {
    const emoji =
      c.change >= 0 ? "🟢" : "🔴";

    return `${i + 1}. ${emoji} $${c.asset} ${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}%
📊 Volume: ${compact(c.volume)}`;
  });

  const lead = movers[0];

  return `🔥 Binance Spot — Top Movers

📈 The strongest Binance Spot movers right now:

${lines.join("\n\n")}

🔎 Percentage gains are more useful when viewed together with volume, liquidity and market structure.

⚡ Leading mover: $${lead.asset} at ${lead.change >= 0 ? "+" : ""}${lead.change.toFixed(2)}%

👀 Which mover are you watching?

🤔 Which one has the most interesting setup?

#Crypto #Binance #Altcoins #MarketUpdate`;
}

function marketUpdatePost(coins) {
  const btc = coins.find(
    x => x.asset === "BTC"
  );

  const eth = coins.find(
    x => x.asset === "ETH"
  );

  const top = [...coins]
    .sort((a, b) => b.change - a.change)[0];

  return `🌐 Binance Spot Market Update

₿ $BTC:
${btc
      ? `${btc.change >= 0 ? "🟢" : "🔴"} ${btc.change >= 0 ? "+" : ""}${btc.change.toFixed(2)}%`
      : "N/A"}

♦️ $ETH:
${eth
      ? `${eth.change >= 0 ? "🟢" : "🔴"} ${eth.change >= 0 ? "+" : ""}${eth.change.toFixed(2)}%`
      : "N/A"}

🔥 Top mover: $${top.asset}
📈 24H Change: ${top.change >= 0 ? "+" : ""}${top.change.toFixed(2)}%
💰 Volume: ${compact(top.volume)}

🔎 Volume and price structure remain important when evaluating momentum.

👀 Market conditions can change quickly.

🤔 What are you watching most closely?

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

⚠️ A breakout with weak participation can become a false breakout.

🧠 The goal is to evaluate the whole structure rather than one candle.

👀 Confirmation matters.

🤔 What confirmation do you usually look for?

#CryptoEducation #Binance #Trading #TechnicalAnalysis`;
}

/* ================================
   AUTOMATIC IMAGE GENERATOR
================================ */

async function createInfoImage({
  title,
  subtitle,
  lines = [],
  positive = false
}) {
  const width = 1400;
  const height = 800;

  const accent = positive
    ? "#22c55e"
    : "#facc15";

  const lineSvg = lines
    .slice(0, 8)
    .map((line, i) => {
      const y = 260 + i * 55;

      return `
      <text
        x="90"
        y="${y}"
        fill="#e5e7eb"
        font-size="28"
        font-family="Arial">
        ${escapeXml(line)}
      </text>`;
    })
    .join("");

  const svg = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="${width}"
    height="${height}"
    viewBox="0 0 ${width} ${height}">

    <rect
      width="100%"
      height="100%"
      fill="#111827"/>

    <rect
      x="60"
      y="60"
      width="1280"
      height="680"
      rx="28"
      fill="#1f2937"
      stroke="#374151"
      stroke-width="2"/>

    <rect
      x="90"
      y="100"
      width="10"
      height="100"
      rx="5"
      fill="${accent}"/>

    <text
      x="135"
      y="140"
      fill="#ffffff"
      font-size="46"
      font-family="Arial"
      font-weight="bold">
      ${escapeXml(title)}
    </text>

    <text
      x="135"
      y="185"
      fill="#9ca3af"
      font-size="24"
      font-family="Arial">
      ${escapeXml(subtitle)}
    </text>

    ${lineSvg}

    <text
      x="90"
      y="700"
      fill="#6b7280"
      font-size="18"
      font-family="Arial">
      Binance Spot Market Data
    </text>

  </svg>
  `;

  fs.mkdirSync(path.dirname(IMAGE_FILE), {
    recursive: true
  });

  await sharp(Buffer.from(svg))
    .png()
    .toFile(IMAGE_FILE);

  return IMAGE_FILE;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* ================================
   REAL TECHNICAL CHART
================================ */

async function createAnalysisChart(symbol) {
  const chartPath = path.join(
    ROOT,
    "bot",
    "analysis-chart.png"
  );

  try {
    execFileSync(
      "node",
      [
        path.join(ROOT, "bot", "chart.mjs"),
        symbol,
        chartPath
      ],
      {
        cwd: ROOT,
        stdio: "inherit"
      }
    );

    if (fs.existsSync(chartPath)) {
      return chartPath;
    }
  } catch {
    console.log(
      "Technical chart failed. Using automatic info image."
    );
  }

  return null;
}

/* ================================
   FIND BINANCE POSTER
================================ */

function findPoster() {
  const locations = [
    ".agents/skills/binance/square-post/scripts/post-image.mjs",
    "agent/skills/binance/square-post/scripts/post-image.mjs",
    ".agents/skills/square-post/scripts/post-image.mjs",
    "agent/skills/square-post/scripts/post-image.mjs"
  ];

  for (const location of locations) {
    const full = path.join(ROOT, location);

    if (fs.existsSync(full)) {
      return full;
    }
  }

  throw new Error(
    "Binance Square post-image.mjs was not found."
  );
}

/* ================================
   PUBLISH
================================ */

function publish(text, imagePath) {
  const poster = findPoster();

  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error(
      "A valid image is required for Binance Square."
    );
  }

  console.log(
    "Publishing with image:",
    imagePath
  );

  execFileSync(
    "node",
    [
      poster,
      "--text",
      text,
      "--images",
      imagePath
    ],
    {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit"
    }
  );
}

/* ================================
   MAIN
================================ */

async function main() {
  console.log("================================");
  console.log("Binance Square Auto Bot");
  console.log("================================");

  const history = loadHistory();

  const slot = Math.floor(
    Date.now() / SLOT_MS
  );

  if (
    history.some(
      x => x.slot === slot
    )
  ) {
    console.log(
      "This 25-minute slot was already published."
    );
    return;
  }

  const coins = await getSpotCoins();

  if (!coins.length) {
    throw new Error(
      "No eligible Binance Spot USDT coins found."
    );
  }

  const slotInCycle =
    ((slot % 5) + 5) % 5;

  let type;
  let text;
  let asset = null;
  let image = null;

  /* 80% ANALYSIS */

  if (slotInCycle < 4) {
    type = "analysis";

    const coin = chooseCoin(
      coins,
      history
    );

    asset = coin.asset;

    const candles =
      await getKlines(coin.symbol);

    text =
      analysisText(
        coin,
        candles
      );

    image =
      await createAnalysisChart(
        coin.symbol
      );

    if (!image) {
      image =
        await createInfoImage({
          title: `$${coin.asset} Technical Analysis`,
          subtitle: "Binance Spot • 1H",
          lines: [
            `Price: ${money(coin.price)}`,
            `24H Change: ${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}%`,
            `Volume: ${compact(coin.volume)}`,
            `24H High: ${money(coin.high)}`,
            `24H Low: ${money(coin.low)}`
          ],
          positive: coin.change >= 0
        });
    }
  }

  /* 20% OTHER */

  else {
    type = "other";

    const cycle =
      Math.floor(slot / 5);

    if (cycle % 2 === 0) {
      text = topMoversPost(coins);

      const movers = [...coins]
        .sort(
          (a, b) =>
            b.change - a.change
        )
        .slice(0, 5);

      image =
        await createInfoImage({
          title: "🔥 Binance Top Movers",
          subtitle: "Binance Spot • 24H",
          lines: movers.map(
            (c, i) =>
              `${i + 1}. $${c.asset}  ${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}%`
          ),
          positive: true
        });
    } else {
      text = educationPost();

      image =
        await createInfoImage({
          title: "📚 Crypto Education",
          subtitle: "Understanding breakout confirmation",
          lines: [
            "🟢 Volume",
            "🟢 Liquidity",
            "🟢 Retests",
            "📈 Market structure",
            "⚡ Momentum",
            "⚠️ Avoid relying on price alone"
          ],
          positive: false
        });
    }
  }

  publish(text, image);

  history.push({
    slot,
    date: new Date()
      .toISOString()
      .slice(0, 10),
    time: new Date().toISOString(),
    type,
    asset
  });

  saveHistory(history);

  if (
    image &&
    fs.existsSync(image)
  ) {
    fs.unlinkSync(image);
  }

  const analysisChart =
    path.join(
      ROOT,
      "bot",
      "analysis-chart.png"
    );

  if (
    fs.existsSync(analysisChart)
  ) {
    fs.unlinkSync(analysisChart);
  }

  console.log(
    "✅ Published successfully."
  );
}

main().catch(err => {
  console.error(
    "❌ Bot failed:",
    err
  );

  process.exit(1);
});
