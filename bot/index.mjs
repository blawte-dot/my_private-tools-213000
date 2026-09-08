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
 * Randomized 39-45 min window (spec: "39-45 minute schedule" as
 * an editorial/operational cadence, not a claimed growth
 * formula) instead of a fixed interval. A perfectly constant
 * cadence is itself a bot fingerprint; jitter makes the timing
 * look human without changing the intended pacing.
 */
const MIN_POST_INTERVAL_MS = 39 * 60 * 1000;
const MAX_POST_INTERVAL_MS = 45 * 60 * 1000;
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

  const eligible = coins.filter(
    c => !usedToday.has(c.asset)
  );

  const pool = eligible.length ? eligible : coins;

  /*
   * Recency-weighted fatigue from the last 30 analysis picks
   * (not just today) — a coin picked 2 days ago should still
   * be somewhat less attractive today, not just excluded on
   * its own literal calendar day.
   */
  const recentAnalysis = history
    .filter(x => x && x.type === "analysis" && x.asset)
    .slice(-30);

  const fatigue = {};

  recentAnalysis.forEach((entry, i) => {
    const recencyWeight =
      (i + 1) / recentAnalysis.length;

    fatigue[entry.asset] =
      (fatigue[entry.asset] || 0) + recencyWeight;
  });

  /*
   * Tier by volume percentile within today's eligible pool, and
   * rotate which tier we target across posts — so the screener
   * doesn't just repeatedly settle on the same handful of
   * largest-volume majors. Momentum can still override this
   * (see scoring below) for a genuinely exceptional mover.
   */
  const byVolume = [...pool].sort(
    (a, b) => b.volume - a.volume
  );

  const majorsCount = Math.max(
    1,
    Math.ceil(byVolume.length * 0.15)
  );

  const largeCount = Math.max(
    1,
    Math.ceil(byVolume.length * 0.35)
  );

  function tierOf(asset) {
    const idx = byVolume.findIndex(
      c => c.asset === asset
    );

    if (idx < majorsCount) return "majors";
    if (idx < majorsCount + largeCount) return "large";
    return "mid";
  }

  const pastAnalysisCount = history.filter(
    x => x && x.type === "analysis"
  ).length;

  /*
   * majors: 1/4 of picks, large: 2/4, mid/liquid-emerging: 1/4
   * — still liquidity-safe (the 5M 24h-volume floor is applied
   * before this function ever sees the list), but not majors
   * every single time.
   */
  const tierCycle = [
    "majors",
    "large",
    "mid",
    "large"
  ];

  const targetTier =
    tierCycle[pastAnalysisCount % tierCycle.length];

  const tierPool = pool.filter(
    c => tierOf(c.asset) === targetTier
  );

  const scoringPool = tierPool.length
    ? tierPool
    : pool;

  const FATIGUE_WEIGHT = 25;

  const candidates = [...scoringPool].sort(
    (a, b) => {
      const momentumA =
        Math.max(a.change, 0) *
        Math.log10(Math.max(a.volume, 1));

      const momentumB =
        Math.max(b.change, 0) *
        Math.log10(Math.max(b.volume, 1));

      const scoreA =
        momentumA -
        (fatigue[a.asset] || 0) * FATIGUE_WEIGHT;

      const scoreB =
        momentumB -
        (fatigue[b.asset] || 0) * FATIGUE_WEIGHT;

      return scoreB - scoreA;
    }
  );

  const picked =
    candidates[0] ||
    [...coins].sort(
      (a, b) => b.change - a.change
    )[0];

  return {
    ...picked,
    tier: tierOf(picked.asset)
  };
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

