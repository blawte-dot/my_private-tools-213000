import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const API = "https://data-api.binance.vision";

const symbol = process.argv[2];
const output = process.argv[3];

if (!symbol || !output) {
  throw new Error("Usage: node chart.mjs BTCUSDT output.png");
}

async function getJson(url) {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }

  return res.json();
}

function sma(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;

    const slice = values.slice(i - period + 1, i + 1);

    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

const data = await getJson(
  `${API}/api/v3/klines?symbol=${symbol}&interval=1h&limit=72`
);

const candles = data.map(k => ({
  open: Number(k[1]),
  high: Number(k[2]),
  low: Number(k[3]),
  close: Number(k[4])
}));

const closes = candles.map(x => x.close);
const ma = sma(closes, 20);

const width = 1400;
const height = 800;

const left = 80;
const right = 40;
const top = 70;
const bottom = 100;

const chartW = width - left - right;
const chartH = height - top - bottom;

const high = Math.max(...candles.map(x => x.high));
const low = Math.min(...candles.map(x => x.low));

const range = high - low || 1;

function y(price) {
  return top + ((high - price) / range) * chartH;
}

const candleWidth = chartW / candles.length;

let svg = `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}"
     height="${height}"
     viewBox="0 0 ${width} ${height}">

<rect width="100%" height="100%" fill="#111827"/>

<text x="80" y="42"
      fill="#ffffff"
      font-size="30"
      font-family="Arial"
      font-weight="bold">
$${symbol.replace("USDT", "")} • 1H Technical Chart
</text>

<text x="80" y="70"
      fill="#9ca3af"
      font-size="16"
      font-family="Arial">
Binance Spot • 72 hours • SMA20
</text>
`;

for (let i = 0; i <= 5; i++) {
  const yy = top + (chartH / 5) * i;

  svg += `
  <line
    x1="${left}"
    y1="${yy}"
    x2="${width - right}"
    y2="${yy}"
    stroke="#374151"
    stroke-width="1"
  />
  `;

  const value = high - (range / 5) * i;

  svg += `
  <text
    x="${width - right - 5}"
    y="${yy - 8}"
    fill="#9ca3af"
    font-size="14"
    text-anchor="end"
    font-family="Arial">
    ${value.toFixed(value < 1 ? 5 : 2)}
  </text>
  `;
}

candles.forEach((c, i) => {
  const x = left + i * candleWidth + candleWidth / 2;

  const bullish = c.close >= c.open;

  const bodyTop = y(Math.max(c.open, c.close));
  const bodyBottom = y(Math.min(c.open, c.close));

  const bodyHeight = Math.max(2, bodyBottom - bodyTop);

  const wickTop = y(c.high);
  const wickBottom = y(c.low);

  const fill = bullish ? "#22c55e" : "#ef4444";

  svg += `
  <line
    x1="${x}"
    y1="${wickTop}"
    x2="${x}"
    y2="${wickBottom}"
    stroke="${fill}"
    stroke-width="2"
  />

  <rect
    x="${x - candleWidth * 0.32}"
    y="${bodyTop}"
    width="${candleWidth * 0.64}"
    height="${bodyHeight}"
    fill="${fill}"
    rx="2"
  />
  `;
});

let maPath = "";

ma.forEach((value, i) => {
  if (value === null) return;

  const x = left + i * candleWidth + candleWidth / 2;
  const yy = y(value);

  maPath += maPath
    ? ` L ${x} ${yy}`
    : `M ${x} ${yy}`;
});

svg += `
<path
  d="${maPath}"
  fill="none"
  stroke="#facc15"
  stroke-width="4"
/>

<line
  x1="${left}"
  y1="${height - bottom}"
  x2="${width - right}"
  y2="${height - bottom}"
  stroke="#6b7280"
  stroke-width="2"
/>

<text
  x="${left}"
  y="${height - 45}"
  fill="#9ca3af"
  font-size="15"
  font-family="Arial">
Real Binance market data
</text>

<text
  x="${width - right}"
  y="${height - 45}"
  fill="#facc15"
  font-size="15"
  text-anchor="end"
  font-family="Arial">
SMA20
</text>

</svg>
`;

fs.mkdirSync(path.dirname(output), { recursive: true });

await sharp(Buffer.from(svg))
  .png()
  .toFile(output);

console.log(`Chart created: ${output}`);
