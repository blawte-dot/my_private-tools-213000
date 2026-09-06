import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import sharp from "sharp";

const API = "https://data-api.binance.vision";
const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";

const ROOT = process.cwd();
const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const HEALTH_FILE = path.join(ROOT, "data", "health.json");
const IMAGE_FILE = path.join(ROOT, "bot", "post-image.png");

/*
 * Randomized 20-32 min window instead of a fixed 25 min.
 * A perfectly constant cadence is itself a bot fingerprint;
 * jitter makes the timing look human without changing the
 * intended ~25 min average.
 */
const MIN_POST_INTERVAL_MS = 20 * 60 * 1000;
const MAX_POST_INTERVAL_MS = 32 * 60 * 1000;
const HISTORY_MAX_RECORDS = 500;

function randomPostIntervalMs() {
  return (
    MIN_POST_INTERVAL_MS +
    Math.random() *
      (MAX_POST_INTERVAL_MS - MIN_POST_INTERVAL_MS)
  );
}

async function getJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "binance-square-bot/3.0"
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
          "Mozilla/5.0 (compatible; BinanceSquareBot/3.0)"
      }
    });

    if (!res.ok) {
      throw new Error(`Image ${res.status}`);
    }

    const type = res.headers.get("content-type") || "";

    if (!type.startsWith("image/")) {
      throw new Error("URL is not an image");
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    await sharp(buffer)
      .resize(1400, 800, {
        fit: "cover",
        position: "attention"
      })
      .jpeg({ quality: 90 })
      .toFile(output);

    return true;
  } catch (err) {
    console.log("Image download failed:", err.message);
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

  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;

  return `$${n.toFixed(0)}`;
}

function sma(values, period) {
  if (values.length < period) return null;

  const slice = values.slice(-period);

  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let result =
    values.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];

    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);

    avgGain =
      ((avgGain * (period - 1)) + gain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function loadHistory() {
  fs.mkdirSync(path.dirname(HISTORY_FILE), {
    recursive: true
  });

  if (!fs.existsSync(HISTORY_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(HISTORY_FILE, "utf8")
    );

    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), {
    recursive: true
  });

  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(
      history.slice(-HISTORY_MAX_RECORDS),
      null,
      2
    )
  );
}

/*
 * Lightweight health/monitoring file.
 * Kept separate from history so it stays tiny
 * and reflects the bot's operational status,
 * including failed attempts (which never enter
 * history, since history only records confirmed
 * successful publications).
 */
function loadHealth() {
  try {
    return JSON.parse(
      fs.readFileSync(HEALTH_FILE, "utf8")
    );
  } catch {
    return {
      lastSuccessfulPost: null,
      lastFailedAttempt: null,
      lastFailureReason: null,
      consecutiveFailures: 0
    };
  }
}

function saveHealth(health) {
  fs.mkdirSync(path.dirname(HEALTH_FILE), {
    recursive: true
  });

  fs.writeFileSync(
    HEALTH_FILE,
    JSON.stringify(health, null, 2)
  );
}

function recordSuccess(now) {
  const health = loadHealth();

  health.lastSuccessfulPost = now;
  health.lastFailedAttempt = null;
  health.lastFailureReason = null;
  health.consecutiveFailures = 0;
  health.nextExpectedPublish = new Date(
    new Date(now).getTime() +
      (MIN_POST_INTERVAL_MS + MAX_POST_INTERVAL_MS) / 2
  ).toISOString();

  saveHealth(health);
}

function recordFailure(err) {
  const health = loadHealth();
  const now = new Date().toISOString();

  health.lastFailedAttempt = now;
  health.lastFailureReason = String(
    err && err.message ? err.message : err
  ).slice(0, 300);
  health.consecutiveFailures =
    (health.consecutiveFailures || 0) + 1;

  saveHealth(health);
}

/*
 * Find the last SUCCESSFUL publication.
 */
function getLastPublished(history) {
  const published = history
    .filter(x => x && x.published === true && x.time)
    .sort(
      (a, b) =>
        new Date(b.time).getTime() -
        new Date(a.time).getTime()
    );

  return published[0] || null;
}

/*
 * 25-minute protection.
 *
 * The bot no longer depends on fixed time slots.
 * If GitHub runs late, the next available run can publish.
 */
