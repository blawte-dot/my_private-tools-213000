import fs from "fs";
import sharp from "sharp";

const symbol = process.argv[2];
const output = process.argv[3];

if (!symbol || !output) {
  throw new Error("Usage: node chart.mjs SYMBOL OUTPUT.png");
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

const data = await getKlines();
const closes = data.map(k => Number(k[4]));

const width = 1200;
const height = 675;
const left = 80;
const right = 50;
const top = 100;
const bottom = 80;

const min = Math.min(...closes);
const max = Math.max(...closes);
const padding = (max - min) * 0.08 || max * 0.02;

const low = min - padding;
const high = max + padding;

const x = i =>
  left + (i / (closes.length - 1)) * (width - left - right);

const y = price =>
  top + ((high - price) / (high - low)) *
  (height - top - bottom);

const points = closes
  .map((price, i) => `${x(i)},${y(price)}`)
  .join(" ");

const last = closes.at(-1);
const first = closes[0];

const change = ((last - first) / first) * 100;

const formatPrice = value => {
  if (value >= 1000) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toFixed(6);
};

const grid = [];

for (let i = 0; i <= 5; i++) {
  const price = high - ((high - low) / 5) * i;
  const yy = y(price);

  grid.push(`
    <line x1="${left}" y1="${yy}"
          x2="${width - right}" y2="${yy}"
          stroke="#30343b" />

    <text x="${width - right}" y="${yy - 8}"
          fill="#9ca3af"
          font-size="18"
          text-anchor="end"
          font-family="Arial">
      ${formatPrice(price)}
    </text>
  `);
}

const svg = `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}"
     height="${height}">

  <rect width="100%" height="100%" fill="#0b0e11"/>

  <text x="60" y="48"
        fill="#ffffff"
        font-size="30"
        font-weight="bold"
        font-family="Arial">
    $${symbol} — 48H MARKET ANALYSIS
  </text>

  <text x="60" y="78"
        fill="#9ca3af"
        font-size="18"
        font-family="Arial">
    Binance Spot • 1H candles
  </text>

  ${grid.join("")}

  <polyline
    points="${points}"
    fill="none"
   
