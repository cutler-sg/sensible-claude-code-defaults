import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { APPLY_DEFAULTS, managedValue, NO_FIX, settingsOf } from "./shared.js";

/** Claude Code accepts either spelling for its boolean env flags. */
const ENABLED = new Set(["1", "true"]);

export const configBedrockCheck = {
  id: "config.bedrock",
  group: "Configuration",
  run(ctx: CheckContext): CheckResult {
    const settings = settingsOf(ctx);
    if (settings === undefined) {
      return {
        id: "config.bedrock",
        group: "Configuration",
        level: "skipped",
        label: LABELS["config.bedrock"].skipped,
        fix: NO_FIX,
      };
    }
    const value = managedValue(settings, "env.CLAUDE_CODE_USE_BEDROCK");
    if (typeof value !== "string" || !ENABLED.has(value)) {
      return {
        id: "config.bedrock",
        group: "Configuration",
        level: "error",
        label: LABELS["config.bedrock"].off,
        fix: APPLY_DEFAULTS,
      };
    }
    return {
      id: "config.bedrock",
      group: "Configuration",
      level: "pass",
      label: LABELS["config.bedrock"].pass,
      fix: NO_FIX,
    };
  },
} satisfies Check;
