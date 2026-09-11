import { isJsonObject } from "../../config/managedKeys.js";
import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { APPLY_DEFAULTS, managedValue, NO_FIX, settingsOf } from "./shared.js";

export const pluginsMarketplaceCheck = {
  id: "plugins.marketplace",
  group: "Plugins",
  run(ctx: CheckContext): CheckResult {
    const settings = settingsOf(ctx);
    if (settings === undefined) {
      return {
        id: "plugins.marketplace",
        group: "Plugins",
        level: "skipped",
        label: LABELS["plugins.marketplace"].skipped,
        fix: NO_FIX,
      };
    }
    const wanted = Object.keys(ctx.manifest.defaults.extraKnownMarketplaces);
    if (wanted.length === 0) {
      return {
        id: "plugins.marketplace",
        group: "Plugins",
        level: "pass",
        label: LABELS["plugins.marketplace"].none,
        fix: NO_FIX,
      };
    }
    const current = managedValue(settings, "extraKnownMarketplaces");
    const present = isJsonObject(current) ? current : {};
    const missing = wanted.filter((id) => !Object.hasOwn(present, id));
    if (missing.length > 0) {
      return {
        id: "plugins.marketplace",
        group: "Plugins",
        level: "info",
        label: LABELS["plugins.marketplace"].missing,
        detail: `Not set up: ${missing.join(", ")}.`,
        fix: APPLY_DEFAULTS,
      };
    }
    return {
      id: "plugins.marketplace",
      group: "Plugins",
      level: "pass",
      label: LABELS["plugins.marketplace"].pass,
      fix: NO_FIX,
    };
  },
} satisfies Check;
