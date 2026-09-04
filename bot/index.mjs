import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const API = "https://data-api.binance.vision";
const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";

const ROOT = process.cwd();

const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const IMAGE_FILE = path.join(ROOT, "bot", "post-image.png");

const SLOT_MS = 25 * 60 * 1000;

async function getJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "binance-square-bot/2.0"
        }
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

async function downloadImage(url, output) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return false;
  }

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; BinanceSquareBot/2.0)"
      }
    });

    if (!res.ok) {
      throw new Error(`Image ${res.status}`);
    }

    const contentType =
      res.headers.get("content-type") || "";

    if (!contentType.startsWith("image/")) {
      throw new Error("URL is not an image");
    }

    const buffer = Buffer.from(
      await res.arrayBuffer()
    );

    await sharp(buffer)
      .resize(1400, 800, {
        fit: "cover",
        position: "attention"
      })
      .jpeg({
        quality: 90
      })
      .toFile(output);

    return true;
  } catch (err) {
    console.log(
      "News image download failed:",
      err.message
    );

    return false;
  }
}

function money(v) {
  const n = Number(v);

  if (!Number.isFinite(n)) return "$0";

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

  if (n >= 1e9) {
    return `$${(n / 1e9).toFixed(2)}B`;
  }

  if (n >= 1e6) {
    return `$${(n / 1e6).toFixed(1)}M`;
  }

  if (n >= 1e3) {
    return `$${(n / 1e3).toFixed(1)}K`;
  }

  return `$${n.toFixed(0)}`;
}

function sma(values, period) {
  if (values.length < period) return null;

  const slice = values.slice(-period);

  return (
    slice.reduce((a, b) => a + b, 0) /
    period
  );
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] - values[i - 1];

    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);

    avgGain =
      ((avgGain * (period - 1)) + gain) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) /
      period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function loadHistory() {
  fs.mkdirSync(
    path.dirname(HISTORY_FILE),
    { recursive: true }
  );

  if (!fs.existsSync(HISTORY_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(
        HISTORY_FILE,
        "utf8"
      )
    );

    return Array.isArray(data)
      ? data
      : [];
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
    JSON.stringify(
      history.slice(-1000),
      null,
      2
    )
  );
}

async function getSpotCoins() {
  const [exchangeInfo, tickers] =
    await Promise.all([
      getJson(
        `${API}/api/v3/exchangeInfo?permissions=SPOT`
      ),
      getJson(
        `${API}/api/v3/ticker/24hr`
      )
    ]);

  const tradingSymbols =
    new Set(
      exchangeInfo.symbols
        .filter(s =>
          s.status === "TRADING" &&
          s.quoteAsset === "USDT" &&
          s.isSpotTradingAllowed === true
        )
        .map(s => s.symbol)
    );

  return tickers
    .filter(t =>
      tradingSymbols.has(t.symbol) &&
      t.symbol.endsWith("USDT") &&
      !/(UP|DOWN|BULL|BEAR)USDT$/.test(
        t.symbol
      ) &&
      Number(t.quoteVolume) >= 5_000_000
    )
    .map(t => ({
      symbol: t.symbol,
      asset: t.symbol.replace(
        "USDT",
        ""
      ),
      price: Number(t.lastPrice),
      change: Number(
        t.priceChangePercent
      ),
      volume: Number(t.quoteVolume),
      high: Number(t.highPrice),
      low: Number(t.lowPrice)
    }));
}

function chooseCoin(coins, history) {
  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  const usedToday =
    new Set(
      history
        .filter(x =>
          x.date === today &&
          x.type === "analysis"
        )
        .map(x => x.asset)
    );

  const candidates =
    coins
      .filter(c =>
        !usedToday.has(c.asset)
      )
      .sort((a, b) => {
        const scoreA =
          Math.max(a.change, 0) *
          Math.log10(
            Math.max(a.volume, 1)
          );

        const scoreB =
          Math.max(b.change, 0) *
          Math.log10(
            Math.max(b.volume, 1)
          );

        return scoreB - scoreA;
      });

  return (
    candidates[0] ||
    [...coins].sort(
      (a, b) =>
        b.change - a.change
    )[0]
  );
}

