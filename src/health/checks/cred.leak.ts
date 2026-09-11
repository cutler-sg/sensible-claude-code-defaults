/**
 * FR-4.8's workspace scan, which lands in M5.
 *
 * Registered now with an honest label so the panel has its final shape: a user
 * who learns where this row sits does not have to relearn it when the scan
 * arrives.
 */

import { LABELS } from "../labels.js";
import type { Check, CheckResult } from "../types.js";
import { NO_FIX } from "./shared.js";

export const credLeakCheck = {
  id: "cred.leak",
  group: "Credential",
  run(): CheckResult {
    return {
      id: "cred.leak",
      group: "Credential",
      level: "skipped",
      label: LABELS["cred.leak"].skipped,
      fix: NO_FIX,
    };
  },
} satisfies Check;
