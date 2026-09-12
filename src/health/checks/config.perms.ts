import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { command, NO_FIX } from "./shared.js";

/**
 * Plan Q-N: the repair already ran silently in `buildContext`, so this check
 * reports its outcome rather than asking the user to press anything. Claude
 * Code resets the mode on every write of its own, so a "Repair" button here
 * would be a treadmill the user could never win. Only an outcome the user can
 * act on gets a button.
 *
 * M6 Part B added the Windows arm. The four outcomes that matter are the same
 * on both kinds of host — private, made private, not private, and can't tell —
 * so they share labels, and the platform never appears in the row.
 *
 * The one shape that must not exist here is a Windows "nothing to check" that
 * reads like a pass. `unverifiable` is a *warning*, deliberately: an ACL we
 * could not read is not an ACL we know is fine, and the file it guards holds
 * the Bedrock key.
 */
export const configPermsCheck = {
  id: "config.perms",
  group: "Configuration",
  run(ctx: CheckContext): CheckResult {
    const base = { id: "config.perms", group: "Configuration" } as const;
    const repair = command("sensibleDefaults.repairPermissions", "Make the settings private");
    const permissions = ctx.permissions;
    switch (permissions.kind) {
      case "repaired":
        return {
          ...base,
          level: "pass",
          label: LABELS["config.perms"].pass,
          detail: "repaired",
          fix: NO_FIX,
        };
      case "aclRepaired":
        return {
          ...base,
          level: "pass",
          label: LABELS["config.perms"].aclPass,
          // The SIDs, not the names: `detail` is the tooltip for the person who
          // goes looking, and a SID is the same string on every locale.
          detail: `Broad user-group grants removed and verified (was granted to ${permissions.before.join(", ")}). Administrator and other corporate-group access is not assessed.`,
          fix: NO_FIX,
        };
      case "ok":
        return { ...base, level: "pass", label: LABELS["config.perms"].pass, fix: NO_FIX };
      case "aclOk":
        return {
          ...base,
          level: "pass",
          label: LABELS["config.perms"].aclPass,
          detail:
            "No grants to Everyone, Users or Authenticated Users were found. Administrator and other corporate-group access is not assessed.",
          fix: NO_FIX,
        };
      case "absent":
        return { ...base, level: "skipped", label: LABELS["config.perms"].skipped, fix: NO_FIX };
      case "unsupported":
        return {
          ...base,
          level: "skipped",
          label: LABELS["config.perms"].unsupported,
          fix: NO_FIX,
        };
      case "aclLoose":
        // The repair ran and the file is still readable by somebody else. That
        // is the one ACL outcome the user can do something about by hand.
        return {
          ...base,
          level: "warning",
          label: LABELS["config.perms"].loose,
          detail:
            permissions.reason === undefined
              ? `granted to ${permissions.found.join(", ")}`
              : `granted to ${permissions.found.join(", ")} — ${permissions.reason}`,
          fix: repair,
        };
      case "unverifiable":
        return {
          ...base,
          level: "warning",
          label: LABELS["config.perms"].unverifiable,
          detail: `${permissions.reason} Permissions have not been confirmed safe. Share diagnostics with support or IT; do not share settings.json because it contains your key.`,
          fix: command("sensibleDefaults.copyDiagnostics", "Copy diagnostics for support"),
        };
      case "failed":
        return {
          ...base,
          level: "warning",
          label: LABELS["config.perms"].failed,
          detail: permissions.error,
          fix: repair,
        };
    }
  },
} satisfies Check;