function canPublish(history) {
  const last = getLastPublished(history);

  if (!last) {
    return {
      allowed: true,
      remaining: 0
    };
  }

  const lastTime = new Date(last.time).getTime();

  if (!Number.isFinite(lastTime)) {
    return {
      allowed: true,
      remaining: 0
    };
  }

  const elapsed = Date.now() - lastTime;
  const threshold = randomPostIntervalMs();

  if (elapsed >= threshold) {
    return {
      allowed: true,
      remaining: 0
    };
  }

  return {
    allowed: false,
    remaining: threshold - elapsed
  };
}

async function getSpotCoins() {
  const [exchangeInfo, tickers] = await Promise.all([
    getJson(
      `${API}/api/v3/exchangeInfo?permissions=SPOT`
    ),
    getJson(`${API}/api/v3/ticker/24hr`)
  ]);

  const tradingSymbols = new Set(
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
      !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol) &&
      Number(t.quoteVolume) >= 5_000_000
    )
    .map(t => ({
      symbol: t.symbol,
      asset: t.symbol.replace("USDT", ""),
      price: Number(t.lastPrice),
      change: Number(t.priceChangePercent),
      volume: Number(t.quoteVolume),
      high: Number(t.highPrice),
      low: Number(t.lowPrice)
    }));
}

function chooseCoin(coins, history) {
  const today = new Date()
    .toISOString()
    .slice(0, 10);

  const usedToday = new Set(
    history
      .filter(x =>
        x.date === today &&
        x.type === "analysis" &&
        x.asset
      )
      .map(x => x.asset)
  );

  const candidates = coins
    .filter(c => !usedToday.has(c.asset))
    .sort((a, b) => {
      const scoreA =
        Math.max(a.change, 0) *
        Math.log10(Math.max(a.volume, 1));

      const scoreB =
        Math.max(b.change, 0) *
        Math.log10(Math.max(b.volume, 1));

      return scoreB - scoreA;
    });

  return (
    candidates[0] ||
    [...coins].sort(
      (a, b) => b.change - a.change
    )[0]
  );
}

/*
 * IMPORTANT:
 * Technical analysis is now 4H.
 */
