import fs from "node:fs";
import sharp from "sharp";

const API = "https://data-api.binance.vision";

const WIDTH = 1400;
const HEIGHT = 850;
const ANALYSIS_HEIGHT = 940;

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "binance-square-bot/3.0"
    }
  });

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function getKlines(symbol) {
  const data = await getJson(
    `${API}/api/v3/klines?symbol=${symbol}&interval=4h&limit=100`
  );

  return data.map(k => ({
    time: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5])
  }));
}

function sma(values, period) {
  const result = [];

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    let sum = 0;

    for (let j = i - period + 1; j <= i; j++) {
      sum += values[j];
    }

    result.push(sum / period);
  }

  return result;
}

function ema(values, period) {
  const result = [];
  const multiplier = 2 / (period + 1);

  let previous = null;

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    if (previous === null) {
      let sum = 0;

      for (let j = i - period + 1; j <= i; j++) {
        sum += values[j];
      }

      previous = sum / period;
    } else {
      previous =
        (values[i] - previous) * multiplier +
        previous;
    }

    result.push(previous);
  }

  return result;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "$0";

  if (value >= 1000) {
    return `$${value.toLocaleString("en-US", {
      maximumFractionDigits: 2
    })}`;
  }

  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }

  if (value >= 0.01) {
    return `$${value.toFixed(4)}`;
  }

  return `$${value.toPrecision(5)}`;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return "0";

  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;

  return value.toFixed(2);
}

function linePath(points) {
  return points
    .filter(p => p)
    .map((p, i) =>
      `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`
    )
    .join(" ");
}

