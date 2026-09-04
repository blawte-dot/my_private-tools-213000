import fs from "node:fs";
import sharp from "sharp";

const BINANCE = "https://data-api.binance.vision";

const symbol = process.argv[2];
const output = process.argv[3];

if (!symbol || !output) {
  console.error("Usage: node chart.mjs SYMBOL OUTPUT.png");
  process.exit(1);
}

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const data = await get(
  `${BINANCE}/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=48`
);

const candles = data.map(k => ({
  open: Number(k[1]),
  high: Number(k[2]),
  low: Number(k[3]),
  close: Number(k[4])
}));

const width = 1400;
const height = 800;
const left = 80;
const right = 40;
const top = 80;
const bottom = 100;

const chartW = width - left - right;
const chartH = height - top - bottom;

const highs = candles.map(x => x.high);
const lows = candles.map(x => x.low);

const max = Math.max(...highs);
const min = Math.min(...lows);
const range = max - min || 1;

const x = i => left + (i / (candles.length - 1)) * chartW;
const y = p => top + ((max - p) / range) * chartH;

const bodyW = Math.max(8, chartW / candles.length * 0.55);

function sma(i, period) {
  if (i < period - 1) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    sum += candles[j].close;
  }
  return sum / period;
}

let svg = `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}" height="${height}"
     viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#0b0e11"/>

<text x="${left}" y="42"
      fill="#f0b90b"
      font-size="30"
      font-family="Arial"
      font-weight="bold">$${symbol} / USDT — 48H</text>

<text x="${left}" y="70"
      fill="#9aa4ad"
      font-size="16"
      font-family="Arial">Binance Spot • 1H Candles</text>
`;

for (let i = 0; i <= 5; i++) {
  const gy = top + (chartH / 5) * i;
  const value = max - (range / 5) * i;

  svg += `
  <line x1="${left}" y1="${gy}" x2="${width - right}" y2="${gy}"
        stroke="#252a30" stroke-width="1"/>
  <text x="${width - right + 5}" y="${gy + 5}"
        fill="#7d8790" font-size="14" font-family="Arial">
        ${value.toPrecision(6)}
  </text>`;
}

for (let i = 0; i < candles.length; i++) {
  const c = candles[i];
  const cx = x(i);

  const up = c.close >= c.open;
  const bodyTop = y(Math.max(c.open, c.close));
  const bodyBottom = y(Math.min(c.open, c.close));
  const bodyHeight = Math.max(2, bodyBottom - bodyTop);

  svg += `
  <line x1="${cx}" y1="${y(c.high)}"
        x2="${cx}" y2="${y(c.low)}"
        stroke="${up ? "#0ecb81" : "#f6465d"}"
        stroke-width="2"/>

  <rect x="${cx - bodyW / 2}"
        y="${bodyTop}"
        width="${bodyW}"
        height="${bodyHeight}"
        fill="${up ? "#0ecb81" : "#f6465d"}"
        rx="1"/>`;
}

let smaPath = "";

for (let i = 0; i < candles.length; i++) {
  const s = sma(i, 20);
  if (s == null) continue;

  smaPath += `${smaPath ? " L" : "M"} ${x(i)} ${y(s)}`;
}

svg += `
<path d="${smaPath}"
      fill="none"
      stroke="#f0b90b"
      stroke-width="3"/>`;

const current = candles[candles.length - 1].close;

svg += `
<line x1="${left}" y1="${y(current)}"
      x2="${width - right}" y2="${y(current)}"
      stroke="#ffffff"
      stroke-width="1"
      stroke-dasharray="7 7"/>

<text x="${left}"
      y="${height - 45}"
      fill="#d1d5db"
      font-size="18"
      font-family="Arial">
Current: ${current.toPrecision(8)}
</text>

<text x="${width - 330}"
      y="${height - 45}"
      fill="#f0b90b"
      font-size="16"
      font-family="Arial">
Yellow = SMA20
</text>

</svg>`;

fs.mkdirSync(new URL(".", `file://${output}`).pathname, { recursive: true });

await sharp(Buffer.from(svg)).png().toFile(output);

console.log(`Chart created: ${output}`);