async function getKlines(
  symbol,
  interval = "4h",
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

function analysisText(coin, candles, angle) {
  const closes = candles.map(x => x.close);

  const price = closes.at(-1);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);

  const rsi14 = rsi(closes, 14);

  const high100 = Math.max(
    ...candles.map(x => x.high)
  );

  const low100 = Math.min(
    ...candles.map(x => x.low)
  );

  const last20 = candles.slice(-20);

  const support = Math.min(
    ...last20.map(x => x.low)
  );

  const resistance = Math.max(
    ...last20.map(x => x.high)
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

  /*
   * Volume trend: recent 5 candles vs the prior 15 — used
   * only to decide whether to call out a conflict, not to
   * force a single direction.
   */
  const recentVol =
    candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;

  const priorVol =
    candles.slice(-20, -5).reduce((s, c) => s + c.volume, 0) / 15;

  const volumeTrend =
    recentVol > priorVol * 1.15
      ? "rising"
      : recentVol < priorVol * 0.85
        ? "fading"
        : "steady";

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
      : momentum === "Weak" ||
        momentum === "Negative"
        ? "📉"
        : "🟡";

  const changeEmoji =
    coin.change >= 0 ? "🟢" : "🔴";

  /*
   * When trend and momentum genuinely disagree, say so
   * explicitly instead of forcing a single clean narrative —
   * a real analyst would flag this rather than paper over it.
   */
  const conflict =
    (trend === "BULLISH" &&
      (momentum === "Weak" || momentum === "Negative")) ||
    (trend === "BEARISH" &&
      (momentum === "Strong" || momentum === "Positive"));

  const scenarioBlock = conflict
    ? `⚖️ Mixed Signal
Trend structure remains ${trend.toLowerCase()}, but RSI momentum is ${momentum.toLowerCase()} and volume is ${volumeTrend}, so the picture is mixed — continuation is possible, but conviction is lower and chasing this move carries more risk.`
    : `🐂 Bullish Scenario
A confirmed 4H close above ${money(resistance)} with stronger volume could improve the structure. 🚀

🐻 Bearish Scenario
A 4H close below ${money(support)} could increase selling pressure. ⚠️`;

  const levelsBlock = `📍 Key 4H Levels
🟢 Support: ${money(support)}
🟢 100-candle Low: ${money(low100)}
🔴 Resistance: ${money(resistance)}
🔴 100-candle High: ${money(high100)}`;

  const structureBlock = `🔎 4H Market Structure
${trendEmoji} Trend: ${trend}
${momentumEmoji} Momentum: ${momentum}
⚡ RSI(14): ${rsi14.toFixed(1)}
📊 Volume trend: ${volumeTrend}`;

  const maBlock = `📈 Moving Averages
• EMA20: ${money(ema20)}
• EMA50: ${money(ema50)}
• SMA20: ${money(sma20)}
• SMA50: ${money(sma50)}`;

  const footer = `🧠 Market analysis only — not financial advice.

🤔 What level are you watching for $${coin.asset}?

#Crypto #Binance #${coin.asset} #TechnicalAnalysis`;

  /*
   * Three structurally distinct openings/orderings, picked by
   * the caller based on recent history — not just different
   * numbers plugged into one fixed template every time.
   */
  if (angle === 1) {
    return `📍 $${coin.asset} is testing the ${money(resistance)} / ${money(support)} range on the 4H chart.

💰 Price: ${money(price)} (${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}% 24H)

${levelsBlock}

${structureBlock}

${maBlock}

${scenarioBlock}

${footer}`;
  }

  if (angle === 2) {
    return `🤔 Is $${coin.asset} setting up for a move? Here's what the 4H chart shows.

${structureBlock}
📊 24H Volume: ${compact(coin.volume)}

${maBlock}

${levelsBlock}

${scenarioBlock}

🧠 Market analysis only — not financial advice.

#Crypto #Binance #${coin.asset} #TechnicalAnalysis`;
  }

  return `📊 $${coin.asset} — 4H Technical Analysis

💰 Price: ${money(price)}
${changeEmoji} 24H Change: ${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}%
📊 24H Volume: ${compact(coin.volume)}

${structureBlock}

${maBlock}

${levelsBlock}

👀 Watch the reaction between ${money(support)} and ${money(resistance)}.

${scenarioBlock}

${footer}`;
}

function topMoversPost(coins) {
  const movers = [...coins]
    .sort((a, b) => b.change - a.change)
    .slice(0, 5);

  const lines = movers.map(
    (c, i) =>
      `${i + 1}. ${c.change >= 0 ? "🟢" : "🔴"} $${c.asset} ${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}%`
  );

  const lead = movers[0];

  return `🔥 Binance Spot — Top Movers

📈 Strongest movers right now:

${lines.join("\n")}

📊 Percentage change should be evaluated with volume and liquidity, not alone.

⚡ Leading mover: $${lead.asset} ${lead.change >= 0 ? "+" : ""}${lead.change.toFixed(2)}%

👀 Which mover has the most interesting setup?

🤔 Which one are you watching?

#Crypto #Binance #Altcoins #MarketUpdate`;
}

function marketUpdatePost(coins) {
  const btc = coins.find(c => c.asset === "BTC");
  const eth = coins.find(c => c.asset === "ETH");

  const totalVolume = coins.reduce(
    (sum, c) => sum + c.volume,
    0
  );

  const advancing = coins.filter(
    c => c.change > 0
  ).length;

  const declining = coins.length - advancing;

  const bias =
    advancing > declining * 1.3
      ? "Broad-based buying pressure"
      : declining > advancing * 1.3
        ? "Broad-based selling pressure"
        : "Mixed, range-bound conditions";

  const lines = [btc, eth]
    .filter(Boolean)
    .map(
      c =>
        `${c.change >= 0 ? "🟢" : "🔴"} $${c.asset}: ${money(c.price)} (${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}%)`
    );

  return `🌐 Crypto Market Update

${lines.join("\n")}

📊 Total tracked Spot volume (24h): ${compact(totalVolume)}
⚖️ Breadth: ${advancing} up / ${declining} down among liquid USDT pairs
🔎 Reading: ${bias}

🧠 Broad market conditions can shift quickly — treat this as a snapshot, not a forecast.

🤔 Is the tape confirming your bias right now?

#Crypto #Binance #MarketUpdate #Bitcoin`;
}

function bullBearPost(coin, candles) {
  const closes = candles.map(x => x.close);
  const price = closes.at(-1);

  const last20 = candles.slice(-20);
  const support = Math.min(...last20.map(x => x.low));
  const resistance = Math.max(
    ...last20.map(x => x.high)
  );

  return `⚖️ $${coin.asset} — Bull vs Bear

💰 Price: ${money(price)}
${coin.change >= 0 ? "🟢" : "🔴"} 24H Change: ${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}%

🐂 Bull Case
A reclaim and 4H close above ${money(resistance)} with rising volume would favor continuation, keeping the higher-timeframe structure constructive.

🐻 Bear Case
A 4H close below ${money(support)} would weaken the structure and put a deeper retracement back in focus.

🧭 Neither scenario is guaranteed — price action around these two levels is the tiebreaker.

🧠 Analysis and scenarios only — not financial advice.

🤔 Which side of this range are you leaning toward?

#Crypto #Binance #${coin.asset} #MarketStructure`;
}

function whatToWatchPost(coins) {
  const watch = [...coins]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5);

  const lines = watch.map(
    c =>
      `• $${c.asset} — ${compact(c.volume)} 24h vol, ${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}%`
  );

  return `👀 What to Watch — Next Few Hours

The most liquid Spot pairs right now, worth keeping on the radar for follow-through or reversal:

${lines.join("\n")}

📊 High liquidity means moves here tend to carry more weight for short-term market structure.

🧠 Levels can shift fast — this list reflects current conditions, not a prediction.

🤔 Which of these are you tracking?

#Crypto #Binance #Watchlist #CryptoMarket`;
}

