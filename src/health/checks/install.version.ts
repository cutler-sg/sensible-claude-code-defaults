import { compareVersions } from "../../manifest/version.js";
import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { command, NO_FIX } from "./shared.js";

export const installVersionCheck = {
  id: "install.version",
  group: "Installation",
  run(ctx: CheckContext): CheckResult {
    const extension = ctx.detection.extension;
    if (!extension.installed) {
      return {
        id: "install.version",
        group: "Installation",
        level: "skipped",
        label: LABELS["install.version"].skipped,
        fix: NO_FIX,
      };
    }
    const floor = ctx.manifest.minimumClaudeCodeVersion;
    // FR-1.6: below the floor is a warning, never a hard failure — Claude Code
    // still runs, it just may not understand every setting we recommend.
    if (compareVersions(extension.version, floor) < 0) {
      return {
        id: "install.version",
        group: "Installation",
        level: "warning",
        label: LABELS["install.version"].outdated,
        detail: `You have ${extension.version}; ${floor} or newer is recommended.`,
        fix: command("extension.open", "Open the Claude Code page", ["anthropic.claude-code"]),
      };
    }
    return {
      id: "install.version",
      group: "Installation",
      level: "pass",
      label: LABELS["install.version"].pass,
      detail: `Version ${extension.version}`,
      fix: NO_FIX,
    };
  },
} satisfies Check;
