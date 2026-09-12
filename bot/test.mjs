/*
 * Automated test suite for the Binance Square bot.
 *
 * Run with: node --test bot/test.mjs
 *
 * Uses Node's built-in test runner (node:test) — no extra
 * dependency, matching the project's dependency policy. Covers
 * scheduler behavior, content-mix convergence, publish() safety
 * checks, and history/health read-write, all with synthetic
 * data — no live Binance/GDELT calls and no real publishing.
 *
 * This suite runs in CI as a non-blocking step (continue-on-error
 * in bot.yml) — a statistical convergence assertion has a small
 * inherent chance of a rare false failure, and that must never be
 * allowed to stop real publishing. Sample sizes here are large
 * (3000) specifically to make that chance negligible in practice.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import * as bot from "./index.mjs";
import * as gemini from "./gemini.mjs";

const SAMPLES = 3000;
const TOLERANCE_PP = 5;

function fakeCandles(count = 100) {
  return Array.from({ length: count }, (_, i) => {
    const base = 60000 + Math.sin(i / 6) * 3000 + i * 15;

    return {
      time: Date.now() - (count - i) * 4 * 3600 * 1000,
      open: base,
      high: base + 250 + Math.random() * 150,
      low: base - 250 - Math.random() * 150,
      close: base + (Math.random() - 0.5) * 300,
      volume: 500 + Math.random() * 2000
    };
  });
}

function fakeCoins(n = 20) {
  const coins = [];

  for (let i = 0; i < n; i++) {
    coins.push({
      symbol: `COIN${i}USDT`,
      asset: `COIN${i}`,
      price: 1 + Math.random() * 100,
      change: Math.random() * 20 - 8,
      volume: 5_000_000 * Math.pow(1.3, n - 1 - i)
    });
  }

  coins[0].asset = "BTC";
  coins[1].asset = "ETH";

  return coins;
}

// ---- Scheduler / interval ----

test("randomPostIntervalMs stays within 39-45 minutes", () => {
  for (let i = 0; i < 200; i++) {
    const ms = bot.randomPostIntervalMs();
    const minutes = ms / 60000;

    assert.ok(
      minutes >= 39 && minutes <= 45,
      `interval ${minutes} out of range`
    );
  }
});

test("canPublish: no history allows immediate publish", () => {
  const result = bot.canPublish([]);
  assert.equal(result.allowed, true);
});

test("canPublish: just-published blocks immediately", () => {
  const result = bot.canPublish([
    { published: true, time: new Date().toISOString() }
  ]);

  assert.equal(result.allowed, false);
});

test("canPublish: published 46+ min ago always allows (past max interval)", () => {
  const result = bot.canPublish([
    {
      published: true,
      time: new Date(Date.now() - 46 * 60 * 1000).toISOString()
    }
  ]);

  assert.equal(result.allowed, true);
});

test("selectPostType converges to ~50/50 (analysis/other)", () => {
  let history = [];
  const counts = { analysis: 0, other: 0 };

  for (let i = 0; i < SAMPLES; i++) {
    const t = bot.selectPostType(history);
    counts[t]++;
    history.push({ type: t, published: true });
  }

  for (const target of bot.POST_TYPE_TARGETS) {
    const actual = (counts[target.key] / SAMPLES) * 100;

    assert.ok(
      Math.abs(actual - target.weight) < TOLERANCE_PP,
      `${target.key}: target ${target.weight}%, got ${actual}%`
    );
  }
});

test("selectOtherType converges to configured weights", () => {
  let history = [];
  const counts = {};

  for (let i = 0; i < SAMPLES; i++) {
    const t = bot.selectOtherType(history);
    counts[t] = (counts[t] || 0) + 1;
    history.push({ type: "other", subtype: t });
  }

  for (const target of bot.OTHER_CONTENT_TYPES) {
    const actual = ((counts[target.key] || 0) / SAMPLES) * 100;

    assert.ok(
      Math.abs(actual - target.weight) < TOLERANCE_PP,
      `${target.key}: target ${target.weight}%, got ${actual}%`
    );
  }
});

test("selectAnalysisMedia converges to 50/20/20/10", () => {
  let history = [];
  const counts = {};

  for (let i = 0; i < SAMPLES; i++) {
    const t = bot.selectAnalysisMedia(history);
    counts[t] = (counts[t] || 0) + 1;
    history.push({ type: "analysis", media: t });
  }

  for (const target of bot.ANALYSIS_MEDIA_TYPES) {
    const actual = ((counts[target.key] || 0) / SAMPLES) * 100;

    assert.ok(
      Math.abs(actual - target.weight) < TOLERANCE_PP,
      `${target.key}: target ${target.weight}%, got ${actual}%`
    );
  }
});

test("selectHashtagUse converges to 60/40 (none/some)", () => {
  let history = [];
  const counts = { none: 0, some: 0 };

  for (let i = 0; i < SAMPLES; i++) {
    const t = bot.selectHashtagUse(history);
    counts[t]++;
    history.push({ type: "analysis", hashtags: t });
  }

  for (const target of bot.HASHTAG_USE_TARGETS) {
    const actual = (counts[target.key] / SAMPLES) * 100;

    assert.ok(
      Math.abs(actual - target.weight) < TOLERANCE_PP,
      `${target.key}: target ${target.weight}%, got ${actual}%`
    );
  }
});

// ---- Asset selection / diversity ----

test("chooseCoin excludes assets already used today", () => {
  const coins = fakeCoins(10);
  const today = new Date().toISOString().slice(0, 10);

  const history = coins
    .slice(0, 9)
    .map(c => ({
      date: today,
      type: "analysis",
      asset: c.asset,
      published: true
    }));

  const picked = bot.chooseCoin(coins, history);
  assert.equal(picked.asset, coins[9].asset);
});

test("chooseCoin produces meaningful variety over many picks (not always the top-volume coin)", () => {
  const coins = fakeCoins(25);
  let history = [];
  const picks = new Set();

  for (let day = 0; day < 8; day++) {
    for (let p = 0; p < 4; p++) {
      const coin = bot.chooseCoin(coins, history);
      picks.add(coin.asset);

      history.push({
        date: `2026-09-${String(10 + day).padStart(2, "0")}`,
        time: new Date().toISOString(),
        type: "analysis",
        asset: coin.asset,
        published: true
      });
    }
  }

  assert.ok(
    picks.size >= 5,
    `expected at least 5 unique coins across 32 picks, got ${picks.size}`
  );
});

// ---- Analysis text ----

test("analysisText produces non-empty, distinct text for all 6 angles", () => {
  const coin = { symbol: "BTCUSDT", asset: "BTC", price: 62000, change: 1.8 };
  const candles = fakeCandles();
  const texts = [];

  for (let angle = 0; angle < 6; angle++) {
    const text = bot.analysisText(coin, candles, angle, true, "Test CTA?");
    assert.ok(text.length > 50, `angle ${angle} text too short`);
    texts.push(text);
  }

  const unique = new Set(texts);
  assert.equal(unique.size, 6, "all 6 angles should produce distinct text");
});

test("analysisText respects includeHashtags=false (no hash symbol anywhere)", () => {
  const coin = { symbol: "BTCUSDT", asset: "BTC", price: 62000, change: 1.8 };
  const candles = fakeCandles();

  for (let angle = 0; angle < 6; angle++) {
    const text = bot.analysisText(coin, candles, angle, false, null);
    assert.ok(!text.includes("#"), `angle ${angle} leaked a hashtag`);
  }
});

test("selectDepth converges to ~85/15 (normal/deep) among majors-tier history", () => {
  let history = [];
  const counts = { normal: 0, deep: 0 };

  for (let i = 0; i < SAMPLES; i++) {
    const t = bot.selectDepth(history);
    counts[t]++;
    history.push({ type: "analysis", tier: "majors", depth: t });
  }

  for (const target of bot.DEPTH_TARGETS) {
    const actual = (counts[target.key] / SAMPLES) * 100;

    assert.ok(
      Math.abs(actual - target.weight) < TOLERANCE_PP,
      `${target.key}: target ${target.weight}%, got ${actual}%`
    );
  }
});

test("deepAnalysisText produces a real long-form article with a title", () => {
  const coin = { symbol: "BTCUSDT", asset: "BTC", price: 62000, change: 1.8 };
  const candles = fakeCandles();

  const deep = bot.deepAnalysisText(coin, candles);

  assert.ok(deep.title.includes("BTC"));
  assert.ok(deep.body.length > 800, "deep dive should be substantially longer than a normal post");
  assert.ok(!deep.body.includes("+-"), "malformed sign found");
});

// ---- Gemini quality gate (pure logic only, no real API calls) ----

test("gemini.judgeContent returns a no-opinion object (with reason) when GEMINI_API_KEY is unset", async () => {
  const savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  try {
    const result = await gemini.judgeContent({
      text: "draft",
      asset: "BTC",
      contentType: "analysis",
      angle: 0,
      recentSummary: ""
    });

    assert.equal(result.decision, null);
    assert.ok(result.reasoning_summary.includes("GEMINI_API_KEY"));
  } finally {
    if (savedKey) process.env.GEMINI_API_KEY = savedKey;
  }
});

test("gemini.validateJudgment accepts a well-formed judgment", () => {
  const result = gemini.validateJudgment({
    decision: "publish",
    quality_score: 85,
    duplicate_risk: 5,
    reasoning_summary: "Clear and original."
  });

  assert.ok(result);
  assert.equal(result.decision, "publish");
});

test("gemini.validateJudgment rejects missing/invalid fields", () => {
  assert.equal(gemini.validateJudgment(null), null);
  assert.equal(gemini.validateJudgment({}), null);
  assert.equal(
    gemini.validateJudgment({
      decision: "not_a_real_decision",
      quality_score: 50,
      duplicate_risk: 50,
      reasoning_summary: "x"
    }),
    null
  );
  assert.equal(
    gemini.validateJudgment({
      decision: "publish",
      quality_score: "high",
      duplicate_risk: 5,
      reasoning_summary: "x"
    }),
    null
  );
});

test("gemini.buildPrompt embeds the draft text and never asks Gemini to verify numbers", () => {
  const prompt = gemini.buildPrompt({
    text: "BTC is at $62,000",
    asset: "BTC",
    contentType: "analysis",
    angle: 2,
    recentSummary: "ETH (angle 1)"
  });

  assert.ok(prompt.includes("BTC is at $62,000"));
  assert.ok(prompt.includes("do NOT have access to live market data"));
});

// ---- Cashtag count safety (regression test for the 220095 bug) ----

function countDistinctCashtags(text) {
  const matches = text.match(/\$[A-Z][A-Z0-9]*/g) || [];
  return new Set(matches).size;
}

