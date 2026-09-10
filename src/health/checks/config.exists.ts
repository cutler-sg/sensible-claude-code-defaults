import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { APPLY_DEFAULTS, NO_FIX } from "./shared.js";

export const configExistsCheck = {
  id: "config.exists",
  group: "Configuration",
  run(ctx: CheckContext): CheckResult {
    if (ctx.read.kind === "absent") {
      return {
        id: "config.exists",
        group: "Configuration",
        level: "warning",
        label: LABELS["config.exists"].absent,
        detail: `Nothing at ${ctx.settingsFile} yet.`,
        fix: APPLY_DEFAULTS,
      };
    }
    // A file that exists but does not parse still exists; `config.parses` owns
    // that failure, and reporting it twice would double the error count.
    return {
      id: "config.exists",
      group: "Configuration",
      level: "pass",
      label: LABELS["config.exists"].pass,
      detail: ctx.settingsFile,
      fix: NO_FIX,
    };
  },
} satisfies Check;
