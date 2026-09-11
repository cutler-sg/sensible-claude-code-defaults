/**
 * Checks whose bodies land in a later milestone (plan Q-M). They are registered
 * now, and report `skipped` with an honest label, so the tree has its final
 * shape from M2 and later milestones only fill in behaviour — a user who learns
 * the panel does not have to relearn it.
 */

import { LABELS } from "../labels.js";
import type { Check, CheckGroup, CheckId } from "../types.js";
import { NO_FIX } from "./shared.js";

function placeholder(id: CheckId, group: CheckGroup, label: string): Check {
  return {
    id,
    group,
    run: () => ({ id, group, level: "skipped", label, fix: NO_FIX }),
  };
}

export const configStaleCheck = placeholder(
  "config.stale",
  "Configuration",
  LABELS["config.stale"].skipped,
);
