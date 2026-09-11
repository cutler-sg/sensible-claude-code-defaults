import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { command, NO_FIX } from "./shared.js";

/**
 * Plan Q-N: the repair already ran silently in `buildContext`, so this check
 * reports its outcome rather than asking the user to press anything. Claude
 * Code resets the mode on every write of its own, so a "Repair" button here
 * would be a treadmill the user could never win. Only a repair that *failed*
 * is worth their attention.
 */
export const configPermsCheck = {
  id: "config.perms",
  group: "Configuration",
  run(ctx: CheckContext): CheckResult {
    const permissions = ctx.permissions;
    switch (permissions.kind) {
      case "repaired":
        return {
          id: "config.perms",
          group: "Configuration",
          level: "pass",
          label: LABELS["config.perms"].pass,
          detail: "repaired",
          fix: NO_FIX,
        };
      case "ok":
        return {
          id: "config.perms",
          group: "Configuration",
          level: "pass",
          label: LABELS["config.perms"].pass,
          fix: NO_FIX,
        };
      case "absent":
        return {
          id: "config.perms",
          group: "Configuration",
          level: "skipped",
          label: LABELS["config.perms"].skipped,
          fix: NO_FIX,
        };
      case "unsupported":
        return {
          id: "config.perms",
          group: "Configuration",
          level: "skipped",
          label: LABELS["config.perms"].unsupported,
          fix: NO_FIX,
        };
      case "failed":
        return {
          id: "config.perms",
          group: "Configuration",
          level: "warning",
          label: LABELS["config.perms"].failed,
          detail: permissions.error,
          fix: command("sensibleDefaults.repairPermissions", "Make the settings private"),
        };
    }
  },
} satisfies Check;
