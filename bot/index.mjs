import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = process.cwd();
const BASE = "https://data-api.binance.vision";

const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const CHART_FILE = path.join(ROOT, "bot", "chart.mjs");

function loadHistory() {
  try {
    return JSON.parse(
      fs.readFileSync(HISTORY_FILE, "utf8")
    );
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.mkdirSync(
    path.dirname(HISTORY_FILE),
    { recursive: true }
  );

  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(history, null, 2)
  );
}

async function api(endpoint) {
  const response = await fetch(`${BASE}${endpoint}`);

  if (!response.ok) {
    throw new Error(
      `Binance API error: ${response.status}`
    );
  }

  return response.json();
}

function findScript(name) {
  const candidates = [
    path.join(
      ROOT,
      `.agents/skills/square-post/scripts/${name}`
    ),
    path.join(
      ROOT,
      `agent/skills/square-post/scripts/${name}`
    ),
    path.join(
      ROOT,
      `../.agents/skills/square-post/scripts/${name}`
    ),
    path.join(
      ROOT,
      `../agent/skills/square-post/scripts/${name}`
    )
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return file;
    }
  }

  throw new Error(`${name} not found`);
}

function createChart(symbol, output) {
  execFileSync(
    process.execPath,
    [CHART_FILE, symbol, output],
    {
      stdio: "inherit"
    }
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

function formatPrice(value) {
  if (value >= 1000) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toFixed(6);
}

async function main() {
  const history = loadHistory();

  const today =
    new Date().toISOString().slice(0, 10);

  const usedToday = new Set(
    history
      .filter(item => item.date === today)
      .map(item => item.symbol)
  );

  const exchangeInfo =
    await api("/api/v3/exchangeInfo");

  const tickers =
    await api("/api/v3/ticker/24hr");

  const tradable = new Set(
    exchangeInfo.symbols
      .filter(symbol =>
        symbol.status === "TRADING" &&
        symbol.quoteAsset === "USDT" &&
        symbol.isSpotTradingAllowed === true
      )
      .map(symbol => symbol.baseAsset)
  );

  const candidates = tickers
    .filter(ticker => {
      if (!ticker.symbol.endsWith("USDT")) {
        return false;
      }

      const base =
        ticker.symbol.replace("USDT", "");

      const change =
        Number(ticker.priceChangePercent);

      const volume =
        Number(ticker.quoteVolume);

      return (
        tradable.has(base) &&
        !usedToday.has(base) &&
        change > 1 &&
        volume >= 5000000
      );
    })
    .sort((a, b) => {
      const scoreA =
        Number(a.priceChangePercent) *
        Math.log10(
          Math.max(Number(a.quoteVolume), 1)
        );

      const scoreB =
        Number(b.priceChangePercent) *
        Math.log10(
          Math.max(Number(b.quoteVolume), 1)
        );

      return scoreB - scoreA;
    });

  if (!candidates.length) {
    throw new Error(
      "No suitable Binance Spot coin found"
    );
  }

  const selected = candidates[0];

  const symbol =
    selected.symbol.replace("USDT", "");

  const price =
    Number(selected.lastPrice);

  const change =
    Number(selected.priceChangePercent);

  const volume =
    Number(selected.quoteVolume);

  const high =
    Number(selected.highPrice);

  const low =
    Number(selected.lowPrice);

  const klines = await api(
    `/api/v3/klines?symbol=${selected.symbol}&interval=1h&limit=48`
  );

  const closes =
    klines.map(k => Number(k[4]));

  const sma = period => {
    const values =
      closes.slice(-period);

    return (
      values.reduce(
        (sum, value) => sum + value,
        0
      ) / values.length
    );
  };

  const sma8 = sma(8);
  const sma20 = sma(20);

  const recentHigh =
    Math.max(...closes);

  const recentLow =
    Math.min(...closes);

  let bias = "Mixed";

  if (sma8 > sma20 && change > 0) {
    bias = "Bullish";
  } else if (
    sma8 < sma20 &&
    change < 0
  ) {
    bias = "Bearish";
  }

  const bullishScenario =
    `A break above $${formatPrice(recentHigh)} could strengthen momentum.`;

  const bearishScenario =
    `A move below $${formatPrice(recentLow)} could increase downside risk.`;

  const question =
    bias === "Bullish"
      ? `Can $${symbol} break the recent high?`
      : `Can $${symbol} recover its short-term trend?`;

  const text = `🔥 $${symbol} — Binance Market Update

$${symbol} is showing ${change >= 0 ? "positive" : "negative"} momentum on Binance Spot.

💰 Price: $${formatPrice(price)}
📈 24H Change: ${change >= 0 ? "+" : ""}${change.toFixed(2)}%
💧 24H Volume: $${(volume / 1000000).toFixed(1)}M
🔺 24H High: $${formatPrice(high)}
🔻 24H Low: $${formatPrice(low)}

📊 Technical Snapshot

• SMA 8: $${formatPrice(sma8)}
• SMA 20: $${formatPrice(sma20)}
• 48H High: $${formatPrice(recentHigh)}
• 48H Low: $${formatPrice(recentLow)}
• Bias: ${bias}

🟢 Bullish scenario:
${bullishScenario}

🔴 Risk scenario:
${bearishScenario}

🎯 Key level:
$${formatPrice(recentHigh)}

❓ ${question}

#${symbol} #Crypto #Binance #Trading

⚠️ Market analysis only. Not financial advice.`;

  const chartPath =
    path.join(
      ROOT,
      `chart-${symbol}-${Date.now()}.png`
    );

  createChart(
    symbol,
    chartPath
  );

  const imageScript =
    findScript("post-image.mjs");

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
    symbol,
    type: "technical_analysis",
    price,
    change
  });

  saveHistory(history);

  console.log(
    `Published $${symbol} successfully.`
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
