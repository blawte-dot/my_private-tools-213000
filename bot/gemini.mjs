/*
 * Gemini quality-gate layer (spec: CLAUDE_BINANCE_SQUARE_AI_MONITORING_ADDENDUM).
 *
 * Division of responsibility (per the spec's section N):
 * - Binance market data remains the sole source of truth for prices,
 *   indicators, and volume — Gemini never invents or overrides a
 *   number. It only ever sees numbers we already computed from real
 *   Binance data, embedded as plain text in the draft.
 * - Gemini's job here is judgment: quality, originality, duplicate
 *   risk versus recent posts, and a publish/rewrite/skip decision —
 *   not generating the analysis itself. Our existing deterministic
 *   generators (6 analysis angles, deep-dive, etc.) already produce
 *   the content; this module reviews it before it goes out.
 * - Any failure here (missing key, network error, malformed JSON)
 *   degrades gracefully to "allow the post through" — Gemini is a
 *   quality improvement layer, not a new single point of failure
 *   for a bot that must keep publishing.
 */

import { GoogleGenAI, Type, Modality } from "@google/genai";

const MODEL = "gemini-3.6-flash";
const IMAGE_MODEL = "gemini-2.5-flash-image";

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    decision: {
      type: Type.STRING,
      enum: ["publish", "rewrite", "skip"]
    },
    quality_score: { type: Type.NUMBER },
    duplicate_risk: { type: Type.NUMBER },
    reasoning_summary: { type: Type.STRING }
  },
  required: [
    "decision",
    "quality_score",
    "duplicate_risk",
    "reasoning_summary"
  ]
};

/*
 * Pure validation, split out so it can be unit-tested without a
 * real network call. Returns the parsed object if it satisfies the
 * required shape, otherwise null.
 */
export function validateJudgment(parsed) {
  if (
    !parsed ||
    !["publish", "rewrite", "skip"].includes(parsed.decision) ||
    typeof parsed.quality_score !== "number" ||
    typeof parsed.duplicate_risk !== "number" ||
    typeof parsed.reasoning_summary !== "string"
  ) {
    return null;
  }

  return parsed;
}

/*
 * Reviews a drafted post before it publishes. Always returns an
 * object with a `decision` field. On success, decision is one of
 * "publish"/"rewrite"/"skip" with real scores. On any failure
 * (missing key, network error, malformed response), decision is
 * null and reasoning_summary explains why — callers must treat a
 * null decision as "no opinion, proceed normally", but the reason
 * is preserved (and recorded in history) instead of being lost to
 * a log line no one can inspect after the fact.
 */
export async function judgeContent({
  text,
  asset,
  contentType,
  angle,
  recentSummary
}) {
  const noOpinion = reason => ({
    decision: null,
    quality_score: null,
    duplicate_risk: null,
    reasoning_summary: reason
  });

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const reason = "GEMINI_API_KEY not set";
    console.log(`${reason} — publishing as drafted.`);
    return noOpinion(reason);
  }

  const prompt = buildPrompt({
    text,
    asset,
    contentType,
    angle,
    recentSummary
  });

  try {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA
      }
    });

    const raw = response.text;

    if (!raw) {
      const reason = "Gemini returned an empty response";
      console.log(`${reason} — proceeding without a quality-gate opinion.`);
      return noOpinion(reason);
    }

    const parsed = validateJudgment(JSON.parse(raw));

    if (!parsed) {
      const reason = `Gemini response failed validation: ${raw.slice(0, 200)}`;
      console.log(`${reason} — proceeding without a quality-gate opinion.`);
      return noOpinion(reason);
    }

    return parsed;
  } catch (err) {
    const safeMessage = apiKey
      ? err.message.split(apiKey).join("[REDACTED]")
      : err.message;

    const reason = `Gemini call failed: ${safeMessage}`;
    console.log(`${reason} — proceeding without a quality-gate opinion.`);
    return noOpinion(reason);
  }
}