function analysisText(coin, candles, angle, includeHashtags, cta) {
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
   * Volume trend: recent 5 candles vs the prior 15 — used to
   * decide whether to call out a conflict, and to describe
   * "what changed" for that specific angle.
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

  const volumeChangePct =
    priorVol > 0
      ? ((recentVol - priorVol) / priorVol) * 100
      : 0;

  const changeText =
    `${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}%`;

  /*
   * When trend and momentum genuinely disagree, every angle
   * needs to be able to say so — but each phrases it in its
   * own words rather than sharing one fixed sentence.
   */
  const conflict =
    (trend === "BULLISH" &&
      (momentum === "Weak" || momentum === "Negative")) ||
    (trend === "BEARISH" &&
      (momentum === "Strong" || momentum === "Positive"));

  const cashtag = `$${coin.asset}`;

  /*
   * Spec: 60% of analysis posts should carry no hashtags at
   * all, 40% may — decided by the caller (selectHashtagUse)
   * and passed in, not a fixed per-angle rule. When omitted,
   * the whole trailing hashtag line (and the blank line before
   * it) is left out entirely rather than replaced with
   * something else.
   */
  function tagLine(tags) {
    return includeHashtags ? `\n\n${tags}` : "";
  }

  /*
   * 6 structurally distinct formats (spec: compact analysis,
   * evidence-first, "what changed", scenario comparison,
   * level-by-level breakdown, mini case study) — each with its
   * own emoji set, its own ordering, and its own wording for
   * every data point, not shared text blocks reused with
   * different headers. Not every angle ends in a question,
   * on purpose.
   */

  if (angle === 0) {
    // Compact analysis — dense, minimal, one-line verdict.
    const verdict = conflict
      ? `mixed — ${trend.toLowerCase()} structure, ${momentum.toLowerCase()} RSI`
      : trend.toLowerCase();

    return `🪙 ${cashtag} — ${money(price)} (${changeText})

📐 EMA20 ${money(ema20)} · EMA50 ${money(ema50)} · RSI ${rsi14.toFixed(1)}
📍 Range: ${money(support)} – ${money(resistance)}

💹 Read: ${verdict}. A break of either side of the range likely sets the next 4H direction.${tagLine(`#Crypto #Binance ${cashtag}`)}`;
  }

  if (angle === 1) {
    // Evidence-first — lead with the strongest single data
    // point before naming the asset.
    const leadFact =
      Math.abs(volumeChangePct) > 20
        ? `4H volume just moved ${volumeChangePct >= 0 ? "up" : "down"} ${Math.abs(volumeChangePct).toFixed(0)}% versus the prior stretch`
        : rsi14 >= 60 || rsi14 <= 40
          ? `RSI(14) has pushed to ${rsi14.toFixed(1)}, a ${rsi14 >= 60 ? "stronger" : "weaker"} reading than typical`
          : `price is holding inside a ${(((resistance - support) / support) * 100).toFixed(1)}% band between ${money(support)} and ${money(resistance)}`;

    return `🧾 Evidence first: ${leadFact}.

📌 That's on ${cashtag}, currently ${money(price)} (${changeText} 24H).

🔬 Supporting data:
EMA20/EMA50: ${money(ema20)} / ${money(ema50)} — structure reads ${trend.toLowerCase()}
Volume: ${volumeTrend}
100-candle range: ${money(low100)} – ${money(high100)}

${conflict ? `⚠️ Worth flagging: trend and momentum aren't fully aligned here, so treat this as lower-conviction until one confirms the other.` : `🧠 Trend and momentum are aligned on this one.`}${tagLine(`#Crypto #Binance ${cashtag} #MarketData`)}`;
  }

  if (angle === 2) {
    // "What changed" — frames around the recent shift, not a
    // static snapshot.
    const shiftLine =
      volumeTrend === "rising"
        ? `volume has picked up ${Math.abs(volumeChangePct).toFixed(0)}% over the last few candles`
        : volumeTrend === "fading"
          ? `volume has faded ${Math.abs(volumeChangePct).toFixed(0)}% over the last few candles`
          : `volume hasn't meaningfully shifted over the last few candles`;

    return `🔄 What changed on ${cashtag} in the last few 4H candles?

⏱️ ${shiftLine.charAt(0).toUpperCase() + shiftLine.slice(1)}, and RSI(14) now sits at ${rsi14.toFixed(1)} (${momentum.toLowerCase()}).

📶 Price: ${money(price)} (${changeText} 24H) — trend structure currently reads ${trend}.

${conflict ? `That's a shift worth watching: momentum hasn't fully confirmed the trend yet.` : `Momentum and trend are moving in the same direction for now.`}

📍 Key levels either side: ${money(support)} support, ${money(resistance)} resistance.${tagLine(`#Crypto #Binance ${cashtag}`)}`;
  }

  if (angle === 3) {
    // Scenario comparison — bull vs bear framed upfront.
    return `🎯 ${cashtag} scenario check — ${money(price)} (${changeText} 24H)

🔀 Bull case: reclaim/hold above ${money(resistance)} on rising volume keeps ${trend === "BULLISH" ? "the current uptrend" : "a recovery attempt"} alive.
🔀 Bear case: a 4H close under ${money(support)} opens room toward the wider ${money(low100)}–${money(high100)} range.

🧭 Current read: trend ${trend.toLowerCase()}, momentum ${momentum.toLowerCase()}${conflict ? " — the two disagree right now, so neither case has full confirmation" : " — both pointing the same way for now"}.${cta ? `\n\n${cta}` : ""}${tagLine(`#Crypto #Binance ${cashtag} #TechnicalAnalysis`)}`;
  }

  if (angle === 4) {
    // Level-by-level breakdown — methodical, numbered, no
    // closing question by design.
    return `📏 ${cashtag} — 4H levels, low to high:

1️⃣ ${money(low100)} — 100-candle low. Losing this would be a structural break.
2️⃣ ${money(support)} — near-term support (last 20 candles).
3️⃣ ${money(price)} — current price (${changeText} 24H).
4️⃣ ${money(resistance)} — near-term resistance (last 20 candles).
5️⃣ ${money(high100)} — 100-candle high. A confirmed break opens fresh territory.

📊 Context: EMA20/50 at ${money(ema20)}/${money(ema50)}, RSI(14) ${rsi14.toFixed(1)}, volume ${volumeTrend}.

🧠 Informational only — not financial advice.${tagLine(`#Crypto #Binance ${cashtag}`)}`;
  }

  // angle 5 — mini case study, narrative framing.
  const daysSpan = Math.round(
    (candles.at(-1).time - candles[0].time) /
      (1000 * 60 * 60 * 24)
  );

  return `📖 A quick look at ${cashtag} over the last ~${daysSpan} days.

🕰️ Price has moved between ${money(low100)} and ${money(high100)} in that window, and currently sits at ${money(price)} (${changeText} 24H).

🔎 Along the way, the 4H structure has shifted to ${trend.toLowerCase()}, with RSI(14) now at ${rsi14.toFixed(1)} and volume ${volumeTrend}${conflict ? " — though momentum hasn't fully caught up with that trend yet" : ""}.

The next test is whether price can hold above ${money(support)} or push through ${money(resistance)}.${cta ? `\n\n${cta}` : ""}${tagLine(`#Crypto #Binance ${cashtag}`)}`;
}


