import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { command, NO_FIX } from "./shared.js";

export const installExtensionCheck = {
  id: "install.extension",
  group: "Installation",
  run(ctx: CheckContext): CheckResult {
    const extension = ctx.detection.extension;
    if (!extension.installed) {
      return {
        id: "install.extension",
        group: "Installation",
        level: "error",
        label: LABELS["install.extension"].missing,
        fix: command("workbench.extensions.installExtension", "Install Claude Code", [
          "anthropic.claude-code",
        ]),
      };
    }
    return {
      id: "install.extension",
      group: "Installation",
      level: "pass",
      label: LABELS["install.extension"].pass,
      detail: `Version ${extension.version}`,
      fix: NO_FIX,
    };
  },
} satisfies Check;
