import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const API =
  "https://data-api.binance.vision";

const input =
  process.argv[2];

const output =
  process.argv[3];

const mode =
  process.argv[4] || "analysis";

if (!input || !output) {
  throw new Error(
    "Usage: node chart.mjs SYMBOL output.png mode"
  );
}

async function getJson(url) {
  const res =
    await fetch(url);

  if (!res.ok) {
    throw new Error(
      `${res.status} ${res.statusText}`
    );
  }

  return res.json();
}

function escapeXml(value) {
  return String(value)
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&apos;"
    );
}

function sma(
  values,
  period
) {
  return values.map(
    (_, i) => {
      if (
        i <
        period - 1
      ) {
        return null;
      }

      const slice =
        values.slice(
          i - period + 1,
          i + 1
        );

      return (
        slice.reduce(
          (a, b) =>
            a + b,
          0
        ) / period
      );
    }
  );
}

function ema(
  values,
  period
) {
  if (
    values.length <
    period
  ) {
    return [];
  }

  const k =
    2 /
    (period + 1);

  let result =
    values
      .slice(
        0,
        period
      )
      .reduce(
        (a, b) =>
          a + b,
        0
      ) /
    period;

  const output =
    Array(
      values.length
    ).fill(null);

  output[
    period - 1
  ] = result;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      values[i] * k +
      result *
        (1 - k);

    output[i] =
      result;
  }

  return output;
}

async function analysisChart() {
  const symbol =
    input;

  const data =
    await getJson(
      `${API}/api/v3/klines?symbol=${symbol}&interval=1h&limit=100`
    );

  const candles =
    data.map(k => ({
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5])
    }));

  const closes =
    candles.map(
      x => x.close
    );

  const ma20 =
    sma(
      closes,
      20
    );

  const ema20 =
    ema(
      closes,
      20
    );

  const ema50 =
    ema(
      closes,
      50
    );

  const width =
    1400;

  const height =
    850;

  const left =
    85;

  const right =
    80;

  const top =
    95;

  const bottom =
    105;

  const volumeHeight =
    130;

  const chartW =
    width -
    left -
    right;

  const chartH =
    height -
    top -
    bottom -
    volumeHeight;

  const high =
    Math.max(
      ...candles.map(
        x => x.high
      )
    );

  const low =
    Math.min(
      ...candles.map(
        x => x.low
      )
    );

  const range =
    high -
    low || 1;

  function y(price) {
    return (
      top +
      ((high - price) /
        range) *
        chartH
    );
  }

  const candleWidth =
    chartW /
    candles.length;

  let svg = `
<svg xmlns="http://www.w3.org/2000/svg"
width="${width}"
height="${height}"
viewBox="0 0 ${width} ${height}">

<rect
width="100%"
height="100%"
fill="#0b1217"/>

<rect
x="35"
y="30"
width="${width - 70}"
height="${height - 60}"
rx="24"
fill="#111c22"
stroke="#26343b"
stroke-width="2"/>

<text
x="75"
y="72"
fill="#ffffff"
font-size="34"
font-family="Arial"
font-weight="bold">
$${escapeXml(
    symbol.replace(
      "USDT",
      ""
    )
  )}/USDT
</text>

<text
x="75"
y="100"
fill="#89969d"
font-size="17"
font-family="Arial">
1H • 100 candles • Real Binance Spot market data
</text>
`;

  for (
    let i = 0;
    i <= 5;
    i++
  ) {
    const yy =
      top +
      (chartH / 5) *
        i;

    const value =
      high -
      (range / 5) *
        i;

    svg += `
<line
x1="${left}"
y1="${yy}"
x2="${width - right}"
y2="${yy}"
stroke="#26343b"
stroke-width="1"/>

<text
x="${width - right + 8}"
y="${yy + 5}"
fill="#8b989f"
font-size="15"
font-family="Arial">
${value < 1
        ? value.toFixed(5)
        : value.toFixed(2)}
</text>`;
  }

  candles.forEach(
    (c, i) => {
      const x =
        left +
        i *
          candleWidth +
        candleWidth /
          2;

      const bullish =
        c.close >=
        c.open;

      const fill =
        bullish
          ? "#18c784"
          : "#ea3943";

      const bodyTop =
        y(
          Math.max(
            c.open,
            c.close
          )
        );

      const bodyBottom =
        y(
          Math.min(
            c.open,
            c.close
          )
        );

      const bodyHeight =
        Math.max(
          2,
          bodyBottom -
            bodyTop
        );

      svg += `
<line
x1="${x}"
y1="${y(c.high)}"
x2="${x}"
y2="${y(c.low)}"
stroke="${fill}"
stroke-width="2"/>

<rect
x="${x -
        candleWidth *
          0.32}"
y="${bodyTop}"
width="${candleWidth *
        0.64}"
height="${bodyHeight}"
fill="${fill}"
rx="1"/>`;
    }
  );

  function pathFor(
    values
  ) {
    let p = "";

    values.forEach(
      (value, i) => {
        if (
          value ===
          null
        ) {
          return;
        }

        const x =
          left +
          i *
            candleWidth +
          candleWidth /
            2;

        const yy =
          y(value);

        p += p
          ? ` L ${x} ${yy}`
          : `M ${x} ${yy}`;
      }
    );

    return p;
  }

  svg += `
<path
d="${pathFor(
    ma20
  )}"
fill="none"
stroke="#f0b90b"
stroke-width="3"/>

<path
d="${pathFor(
    ema20
  )}"
fill="none"
stroke="#5aa9ff"
stroke-width="2"/>

<path
d="${pathFor(
    ema50
  )}"
fill="none"
stroke="#b56cff"
stroke-width="2"/>`;

  /*
   * Volume
   */
  const maxVolume =
    Math.max(
      ...candles.map(
        x => x.volume
      )
    );

  const volumeTop =
    height -
    bottom -
    volumeHeight;

  candles.forEach(
    (c, i) => {
      const x =
        left +
        i *
          candleWidth +
        candleWidth /
          2;

      const h =
        (c.volume /
          maxVolume) *
        volumeHeight;

      const bullish =
        c.close >=
        c.open;

      svg += `
<rect
x="${x -
        candleWidth *
          0.30}"
y="${volumeTop +
        volumeHeight -
        h}"
width="${candleWidth *
        0.60}"
height="${h}"
fill="${bullish
          ? "#18c784"
          : "#ea3943"}"
opacity="0.65"/>`;
    }
  );

  /*
   * Support / Resistance
   */
  const last20 =
    candles.slice(
      -20
    );

  const support =
    Math.min(
      ...last20.map(
        x => x.low
      )
    );

  const resistance =
    Math.max(
      ...last20.map(
        x => x.high
      )
    );

  svg += `
<line
x1="${left}"
y1="${y(support)}"
x2="${width - right}"
y2="${y(support)}"
stroke="#18c784"
stroke-width="2"
stroke-dasharray="8 7"/>

<text
x="${left + 10}"
y="${y(support) - 8}"
fill="#18c784"
font-size="17"
font-family="Arial">
Support
</text>

<line
x1="${left}"
y1="${y(resistance)}"
x2="${width - right}"
y2="${y(resistance)}"
stroke="#ea3943"
stroke-width="2"
stroke-dasharray="8 7"/>

<text
x="${left + 10}"
y="${y(resistance) - 8}"
fill="#ea3943"
font-size="17"
font-family="Arial">
Resistance
</text>

<text
x="${left}"
y="${height - 42}"
fill="#89969d"
font-size="16"
font-family="Arial">
Volume
</text>

<text
x="${width - right}"
y="${height - 42}"
fill="#f0b90b"
font-size="16"
text-anchor="end"
font-family="Arial">
SMA20
</text>

</svg>`;

  await sharp(
    Buffer.from(svg)
  )
    .png()
    .toFile(output);
}