function deepAnalysisText(coin, candles) {
  const closes = candles.map(c => c.close);
  const price = closes.at(-1);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsi14 = rsi(closes, 14);

  const high100 = Math.max(...candles.map(c => c.high));
  const low100 = Math.min(...candles.map(c => c.low));

  const last20 = candles.slice(-20);
  const support = Math.min(...last20.map(c => c.low));
  const resistance = Math.max(...last20.map(c => c.high));

  const first = candles[0];
  const mid = candles[Math.floor(candles.length / 2)];
  const daysSpan = Math.round(
    (candles.at(-1).time - first.time) / (1000 * 60 * 60 * 24)
  );

  const periodChangePct =
    ((price - first.open) / first.open) * 100;

  const firstHalfChangePct =
    ((mid.close - first.open) / first.open) * 100;

  const secondHalfChangePct =
    ((price - mid.close) / mid.close) * 100;

  const recentVol =
    candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;

  const priorVol =
    candles.slice(-20, -5).reduce((s, c) => s + c.volume, 0) / 15;

  const volumeTrend =
    recentVol > priorVol * 1.15
      ? "picking up"
      : recentVol < priorVol * 0.85
        ? "fading"
        : "holding steady";

  let trend = "neutral";

  if (price > ema20 && ema20 > ema50) trend = "bullish";
  else if (price < ema20 && ema20 < ema50) trend = "bearish";

  const rsiReading =
    rsi14 >= 70
      ? "in overbought territory"
      : rsi14 >= 55
        ? "on the stronger side without being overbought"
        : rsi14 <= 30
          ? "in oversold territory"
          : rsi14 <= 45
            ? "on the weaker side without being oversold"
            : "roughly neutral";

  const title = `$${coin.asset} Deep Dive — 4H Structure, Momentum, and Levels`;

  const body = `${coin.asset} is currently trading at ${money(price)}, ${coin.change >= 0 ? "up" : "down"} ${Math.abs(coin.change).toFixed(2)}% over the last 24 hours. Here's a full walk through the 4H picture — not just the numbers, but why each of them matters.

📈 The Bigger Picture (Last ${daysSpan} Days)

Over this window, price has moved between ${money(low100)} and ${money(high100)} — a range of about ${(((high100 - low100) / low100) * 100).toFixed(1)}%. The first half of that period saw a ${firstHalfChangePct >= 0 ? "gain" : "decline"} of ${Math.abs(firstHalfChangePct).toFixed(1)}%, while the second half has moved ${secondHalfChangePct >= 0 ? "up" : "down"} ${Math.abs(secondHalfChangePct).toFixed(1)}%. Net change across the full window: ${periodChangePct >= 0 ? "+" : ""}${periodChangePct.toFixed(1)}%. That split matters because it shows whether the recent move is accelerating, decelerating, or reversing relative to the earlier trend — not just where price ended up.

🔎 Trend Structure

The 4H trend currently reads ${trend}. This comes from comparing price to two moving averages: the 20-period EMA (${money(ema20)}) and the 50-period EMA (${money(ema50)}). When price sits above a rising short-term average, and that average sits above the longer-term one, buyers have been in control on this timeframe — that's what "bullish structure" means here, and the reverse defines "bearish." Right now: price ${price > ema20 ? "above" : "below"} the 20 EMA, and the 20 EMA ${ema20 > ema50 ? "above" : "below"} the 50 EMA.

For reference, the simple moving averages sit at SMA20 ${money(sma20)} and SMA50 ${money(sma50)} — these weight all candles equally rather than favoring recent ones like the EMAs do, so a gap between the SMA and EMA readings can hint at how much the trend has accelerated or decelerated very recently.

⚡ Momentum (RSI)

RSI(14) is at ${rsi14.toFixed(1)}, which is ${rsiReading}. RSI measures the speed and size of recent price changes on a 0-100 scale — above 70 typically signals the move has been fast enough that a pause or pullback becomes more likely, while below 30 signals the opposite. A neutral RSI alongside a clear trend (or vice versa) is often more informative than either reading alone, because it tells you whether the current move still has room to run or is already stretched.

📊 Volume Context

Volume over the last few candles has been ${volumeTrend} relative to the prior stretch. Volume matters because a price move on rising volume reflects broader participation and tends to be more reliable than the same move on fading volume, which can indicate the move is running out of committed buyers or sellers.

📍 The Levels That Matter Right Now

Support sits at ${money(support)} (the lowest point of the last 20 candles) and resistance at ${money(resistance)} (the highest). These aren't arbitrary lines — they mark where price has already been rejected or defended recently, which is exactly why traders watch them: a level that has held before tends to attract attention when price approaches it again, whether that means it holds a third time or finally breaks.

Zooming out, the wider ${money(low100)}–${money(high100)} range from the full ${daysSpan}-day window is the structure that a confirmed break of either near-term level would ultimately be testing.

🧭 Putting It Together

None of these signals work well in isolation — a bullish trend reading with weak momentum and fading volume tells a different story than the same trend with strong momentum and rising volume, even though the "trend" label is identical in both cases. That's the actual reason to look at structure, momentum, and volume together rather than any single indicator on its own.

🧠 This is market analysis and educational context only — not financial advice. Always do your own research before making any decisions.

#Crypto #Binance #${coin.asset} #TechnicalAnalysis`;

  return { title, body };
}