async function fetchCoinIcon(asset) {
  const symbol = asset.toLowerCase();
  const url = `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${symbol}.png`;

  try {
    const res = await fetch(url);

    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());

    return `data:image/png;base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

function coinBadgeSvg(asset, iconDataUri, cx, cy, r) {
  if (iconDataUri) {
    return `
      <defs>
        <clipPath id="coinIconClip">
          <circle cx="${cx}" cy="${cy}" r="${r}" />
        </clipPath>
      </defs>
      <image
        href="${iconDataUri}"
        x="${cx - r}"
        y="${cy - r}"
        width="${r * 2}"
        height="${r * 2}"
        clip-path="url(#coinIconClip)"
      />
      <circle
        cx="${cx}"
        cy="${cy}"
        r="${r}"
        fill="none"
        stroke="#F0B90B"
        stroke-width="2"
      />
    `;
  }

  /*
   * No public icon found for this ticker (common for
   * low-cap/obscure coins) — fall back to a lettered badge
   * instead of leaving a blank gap.
   */
  return `
    <circle
      cx="${cx}"
      cy="${cy}"
      r="${r}"
      fill="#2B3139"
      stroke="#F0B90B"
      stroke-width="2"
    />
    <text
      x="${cx}"
      y="${cy + 8}"
      text-anchor="middle"
      fill="#F0B90B"
      font-size="22"
      font-family="Arial"
      font-weight="bold"
    >
      ${escapeXml(asset.slice(0, 1))}
    </text>
  `;
}

function createAnalysisSvg(symbol, candles, iconDataUri) {
  const closes = candles.map(c => c.close);

  const sma20 = sma(closes, 20);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const highest = Math.max(...highs);
  const lowest = Math.min(...lows);

  const highestIndex = highs.indexOf(highest);
  const lowestIndex = lows.indexOf(lowest);

  const priceRange = highest - lowest;

  const padding = priceRange * 0.08;

  const maxPrice = highest + padding;
  const minPrice = Math.max(0, lowest - padding);

  /*
   * Chart area. Shifted down to make room for an
   * app-style header/stats panel above it.
   */
  const left = 80;
  const right = 1230;
  const top = 350;
  const bottom = 760;

  const chartWidth = right - left;
  const chartHeight = bottom - top;

  function x(i) {
    return (
      left +
      (i / (candles.length - 1)) *
        chartWidth
    );
  }

  function y(price) {
    return (
      bottom -
      ((price - minPrice) /
        (maxPrice - minPrice)) *
        chartHeight
    );
  }

  /*
   * Candlestick width.
   */
  const candleWidth =
    Math.max(
      4,
      (chartWidth / candles.length) * 0.62
    );

  let candlesSvg = "";

  candles.forEach((candle, i) => {
    const cx = x(i);

    const openY = y(candle.open);
    const closeY = y(candle.close);
    const highY = y(candle.high);
    const lowY = y(candle.low);

    const bullish =
      candle.close >= candle.open;

    const bodyTop = Math.min(
      openY,
      closeY
    );

    const bodyHeight = Math.max(
      2,
      Math.abs(closeY - openY)
    );

    const color = bullish
      ? "#0ECB81"
      : "#F6465D";

    candlesSvg += `
      <line
        x1="${cx}"
        y1="${highY}"
        x2="${cx}"
        y2="${lowY}"
        stroke="${color}"
        stroke-width="2"
      />

      <rect
        x="${cx - candleWidth / 2}"
        y="${bodyTop}"
        width="${candleWidth}"
        height="${bodyHeight}"
        fill="${color}"
        rx="1"
      />
    `;
  });

  /*
   * Moving-average lines.
   */
  const smaPoints = sma20
    .map((v, i) =>
      v === null
        ? null
        : {
            x: x(i),
            y: y(v)
          }
    );

  const ema20Points = ema20
    .map((v, i) =>
      v === null
        ? null
        : {
            x: x(i),
            y: y(v)
          }
    );

  const ema50Points = ema50
    .map((v, i) =>
      v === null
        ? null
        : {
            x: x(i),
            y: y(v)
          }
    );

  /*
   * Support / resistance.
   */
  const recent = candles.slice(-20);

  const support = Math.min(
    ...recent.map(c => c.low)
  );

  const resistance = Math.max(
    ...recent.map(c => c.high)
  );

  const supportY = y(support);
  const resistanceY = y(resistance);

  /*
   * Volume.
   */
  const volumeTop = 780;
  const volumeBottom = 860;

  const maxVolume = Math.max(
    ...candles.map(c => c.volume)
  );

  let volumeSvg = "";

  candles.forEach((candle, i) => {
    const cx = x(i);

    const height =
      (candle.volume / maxVolume) *
      (volumeBottom - volumeTop);

    const bullish =
      candle.close >= candle.open;

    const color = bullish
      ? "#0ECB81"
      : "#F6465D";

    volumeSvg += `
      <rect
        x="${cx - candleWidth / 2}"
        y="${volumeBottom - height}"
        width="${candleWidth}"
        height="${height}"
        fill="${color}"
        opacity="0.45"
      />
    `;
  });

  /*
   * Horizontal price grid.
   */
  let gridSvg = "";

  for (let i = 0; i <= 5; i++) {
    const price =
      maxPrice -
      ((maxPrice - minPrice) * i) / 5;

    const yy = y(price);

    gridSvg += `
      <line
        x1="${left}"
        y1="${yy}"
        x2="${right}"
        y2="${yy}"
        stroke="#2B3139"
        stroke-width="1"
      />

      <text
        x="${right + 10}"
        y="${yy + 5}"
        fill="#848E9C"
        font-size="15"
        font-family="Arial"
      >
        ${escapeXml(formatPrice(price))}
      </text>
    `;
  }

  /*
   * Peak / trough callouts, like the native app labels
   * the visible high and low on the price axis.
   */
  const peakLabelY = Math.max(top + 16, y(highest) - 12);
  const troughLabelY = Math.min(bottom - 6, y(lowest) + 20);

  const calloutSvg = `
    <text
      x="${x(highestIndex)}"
      y="${peakLabelY}"
      text-anchor="middle"
      fill="#F0F0F0"
      font-size="16"
      font-family="Arial"
      font-weight="bold"
    >
      ${escapeXml(formatPrice(highest))}
    </text>
    <text
      x="${x(lowestIndex)}"
      y="${troughLabelY}"
      text-anchor="middle"
      fill="#F0F0F0"
      font-size="16"
      font-family="Arial"
      font-weight="bold"
    >
      ${escapeXml(formatPrice(lowest))}
    </text>
  `;

  /*
   * Time labels.
   */
  let timeSvg = "";

  const indexes = [
    0,
    20,
    40,
    60,
    80,
    99
  ];

  indexes.forEach(i => {
    const date = new Date(
      candles[i].time
    );

    const label =
      `${String(date.getUTCDate()).padStart(2, "0")}/` +
      `${String(date.getUTCMonth() + 1).padStart(2, "0")} ` +
      `${String(date.getUTCHours()).padStart(2, "0")}:00`;

    timeSvg += `
      <text
        x="${x(i)}"
        y="880"
        text-anchor="middle"
        fill="#848E9C"
        font-size="16"
        font-family="Arial"
      >
        ${label}
      </text>
    `;
  });

  const last = candles.at(-1);

  /*
   * "24H" stats computed from the last 6 candles of this
   * same 4H series (6 x 4h = 24h) — real values from the
   * data already fetched, not a separate API call.
   */
  const last24h = candles.slice(-6);
  const openStart24h = last24h[0].open;

  const high24h = Math.max(...last24h.map(c => c.high));
  const low24h = Math.min(...last24h.map(c => c.low));
  const volAsset24h = last24h.reduce((sum, c) => sum + c.volume, 0);
  const volUsdt24h = last24h.reduce(
    (sum, c) => sum + c.volume * c.close,
    0
  );

  const change =
    ((last.close - openStart24h) / openStart24h) * 100;

  const changeText =
    `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;

  const changeColor =
    change >= 0
      ? "#0ECB81"
      : "#F6465D";

  const tagLabel = change >= 0 ? "Gainer" : "Loser";

  const titleSymbol =
    symbol.replace("USDT", "");

  const currentPriceY = y(last.close);

  return `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${WIDTH}"
  height="${ANALYSIS_HEIGHT}"
  viewBox="0 0 ${WIDTH} ${ANALYSIS_HEIGHT}"
>
  <rect
    width="${WIDTH}"
    height="${ANALYSIS_HEIGHT}"
    fill="#0B0E11"
  />

  <!-- Fake app tab row -->
  <text x="60" y="30" fill="#F0F0F0" font-size="17" font-family="Arial" font-weight="bold">Price</text>
  <rect x="60" y="38" width="38" height="3" fill="#F0B90B" />
  <text x="130" y="30" fill="#848E9C" font-size="17" font-family="Arial">Info</text>
  <text x="190" y="30" fill="#848E9C" font-size="17" font-family="Arial">Data</text>
  <text x="255" y="30" fill="#848E9C" font-size="17" font-family="Arial">Square</text>
  <text x="335" y="30" fill="#848E9C" font-size="17" font-family="Arial">Trade-X</text>
  <line x1="0" y1="52" x2="${WIDTH}" y2="52" stroke="#1E2329" stroke-width="1" />

  <!-- Coin row -->
  ${coinBadgeSvg(titleSymbol, iconDataUri, 78, 100, 30)}

  <text x="122" y="92" fill="#F0F0F0" font-size="30" font-family="Arial" font-weight="bold">
    ${escapeXml(titleSymbol)}/USDT
  </text>

  <text x="122" y="120" fill="#848E9C" font-size="18" font-family="Arial">
    Binance Spot
  </text>

  <!-- Big price -->
  <text x="60" y="205" fill="${changeColor}" font-size="56" font-family="Arial" font-weight="bold">
    ${escapeXml(formatPrice(last.close))}
  </text>

  <text x="60" y="236" fill="${changeColor}" font-size="22" font-family="Arial" font-weight="bold">
    ${changeText}
  </text>

  <rect x="60" y="248" width="92" height="30" rx="6" fill="${changeColor}" opacity="0.15" />
  <text x="106" y="268" text-anchor="middle" fill="${changeColor}" font-size="16" font-family="Arial" font-weight="bold">
    ${tagLabel}
  </text>

  <!-- 24H stats panel -->
  <text x="950" y="150" fill="#848E9C" font-size="17" font-family="Arial">24H High</text>
  <text x="1360" y="150" text-anchor="end" fill="#F0F0F0" font-size="17" font-family="Arial" font-weight="bold">${escapeXml(formatPrice(high24h))}</text>

  <text x="950" y="180" fill="#848E9C" font-size="17" font-family="Arial">24H Low</text>
  <text x="1360" y="180" text-anchor="end" fill="#F0F0F0" font-size="17" font-family="Arial" font-weight="bold">${escapeXml(formatPrice(low24h))}</text>

  <text x="950" y="210" fill="#848E9C" font-size="17" font-family="Arial">24H Vol(${escapeXml(titleSymbol)})</text>
  <text x="1360" y="210" text-anchor="end" fill="#F0F0F0" font-size="17" font-family="Arial" font-weight="bold">${escapeXml(compactNumber(volAsset24h))}</text>

  <text x="950" y="240" fill="#848E9C" font-size="17" font-family="Arial">24H Vol(USDT)</text>
  <text x="1360" y="240" text-anchor="end" fill="#F0F0F0" font-size="17" font-family="Arial" font-weight="bold">${escapeXml(compactNumber(volUsdt24h))}</text>

  <!-- Timeframe tabs -->
  <text x="60" y="300" fill="#848E9C" font-size="17" font-family="Arial">Time</text>
  <text x="130" y="300" fill="#848E9C" font-size="17" font-family="Arial">15m</text>
  <text x="190" y="300" fill="#848E9C" font-size="17" font-family="Arial">1h</text>
  <text x="240" y="300" fill="#F0F0F0" font-size="17" font-family="Arial" font-weight="bold">4h</text>
  <rect x="235" y="308" width="24" height="3" fill="#F0B90B" />
  <text x="290" y="300" fill="#848E9C" font-size="17" font-family="Arial">1D</text>
  <text x="340" y="300" fill="#848E9C" font-size="17" font-family="Arial">More</text>

  <line x1="0" y1="330" x2="${WIDTH}" y2="330" stroke="#1E2329" stroke-width="1" />

  <!-- Watermark -->
  <text
    x="${(left + right) / 2}"
    y="${(top + bottom) / 2}"
    text-anchor="middle"
    fill="#F0F0F0"
    opacity="0.045"
    font-size="110"
    font-family="Arial"
    font-weight="bold"
  >
    BINANCE
  </text>

  <!-- Grid -->
  ${gridSvg}

  <!-- Candles -->
  ${candlesSvg}

  <!-- SMA20 -->
  <path
    d="${linePath(smaPoints)}"
    fill="none"
    stroke="#F0B90B"
    stroke-width="2"
  />

  <!-- EMA20 -->
  <path
    d="${linePath(ema20Points)}"
    fill="none"
    stroke="#8B5CF6"
    stroke-width="2"
  />

  <!-- EMA50 -->
  <path
    d="${linePath(ema50Points)}"
    fill="none"
    stroke="#3B82F6"
    stroke-width="2"
  />

  <!-- Support -->
  <line
    x1="${left}"
    y1="${supportY}"
    x2="${right}"
    y2="${supportY}"
    stroke="#0ECB81"
    stroke-width="2"
    stroke-dasharray="10 8"
    opacity="0.8"
  />

  <text
    x="${left + 10}"
    y="${supportY - 10}"
    fill="#0ECB81"
    font-size="16"
    font-family="Arial"
    font-weight="bold"
  >
    SUPPORT ${escapeXml(formatPrice(support))}
  </text>

  <!-- Resistance -->
  <line
    x1="${left}"
    y1="${resistanceY}"
    x2="${right}"
    y2="${resistanceY}"
    stroke="#F6465D"
    stroke-width="2"
    stroke-dasharray="10 8"
    opacity="0.8"
  />

  <text
    x="${left + 10}"
    y="${resistanceY - 10}"
    fill="#F6465D"
    font-size="16"
    font-family="Arial"
    font-weight="bold"
  >
    RESISTANCE ${escapeXml(formatPrice(resistance))}
  </text>

  <!-- Peak / trough callouts -->
  ${calloutSvg}

  <!-- Current-price dashed line + boxed label, like the app's live price marker -->
  <line
    x1="${x(candles.length - 1)}"
    y1="${currentPriceY}"
    x2="${right + 10}"
    y2="${currentPriceY}"
    stroke="#5E6673"
    stroke-width="1"
    stroke-dasharray="4 4"
  />
  <rect
    x="${right + 10}"
    y="${currentPriceY - 14}"
    width="140"
    height="28"
    rx="4"
    fill="${changeColor}"
  />
  <text
    x="${right + 80}"
    y="${currentPriceY + 5}"
    text-anchor="middle"
    fill="#0B0E11"
    font-size="16"
    font-family="Arial"
    font-weight="bold"
  >
    ${escapeXml(formatPrice(last.close))}
  </text>

  <!-- Volume -->
  <line
    x1="${left}"
    y1="${volumeTop}"
    x2="${right}"
    y2="${volumeTop}"
    stroke="#2B3139"
    stroke-width="1"
  />

  <text
    x="${left}"
    y="${volumeTop - 10}"
    fill="#848E9C"
    font-size="15"
    font-family="Arial"
  >
    VOLUME
  </text>

  ${volumeSvg}

  <!-- Time -->
  ${timeSvg}

  <!-- Legend -->
  <rect x="90" y="340" width="12" height="12" fill="#F0B90B" />
  <text x="108" y="350" fill="#848E9C" font-size="14" font-family="Arial">SMA20</text>

  <rect x="185" y="340" width="12" height="12" fill="#8B5CF6" />
  <text x="203" y="350" fill="#848E9C" font-size="14" font-family="Arial">EMA20</text>

  <rect x="280" y="340" width="12" height="12" fill="#3B82F6" />
  <text x="298" y="350" fill="#848E9C" font-size="14" font-family="Arial">EMA50</text>

  <!-- Footer -->
  <text
    x="60"
    y="900"
    fill="#5E6673"
    font-size="13"
    font-family="Arial"
  >
    Real Binance Spot market data \u2022 4-hour candles \u2022 stats independently computed, not an official Binance screenshot
  </text>

</svg>
`;
}


