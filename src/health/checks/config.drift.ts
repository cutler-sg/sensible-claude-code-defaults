import { redactDrift, SECRET_KEYS } from "../../config/managedKeys.js";
import type { Drift, JsonValue } from "../../config/types.js";
import { driftLabel, LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult, DriftChild } from "../types.js";
import { command, NO_FIX } from "./shared.js";

export const configDriftCheck = {
  id: "config.drift",
  group: "Configuration",
  run(ctx: CheckContext): CheckResult {
    if (ctx.drift.length === 0) {
      return {
        id: "config.drift",
        group: "Configuration",
        level: "pass",
        label: LABELS["config.drift"].pass,
        fix: NO_FIX,
      };
    }
    // Redact before rendering, never at the source: `merge` returns the real
    // value because `commit` has to write it (hard rule 4).
    return {
      id: "config.drift",
      group: "Configuration",
      level: "info",
      label: LABELS["config.drift"].drifted,
      fix: NO_FIX,
      children: redactDrift(ctx.drift).map(toChild),
    };
  },
} satisfies Check;

function toChild(entry: Drift): DriftChild {
  const child: DriftChild = {
    key: entry.key,
    label: driftLabel(entry.key),
    fix: command("sensibleDefaults.resetKey", "Reset to recommended", [entry.key]),
  };
  // A secret's value is never shown at all, not even redacted: the tooltip is
  // the one place a shoulder-surfer reads for free, and "«redacted»" there
  // teaches nothing the label has not already said.
  const detail = SECRET_KEYS.has(entry.key) ? undefined : describe(entry.current);
  return detail === undefined ? child : { ...child, detail };
}

function describe(current: JsonValue | undefined): string | undefined {
  return current === undefined ? undefined : `Currently ${render(current)}.`;
}

function render(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