export function buildPrompt({
  text,
  asset,
  contentType,
  angle,
  recentSummary
}) {
  return `You are a quality and originality judge for a crypto content account on Binance Square. You do NOT have access to live market data and must NOT invent, correct, or second-guess any price, percentage, or indicator value mentioned below — treat every number in the draft as already verified and accurate. Your job is only to judge the WRITING: quality, originality versus recent posts, and whether this is worth publishing as-is.

Draft post (asset: ${asset}, content type: ${contentType}, angle: ${angle ?? "n/a"}):
"""
${text}
"""

Recent post summary for duplicate-risk comparison (assets and angles used recently, most recent last):
${recentSummary || "(no recent history available)"}

Judge this draft and respond with the required JSON only:
- decision: "publish" if it's original and clear enough to post as-is; "rewrite" if the idea is fine but wording/structure is too similar to something recent; "skip" only if it's genuinely low-value or essentially a duplicate with nothing new to say.
- quality_score: 0-100, your assessment of clarity, structure, and genuine informational value.
- duplicate_risk: 0-100, how similar this feels to what the recent summary shows, structurally or in conclusion — not just because it's the same asset.
- reasoning_summary: one or two sentences explaining the decision.

Do not be a rubber stamp — a real fraction of drafts should get "rewrite" when they're genuinely repetitive, but most solid, data-grounded drafts should pass as "publish". Never invent a reason involving market data accuracy — that is out of scope for you.`;
}

/*
 * Generates a themed illustration (not a data chart — those stay
 * deterministic and SVG-based) via Gemini's current image model
 * ("Nano Banana"). Used sparingly as one option in the analysis
 * media mix for genuine visual variety. Always returns an object
 * with a `path` field — null on any failure, with `reason`
 * explaining why (same pattern as judgeContent, learned from the
 * model-name issue: the real reason must be preserved in data we
 * can inspect later, not just logged to an Actions run we have no
 * way to read after the fact).
 */
export async function generateMemeImage(prompt, outputPath) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const reason = "GEMINI_API_KEY not set";
    console.log(`${reason} — skipping AI image generation.`);
    return { path: null, reason };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: prompt,
      config: {
        responseModalities: [Modality.IMAGE]
      }
    });

    const parts = response?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.data);

    if (!imagePart) {
      const textPart = parts.find(p => p.text)?.text;

      const reason = textPart
        ? `No image data in response; model said: ${textPart.slice(0, 200)}`
        : "No image data in response (no text explanation either)";

      console.log(`${reason} — skipping.`);
      return { path: null, reason };
    }

    const fs = await import("node:fs");
    const buffer = Buffer.from(imagePart.inlineData.data, "base64");
    fs.writeFileSync(outputPath, buffer);

    return { path: outputPath, reason: null };
  } catch (err) {
    const safeMessage = apiKey
      ? err.message.split(apiKey).join("[REDACTED]")
      : err.message;

    const reason = `Gemini image call failed: ${safeMessage}`;
    console.log(`${reason} — skipping.`);
    return { path: null, reason };
  }
}

/*
 * Suggests a currently-trending crypto topic/hashtag using real
 * Google Search grounding (not just the model's training data) —
 * genuinely current, but NOT Binance's internal daily Task
 * Center tag specifically, which isn't publicly indexed anywhere
 * search can reach. Returns a short plain-text suggestion (e.g.
 * "#Bitcoin100K" or a bare topic phrase) or null on any failure —
 * this is an occasional enhancement, never required for a post.
 */
export async function suggestTrendingTopic() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.log("GEMINI_API_KEY not set — skipping trending-topic lookup.");
    return null;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: MODEL,
      contents:
        "Search the web right now for what's genuinely trending in crypto today (a coin, narrative, or news event getting real attention). Reply with ONLY a single short hashtag or 2-3 word phrase suitable to append to a social media post — no explanation, no punctuation besides an optional #, nothing else.",
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const text = response.text?.trim();

    if (!text || text.length > 40 || text.includes("\n")) {
      console.log(
        `Trending-topic response unusable (${text ? "too long/multiline" : "empty"}) — skipping.`
      );
      return null;
    }

    return text;
  } catch (err) {
    const safeMessage = apiKey
      ? err.message.split(apiKey).join("[REDACTED]")
      : err.message;

    console.log(`Trending-topic lookup failed — skipping: ${safeMessage}`);
    return null;
  }
}