function createEducationSvg(topic) {
  const common = `
    <rect
      width="${WIDTH}"
      height="${HEIGHT}"
      fill="#0B0E11"
    />

    <text
      x="70"
      y="70"
      fill="#F0F0F0"
      font-size="34"
      font-family="Arial"
      font-weight="bold"
    >
      Binance Crypto Education
    </text>
  `;

  if (topic === "rsi") {
    return `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${WIDTH}"
  height="${HEIGHT}"
>
${common}

<text
  x="70"
  y="125"
  fill="#848E9C"
  font-size="22"
  font-family="Arial"
>
RSI — Relative Strength Index
</text>

<line x1="100" y1="250" x2="1300" y2="250"
  stroke="#F6465D" stroke-width="3"/>

<line x1="100" y1="425" x2="1300" y2="425"
  stroke="#848E9C" stroke-width="2"/>

<line x1="100" y1="600" x2="1300" y2="600"
  stroke="#0ECB81" stroke-width="3"/>

<text x="115" y="235"
  fill="#F6465D"
  font-size="26"
  font-family="Arial">
70 — Overbought zone
</text>

<text x="115" y="410"
  fill="#848E9C"
  font-size="26"
  font-family="Arial">
50 — Neutral zone
</text>

<text x="115" y="585"
  fill="#0ECB81"
  font-size="26"
  font-family="Arial">
30 — Oversold zone
</text>

<path
  d="
  M100 520
  C180 500 220 430 280 470
  C350 515 400 590 470 540
  C540 490 570 330 650 350
  C720 370 760 240 830 290
  C900 340 930 440 1000 400
  C1070 360 1100 250 1160 300
  C1210 340 1250 400 1300 370
  "
  fill="none"
  stroke="#F0B90B"
  stroke-width="6"
  stroke-linecap="round"
  stroke-linejoin="round"
/>

<text x="70" y="760"
  fill="#F0F0F0"
  font-size="23"
  font-family="Arial">
RSI is a momentum indicator. Always interpret it with trend,
support/resistance and volume.
</text>

</svg>
`;
  }

  if (topic === "breakout") {
    return `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${WIDTH}"
  height="${HEIGHT}"
>
${common}

<text
  x="70"
  y="125"
  fill="#848E9C"
  font-size="22"
  font-family="Arial"
>
Breakout + Retest
</text>

<line
  x1="150"
  y1="430"
  x2="1250"
  y2="430"
  stroke="#F6465D"
  stroke-width="5"
  stroke-dasharray="14 10"
/>

<text
  x="170"
  y="405"
  fill="#F6465D"
  font-size="25"
  font-family="Arial"
>
Resistance
</text>

<path
  d="
  M150 650
  L250 590
  L350 620
  L450 540
  L550 580
  L650 450
  L750 360
  L850 250
  L950 320
  L1050 430
  L1150 390
  L1250 300
  "
  fill="none"
  stroke="#0ECB81"
  stroke-width="7"
  stroke-linecap="round"
/>

<circle cx="650" cy="450" r="11"
  fill="#0ECB81"/>

<text
  x="580"
  y="500"
  fill="#0ECB81"
  font-size="24"
  font-family="Arial"
>
BREAKOUT
</text>

<circle cx="1050" cy="430" r="11"
  fill="#F0B90B"/>

<text
  x="960"
  y="480"
  fill="#F0B90B"
  font-size="24"
  font-family="Arial"
>
RETEST
</text>

<text
  x="70"
  y="760"
  fill="#F0F0F0"
  font-size="23"
  font-family="Arial"
>
A stronger breakout is generally supported by a convincing close
and increased volume. A retest can provide additional confirmation.
</text>

</svg>
`;
  }

  return `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${WIDTH}"
  height="${HEIGHT}"
>
${common}

<text
  x="70"
  y="125"
  fill="#848E9C"
  font-size="22"
  font-family="Arial"
>
Candlestick Anatomy
</text>

<!-- Wick -->
<line
  x1="700"
  y1="200"
  x2="700"
  y2="650"
  stroke="#F0F0F0"
  stroke-width="6"
/>

<!-- Candle -->
<rect
  x="620"
  y="330"
  width="160"
  height="210"
  fill="#0ECB81"
  rx="4"
/>

<text
  x="820"
  y="225"
  fill="#F0F0F0"
  font-size="25"
  font-family="Arial"
>
HIGH
</text>

<line
  x1="790"
  y1="210"
  x2="760"
  y2="210"
  stroke="#848E9C"
  stroke-width="2"
/>

<text
  x="820"
  y="350"
  fill="#0ECB81"
  font-size="25"
  font-family="Arial"
>
CLOSE
</text>

<text
  x="820"
  y="525"
  fill="#0ECB81"
  font-size="25"
  font-family="Arial"
>
OPEN
</text>

<text
  x="820"
  y="665"
  fill="#F0F0F0"
  font-size="25"
  font-family="Arial"
>
LOW
</text>

<text
  x="70"
  y="760"
  fill="#F0F0F0"
  font-size="23"
  font-family="Arial"
>
The candle body shows open and close.
The wicks show the highest and lowest traded prices.
</text>

</svg>
`;
}