async function educationChart() {
  const topic =
    input;

  const width =
    1400;

  const height =
    800;

  let title =
    "Crypto Education";

  let content = "";

  if (
    topic ===
    "rsi"
  ) {
    title =
      "RSI Momentum Guide";

    content = `
<line
x1="160"
y1="300"
x2="1240"
y2="300"
stroke="#ea3943"
stroke-width="5"/>

<line
x1="160"
y1="420"
x2="1240"
y2="420"
stroke="#f0b90b"
stroke-width="5"/>

<line
x1="160"
y1="540"
x2="1240"
y2="540"
stroke="#18c784"
stroke-width="5"/>

<text
x="180"
y="280"
fill="#ea3943"
font-size="30"
font-family="Arial"
font-weight="bold">
70+  Strong / Potentially Overextended
</text>

<text
x="180"
y="400"
fill="#f0b90b"
font-size="30"
font-family="Arial"
font-weight="bold">
50  Balanced Momentum
</text>

<text
x="180"
y="520"
fill="#18c784"
font-size="30"
font-family="Arial"
font-weight="bold">
30-  Weak / Potentially Oversold
</text>

<path
d="M180 590 C350 500 430 650 570 560 S780 400 900 490 S1080 620 1230 420"
fill="none"
stroke="#5aa9ff"
stroke-width="8"/>

<circle
cx="1230"
cy="420"
r="12"
fill="#5aa9ff"/>`;
  } else if (
    topic ===
    "breakout"
  ) {
    title =
      "Breakout Confirmation";

    content = `
<line
x1="180"
y1="450"
x2="1220"
y2="450"
stroke="#ea3943"
stroke-width="5"
stroke-dasharray="12 10"/>

<text
x="190"
y="430"
fill="#ea3943"
font-size="28"
font-family="Arial">
Resistance
</text>

<path
d="M180 620 L300 590 L390 610 L480 570 L560 590 L650 540 L730 450 L810 360 L890 390 L970 330"
fill="none"
stroke="#18c784"
stroke-width="9"/>

<path
d="M810 360 L870 430 L950 450"
fill="none"
stroke="#5aa9ff"
stroke-width="8"/>

<circle
cx="950"
cy="450"
r="14"
fill="#5aa9ff"/>

<text
x="800"
y="300"
fill="#18c784"
font-size="28"
font-family="Arial"
font-weight="bold">
Breakout
</text>

<text
x="880"
y="510"
fill="#5aa9ff"
font-size="28"
font-family="Arial">
Retest
</text>`;
  } else {
    title =
      "Candlestick Anatomy";

    content = `
<line
x1="700"
y1="180"
x2="700"
y2="620"
stroke="#18c784"
stroke-width="8"/>

<rect
x="620"
y="300"
width="160"
height="220"
rx="8"
fill="#18c784"/>

<line
x1="800"
y1="300"
x2="1080"
y2="300"
stroke="#89969d"
stroke-width="3"/>

<text
x="1100"
y="310"
fill="#ffffff"
font-size="28"
font-family="Arial">
Open / Close
</text>

<line
x1="800"
y1="180"
x2="1080"
y2="180"
stroke="#89969d"
stroke-width="3"/>

<text
x="1100"
y="190"
fill="#ffffff"
font-size="28"
font-family="Arial">
High
</text>

<line
x1="800"
y1="620"
x2="1080"
y2="620"
stroke="#89969d"
stroke-width="3"/>

<text
x="1100"
y="630"
fill="#ffffff"
font-size="28"
font-family="Arial">
Low
</text>`;
  }

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg"
width="${width}"
height="${height}"
viewBox="0 0 ${width} ${height}">

<rect
width="100%"
height="100%"
fill="#0b1217"/>

<rect
x="35"
y="30"
width="${width - 70}"
height="${height - 60}"
rx="24"
fill="#111c22"
stroke="#26343b"
stroke-width="2"/>

<text
x="85"
y="95"
fill="#ffffff"
font-size="42"
font-family="Arial"
font-weight="bold">
${escapeXml(title)}
</text>

${content}

<text
x="85"
y="735"
fill="#89969d"
font-size="18"
font-family="Arial">
Crypto education • Visual guide
</text>

</svg>`;

  await sharp(
    Buffer.from(svg)
  )
    .png()
    .toFile(output);
}

async function moversChart() {
  const movers =
    JSON.parse(
      input
    );

  const width =
    1400;

  const height =
    800;

  const max =
    Math.max(
      ...movers.map(
        x =>
          Math.abs(
            x.change
          )
      ),
      1
    );

  let bars = "";

  movers.forEach(
    (item, i) => {
      const y =
        170 +
        i * 105;

      const barWidth =
        Math.max(
          20,
          (Math.abs(
            item.change
          ) /
            max) *
            800
        );

      bars += `
<text
x="120"
y="${y + 35}"
fill="#ffffff"
font-size="30"
font-family="Arial"
font-weight="bold">
$${escapeXml(
        item.asset
      )}
</text>

<rect
x="300"
y="${y}"
width="${barWidth}"
height="55"
rx="8"
fill="${item.change >= 0
          ? "#18c784"
          : "#ea3943"}"/>

