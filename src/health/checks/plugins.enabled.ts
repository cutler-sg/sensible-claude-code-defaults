import { isJsonObject } from "../../config/managedKeys.js";
import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { APPLY_DEFAULTS, managedValue, NO_FIX, settingsOf } from "./shared.js";

export const pluginsEnabledCheck = {
  id: "plugins.enabled",
  group: "Plugins",
  run(ctx: CheckContext): CheckResult {
    const settings = settingsOf(ctx);
    if (settings === undefined) {
      return {
        id: "plugins.enabled",
        group: "Plugins",
        level: "skipped",
        label: LABELS["plugins.enabled"].skipped,
        fix: NO_FIX,
      };
    }
    const wanted = Object.keys(ctx.manifest.defaults.enabledPlugins);
    if (wanted.length === 0) {
      return {
        id: "plugins.enabled",
        group: "Plugins",
        level: "pass",
        label: LABELS["plugins.enabled"].none,
        fix: NO_FIX,
      };
    }
    const current = managedValue(settings, "enabledPlugins");
    const present = isJsonObject(current) ? current : {};
    // Presence only, not equality: the value is a scope list the user may
    // legitimately narrow, and narrowing it is drift, not a missing plugin.
    const missing = wanted.filter((id) => !Object.hasOwn(present, id));
    if (missing.length > 0) {
      return {
        id: "plugins.enabled",
        group: "Plugins",
        level: "info",
        label: LABELS["plugins.enabled"].missing,
        detail: `Not turned on: ${missing.join(", ")}.`,
        fix: APPLY_DEFAULTS,
      };
    }
    return {
      id: "plugins.enabled",
      group: "Plugins",
      level: "pass",
      label: LABELS["plugins.enabled"].pass,
      fix: NO_FIX,
    };
  },
} satisfies Check;
