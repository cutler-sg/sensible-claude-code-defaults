import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { NO_FIX } from "./shared.js";

/**
 * FR-1.4 signal 2. Informational in both directions: the Claude Code extension
 * bundles its own binary and does not always place one on PATH, so a missing
 * CLI is a normal install and must never read as a fault.
 */
export const installCliCheck = {
  id: "install.cli",
  group: "Installation",
  run(ctx: CheckContext): CheckResult {
    const cli = ctx.detection.cli;
    if (!cli.found) {
      return {
        id: "install.cli",
        group: "Installation",
        level: "info",
        label: LABELS["install.cli"].missing,
        fix: NO_FIX,
      };
    }
    return {
      id: "install.cli",
      group: "Installation",
      level: "pass",
      label: LABELS["install.cli"].pass,
      detail: `Version ${cli.version}`,
      fix: NO_FIX,
    };
  },
} satisfies Check;
