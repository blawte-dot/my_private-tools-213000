import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const BASE = "https://data-api.binance.vision";
const ROOT = process.cwd();

const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const CHART_FILE = path.join(ROOT, "bot", "chart.mjs");

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

async function api(endpoint) {
  const response = await fetch(`${BASE}${endpoint}`);

  if (!response.ok) {
    throw new Error(`Binance API ${response.status}`);
  }

  return response.json();
}

function findPostImageScript() {
  const candidates = [
    path.join(ROOT, ".agents/skills/square-post/scripts/post-image.mjs"),
    path.join(ROOT, "agent/skills/square-post/scripts/post-image.mjs"),
    path.join(ROOT, "../.agents/skills/square-post/scripts/post-image.mjs"),
    path.join(ROOT, "../agent/skills/square-post/scripts/post-image.mjs")
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }

  throw new Error("post-image.mjs not found");
}

function findPostTextScript() {
  const candidates = [
    path.join(ROOT, ".agents/skills/square-post/scripts/post-text.mjs"),
    path.join(ROOT, "agent/skills/square-post/scripts/post-text.mjs"),
    path.join(ROOT, "../.agents/skills/square-post/scripts/post-text.mjs"),
    path.join(ROOT, "../agent/skills/square-post/scripts/post-text.mjs")
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }

  throw new Error("post-text.mjs not found");
}

function runChart(symbol, output) {
  execFileSync(
    process.execPath,
    [CHART_FILE, symbol, output],
    { stdio: "inherit" }
  );
}

function publishImage(script, text, image) {
  execFileSync(
    process.execPath,
    [
      script,
      "--text",
      text,
      "--images",
      image
    ],
    {
      stdio: "inherit",
      env: process.env
    }
  );
}

function publishText(script, text) {
  execFileSync(
    process.execPath,
    [
      script,
      "--text",
      text
    ],
    {
      stdio: "inherit",
      env: process.env
    }
  );
}

function fmtPrice(price) {
  if (price >= 1000) return price.toFixed(0);
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

function escapeSymbol(symbol) {
  return symbol.replace(/[^A-Z0-9]/g, "");
}

async function main() {
  const history = loadHistory();

  const exchange = await api("/api/v3/exchangeInfo");
  const tickers = await api("/api/v3/ticker/24hr");

  const tradable = new Set(
    exchange.symbols
      .filter(
        s =>
          s.status === "TRADING" &&
          s.quoteAsset === "USDT" &&
          s.isSpotTradingAllowed === true
      )
      .map(s => s.baseAsset)
  );

  const today = new Date().toISOString().slice(0, 10);

  const usedToday = new Set(
    history
      .filter(x => x.date === today)
      .map(x => x.symbol)
  );

  const candidates = tickers
    .filter(t => {
      const symbol = t.symbol;

      if (!symbol.endsWith("USDT")) return false;

      const base = symbol.slice(0, -4);

      if (!tradable.has(base)) return false;
      if (usedToday.has(base)) return false;

      const change = Number(t.priceChangePercent);
      const volume = Number(t.quoteVolume);

      return (
        Number.isFinite(change) &&
        Number.isFinite(volume) &&
        volume >= 5000000 &&
        change > 1
      );
    })
    .sort((a, b) => {
      const scoreA =
        Number(a.priceChangePercent) *
        Math.log10(Math.max(Number(a.quoteVolume), 1));

      const scoreB =
        Number(b.priceChangePercent) *
        Math.log10(Math.max(Number(b.quoteVolume), 1));

      return scoreB - scoreA;
    });

  if (!candidates.length) {
    throw new Error("No suitable Binance Spot coin found");
  }

  const selected = candidates[0];

  const symbol = selected.symbol;
  const base = symbol.replace("USDT", "");

  const price = Number(selected.lastPrice);
  const change = Number(selected.priceChangePercent);
  const volume = Number(selected.quoteVolume);
  const high = Number(selected.highPrice);
  const low = Number(selected.lowPrice);

  const klines = await api(
    `/api/v3/klines?symbol=${symbol}&interval=1h&limit=48`
  );

  const closes = klines.map(k => Number(k[4]));

  const sma = period => {
    const values = closes.slice(-period);
    return values.reduce((a, b) => a + b, 0) / values.length;
  };

  const sma8 = sma(8);
  const sma20 = sma(20);

  const recentHigh = Math.max(...closes);
  const recentLow = Math.min(...closes);

  const momentum =
    sma8 > sma20
      ? "short-term momentum is bullish"
      : "short-term momentum is bearish";

  const bias =
    change >= 0 && sma8 > sma20
      ? "Bullish"
      : change < 0 && sma8 < sma20
        ? "Bearish"
        : "Mixed";

  const question =
    bias === "Bullish"
      ? `Can $${base} hold this momentum and challenge the recent high?`
      : `Can $${base} reclaim its short-term trend, or is another pullback likely?`;

  const text = `🔥 $${base} is moving on Binance

$${base} is currently showing ${change >= 0 ? "positive" : "negative"} 24h momentum.

💰 Price: $${fmtPrice(price)}
📈 24h: ${change >= 0 ? "+" : ""}${change.toFixed(2)}%
💧 24h Volume: $${(volume / 1e6).toFixed(1)}M
🔺 24h High: $${fmtPrice(high)}
🔻 24h Low: $${fmtPrice(low)}

📊 Technical snapshot
• SMA 8: $${fmtPrice(sma8)}
• SMA 20: $${fmtPrice(sma20)}
• 48H High: $${fmtPrice(recentHigh)}
• 48H Low: $${fmtPrice(recentLow)}
• Bias: ${bias}
• ${momentum}

🟢 Bullish scenario:
A break above the recent high could strengthen momentum.

🔴 Risk scenario:
A loss of the recent low could signal deeper weakness.

🎯 Key level: $${fmtPrice(recentHigh)}

${question}

#${base} #Crypto #Binance #Trading

⚠️ Market analysis only. Not financial advice.`;

  const chartPath = path.join(
    ROOT,
    `chart-${base}-${Date.now()}.svg`
  );

  runChart(base, chartPath);

  const imageScript = findPostImageScript();

  publishImage(
    imageScript,
    text,
    chartPath
  );

  try {
    fs.unlinkSync(chartPath);
  } catch {}

  history.push({
    date: today,
    timestamp: new Date().toISOString(),
    symbol: base,
    type: "technical_analysis",
    price,
    change
  });

  saveHistory(history);

  console.log(`Published $${base} successfully.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