function createMoversSvg(movers) {
  const max =
    Math.max(
      ...movers.map(x =>
        Math.abs(Number(x.change))
      ),
      1
    );

  let bars = "";

  movers.forEach((coin, i) => {
    const value = Number(
      coin.change
    );

    const y = 180 + i * 110;

    const width =
      Math.abs(value) / max * 850;

    const positive = value >= 0;

    const x = positive
      ? 400
      : 400 - width;

    const color = positive
      ? "#0ECB81"
      : "#F6465D";

    bars += `
      <text
        x="80"
        y="${y + 38}"
        fill="#F0F0F0"
        font-size="25"
        font-family="Arial"
        font-weight="bold"
      >
        $${escapeXml(coin.asset)}
      </text>

      <rect
        x="${x}"
        y="${y}"
        width="${width}"
        height="55"
        fill="${color}"
        rx="5"
      />

      <text
        x="${positive ? x + width + 15 : x - 15}"
        y="${y + 37}"
        text-anchor="${positive ? "start" : "end"}"
        fill="${color}"
        font-size="24"
        font-family="Arial"
        font-weight="bold"
      >
        ${value >= 0 ? "+" : ""}${value.toFixed(2)}%
      </text>
    `;
  });

  return `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${WIDTH}"
  height="${HEIGHT}"
>
  <rect
    width="${WIDTH}"
    height="${HEIGHT}"
    fill="#0B0E11"
  />

  <text
    x="70"
    y="70"
    fill="#F0F0F0"
    font-size="34"
    font-family="Arial"
    font-weight="bold"
  >
    Binance Spot — Top Movers
  </text>

  <text
    x="70"
    y="115"
    fill="#848E9C"
    font-size="21"
    font-family="Arial"
  >
    Current 24H price movement
  </text>

  <line
    x1="400"
    y1="150"
    x2="400"
    y2="700"
    stroke="#2B3139"
    stroke-width="2"
  />

  ${bars}

  <text
    x="70"
    y="790"
    fill="#5E6673"
    font-size="16"
    font-family="Arial"
  >
    Real Binance Spot market data
  </text>
</svg>
`;
}

