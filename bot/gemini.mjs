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

import { GoogleGenAI, Type } from "@google/genai";

const MODEL = "gemini-2.5-flash";

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
 * Reviews a drafted post before it publishes. Returns the parsed
 * judgment object, or null if Gemini is unavailable/misconfigured/
 * failed/returned something unusable — callers must treat null as
 * "no opinion, proceed normally", never as a reason to fail the
 * whole publish.
 */
export async function judgeContent({
  text,
  asset,
  contentType,
  angle,
  recentSummary
}) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.log(
      "GEMINI_API_KEY not set — skipping quality gate, publishing as drafted."
    );

    return null;
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
      console.log(
        "Gemini returned an empty response — proceeding without a quality-gate opinion."
      );

      return null;
    }

    const parsed = validateJudgment(JSON.parse(raw));

    if (!parsed) {
      console.log(
        "Gemini response failed validation — proceeding without a quality-gate opinion:",
        raw
      );

      return null;
    }

    return parsed;
  } catch (err) {
    const safeMessage = apiKey
      ? err.message.split(apiKey).join("[REDACTED]")
      : err.message;

    console.log(
      "Gemini quality gate failed (network/API error) — proceeding without a quality-gate opinion:",
      safeMessage
    );

    return null;
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
