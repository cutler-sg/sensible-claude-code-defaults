import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { command, NO_FIX } from "./shared.js";

/**
 * FR-2.5. The primary remediation is opening the file; the tree offers
 * "restore previous configuration" alongside it. Neither writes anything: a
 * file we cannot parse is a file we must not overwrite.
 */
export const configParsesCheck = {
  id: "config.parses",
  group: "Configuration",
  run(ctx: CheckContext): CheckResult {
    if (ctx.read.kind === "absent") {
      return {
        id: "config.parses",
        group: "Configuration",
        level: "skipped",
        label: LABELS["config.parses"].skipped,
        fix: NO_FIX,
      };
    }
    if (ctx.read.kind === "malformed") {
      return {
        id: "config.parses",
        group: "Configuration",
        level: "error",
        label: LABELS["config.parses"].malformed,
        detail: ctx.read.error,
        fix: command("sensibleDefaults.openSettings", "Open the settings file"),
      };
    }
    return {
      id: "config.parses",
      group: "Configuration",
      level: "pass",
      label: LABELS["config.parses"].pass,
      fix: NO_FIX,
    };
  },
} satisfies Check;