async function saveSvgAsPng(svg, output) {
  await sharp(
    Buffer.from(svg)
  )
    .png()
    .toFile(output);
}

async function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  const mode = process.argv[4];

  if (!input || !output || !mode) {
    throw new Error(
      "Usage: node bot/chart.mjs <input> <output> <mode>"
    );
  }

  fs.mkdirSync(
    output.substring(
      0,
      output.lastIndexOf("/")
    ) || ".",
    { recursive: true }
  );

  if (mode === "analysis") {
    const symbol = input;

    console.log(
      `Creating 4H Binance chart for ${symbol}...`
    );

    const candles =
      await getKlines(symbol);

    if (candles.length < 50) {
      throw new Error(
        "Not enough Binance candle data."
      );
    }

    const asset = symbol.replace("USDT", "");
    const iconDataUri = await fetchCoinIcon(asset);

    const svg =
      createAnalysisSvg(
        symbol,
        candles,
        iconDataUri
      );

    await saveSvgAsPng(
      svg,
      output
    );

    console.log(
      `4H chart created: ${output}`
    );

    return;
  }

  if (mode === "education") {
    const svg =
      createEducationSvg(input);

    await saveSvgAsPng(
      svg,
      output
    );

    console.log(
      `Education image created: ${output}`
    );

    return;
  }

  if (mode === "movers") {
    const movers =
      JSON.parse(input);

    const svg =
      createMoversSvg(
        movers
      );

    await saveSvgAsPng(
      svg,
      output
    );

    console.log(
      `Movers image created: ${output}`
    );

    return;
  }

  throw new Error(
    `Unknown chart mode: ${mode}`
  );
}

main().catch(err => {
  console.error(
    "Chart error:",
    err
  );

  process.exit(1);
});