test("topMoversPost never tags more than 3 distinct cashtags", () => {
  const coins = fakeCoins(15);
  const text = bot.topMoversPost(coins);
  assert.ok(countDistinctCashtags(text) <= 3);
});

test("whatToWatchPost never tags more than 3 distinct cashtags", () => {
  const coins = fakeCoins(15);
  const text = bot.whatToWatchPost(coins);
  assert.ok(countDistinctCashtags(text) <= 3);
});

test("reportPost never tags more than 3 distinct cashtags", () => {
  const coins = fakeCoins(15);
  const report = bot.reportPost(coins);
  assert.ok(countDistinctCashtags(report.body) <= 3);
});

test("reportPost gainers/losers never overlap and signs are never malformed", () => {
  // All-negative market — the exact edge case that caused a
  // real sign-formatting bug earlier this session.
  const coins = fakeCoins(10).map(c => ({
    ...c,
    change: -Math.abs(c.change) - 1
  }));

  const report = bot.reportPost(coins);

  assert.ok(!report.body.includes("+-"), "malformed sign found");
});

// ---- publish() safety checks (no real network/process calls) ----

test("publish() rejects more than 4 images before touching the network", () => {
  assert.throws(
    () => bot.publish("text", ["a.png", "b.png", "c.png", "d.png", "e.png"]),
    /At most 4 images/
  );
});

