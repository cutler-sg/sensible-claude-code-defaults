/**
 * How old is the key (FR-4.6)?
 *
 * A proxy, and an honest one: AWS does not tell us when a Bedrock API key
 * expires, and a long-term key's expiry is chosen at creation. All we know is
 * when the user gave it to us, so the check nudges rather than asserts, and the
 * thresholds come from the manifest so they can be retuned without a release.
 */

import { ageInDays, ageLevel } from "../../credential/store.js";
import { credAgeLabel, LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult, Level } from "../types.js";
import { command, NO_FIX } from "./shared.js";

const ROTATE = command("sensibleDefaults.rotateToken", "Replace your Bedrock API key");

const LEVELS: Record<"ok" | "warn" | "fail", Level> = {
  ok: "pass",
  warn: "warning",
  fail: "error",
};

export const credAgeCheck = {
  id: "cred.age",
  group: "Credential",
  run(ctx: CheckContext): CheckResult {
    const { stored, policy, now } = ctx.credential;
    if (stored === undefined) {
      return result("skipped", LABELS["cred.age"].skipped, NO_FIX);
    }

    // `ageInDays` returns undefined for a stamp we cannot read — a secret
    // written by an older shape, or one repaired by hand. The key still works,
    // so this is information, not a failure.
    const days = ageInDays({ token: "", setAt: stored.setAt }, now);
    if (days === undefined) {
      return result("info", LABELS["cred.age"].unknown, ROTATE);
    }

    const level = ageLevel({ token: "", setAt: stored.setAt }, policy, now);
    return result(LEVELS[level], credAgeLabel(level, days), level === "ok" ? NO_FIX : ROTATE);
  },
} satisfies Check;

function result(level: Level, label: string, fix: CheckResult["fix"]): CheckResult {
  return { id: "cred.age", group: "Credential", level, label, fix };
}