function topMoversPost(coins) {
  const movers = [...coins]
    .sort((a, b) => b.change - a.change)
    .slice(0, 5);

  /*
   * Binance Square's API rejects posts that tag too many
   * distinct coin pairs at once (observed: error 220095,
   * "Coin pair count exceed", with 5 $CASHTAGs). Cap to 3
   * tagged, list the rest by plain ticker (no $) instead of
   * dropping them from the post entirely.
   */
  const lines = movers.map(
    (c, i) =>
      `${i + 1}. ${c.change >= 0 ? "🟢" : "🔴"} ${i < 3 ? "$" + c.asset : c.asset} ${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}%`
  );

  const lead = movers[0];

  return `📈 Strongest movers on Binance Spot right now:

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

  return `${lines.join("\n")}

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

  return `💰 $${coin.asset} — ${money(price)}
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
    (c, i) =>
      `• ${i < 3 ? "$" + c.asset : c.asset} — ${compact(c.volume)} 24h vol, ${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}%`
  );

  return `👀 The most liquid Spot pairs right now, worth keeping on the radar for follow-through or reversal:

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

async function getNews(history) {
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

  /*
   * Spec 20/93: a story should only be reused when there's a
   * genuinely new development, not reposted verbatim. Filter
   * out anything matching a URL we've already published as
   * news in the last 20 news posts, rather than relying only
   * on the 6h GDELT window to prevent repeats.
   */
  const recentlyUsed = new Set(
    (history || [])
      .filter(x => x && x.subtype === "news" && x.newsUrl)
      .slice(-20)
      .map(x => x.newsUrl)
  );

  return [...unique.values()]
    .filter(a => !recentlyUsed.has(a.url))
    .slice(0, 30);
}

async function createNewsImage(article) {
  const ok = await downloadImage(
    article.socialimage,
    IMAGE_FILE
  );

  return ok ? IMAGE_FILE : null;
}

function runChart(input, output, mode, extraArg) {
  const chart = path.join(
    ROOT,
    "bot",
    "chart.mjs"
  );

  const args = extraArg === undefined
    ? [chart, input, output, mode]
    : [chart, input, output, mode, String(extraArg)];

  try {
    execFileSync(
      "node",
      args,
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

function createAnalysisChart(symbol, variantIndex) {
  return runChart(
    symbol,
    path.join(
      ROOT,
      "bot",
      "analysis-chart.png"
    ),
    "analysis",
    variantIndex
  );
}

function createCoinCardImage(symbol, variantIndex) {
  return runChart(
    symbol,
    path.join(
      ROOT,
      "bot",
      "coin-card.png"
    ),
    "coincard",
    variantIndex
  );
}

/*
 * Media mix for ANALYSIS posts specifically (the text itself is
 * always the full technical breakdown regardless of this — this
 * only decides which image(s), if any, accompany it). Same
 * proportional-fair approach as the "other" content scheduler.
 */
const ANALYSIS_MEDIA_TYPES = [
  { key: "no_image", weight: 60 },
  { key: "chart_only", weight: 16 },
  { key: "chart_plus_coin", weight: 16 },
  { key: "coin_only", weight: 8 }
];

/*
 * Occasional long-form "deep dive" analysis for major coins only
 * (chooseCoin's "majors" tier) — a genuinely longer, more
 * explanatory piece (real article via publish()'s title support),
 * not just another quick angle. Kept rare and majors-only per
 * "an important coin... explained in detail" / "an excellent
 * occasion" — this is meant to feel like an occasional event, not
 * the default.
 */
const DEPTH_TARGETS = [
  { key: "normal", weight: 85 },
  { key: "deep", weight: 15 }
];

function selectDepth(history) {
  const recentMajors = history
    .filter(
      x => x && x.type === "analysis" && x.tier === "majors" && x.depth
    )
    .slice(-20);

  const total = recentMajors.length || 1;

  let best = DEPTH_TARGETS[0].key;
  let bestDeficit = -Infinity;

  for (const t of DEPTH_TARGETS) {
    const count = recentMajors.filter(
      x => x.depth === t.key
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

function selectAnalysisMedia(history) {
  const recentAnalysis = history
    .filter(x => x && x.type === "analysis" && x.media)
    .slice(-40);

  const total = recentAnalysis.length || 1;

  let best = ANALYSIS_MEDIA_TYPES[0].key;
  let bestDeficit = -Infinity;

  for (const t of ANALYSIS_MEDIA_TYPES) {
    const count = recentAnalysis.filter(
      x => x.media === t.key
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
/*
 * Top-level type split. Targets ~15 analysis posts/day (revised
 * down from the earlier ~20 request), against ~30 posts/day
 * total at the 39-45 min interval (including polling overhead)
 * — i.e. ~50% analysis / 50% other. Tracked adaptively the same
 * way as the other schedulers rather than a fixed cycle.
 */
/*
 * Spec 23: 60% of analysis posts carry no hashtags at all,
 * 40% may. Spec 25: don't always end with "What do you think?" —
 * vary the CTA, and sometimes have none.
 */
const HASHTAG_USE_TARGETS = [
  { key: "none", weight: 60 },
  { key: "some", weight: 40 }
];

function selectHashtagUse(history) {
  const recent = history
    .filter(x => x && x.type === "analysis" && x.hashtags)
    .slice(-40);

  const total = recent.length || 1;

  let best = HASHTAG_USE_TARGETS[0].key;
  let bestDeficit = -Infinity;

  for (const t of HASHTAG_USE_TARGETS) {
    const count = recent.filter(
      x => x.hashtags === t.key
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

const ANALYSIS_CTAS = [
  "🤔 Would you watch this level?",
  "🤔 Would a 4H close change your view?",
  "🤔 Which level matters more here?",
  "🤔 What would invalidate this setup for you?",
  "📊 The volume here is the part I'm watching most."
];

function pickCta(history) {
  const pastCtaCount = history.filter(
    x => x && x.type === "analysis" && x.angle !== null
  ).length;

  return ANALYSIS_CTAS[pastCtaCount % ANALYSIS_CTAS.length];
}

const POST_TYPE_TARGETS = [
  { key: "analysis", weight: 50 },
  { key: "other", weight: 50 }
];

function selectPostType(history) {
  const recent = history
    .filter(x => x && x.type && x.published === true)
    .slice(-40);

  const total = recent.length || 1;

  let best = POST_TYPE_TARGETS[0].key;
  let bestDeficit = -Infinity;

  for (const t of POST_TYPE_TARGETS) {
    const count = recent.filter(
      x => x.type === t.key
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
 * Target mix for the "other" bucket. Rebalanced from the
 * original 20%-bucket proportions now that "other" is the
 * majority of daily content (~57%): education and news stay
 * dominant per the spec, poll is raised because direct
 * questions drive the reply/engagement CreatorPad's 2026
 * scoring actually rewards, and market_snapshot/project_study
 * are trimmed slightly to make room.
 */
const OTHER_CONTENT_TYPES = [
  { key: "education", weight: 25 },
  { key: "news", weight: 20 },
  { key: "poll", weight: 10 },
  { key: "market_snapshot", weight: 12 },
  { key: "top_movers", weight: 10 },
  { key: "bull_bear", weight: 10 },
  { key: "project_study", weight: 8 },
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

  return `🗣️ ${question}

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

  return `ℹ️ ${note.body}

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

  return `🔍 $${coin.asset} is ${note}

💰 Price: ${money(coin.price)}
${coin.change >= 0 ? "🟢" : "🔴"} 24H Change: ${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}%
📊 24H Volume: ${compact(coin.volume)}

🧠 Informational only — not financial advice, always do your own research.

#Crypto #Binance #${coin.asset}`;
}

/*
 * Long-form article (real Binance Square article via
 * post-text.mjs --title, contentType=2, up to 80,000 chars),
 * not a short post padded out. Genuine multi-section depth
 * built entirely from the same real coins/market data already
 * fetched — a market-breadth digest rather than a single-coin
 * analysis, so it doesn't compete with or duplicate the
 * analysis posts.
 */
function reportPost(coins) {
  const sorted = [...coins].sort(
    (a, b) => b.change - a.change
  );

  const gainers = sorted.slice(0, 5);
  const losers = sorted
    .slice(-5)
    .reverse()
    .filter(c => !gainers.includes(c));

  const advancing = coins.filter(
    c => c.change > 0
  ).length;

  const declining = coins.length - advancing;

  const totalVolume = coins.reduce(
    (sum, c) => sum + c.volume,
    0
  );

  const btc = coins.find(c => c.asset === "BTC");
  const eth = coins.find(c => c.asset === "ETH");

  const breadthLine =
    advancing > declining * 1.3
      ? "More assets are advancing than declining across the tracked Spot pairs, a broadly constructive backdrop."
      : declining > advancing * 1.3
        ? "More assets are declining than advancing across the tracked Spot pairs, a broadly cautious backdrop."
        : "Advancing and declining assets are roughly balanced — a mixed, rotation-driven backdrop rather than a clear market-wide direction.";

  const title = `Crypto Market Report — ${new Date().toISOString().slice(0, 10)}`;

  /*
   * Plain tickers here (no $) — the BTC/ETH highlight line
   * below already accounts for 2 tagged cashtags, and this
   * report can list up to 10 assets between gainers/losers,
   * which would otherwise trip the same "coin pair count"
   * limit fixed in topMoversPost/whatToWatchPost.
   */
  const gainersList = gainers
    .map(
      c =>
        `• ${c.asset}: ${money(c.price)} (${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}%)`
    )
    .join("\n");

  const losersList = losers
    .map(
      c =>
        `• ${c.asset}: ${money(c.price)} (${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)}%)`
    )
    .join("\n");

  const body = `📊 Market Overview

${breadthLine}

Tracked Spot volume (24H, liquid USDT pairs): ${compact(totalVolume)}
Advancing: ${advancing} • Declining: ${declining}

${btc ? `$BTC: ${money(btc.price)} (${btc.change >= 0 ? "+" : ""}${btc.change.toFixed(2)}%)` : ""}
${eth ? `$ETH: ${money(eth.price)} (${eth.change >= 0 ? "+" : ""}${eth.change.toFixed(2)}%)` : ""}

📈 Top Gainers (24H)

${gainersList}

📉 Top Losers (24H)

${losersList}

🧭 What This Means

A market breadth reading like this describes participation, not direction on any single asset — a handful of large-cap movers can pull the overall picture in either direction even when breadth disagrees. Worth checking price action on any specific asset individually before drawing conclusions from the aggregate numbers here.

🧠 This report is informational market data only — not financial advice.

#Crypto #Binance #MarketReport #CryptoMarket`;

  return { title, body };
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

  const idMatch = stdout.match(/^ID:\s*(.+)$/m);
  const linkMatch = stdout.match(/^Link:\s*(.+)$/m);

  const postId =
    idMatch && idMatch[1].trim() !== "unavailable"
      ? idMatch[1].trim()
      : null;

  const postLink =
    linkMatch && linkMatch[1].trim() !== "unavailable"
      ? linkMatch[1].trim()
      : null;

  return { stdout, stderr, postId, postLink };
}

/*
 * Publishes text content, optionally with 0-4 images.
 *
 * images: null/undefined/[] -> text-only post (post-text.mjs)
 *         string             -> single image (back-compat)
 *         string[] (1-4)     -> image post (post-image.mjs,
 *                                comma-separated, official max is 4)
 */
function publish(text, images, title) {
  /*
   * Validate cheap, pure inputs before touching the filesystem
   * for the Skill directory or the environment for the API key —
   * fail fast with the most relevant error, and let these checks
   * run in tests without requiring the Skill to be installed.
   */
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

  const scriptsDir = findSkillScriptsDir();

  console.log("Publishing Binance Square post...");
  console.log(
    imageList.length
      ? `Images (${imageList.length}): ${imageList.join(", ")}`
      : "Images: none (text-only post)"
  );

  if (title) {
    console.log(`Article title: ${title}`);
  }

  if (imageList.length === 0) {
    const args = title
      ? ["--text", text, "--title", title]
      : ["--text", text];

    return runSkillScript(
      path.join(scriptsDir, "post-text.mjs"),
      args
    );
  }

  if (title) {
    if (imageList.length > 1) {
      throw new Error(
        "Article posts support exactly one cover image."
      );
    }

    return runSkillScript(
      path.join(scriptsDir, "post-image.mjs"),
      [
        "--text",
        text,
        "--title",
        title,
        "--cover",
        imageList[0]
      ]
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
    ),
    path.join(
      ROOT,
      "bot",
      "coin-card.png"
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
   * Adaptive type split (~50% analysis / 50% other, i.e. about
   * 15 analysis posts out of this bot's ~30 posts/day at the
   * 39-45 min interval), tracked over the same rolling window
   * as the other schedulers rather than a fixed per-5-posts
   * cycle.
   */
  let type = selectPostType(history);
  let text;
  let asset = null;
  let image = null;
  let subtype = null;
  let angle = null;
  let media = null;
  let title = null;
  let hashtags = null;
  let newsUrl = null;
  let tier = null;
  let depth = null;

  if (type === "analysis") {
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

    tier = coin.tier;

    const depthChoice =
      coin.tier === "majors"
        ? selectDepth(history)
        : "normal";

    depth = depthChoice;

    if (depthChoice === "deep") {
      const deep = deepAnalysisText(coin, candles);

      title = deep.title;
      text = deep.body;
      image = null;
      media = "no_image";
      hashtags = "some";
    } else {
      angle = pastAnalysisCount % 6;

      const hashtagUse = selectHashtagUse(history);
      hashtags = hashtagUse;
      const includeHashtags = hashtagUse === "some";

      const cta =
        angle === 3 || angle === 5
          ? pickCta(history)
          : null;

      text =
        analysisText(
          coin,
          candles,
          angle,
          includeHashtags,
          cta
        );

      media = selectAnalysisMedia(history);

      if (media === "chart_only") {
        image = createAnalysisChart(coin.symbol, angle);
      } else if (media === "coin_only") {
        image = createCoinCardImage(coin.symbol, pastAnalysisCount);
      } else if (media === "chart_plus_coin") {
        image = [
          createAnalysisChart(coin.symbol, angle),
          createCoinCardImage(coin.symbol, pastAnalysisCount)
        ];
      }
      /* media === "no_image" -> image stays null (text-only) */
    }
  } else {
    type = "other";

    subtype = selectOtherType(history);

    if (subtype === "news") {
      const news =
        await getNews(history);

      if (news.length) {
        const article =
          news[0];

        newsUrl = article.url || null;

        text = `${article.title}

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
      const pastEducationCount = history.filter(
        x => x && x.subtype === "education"
      ).length;

      /*
       * Alternate short educational posts with genuine
       * long-form articles (real Binance Square article mode,
       * not a padded-out short post) — per the requested
       * "don't forget reports" and the spec's 50/50 education
       * split.
       */
      if (pastEducationCount % 2 === 1) {
        const report = reportPost(coins);

        title = report.title;
        text = report.body;
        image = null;
      } else {
        const topics = [
          "candlesticks",
          "breakout",
          "rsi"
        ];

        const topic =
          topics[
            Math.floor(pastEducationCount / 2) %
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
      }
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
  const publishResult = publish(
    text,
    images,
    title
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
    media,
    title,
    hashtags,
    postId: publishResult
      ? publishResult.postId
      : null,
    postLink: publishResult
      ? publishResult.postLink
      : null,
    newsUrl,
    tier,
    depth,
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

/*
 * Exported for bot/test.mjs. Pure/logic functions only —
 * network-dependent functions (getSpotCoins, getKlines, getNews,
 * createNewsImage, downloadImage, getJson) are exported too so
 * tests can mock fetch around them, but are not called live in
 * the test suite itself.
 */
export {
  randomPostIntervalMs,
  money,
  compact,
  sma,
  ema,
  rsi,
  loadHistory,
  saveHistory,
  loadHealth,
  saveHealth,
  recordSuccess,
  recordFailure,
  getLastPublished,
  canPublish,
  chooseCoin,
  analysisText,
  deepAnalysisText,
  selectDepth,
  DEPTH_TARGETS,
  topMoversPost,
  marketUpdatePost,
  bullBearPost,
  whatToWatchPost,
  educationPost,
  selectAnalysisMedia,
  ANALYSIS_MEDIA_TYPES,
  selectHashtagUse,
  HASHTAG_USE_TARGETS,
  pickCta,
  ANALYSIS_CTAS,
  selectPostType,
  POST_TYPE_TARGETS,
  selectOtherType,
  OTHER_CONTENT_TYPES,
  pollPost,
  ecosystemPost,
  ECOSYSTEM_NOTES,
  projectStudyPost,
  PROJECT_NOTES,
  reportPost,
  findSkillScriptsDir,
  redactSecret,
  runSkillScript,
  publish,
  cleanup,
  getJson,
  getSpotCoins,
  getKlines,
  getNews,
  createNewsImage,
  downloadImage,
  main
};

/*
 * Only auto-run when executed directly (node bot/index.mjs),
 * not when imported — e.g. by bot/test.mjs. Standard Node
 * entry-point guard, so the real functions above can be
 * unit-tested without a regex-stripping hack.
 */
if (
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch(err => {
    console.error(
      "❌ Bot failed:",
      err
    );

    recordFailure(err);

    process.exit(1);
  });
}