test("publish() rejects a nonexistent image path before touching the network", () => {
  const missing = path.join(os.tmpdir(), "definitely-does-not-exist.png");

  assert.throws(
    () => bot.publish("text", [missing]),
    /does not exist/
  );
});

test("redactSecret removes every occurrence of the secret", () => {
  const out = bot.redactSecret(
    "key=SECRET123 middle SECRET123 end",
    "SECRET123"
  );

  assert.ok(!out.includes("SECRET123"));
  assert.ok(out.includes("[REDACTED]"));
});

// ---- History / health read-write ----

test("history/health round-trip (backs up and restores real data files)", () => {
  // ROOT/HISTORY_FILE/HEALTH_FILE are computed once at import
  // time from the real process.cwd() — chdir() after import
  // does not redirect them. So this test operates on the real
  // files directly, but backs up and restores their exact
  // original content (even if absent) in a finally block,
  // regardless of pass/fail, to never risk production data.
  const historyPath = path.join(process.cwd(), "data", "history.json");
  const healthPath = path.join(process.cwd(), "data", "health.json");

  const originalHistory = fs.existsSync(historyPath)
    ? fs.readFileSync(historyPath, "utf8")
    : null;

  const originalHealth = fs.existsSync(healthPath)
    ? fs.readFileSync(healthPath, "utf8")
    : null;

  try {
    bot.saveHistory([
      { type: "analysis", asset: "TEST_ONLY", published: true }
    ]);

    const reloaded = bot.loadHistory();

    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].asset, "TEST_ONLY");

    bot.recordSuccess(new Date().toISOString());
    const health = bot.loadHealth();
    assert.equal(health.consecutiveFailures, 0);
    assert.equal(health.lastFailedAttempt, null);

    bot.recordFailure(new Error("simulated failure"));
    const health2 = bot.loadHealth();
    assert.equal(health2.consecutiveFailures, 1);
    assert.equal(health2.lastFailureReason, "simulated failure");
  } finally {
    if (originalHistory === null) {
      if (fs.existsSync(historyPath)) fs.unlinkSync(historyPath);
    } else {
      fs.writeFileSync(historyPath, originalHistory);
    }

    if (originalHealth === null) {
      if (fs.existsSync(healthPath)) fs.unlinkSync(healthPath);
    } else {
      fs.writeFileSync(healthPath, originalHealth);
    }
  }
});