<text
x="${330 + barWidth}"
y="${y + 38}"
fill="${item.change >= 0
          ? "#18c784"
          : "#ea3943"}"
font-size="27"
font-family="Arial"
font-weight="bold">
${item.change >= 0 ? "+" : ""}${item.change.toFixed(2)}%
</text>`;
    }
  );

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg"
width="${width}"
height="${height}">

<rect
width="100%"
height="100%"
fill="#0b1217"/>

<rect
x="35"
y="30"
width="${width - 70}"
height="${height - 60}"
rx="24"
fill="#111c22"
stroke="#26343b"
stroke-width="2"/>

<text
x="85"
y="95"
fill="#ffffff"
font-size="42"
font-family="Arial"
font-weight="bold">
🔥 Binance Spot Top Movers
</text>

<text
x="85"
y="130"
fill="#89969d"
font-size="18"
font-family="Arial">
Real-time 24H market data
</text>

${bars}

</svg>`;

  await sharp(
    Buffer.from(svg)
  )
    .png()
    .toFile(output);
}

if (
  mode ===
  "analysis"
) {
  await analysisChart();
} else if (
  mode ===
  "education"
) {
  await educationChart();
} else if (
  mode ===
  "movers"
) {
  await moversChart();
}

fs.mkdirSync(
  path.dirname(output),
  {
    recursive: true
  }
);

console.log(
  `Image created: ${output}`
);