function educationPost(topic) {
  if (topic === "rsi") {
    return `📚 Crypto Education — RSI

⚡ RSI measures momentum.

🟢 Above 70: strong momentum / potentially overextended
🟡 Around 50: balanced momentum
🔴 Below 30: weak momentum / potentially oversold

📊 RSI should not be used alone.

🔎 Price structure, volume and trend can provide confirmation.

👀 Context matters.

🤔 Do you combine RSI with another indicator?

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

📊 Candles become more useful with:

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

      const data = await getJson(url);

      if (Array.isArray(data.articles)) {
        results.push(...data.articles);
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
    "bombing",
    "conflict",
    "ceasefire",
    "troops",
    "terrorist",
    "genocide",
    "airbase"
  ];

  const filtered = results.filter(article => {
    const text =
      `${article.title || ""} ${article.url || ""}`
        .toLowerCase();

    return (
      article.socialimage &&
      !blocked.some(word => text.includes(word))
    );
  });

  const unique = new Map();

  for (const article of filtered) {
    const key =
      article.url ||
      article.title;

    if (!unique.has(key)) {
      unique.set(key, article);
    }
  }

  return [...unique.values()].slice(0, 30);
}

async function createNewsImage(article) {
  const ok = await downloadImage(
    article.socialimage,
    IMAGE_FILE
  );

  return ok ? IMAGE_FILE : null;
}

function runChart(input, output, mode) {
  const chart = path.join(
    ROOT,
    "bot",
    "chart.mjs"
  );

  try {
    execFileSync(
      "node",
      [chart, input, output, mode],
      {
        cwd: ROOT,
        stdio: "inherit"
      }
    );

    return fs.existsSync(output)
      ? output
      : null;
  } catch (err) {
    console.log(
      `${mode} chart failed:`,
      err.message
    );

    return null;
  }
}

function createAnalysisChart(symbol) {
  return runChart(
    symbol,
    path.join(
      ROOT,
      "bot",
      "analysis-chart.png"
    ),
    "analysis"
  );
}

function createEducationImage(topic) {
  return runChart(
    topic,
    path.join(
      ROOT,
      "bot",
      "education.png"
    ),
    "education"
  );
}

function createMoversImage(coins) {
  const movers = [...coins]
    .sort((a, b) => b.change - a.change)
    .slice(0, 5);

  return runChart(
    JSON.stringify(
      movers.map(x => ({
        asset: x.asset,
        change: x.change
      }))
    ),
    path.join(
      ROOT,
      "bot",
      "movers.png"
    ),
    "movers"
  );
}

function createMarketSnapshotImage(coins) {
  const btc = coins.find(c => c.asset === "BTC");
  const eth = coins.find(c => c.asset === "ETH");

  const others = [...coins]
    .filter(c => c.asset !== "BTC" && c.asset !== "ETH")
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 3);

  const snapshot = [btc, eth, ...others].filter(Boolean);

  return runChart(
    JSON.stringify(
      snapshot.map(x => ({
        asset: x.asset,
        change: x.change
      }))
    ),
    path.join(ROOT, "bot", "snapshot.png"),
    "movers"
  );
}

function createWatchlistImage(coins) {
  const watch = [...coins]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5);

  return runChart(
    JSON.stringify(
      watch.map(x => ({
        asset: x.asset,
        change: x.change
      }))
    ),
    path.join(ROOT, "bot", "watchlist.png"),
    "movers"
  );
}

/*
 * Target mix for the "other" 20% bucket. Real percentages,
 * checked against actual recent history rather than a fixed
 * round-robin, so the mix self-corrects (e.g. if news keeps
 * being unavailable, other types pick up the slack instead of
 * the schedule silently drifting).
 */
const OTHER_CONTENT_TYPES = [
  { key: "education", weight: 25 },
  { key: "news", weight: 20 },
  { key: "market_snapshot", weight: 15 },
  { key: "top_movers", weight: 10 },
  { key: "project_study", weight: 10 },
  { key: "bull_bear", weight: 10 },
  { key: "poll", weight: 5 },
  { key: "ecosystem", weight: 5 }
];

function selectOtherType(history) {
  const recentOther = history
    .filter(x => x && x.type === "other" && x.subtype)
    .slice(-40);

  const total = recentOther.length || 1;

  let best = OTHER_CONTENT_TYPES[0].key;
  let bestDeficit = -Infinity;

  for (const t of OTHER_CONTENT_TYPES) {
    const count = recentOther.filter(
      x => x.subtype === t.key
    ).length;

    const actualShare = (count / total) * 100;
    const deficit = t.weight - actualShare;

    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      best = t.key;
    }
  }

  return best;
}

/*
 * Text-only by design — a genuine use of the no-image posting
 * path, not a workaround. A direct question invites replies,
 * which is exactly the kind of engagement CreatorPad's 2026
 * scoring update rewards over raw post volume.
 */
function pollPost(coins) {
  const btc = coins.find(c => c.asset === "BTC");

  const questions = [
    `Do you think $BTC holds ${btc ? money(btc.price) : "current levels"} through the next few sessions, or do we see a deeper pullback first?`,
    "Which matters more to you right now: price action, or on-chain/volume signals?",
    "Spot or futures — which are you paying more attention to this week?",
    "Are you currently more focused on majors (BTC/ETH) or altcoins?",
    "What's one level, on any coin, you're personally watching closely right now?"
  ];

  const question =
    questions[
      Math.floor(Math.random() * questions.length)
    ];

  return `🗣️ Quick Question

${question}

🧠 Not financial advice — just curious where the community's head is at.

#Crypto #Binance #CryptoCommunity`;
}

/*
 * Short, factual notes about real, currently-documented
 * Binance Square features — verified against Binance's own
 * announcements rather than invented. Text-only.
 */
const ECOSYSTEM_NOTES = [
  {
    title: "Gold Verification",
    body: "Binance Square offers Gold Verification for creators — a one-time verification step that can improve profile credibility and content reach on the platform."
  },
  {
    title: "CreatorPad",
    body: "CreatorPad runs project-funded content campaigns on Binance Square. In 2026, its scoring was updated to weigh genuine engagement and content quality more heavily than raw posting volume."
  },
  {
    title: "Write to Earn",
    body: "Write to Earn is Binance Square's program for rewarding consistent, quality written content from creators over time."
  },
  {
    title: "Task Center",
    body: "Binance Square's Task Center refreshes daily with a featured hashtag or trading pair — visible inside the app under Creator Center, and it changes every 24 hours."
  },
  {
    title: "Live Trading Hub",
    body: "Binance's Live Trading Hub lets verified creators with a minimum follower count stream and earn a share of trading fees from followers who trade alongside them."
  }
];

function ecosystemPost() {
  const note =
    ECOSYSTEM_NOTES[
      Math.floor(Math.random() * ECOSYSTEM_NOTES.length)
    ];

  return `ℹ️ Binance Square Feature: ${note.title}

${note.body}

🔎 Details and eligibility can change — check Binance Square's Creator Center for the current, official terms.

#Binance #BinanceSquare #CryptoCommunity`;
}

/*
 * Short factual spotlights for well-known projects only — no
 * invented claims for obscure/low-cap tickers we don't actually
 * have reliable information about.
 */
const PROJECT_NOTES = {
  BTC: "the original cryptocurrency and largest by market cap, a decentralized peer-to-peer digital currency secured by proof-of-work mining.",
  ETH: "a smart-contract platform and the base layer for most DeFi, NFT, and dApp activity, secured by proof-of-stake.",
  BNB: "the native token of the BNB Chain ecosystem and Binance's exchange token, used for fees, staking, and on-chain activity.",
  SOL: "a high-throughput smart-contract platform known for fast, low-cost transactions, widely used for DeFi and NFTs.",
  XRP: "a token built for fast, low-cost cross-border payments, associated with Ripple's payment-settlement network.",
  DOGE: "the original meme coin, a proof-of-work chain that has retained a large, active community since 2013.",
  ADA: "the native token of Cardano, a proof-of-stake smart-contract platform built with a research-driven development approach.",
  DOT: "Polkadot's native token, designed to connect multiple specialized blockchains ('parachains') into one network.",
  LINK: "Chainlink's token, used to secure decentralized oracle networks that feed real-world data to smart contracts.",
  AVAX: "Avalanche's native token, powering a smart-contract platform built around fast finality and custom subnets.",
  LTC: "one of the earliest Bitcoin forks, designed for faster block times and lower fees for payments.",
  TRX: "TRON's native token, powering a smart-contract platform with a strong focus on stablecoin transaction volume.",
  MATIC: "the token of Polygon, an Ethereum-scaling network widely used for cheaper, faster transactions.",
  POL: "the token of Polygon's ecosystem, an Ethereum-scaling network widely used for cheaper, faster transactions.",
  DASH: "a payments-focused fork of Bitcoin offering optional faster transactions via its masternode network.",
  ATOM: "Cosmos's native token, part of an ecosystem built around interoperable, independent blockchains.",
  UNI: "the governance token of Uniswap, one of the largest decentralized exchanges by trading volume.",
  NEAR: "the native token of a sharded, developer-focused smart-contract platform.",
  APT: "the token of Aptos, a smart-contract platform built with the Move programming language.",
  ARB: "the governance token of Arbitrum, one of the largest Ethereum layer-2 scaling networks.",
  OP: "the governance token of Optimism, an Ethereum layer-2 network and the base of the broader OP Stack ecosystem.",
  SUI: "the native token of Sui, a smart-contract platform also built with the Move language, focused on parallel transaction execution.",
  SHIB: "a large meme-coin ecosystem that expanded from its original token into its own layer-2 network (Shibarium).",
  PEPE: "one of the largest meme coins by market cap, with no stated utility beyond community and speculation.",
  BCH: "a Bitcoin fork created to prioritize larger block sizes for cheaper on-chain payments."
};

function projectStudyPost(coins) {
  const withNotes = coins.filter(
    c => PROJECT_NOTES[c.asset]
  );

  const coin =
    withNotes.length
      ? withNotes.sort(
          (a, b) => b.volume - a.volume
        )[0]
      : [...coins].sort(
          (a, b) => b.volume - a.volume
        )[0];

  const note =
    PROJECT_NOTES[coin.asset] ||
    "a listed asset on Binance Spot — no verified project summary in our notes, so this covers market stats only rather than guessing at its purpose.";

  return `🔍 Project Spotlight: $${coin.asset}

${coin.asset} is ${note}

💰 Price: ${money(coin.price)}
${coin.change >= 0 ? "🟢" : "🔴"} 24H Change: ${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}%
📊 24H Volume: ${compact(coin.volume)}

🧠 Informational only — not financial advice, always do your own research.

#Crypto #Binance #${coin.asset}`;
}

/*
 * Finds the official Binance Square Skill's scripts directory.
 * The install command can place it under a few different
 * relative paths depending on the agent invoking it, so we
 * search for post-image.mjs specifically and derive the shared
 * scripts directory from wherever it's actually found — rather
 * than hard-coding one location and hoping it matches.
 */
function findSkillScriptsDir() {
  const candidates = [
    ".agents/skills/binance/square-post/scripts",
    "agent/skills/binance/square-post/scripts",
    ".agents/skills/square-post/scripts",
    "agent/skills/square-post/scripts"
  ];

  for (const location of candidates) {
    const dir = path.join(ROOT, location);
    const marker = path.join(dir, "post-image.mjs");

    if (fs.existsSync(marker)) {
      return dir;
    }
  }

  throw new Error(
    "Binance Square Skill scripts directory was not found " +
      "(checked: " +
      candidates.join(", ") +
      ")."
  );
}

function redactSecret(text, secret) {
  if (!secret) return text;

  return text.split(secret).join("[REDACTED]");
}

/*
 * Runs the official Binance Square Skill script and returns
 * its captured stdout/stderr instead of just inheriting stdio,
 * so a failure is diagnosable from the GitHub Actions log
 * instead of surfacing only as a bare "exit code 1".
 */
function runSkillScript(scriptPath, args) {
  const apiKey = process.env.BINANCE_SQUARE_OPENAPI_KEY;

  if (!apiKey) {
    throw new Error(
      "BINANCE_SQUARE_OPENAPI_KEY is not set in the environment."
    );
  }

  const result = spawnSync(
    "node",
    [scriptPath, ...args],
    {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8"
    }
  );

  const stdout = redactSecret(
    result.stdout || "",
    apiKey
  );
  const stderr = redactSecret(
    result.stderr || "",
    apiKey
  );

  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());

  if (result.error) {
    throw new Error(
      `Failed to launch Binance Square Skill script: ${result.error.message}`
    );
  }

  if (result.status !== 0) {
    throw new Error(
      "Binance Square publish failed.\n" +
        `Exit code: ${result.status}\n` +
        `stdout:\n${stdout.trim() || "(empty)"}\n\n` +
        `stderr:\n${stderr.trim() || "(empty)"}`
    );
  }

  return { stdout, stderr };
}

