/**
 * Shape checks for a pasted Bedrock API key (FR-4.2).
 *
 * AWS does not document the key format, so every rule here rejects things that
 * are certainly *not* a Bedrock key rather than trying to recognise one that
 * is. A rule that turns away a real key costs the user their whole setup and
 * leaves them no way through; a rule that lets a wrong value past costs them one
 * "Test connection" click. The asymmetry decides every judgement call below.
 */

import type { ShapeProblem, ShapeVerdict } from "./types.js";

/** Prefixes seen on real keys: `ABSK…` long-term, `bedrock-api-key-…` short-term. */
const KNOWN_PREFIXES = ["ABSK", "bedrock-api-key-"] as const;

/** An AWS access key ID: `AKIA` plus sixteen upper-case alphanumerics. */
const ACCESS_KEY_ID = /^AKIA[0-9A-Z]{16}$/;

/** An AWS secret access key: forty unpadded base64 characters and nothing else. */
const SECRET_ACCESS_KEY = /^[A-Za-z0-9+/]{40}$/;

/** Below this a value cannot plausibly be a key — but we only warn (see file header). */
const MIN_PLAUSIBLE_LENGTH = 20;

/**
 * The value we would actually store for `candidate`. Exported so the entry flow
 * stores exactly what was validated: validating the trimmed value and storing
 * the untrimmed one would put a stray newline in the `Authorization` header.
 */
export function normalizeToken(candidate: string): string {
  return candidate.trim();
}

export function validateTokenShape(candidate: string): ShapeVerdict | undefined {
  const value = normalizeToken(candidate);

  if (value === "") {
    return { problem: "empty", severity: "error" };
  }
  if (/\s/.test(value)) {
    return { problem: "whitespace-inside", severity: "error" };
  }
  if (ACCESS_KEY_ID.test(value)) {
    return { problem: "looks-like-access-key-id", severity: "error" };
  }
  // Guarded by the prefixes so a (hypothetical) short key that still announces
  // itself as a Bedrock key is never mistaken for an IAM secret.
  if (SECRET_ACCESS_KEY.test(value) && !hasKnownPrefix(value)) {
    return { problem: "looks-like-secret-access-key", severity: "error" };
  }
  if (value.length < MIN_PLAUSIBLE_LENGTH) {
    return { problem: "too-short", severity: "warning" };
  }
  return undefined;
}

function hasKnownPrefix(value: string): boolean {
  return KNOWN_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * FR-5.3: written for someone who does not know what an environment variable
 * is. No variable names, no status codes, no AWS jargon beyond the two words
 * printed on the console page the user just came from.
 */
export const SHAPE_MESSAGES: Record<ShapeProblem, string> = {
  empty: "Paste your Bedrock API key here.",
  "whitespace-inside":
    "This has a space or a line break inside it, so it was probably copied with some extra text. Copy just the key.",
  "looks-like-access-key-id":
    "This looks like an AWS access key ID, not a Bedrock API key. Bedrock API keys come from the API keys page of the Bedrock console.",
  "looks-like-secret-access-key":
    "This looks like an AWS secret access key, not a Bedrock API key. Bedrock API keys come from the API keys page of the Bedrock console.",
  "too-short":
    "This is shorter than a Bedrock API key usually is — check you copied all of it. You can still use it if you are sure it is right.",
};
