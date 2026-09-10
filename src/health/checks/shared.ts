/**
 * Helpers shared by the check bodies. Deliberately thin: anything with a
 * decision in it belongs in the check that makes the decision.
 */

import { getPath } from "../../config/managedKeys.js";
import type { JsonValue, ManagedKey, Settings } from "../../config/types.js";
import type { CheckContext, Remediation } from "../types.js";

export const NO_FIX: Remediation = { kind: "none" };

export function command(command: string, title: string, args?: readonly unknown[]): Remediation {
  return args === undefined
    ? { kind: "command", command, title }
    : { kind: "command", command, title, args };
}

export const APPLY_DEFAULTS = command(
  "sensibleDefaults.applyDefaults",
  "Apply recommended settings",
);

/**
 * The settings document, or `undefined` when there is nothing to inspect —
 * absent or malformed. Both are already reported by `config.exists` and
 * `config.parses`, so every other configuration check skips on `undefined`
 * rather than restating a problem the user has already been told about.
 */
export function settingsOf(ctx: CheckContext): Settings | undefined {
  return ctx.read.kind === "ok" ? ctx.read.data : undefined;
}

export function managedValue(settings: Settings, key: ManagedKey): JsonValue | undefined {
  return getPath(settings, key);
}