/*
 * Publishes text content, optionally with 0-4 images.
 *
 * images: null/undefined/[] -> text-only post (post-text.mjs)
 *         string             -> single image (back-compat)
 *         string[] (1-4)     -> image post (post-image.mjs,
 *                                comma-separated, official max is 4)
 */
function publish(text, images) {
  const scriptsDir = findSkillScriptsDir();

  const imageList = !images
    ? []
    : Array.isArray(images)
      ? images
      : [images];

  if (imageList.length > 4) {
    throw new Error(
      "At most 4 images are supported per post."
    );
  }

  for (const img of imageList) {
    if (!img || !fs.existsSync(img)) {
      throw new Error(
        `Image path does not exist: ${img}`
      );
    }
  }

  console.log("Publishing Binance Square post...");
  console.log(
    imageList.length
      ? `Images (${imageList.length}): ${imageList.join(", ")}`
      : "Images: none (text-only post)"
  );

  if (imageList.length === 0) {
    return runSkillScript(
      path.join(scriptsDir, "post-text.mjs"),
      ["--text", text]
    );
  }

  return runSkillScript(
    path.join(scriptsDir, "post-image.mjs"),
    ["--text", text, "--images", imageList.join(",")]
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
    ),
    path.join(
      ROOT,
      "bot",
      "snapshot.png"
    ),
    path.join(
      ROOT,
      "bot",
      "watchlist.png"
    )
  ];

  for (const file of files) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

