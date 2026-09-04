import fs from "node:fs";
import sharp from "sharp";

const BINANCE = "https://data-api.binance.vision";

const symbol = process.argv[2];
const output = process.argv[3];

if (!symbol || !output) {
  throw new Error(
    "Usage: node chart.mjs SYMBOL OUTPUT.png"
  );
}

async function get(url) {
  const r = await fetch(url);

  if (!r.ok) {
    throw new Error(`Binance API ${r.status}`);
  }

  return r.json();
}

const raw = await get(
  `${BINANCE}/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=72`
);

const candles = raw.map(k => ({
  open: Number(k[1]),
  high: Number(k[2]),
  low: Number(k[3]),
  close: Number(k[4])
}));

const width = 1500;
const height = 850;

const left = 90;
const right = 100;
const top = 90;
const bottom = 110;

const chartWidth = width - left - right;
const chartHeight = height - top - bottom;

const high = Math.max(...candles.map(x => x.high));
const low = Math.min(...candles.map(x => x.low));

const range = high - low || 1;

const x = i =>
  left +
  (i / (candles.length - 1)) *
  chartWidth;

const y = price =>
  top +
  ((high - price) / range) *
  chartHeight;

function sma(index, period) {
  if (index < period - 1) return null;

  let total = 0;

  for (
    let i = index - period + 1;
    i <= index;
    i++
  ) {
    total += candles[i].close;
  }

  return total / period;
}

let svg = `
<svg
xmlns="http://www.w3.org/2000/svg"
width="${width}"
height="${height}"
viewBox="0 0 ${width} ${height}">

<rect width="100%" height="100%" fill="#0b0e11"/>

<text
x="${left}"
y="45"
fill="#f0b90b"
font-family="Arial"
font-size="32"
font-weight="bold">
$${symbol} / USDT
</text>

<text
x="${left}"
y="75"
fill="#9aa4ad"
font-family="Arial"
font-size="17">
Binance Spot • 1H • 72 Candles
</text>
`;

for (let i = 0; i <= 6; i++) {
  const gy =
    top +
    (chartHeight / 6) * i;

  const value =
    high -
    (range / 6) * i;

  svg += `
<line
x1="${left}"
y1="${gy}"
x2="${width - right}"
y2="${gy}"
stroke="#24282d"
stroke-width="1"/>

<text
x="${width - right + 10}"
y="${gy + 5}"
fill="#7d8790"
font-family="Arial"
font-size="14">
${value.toPrecision(7)}
</text>
`;
}

const candleWidth =
  (chartWidth / candles.length) * 0.58;

for (let i = 0; i < candles.length; i++) {
  const c = candles[i];

  const cx = x(i);

  const bullish =
    c.close >= c.open;

  const candleColor =
    bullish ? "#0ecb81" : "#f6465d";

  const bodyTop =
    y(Math.max(c.open, c.close));

  const bodyBottom =
    y(Math.min(c.open, c.close));

  const bodyHeight =
    Math.max(2, bodyBottom - bodyTop);

  svg += `
<line
x1="${cx}"
y1="${y(c.high)}"
x2="${cx}"
y2="${y(c.low)}"
stroke="${candleColor}"
stroke-width="2"/>

<rect
x="${cx - candleWidth / 2}"
y="${bodyTop}"
width="${candleWidth}"
height="${bodyHeight}"
fill="${candleColor}"
rx="1"/>
`;
}

let smaPath = "";

for (let i = 0; i < candles.length; i++) {
  const value = sma(i, 20);

  if (value == null) continue;

  smaPath +=
    `${smaPath ? " L" : "M"} ${x(i)} ${y(value)}`;
}

svg += `
<path
d="${smaPath}"
fill="none"
stroke="#f0b90b"
stroke-width="3"/>

<text
x="${left}"
y="${height - 55}"
fill="#f0b90b"
font-family="Arial"
font-size="17">
SMA20
</text>

<text
x="${left + 100}"
y="${height - 55}"
fill="#cbd5e1"
font-family="Arial"
font-size="17">
Current: ${candles.at(-1).close.toPrecision(8)}
</text>

</svg>
`;

fs.mkdirSync(
  new URL(
    "./",
    `file://${output}`
  ).pathname,
  { recursive: true }
);

await sharp(
  Buffer.from(svg)
)
  .png()
  .toFile(output);

console.log(`Chart created: ${output}`);
