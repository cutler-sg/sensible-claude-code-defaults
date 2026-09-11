import type { ManagedKey } from "../../config/types.js";
import { keyDisplayName, LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { APPLY_DEFAULTS, managedValue, NO_FIX, settingsOf } from "./shared.js";

const MODEL_KEYS = [
  "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
  "env.ANTHROPIC_DEFAULT_SONNET_MODEL",
  "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const satisfies readonly ManagedKey[];

export const configModelsCheck = {
  id: "config.models",
  group: "Configuration",
  run(ctx: CheckContext): CheckResult {
    const settings = settingsOf(ctx);
    if (settings === undefined) {
      return {
        id: "config.models",
        group: "Configuration",
        level: "skipped",
        label: LABELS["config.models"].skipped,
        fix: NO_FIX,
      };
    }
    const drifted = new Set(ctx.drift.map((entry) => entry.key));
    const wrong = MODEL_KEYS.filter((key) => {
      // A drifted pin is a deliberate choice — Claude Code's or the user's —
      // and belongs to `config.drift`, which offers a per-key reset. Repeating
      // it here would tell the same person the same thing twice and point them
      // at an apply that will not touch the key anyway.
      if (drifted.has(key)) return false;
      const want = ctx.manifest.defaults.env[key.slice("env.".length)];
      return want !== undefined && managedValue(settings, key) !== want;
    });

    if (wrong.length > 0) {
      return {
        id: "config.models",
        group: "Configuration",
        level: "warning",
        label: LABELS["config.models"].mismatch,
        detail: `Not set as recommended: ${wrong.map(keyDisplayName).join(", ")}.`,
        fix: APPLY_DEFAULTS,
      };
    }
    return {
      id: "config.models",
      group: "Configuration",
      level: "pass",
      label: LABELS["config.models"].pass,
      fix: NO_FIX,
    };
  },
} satisfies Check;
