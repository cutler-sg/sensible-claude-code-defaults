/**
 * Health-check contracts (PRD FR-5). Checks are pure functions of a
 * `CheckContext` built once per run, so every check is unit-testable on a fake
 * context. Nothing in `src/health/` imports `vscode`; the host adapters live in
 * `src/ui/`.
 */

import type { Drift, ManagedKey, PlanResult, ReadResult, Snapshot } from "../config/types.js";
import type { ConnectionResult, TokenPresence } from "../credential/types.js";
import type { ManifestSource } from "../manifest/resolve.js";
import type { CredentialPolicy, Manifest } from "../manifest/types.js";

export type CheckGroup = "Installation" | "Configuration" | "Credential" | "Plugins";

export const CHECK_GROUPS: readonly CheckGroup[] = [
  "Installation",
  "Configuration",
  "Credential",
  "Plugins",
];

/**
 * A manifest notice rendered as a panel row. Not a catalogue entry: there are
 * between zero and two of them per run and their text comes from the manifest,
 * so they are synthesised per report rather than registered. The index keeps
 * the tree ids distinct, which is what stops VS Code collapsing two rows into
 * one and losing the second notice entirely.
 */
export type NoticeId = `notice.${number}`;

export type CatalogueCheckId =
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

export type CheckId = CatalogueCheckId | NoticeId;

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

/**
 * What the checks are allowed to know about the stored token: when it was set,
 * and nothing else.
 *
 * `StoredToken` carries the value, so it deliberately does not appear anywhere
 * in this file. Hard rule 4 is a property of the type here rather than a rule
 * every check body has to remember: a `CheckContext` has no field a token could
 * be assigned to, so no label, tooltip or detail can render one by accident.
 */
export interface StoredTokenMeta {
  /** ISO 8601, as stored. Rendered as an approximate age, never as a date. */
  setAt: string;
}

export interface CredentialContext {
  presence: TokenPresence;
  /** Present only when the keychain holds a token. */
  stored?: StoredTokenMeta;
  /** FR-4.6 thresholds, from the manifest. */
  policy: CredentialPolicy;
  /**
   * The last user-initiated test call, if one has been made in this window.
   * `cred.valid` reports it and never triggers one (plan Q-T).
   *
   * `tokenSetAt` is the `setAt` of the token the call was made with. A result
   * only speaks for the key it tested, so when it does not match the stored
   * key's stamp `cred.valid` reports "untested" rather than vouching for a key
   * that has since been replaced. Optional: a host that does not stamp its
   * results yet is trusted rather than ignored.
   */
  lastTest?: { at: string; tokenSetAt?: string; result: ConnectionResult };
  /**
   * Set when `SecretStorage` threw — Linux without libsecret, most often. The
   * token's presence is then unknowable rather than false (plan Q-X).
   */
  keychainError?: string;
  /**
   * The clock `cred.age` measures against. Carried on the context rather than
   * read inside the check so the check stays a pure function of its input, like
   * every other one.
   */
  now: Date;
}

/**
 * Where the defaults in force came from (FR-3.2, FR-3.5).
 *
 * Deliberately not the `Resolution` itself: a check holding that could reach
 * the fetch layer, and every check is a pure function of this context. This is
 * the projection `config.stale` needs and nothing more.
 */
export interface ManifestStatus {
  /** `manifest.revision`, restated so `config.stale` has one thing to compare. */
  revision: string;
  source: ManifestSource;
  /** ISO 8601. Present for a fetched or cached manifest, absent for the bundle. */
  fetchedAt?: string;
  /** FR-3.5: a manifest was skipped because it wants this extension version or newer. */
  needsExtensionVersion?: string;
}

export interface CheckContext {
  claudeDir: string;
  settingsFile: string;
  platform: NodeJS.Platform;
  read: ReadResult;
  snapshot: Snapshot;
  manifest: Manifest;
  /** Provenance of `manifest`, for `config.stale`. Its `revision` is `manifest.revision`. */
  manifestStatus: ManifestStatus;
  /** `plan(env, desiredFromManifest(manifest))`; `blocked` when the file is malformed. */
  plan: PlanResult;
  drift: Drift[];
  detection: ClaudeCodeDetection;
  credential: CredentialContext;
  /** Outcome of the silent FR-2.8 repair run before the checks (plan Q-N). */
  permissions:
    | { kind: "repaired"; before: number }
    | { kind: "ok"; before: number }
    | { kind: "absent" }
    | { kind: "unsupported" }
    | { kind: "failed"; error: string };
}

export interface Check {
  /** Narrower than `CheckResult["id"]`: a notice is synthesised, never registered. */
  id: CatalogueCheckId;
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