async function getKlines(
  symbol,
  interval = "1h",
  limit = 100
) {
  const data = await getJson(
    `${API}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
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

function analysisText(
  coin,
  candles
) {
  const closes =
    candles.map(x => x.close);

  const price =
    closes.at(-1);

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const sma20 =
    sma(closes, 20);

  const sma50 =
    sma(closes, 50);

  const rsi14 =
    rsi(closes, 14);

  const high72 =
    Math.max(
      ...candles.map(
        x => x.high
      )
    );

  const low72 =
    Math.min(
      ...candles.map(
        x => x.low
      )
    );

  const last20 =
    candles.slice(-20);

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

  let trend = "NEUTRAL";

  if (
    price > ema20 &&
    ema20 > ema50
  ) {
    trend = "BULLISH";
  } else if (
    price < ema20 &&
    ema20 < ema50
  ) {
    trend = "BEARISH";
  }

  let momentum = "Neutral";

  if (rsi14 >= 60) {
    momentum = "Strong";
  } else if (rsi14 >= 52) {
    momentum = "Positive";
  } else if (rsi14 <= 40) {
    momentum = "Weak";
  } else if (rsi14 <= 48) {
    momentum = "Negative";
  }

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
    coin.change >= 0
      ? "🟢"
      : "🔴";

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
🟢 Support: ${money(support)}
🟢 72H Low: ${money(low72)}
🔴 Resistance: ${money(resistance)}
🔴 72H High: ${money(high72)}

👀 Watch the reaction between ${money(support)} and ${money(resistance)}.

🐂 Bullish Scenario
A breakout above ${money(resistance)} with stronger volume could improve the short-term structure. 🚀

🐻 Bearish Scenario
A break below ${money(support)} could increase selling pressure. ⚠️

🧠 Market analysis only — not financial advice.

🤔 What level are you watching for $${coin.asset}?

#Crypto #Binance #${coin.asset} #TechnicalAnalysis`;
}

function topMoversPost(coins) {
  const movers =
    [...coins]
      .sort(
        (a, b) =>
          b.change - a.change
      )
      .slice(0, 5);

  const lines =
    movers.map(
      (c, i) =>
        `${i + 1}. ${c.change >= 0 ? "🟢" : "🔴"} $${c.asset} ${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}%`
    );

  const lead = movers[0];

  return `🔥 Binance Spot — Top Movers

📈 Strongest movers right now:

${lines.join("\n")}

📊 These moves should be evaluated with volume and liquidity, not percentage change alone.

⚡ Leading mover: $${lead.asset} ${lead.change >= 0 ? "+" : ""}${lead.change.toFixed(2)}%

👀 Which mover has the most interesting setup?

🤔 Which one are you watching?

#Crypto #Binance #Altcoins #MarketUpdate`;
}

function educationPost(topic) {
  if (topic === "rsi") {
    return `📚 Crypto Education — RSI

⚡ RSI helps measure momentum.

🟢 Above 70: strong momentum / potentially overextended
🟡 Around 50: balanced momentum
🔴 Below 30: weak momentum / potentially oversold

📊 RSI should not be used alone.

🔎 Price structure, volume and trend can provide important confirmation.

👀 The key is context.

🤔 Do you use RSI with another indicator?

#CryptoEducation #Binance #RSI #TechnicalAnalysis`;
  }

  if (topic === "breakout") {
    return `📚 Crypto Education — Breakouts

🚀 A move above resistance is not automatically a confirmed breakout.

📊 Traders often watch:

🟢 Volume expansion
🟢 Candle close
🟢 Retest of resistance
⚡ Momentum
🔎 Higher-timeframe structure

⚠️ Weak volume can increase the chance of a false breakout.

🤔 What confirmation do you wait for?

#CryptoEducation #Binance #Trading #Breakout`;
  }

  return `📚 Crypto Education — Candlesticks

🟢 Bullish candle: buyers controlled the period.

🔴 Bearish candle: sellers controlled the period.

📍 The wick shows where price traded but failed to hold.

📊 Candle patterns become more useful when combined with:

🔎 Support/resistance
📈 Trend
⚡ Volume
👀 Higher-timeframe structure

🤔 Which candle pattern do you watch most?

#CryptoEducation #Binance #Candlesticks #Trading`;
}

async function getNews() {
  const queries = [
    `"bitcoin" OR "ethereum" OR "cryptocurrency" OR "crypto market"`,
    `"donald trump" AND (bitcoin OR crypto OR cryptocurrency)`,
    `"federal reserve" AND (bitcoin OR crypto OR cryptocurrency)`,
    `("bitcoin ETF" OR "ethereum ETF" OR "crypto ETF")`,
    `("interest rates" OR inflation) AND (bitcoin OR crypto)`
  ];

  const results = [];

  for (const query of queries) {
    try {
      const url =
        `${GDELT}?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=10&timespan=6h&sort=datedesc`;

      const data =
        await getJson(url);

      if (Array.isArray(data.articles)) {
        results.push(
          ...data.articles
        );
      }
    } catch (err) {
      console.log(
        "News search failed:",
        err.message
      );
    }
  }

  const blocked = [
    "war",
    "warfare",
    "missile",
    "military",
    "battle",
    "weapon",
    "airstrike",
    "invasion",
    "bombing"
  ];

  const filtered =
    results.filter(article => {
      const text =
        `${article.title || ""} ${article.url || ""}`
          .toLowerCase();

      return (
        article.socialimage &&
        !blocked.some(
          word =>
            text.includes(word)
        )
      );
    });

  const unique =
    new Map();

  for (const article of filtered) {
    const key =
      article.url ||
      article.title;

    if (!unique.has(key)) {
      unique.set(key, article);
    }
  }

  return [
    ...unique.values()
  ].slice(0, 30);
}

async function createNewsImage(
  article
) {
  const ok =
    await downloadImage(
      article.socialimage,
      IMAGE_FILE
    );

  if (!ok) {
    return null;
  }

  return IMAGE_FILE;
}

function createAnalysisChart(
  symbol
) {
  const chartPath =
    path.join(
      ROOT,
      "bot",
      "analysis-chart.png"
    );

  try {
    execFileSync(
      "node",
      [
        path.join(
          ROOT,
          "bot",
          "chart.mjs"
        ),
        symbol,
        chartPath,
        "analysis"
      ],
      {
        cwd: ROOT,
        stdio: "inherit"
      }
    );

    if (
      fs.existsSync(chartPath)
    ) {
      return chartPath;
    }
  } catch (err) {
    console.log(
      "Chart generation failed:",
      err.message
    );
  }

  return null;
}

function createEducationImage(
  topic
) {
  const imagePath =
    path.join(
      ROOT,
      "bot",
      "education.png"
    );

  try {
    execFileSync(
      "node",
      [
        path.join(
          ROOT,
          "bot",
          "chart.mjs"
        ),
        topic,
        imagePath,
        "education"
      ],
      {
        cwd: ROOT,
        stdio: "inherit"
      }
    );

    if (
      fs.existsSync(imagePath)
    ) {
      return imagePath;
    }
  } catch (err) {
    console.log(
      "Education image failed:",
      err.message
    );
  }

  return null;
}

function createMoversImage(
  coins
) {
  const imagePath =
    path.join(
      ROOT,
      "bot",
      "movers.png"
    );

  const movers =
    [...coins]
      .sort(
        (a, b) =>
          b.change - a.change
      )
      .slice(0, 5);

  try {
    execFileSync(
      "node",
      [
        path.join(
          ROOT,
          "bot",
          "chart.mjs"
        ),
        JSON.stringify(
          movers.map(
            x => ({
              asset: x.asset,
              change: x.change
            })
          )
        ),
        imagePath,
        "movers"
      ],
      {
        cwd: ROOT,
        stdio: "inherit"
      }
    );

    if (
      fs.existsSync(imagePath)
    ) {
      return imagePath;
    }
  } catch (err) {
    console.log(
      "Movers image failed:",
      err.message
    );
  }

  return null;
}

function findPoster() {
  const locations = [
    ".agents/skills/binance/square-post/scripts/post-image.mjs",
    "agent/skills/binance/square-post/scripts/post-image.mjs",
    ".agents/skills/square-post/scripts/post-image.mjs",
    "agent/skills/square-post/scripts/post-image.mjs"
  ];

  for (
    const location of locations
  ) {
    const full =
      path.join(
        ROOT,
        location
      );

    if (
      fs.existsSync(full)
    ) {
      return full;
    }
  }

  throw new Error(
    "Binance Square post-image.mjs was not found."
  );
}

function publish(
  text,
  imagePath
) {
  const poster =
    findPoster();

  if (
    !imagePath ||
    !fs.existsSync(imagePath)
  ) {
    throw new Error(
      "A valid image is required."
    );
  }

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

function cleanup() {
  const files = [
    IMAGE_FILE,
    path.join(
      ROOT,
      "bot",
      "analysis-chart.png"
    ),
    path.join(
      ROOT,
      "bot",
      "education.png"
    ),
    path.join(
      ROOT,
      "bot",
      "movers.png"
    )
  ];

  for (
    const file of files
  ) {
    if (
      fs.existsSync(file)
    ) {
      fs.unlinkSync(file);
    }
  }
}

async function main() {
  console.log(
    "================================"
  );
  console.log(
    "Binance Square Auto Bot 2.0"
  );
  console.log(
    "================================"
  );

  const history =
    loadHistory();

  const slot =
    Math.floor(
      Date.now() /
      SLOT_MS
    );

  if (
    history.some(
      x => x.slot === slot
    )
  ) {
    console.log(
      "This slot was already published."
    );
    return;
  }

  const coins =
    await getSpotCoins();

  if (!coins.length) {
    throw new Error(
      "No eligible Binance Spot USDT coins found."
    );
  }

  /*
   * 4 analysis slots + 1 other slot
   * = approximately 80% analysis.
   */
  const slotInCycle =
    ((slot % 5) + 5) % 5;

  let type;
  let text;
  let asset = null;
  let image = null;

  if (
    slotInCycle < 4
  ) {
    type = "analysis";

    const coin =
      chooseCoin(
        coins,
        history
      );

    asset =
      coin.asset;

    const candles =
      await getKlines(
        coin.symbol,
        "1h",
        100
      );

    text =
      analysisText(
        coin,
        candles
      );

    image =
      createAnalysisChart(
        coin.symbol
      );
  } else {
    type = "other";

    const cycle =
      Math.floor(
        slot / 5
      );

    /*
     * Other content rotation:
     * News → Movers → Education
     */
    const mode =
      cycle % 3;

    if (mode === 0) {
      const news =
        await getNews();

      if (news.length) {
        const article =
          news[0];

        text = `📰 Crypto News Update

🔎 ${article.title}

🌐 Source: ${article.domain || "News source"}

📊 This development may be relevant to crypto-market sentiment and should be considered alongside price action and volume.

👀 The market can react differently depending on the details and follow-up developments.

🤔 How do you think this could affect the crypto market?

#CryptoNews #Binance #Bitcoin #CryptoMarket`;

        image =
          await createNewsImage(
            article
          );
      }

      if (!text || !image) {
        text =
          topMoversPost(
            coins
          );

        image =
          createMoversImage(
            coins
          );
      }
    } else if (
      mode === 1
    ) {
      text =
        topMoversPost(
          coins
        );

      image =
        createMoversImage(
          coins
        );
    } else {
      const topics = [
        "candlesticks",
        "breakout",
        "rsi"
      ];

      const topic =
        topics[
          cycle % topics.length
        ];

      text =
        educationPost(
          topic
        );

      image =
        createEducationImage(
          topic
        );
    }
  }

  if (
    !image ||
    !fs.existsSync(image)
  ) {
    throw new Error(
      "Could not create a valid post image."
    );
  }

  publish(
    text,
    image
  );

  history.push({
    slot,
    date:
      new Date()
        .toISOString()
        .slice(0, 10),
    time:
      new Date().toISOString(),
    type,
    asset
  });

  saveHistory(
    history
  );

  cleanup();

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
