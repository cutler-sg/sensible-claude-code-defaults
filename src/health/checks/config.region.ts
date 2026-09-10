import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { command, managedValue, NO_FIX, settingsOf } from "./shared.js";

const SELECT_REGION = command("sensibleDefaults.selectRegion", "Choose an Amazon region");

export const configRegionCheck = {
  id: "config.region",
  group: "Configuration",
  run(ctx: CheckContext): CheckResult {
    const settings = settingsOf(ctx);
    if (settings === undefined) {
      return {
        id: "config.region",
        group: "Configuration",
        level: "skipped",
        label: LABELS["config.region"].skipped,
        fix: NO_FIX,
      };
    }
    const value = managedValue(settings, "env.AWS_REGION");
    if (typeof value !== "string" || value === "") {
      return {
        id: "config.region",
        group: "Configuration",
        level: "error",
        label: LABELS["config.region"].unset,
        fix: SELECT_REGION,
      };
    }
    if (!ctx.manifest.regions.includes(value)) {
      return {
        id: "config.region",
        group: "Configuration",
        level: "error",
        label: LABELS["config.region"].unknown,
        detail: `Currently ${value}. Known regions: ${ctx.manifest.regions.join(", ")}.`,
        fix: SELECT_REGION,
      };
    }
    return {
      id: "config.region",
      group: "Configuration",
      level: "pass",
      label: LABELS["config.region"].pass,
      detail: `Currently ${value}.`,
      fix: NO_FIX,
    };
  },
} satisfies Check;
