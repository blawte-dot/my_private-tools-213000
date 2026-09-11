/*
 * Post-visibility monitoring (spec: AI_MONITORING_ADDENDUM,
 * sections I/J/K). Runs as a SEPARATE script/workflow from the
 * publishing bot — a failure or slowdown here must never affect
 * publishing.
 *
 * Real, verified findings this is built on:
 * - The public, no-login post page is
 *   https://www.binance.com/en/square/post/{id} — confirmed
 *   reachable and rendering real content.
 * - The exact DOM/JSON structure of that page was NOT directly
 *   inspectable from the environment this was built in (only a
 *   processed/markdown view of the page was available, not raw
 *   HTML). So this tries several plausible embedded-JSON key
 *   patterns for a view count and takes the first match — if
 *   NONE match, it records "unavailable" with the reasons tried,
 *   rather than ever guessing from unlabeled visible numbers.
 *   This extraction's real reliability can only be confirmed by
 *   watching its actual output once run for real (which logs
 *   exactly what was tried and found/not found).
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const STATS_FILE = path.join(ROOT, "data", "post-stats.json");

/*
 * Candidate patterns for an embedded view-count value in the raw
 * HTML — common key names used by similar platforms. Whichever
 * matches first is used; if none match, the result is
 * "unavailable", never a guess.
 */
const VIEW_COUNT_PATTERNS = [
  /"viewNum"\s*:\s*(\d+)/,
  /"viewCount"\s*:\s*(\d+)/,
  /"pv"\s*:\s*(\d+)/,
  /"readNum"\s*:\s*(\d+)/,
  /"browseNum"\s*:\s*(\d+)/,
  /"visitNum"\s*:\s*(\d+)/
];

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveStats(stats) {
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

async function fetchViewCount(postId) {
  const url = `https://www.binance.com/en/square/post/${postId}`;

  let html;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    if (!res.ok) {
      return {
        views: null,
        status: "unavailable",
        reason: `HTTP ${res.status}`
      };
    }

    html = await res.text();
  } catch (err) {
    return {
      views: null,
      status: "unavailable",
      reason: `fetch failed: ${err.message}`
    };
  }

  for (const pattern of VIEW_COUNT_PATTERNS) {
    const match = html.match(pattern);

    if (match) {
      return {
        views: Number(match[1]),
        status: "ok",
        reason: `matched pattern ${pattern}`
      };
    }
  }

  /*
   * TEMPORARY diagnostic: none of the guessed patterns matched.
   * Save a sample of the real raw HTML — only the first one this
   * run finds (skip if already saved and non-empty this run, and
   * skip saving if this particular fetch came back suspiciously
   * short/empty) — so the actual structure can be inspected via
   * git pull instead of guessing further. Remove this once real
   * patterns are identified and confirmed working.
   */
  const debugPath = path.join(ROOT, "data", "debug-post-html-sample.txt");

  if (html && html.length > 500) {
    try {
      const alreadySaved =
        fs.existsSync(debugPath) && fs.statSync(debugPath).size > 500;

      if (!alreadySaved) {
        fs.writeFileSync(debugPath, html.slice(0, 50000));
      }
    } catch {
      // non-critical, ignore
    }
  }

  return {
    views: null,
    status: "unavailable",
    reason: `no known pattern matched (tried ${VIEW_COUNT_PATTERNS.length} patterns), html length ${html ? html.length : 0}`
  };
}

async function main() {
  const history = loadJson(HISTORY_FILE, []);
  const stats = loadJson(STATS_FILE, {});

  /*
   * Monitor posts from the last 48h that have a real postId —
   * older posts aren't worth re-checking as often, and posts
   * without a postId (Skill reported "unavailable") can't be
   * looked up at all.
   */
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;

  const candidates = history.filter(
    x =>
      x &&
      x.postId &&
      x.time &&
      new Date(x.time).getTime() >= cutoff
  );

  console.log(
    `Checking ${candidates.length} recent post(s) with a known postId...`
  );

  let checked = 0;
  let found = 0;

  for (const entry of candidates) {
    const result = await fetchViewCount(entry.postId);

    checked++;
    if (result.status === "ok") found++;

    const existing = stats[entry.postId] || { history: [] };

    existing.postId = entry.postId;
    existing.asset = entry.asset || null;
    existing.type = entry.type || null;
    existing.publishedAt = entry.time;
    existing.lastChecked = new Date().toISOString();
    existing.lastStatus = result.status;
    existing.lastReason = result.reason;
    existing.views = result.views ?? existing.views ?? null;

    existing.history = [
      ...(existing.history || []),
      {
        checkedAt: existing.lastChecked,
        views: result.views,
        status: result.status
      }
    ].slice(-20);

    stats[entry.postId] = existing;

    console.log(
      `postId ${entry.postId} (${entry.asset || "?"}): ${result.status} — ${result.reason}`
    );

    /*
     * Small delay between requests — polite to Binance's public
     * page and avoids looking like a scraping burst.
     */
    await new Promise(r => setTimeout(r, 1500));
  }

  saveStats(stats);

  console.log(
    `Done. Checked ${checked}, got a view count for ${found}.`
  );
}

if (
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch(err => {
    console.error("Monitor script failed:", err);
    // Never exit non-zero — this must never be treated as a
    // pipeline failure by anything watching this workflow.
    process.exit(0);
  });
}

export { fetchViewCount, VIEW_COUNT_PATTERNS };
