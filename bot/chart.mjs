import fs from "fs";

const symbol = process.argv[2];
const output = process.argv[3] || "chart.svg";

if (!symbol) {
  throw new Error("Missing symbol");
}

const BASE = "https://data-api.binance.vision";

async function getKlines() {
  const url =
    `${BASE}/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=48`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Binance API error: ${response.status}`);
  }

  return response.json();
}

function priceFormat(value) {
  if (value >= 1000) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toFixed(6);
}

function createChart(data) {
  const width = 1200;
  const height = 675;

  const left = 80;
  const right = 40;
  const top = 90;
  const bottom = 70;

  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;

  const closes = data.map(x => Number(x[4]));

  const min = Math.min(...closes);
  const max = Math.max(...closes);

  const padding = (max - min) * 0.08 || max * 0.02;

  const low = min - padding;
  const high = max + padding;

  const x = i =>
    left + (i / (closes.length - 1)) * chartWidth;

  const y = price =>
    top +
    ((high - price) / (high - low)) *
      chartHeight;

  const points = closes
    .map((price, i) => `${x(i)},${y(price)}`)
    .join(" ");

  const lastPrice = closes[closes.length - 1];

  const firstPrice = closes[0];

  const change =
    ((lastPrice - firstPrice) / firstPrice) * 100;

  const changeText =
    `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;

  const trendText =
    change >= 0 ? "BULLISH MOMENTUM" : "BEARISH MOMENTUM";

  const gridLines = [];

  for (let i = 0; i <= 5; i++) {
    const price =
      high - ((high - low) / 5) * i;

    const yy = y(price);

    gridLines.push(`
      <line
        x1="${left}"
        y1="${yy}"
        x2="${width - right}"
        y2="${yy}"
        stroke="#30343b"
        stroke-width="1"
      />

      <text
        x="${width - right}"
        y="${yy - 6}"
        fill="#9ca3af"
        font-size="18"
        text-anchor="end"
      >
        ${priceFormat(price)}
      </text>
    `);
  }

  const verticalLines = [];

  for (let i = 0; i < closes.length; i += 8) {
    const xx = x(i);

    verticalLines.push(`
      <line
        x1="${xx}"
        y1="${top}"
        x2="${xx}"
        y2="${height - bottom}"
        stroke="#252930"
        stroke-width="1"
      />
    `);
  }

  const lastX = x(closes.length - 1);
  const lastY = y(lastPrice);

  return `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${width}"
  height="${height}"
  viewBox="0 0 ${width} ${height}"
>

  <rect
    width="1200"
    height="675"
    fill="#0b0e11"
  />

  <text
    x="60"
    y="50"
    fill="#ffffff"
    font-size="30"
    font-family="Arial, sans-serif"
    font-weight="bold"
  >
    $${symbol} — 48H MARKET ANALYSIS
  </text>

  <text
    x="60"
    y="78"
    fill="#9ca3af"
    font-size="18"
    font-family="Arial, sans-serif"
  >
    Binance Spot • 1H candles
  </text>

  ${gridLines.join("")}
  ${verticalLines.join("")}

  <polyline
    points="${points}"
    fill="none"
    stroke="#f0b90b"
    stroke-width="5"
    stroke-linejoin="round"
    stroke-linecap="round"
  />

  <circle
    cx="${lastX}"
    cy="${lastY}"
    r="9"
    fill="#f0b90b"
  />

  <line
    x1="${left}"
    y1="${lastY}"
    x2="${width - right}"
    y2="${lastY}"
    stroke="#f0b90b"
    stroke-width="1"
    stroke-dasharray="8 8"
    opacity="0.7"
  />

  <rect
    x="${width - 230}"
    y="${lastY - 28}"
    width="180"
    height="42"
    rx="8"
    fill="#181c22"
  />

  <text
    x="${width - 140}"
    y="${lastY}"
    fill="#ffffff"
    font-size="20"
    text-anchor="middle"
    font-family="Arial, sans-serif"
    dominant-baseline="middle"
  >
    ${priceFormat(lastPrice)}
  </text>

  <text
    x="60"
    y="${height - 35}"
    fill="#9ca3af"
    font-size="20"
    font-family="Arial, sans-serif"
  >
    ${trendText}
  </text>

  <text
    x="${width - 60}"
    y="${height - 35}"
    fill="#ffffff"
    font-size="22"
    font-family="Arial, sans-serif"
    text-anchor="end"
    font-weight="bold"
  >
    ${changeText}
  </text>

</svg>
`;
}

const data = await getKlines();

if (!Array.isArray(data) || data.length < 10) {
  throw new Error("Not enough Binance candle data");
}

const svg = createChart(data);

fs.writeFileSync(output, svg, "utf8");

console.log(`Chart created: ${output}`);
