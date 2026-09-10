/**
 * Health-check contracts (PRD FR-5). Checks are pure functions of a
 * `CheckContext` built once per run, so every check is unit-testable on a fake
 * context. Nothing in `src/health/` imports `vscode`; the host adapters live in
 * `src/ui/`.
 */

import type { Drift, ManagedKey, PlanResult, ReadResult, Snapshot } from "../config/types.js";
import type { Manifest } from "../manifest/types.js";

export type CheckGroup = "Installation" | "Configuration" | "Credential" | "Plugins";

export const CHECK_GROUPS: readonly CheckGroup[] = [
  "Installation",
  "Configuration",
  "Credential",
  "Plugins",
];

export type CheckId =
  | "install.extension"
  | "install.version"
  | "install.cli"
  | "config.exists"
  | "config.parses"
  | "config.perms"
  | "config.bedrock"
  | "config.region"
  | "config.models"
  | "config.drift"
  | "config.stale"
  | "cred.present"
  | "cred.mirrored"
  | "cred.valid"
  | "cred.age"
  | "cred.leak"
  | "plugins.marketplace"
  | "plugins.enabled";

/**
 * `skipped` is for checks whose implementation lands in a later milestone or
 * whose precondition is unmet (e.g. no file to check permissions on). It never
 * counts toward the badge and never triggers a notification.
 */
export type Level = "pass" | "info" | "warning" | "error" | "skipped";

/** Remediations are references to commands the UI layer registers (FR-6). */
export type Remediation =
  | { kind: "command"; command: string; title: string; args?: readonly unknown[] }
  | { kind: "none" };

export interface CheckResult {
  id: CheckId;
  group: CheckGroup;
  level: Level;
  /** Plain-language, one line, no env-var names (FR-5.3). From `labels.ts`. */
  label: string;
  /** Optional second line for the tooltip. Redacted at the boundary. */
  detail?: string;
  fix: Remediation;
  /** `config.drift` expands into one child per drifted key. */
  children?: DriftChild[];
}

export interface DriftChild {
  key: ManagedKey;
  label: string;
  detail?: string;
  fix: Remediation;
}

export interface ClaudeCodeDetection {
  /** `vscode.extensions.getExtension('anthropic.claude-code')` — FR-1.4 signal 1. */
  extension: { installed: false } | { installed: true; version: string };
  /** `claude --version` on PATH — signal 2. Failure here is informational only. */
  cli: { found: false } | { found: true; version: string };
}

export interface CheckContext {
  claudeDir: string;
  settingsFile: string;
  platform: NodeJS.Platform;
  read: ReadResult;
  snapshot: Snapshot;
  manifest: Manifest;
  /** `plan(env, desiredFromManifest(manifest))`, or undefined when read is malformed. */
  plan: PlanResult | undefined;
  drift: Drift[];
  detection: ClaudeCodeDetection;
  /** Outcome of the silent FR-2.8 repair run before the checks (plan Q-N). */
  permissions:
    | { kind: "repaired"; before: number }
    | { kind: "ok"; before: number }
    | { kind: "absent" }
    | { kind: "unsupported" }
    | { kind: "failed"; error: string };
}

export interface Check {
  id: CheckId;
  group: CheckGroup;
  run(ctx: CheckContext): CheckResult | Promise<CheckResult>;
}

export interface HealthReport {
  at: string;
  results: CheckResult[];
  counts: Record<Level, number>;
}

export function countLevels(results: readonly CheckResult[]): Record<Level, number> {
  const counts: Record<Level, number> = { pass: 0, info: 0, warning: 0, error: 0, skipped: 0 };
  for (const r of results) counts[r.level] += 1;
  return counts;
}