async function main() {
  console.log("================================");
  console.log("Binance Square Auto Bot 3.0");
  console.log("================================");

  const history = loadHistory();

  /*
   * NEW:
   * Check the actual last successful publication.
   * No fixed 25-minute slots anymore.
   */
  const timing = canPublish(history);

  if (!timing.allowed) {
    const minutes = Math.ceil(
      timing.remaining / 60000
    );

    console.log(
      `⏳ Too early. Next publication allowed in approximately ${minutes} minute(s).`
    );

    return;
  }

  console.log(
    "✅ 25-minute interval reached. Preparing a new post..."
  );

  const coins = await getSpotCoins();

  if (!coins.length) {
    throw new Error(
      "No eligible Binance Spot USDT coins found."
    );
  }

  /*
   * 4 analysis posts + 1 other post.
   * The cycle is based on SUCCESSFUL PUBLICATIONS,
   * not on the clock.
   *
   * This keeps the 80/20 ratio even when GitHub
   * delays a scheduled workflow.
   */
  const successfulPosts =
    history.filter(
      x => x && x.published === true
    ).length;

  const position =
    successfulPosts % 5;

  let type;
  let text;
  let asset = null;
  let image = null;
  let subtype = null;
  let angle = null;

  if (position < 4) {
    type = "analysis";

    const coin =
      chooseCoin(
        coins,
        history
      );

    asset = coin.asset;

    const candles =
      await getKlines(
        coin.symbol,
        "4h",
        100
      );

    const pastAnalysisCount = history.filter(
      x => x && x.type === "analysis"
    ).length;

    angle = pastAnalysisCount % 3;

    text =
      analysisText(
        coin,
        candles,
        angle
      );

    image =
      createAnalysisChart(
        coin.symbol
      );
  } else {
    type = "other";

    subtype = selectOtherType(history);

    if (subtype === "news") {
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

        /*
         * Only attach an image when the article actually has
         * a usable one. Otherwise this goes out as a text-only
         * post instead of forcing an unrelated fallback image.
         */
        image =
          await createNewsImage(
            article
          );
      } else {
        /*
         * No usable news right now — actually publish as
         * top_movers content, and record it as such, so the
         * adaptive scheduler sees what really went out rather
         * than crediting a "news" slot that didn't happen.
         */
        subtype = "top_movers";

        text =
          topMoversPost(
            coins
          );

        image =
          createMoversImage(
            coins
          );
      }
    } else if (subtype === "top_movers") {
      const useWatchlist =
        history.filter(
          x => x && x.subtype === "top_movers"
        ).length % 2 === 1;

      if (useWatchlist) {
        text = whatToWatchPost(coins);

        const watchlistImg = createWatchlistImage(coins);

        const topPick = [...coins].sort(
          (a, b) => b.volume - a.volume
        )[0];

        const topPickImg = topPick
          ? createAnalysisChart(topPick.symbol)
          : null;

        image = [watchlistImg, topPickImg].filter(Boolean);
      } else {
        text =
          topMoversPost(
            coins
          );

        image =
          createMoversImage(
            coins
          );
      }
    } else if (subtype === "education") {
      const topics = [
        "candlesticks",
        "breakout",
        "rsi"
      ];

      const pastEducationCount = history.filter(
        x => x && x.subtype === "education"
      ).length;

      const topic =
        topics[
          pastEducationCount %
          topics.length
        ];

      text =
        educationPost(
          topic
        );

      image =
        createEducationImage(
          topic
        );
    } else if (subtype === "market_snapshot") {
      text = marketUpdatePost(coins);
      image = createMarketSnapshotImage(coins);
    } else if (subtype === "bull_bear") {
      const coin = chooseCoin(coins, history);

      const candles = await getKlines(
        coin.symbol,
        "4h",
        100
      );

      text = bullBearPost(coin, candles);
      image = createAnalysisChart(coin.symbol);
    } else if (subtype === "project_study") {
      text = projectStudyPost(coins);

      const coin = [...coins]
        .filter(c => PROJECT_NOTES[c.asset])
        .sort((a, b) => b.volume - a.volume)[0] ||
        [...coins].sort((a, b) => b.volume - a.volume)[0];

      image = createAnalysisChart(coin.symbol);
    } else if (subtype === "poll") {
      text = pollPost(coins);
      image = null;
    } else {
      text = ecosystemPost();
      image = null;
    }
  }

  /*
   * `image` may be: a single path (string), an array of paths
   * (0-4), or null/undefined for a text-only post. Normalize
   * and validate here, once, regardless of which branch above
   * produced it.
   */
  const images = !image
    ? []
    : Array.isArray(image)
      ? image.filter(Boolean)
      : [image];

  for (const img of images) {
    if (!fs.existsSync(img)) {
      throw new Error(
        `Could not create a valid post image: ${img}`
      );
    }
  }

  /*
   * Publish FIRST.
   *
   * Only after publish() succeeds do we
   * write published:true to history.
   */
  publish(
    text,
    images
  );

  const now =
    new Date().toISOString();

  history.push({
    date: now.slice(0, 10),
    time: now,
    type,
    asset,
    subtype,
    angle,
    published: true
  });

  saveHistory(history);

  recordSuccess(now);

  cleanup();

  console.log(
    "✅ Published successfully."
  );
  console.log(
    `🕐 Published at: ${now}`
  );
}

main().catch(err => {
  console.error(
    "❌ Bot failed:",
    err
  );

  recordFailure(err);

  process.exit(1);
});
