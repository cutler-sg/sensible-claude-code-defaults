/**
 * Two-phase apply: `plan` computes what would change, `commit` writes it.
 *
 * FR-6.1 wants a diff preview before anything is written. Splitting the two
 * phases makes that structural rather than a courtesy the UI can forget: the
 * only way to reach the writer is through a `PlanResult` the caller already
 * holds, and a plan built from a malformed file cannot be committed at all
 * (FR-2.5 — the blocked variant is not assignable to `commit`).
 *
 * Invariant: nothing here imports `vscode`; the host injects `ConfigEnv`.
 */

import { getPath } from "./managedKeys.js";
import { merge } from "./merge.js";
import { assertOutsideWorkspace, backupsDir, settingsPath } from "./paths.js";
import { readSettings } from "./reader.js";
import {
  type BackupInfo,
  type Change,
  type ConfigEnv,
  DEFAULT_STYLE,
  type Desired,
  type Drift,
  type ManagedKey,
  type PlanResult,
  type Settings,
  type Snapshot,
} from "./types.js";
import {
  backupSettings,
  ensureMode0600,
  pruneBackups,
  restoreBackup,
  type WriteOptions,
  writeSettingsAtomic,
} from "./writer.js";

/** FR-2.4: retain the ten most recent backups. */
const BACKUP_RETENTION = 10;

/** A plan that passed the malformed-file gate and can therefore be committed. */
export type ReadyPlan = Extract<PlanResult, { kind: "ready" }>;

/**
 * One backup per session, not per write (FR-2.4). The extension holds a single
 * session per window, so the backup captures the file as it was before we
 * touched it, not an intermediate state we produced ourselves.
 */
export interface ApplySession {
  backedUp: boolean;
}

export function createSession(): ApplySession {
  return { backedUp: false };
}

export interface CommitResult {
  written: boolean;
  /** The backup taken by this commit, if it was the first write of the session. */
  backup?: BackupInfo | undefined;
  changes: Change[];
  drift: Drift[];
}

export interface CommitMeta {
  /** Manifest revision that produced `desired`, recorded in the snapshot. */
  manifestRevision?: string;
}

/** Read, load the snapshot, and merge — no I/O beyond reads, nothing written. */
export async function plan(env: ConfigEnv, desired: Desired): Promise<PlanResult> {
  return planWith(env, desired, undefined);
}

/**
 * A plan for a single key whose current value is pre-seeded into the snapshot,
 * so `merge` sees "equal to what we last wrote" and the recommended value wins.
 *
 * This is the only path that transfers ownership of a key from the user to us,
 * and it exists because the health panel's "reset to recommended" action must
 * be an explicit, per-key decision — never a side effect of a routine apply.
 */
export async function resetKeyPlan(
  env: ConfigEnv,
  desired: Desired,
  key: ManagedKey,
): Promise<PlanResult> {
  const single: Desired = {};
  if (key in desired) {
    single[key] = desired[key];
  }
  return planWith(env, single, key);
}

async function planWith(
  env: ConfigEnv,
  desired: Desired,
  adopt: ManagedKey | undefined,
): Promise<PlanResult> {
  const read = await readSettings(settingsPath(env.claudeDir));
  if (read.kind === "malformed") {
    return { kind: "blocked", reason: "malformed", error: read.error, raw: read.raw };
  }

  const current: Settings = read.kind === "ok" ? read.data : {};
  const style = read.kind === "ok" ? read.style : DEFAULT_STYLE;
  const snapshot = await env.snapshotStore.load();
  const merged = merge(
    current,
    adopt === undefined ? snapshot : seed(snapshot, current, adopt),
    desired,
  );

  return { kind: "ready", read, merge: merged, style, noop: merged.changes.length === 0 };
}

/** Claim `key`'s current value as ours. A key that is absent has nothing to claim. */
function seed(snapshot: Snapshot, current: Settings, key: ManagedKey): Snapshot {
  const value = getPath(current, key);
  if (value === undefined) {
    return snapshot;
  }
  return { ...snapshot, values: { ...snapshot.values, [key]: value } };
}

/**
 * Back up once, write the file, then advance the snapshot.
 *
 * The ordering is the safe one and must not be swapped: if the write fails the
 * snapshot still describes what is genuinely on disk, so the next plan reads
 * the file as ours-and-unchanged. A snapshot that ran ahead of a failed write
 * would claim we own a value we never wrote, and the next apply would overwrite
 * the user's real value without reporting drift.
 */
export async function commit(
  env: ConfigEnv,
  session: ApplySession,
  planned: ReadyPlan,
  meta?: CommitMeta,
): Promise<CommitResult> {
  const { changes, drift, next, snapshotValues } = planned.merge;
  if (planned.noop) {
    return { written: false, backup: undefined, changes, drift };
  }

  const file = settingsPath(env.claudeDir);
  const opts = writeOptions(env);
  // The writer asserts this too; asserting here means a refused write also
  // means a refused backup, so nothing at all lands inside a workspace.
  assertOutsideWorkspace(file, opts.workspaceFolders, opts.platform);

  const backup = await backupOnce(env, session, opts);
  await writeSettingsAtomic(file, next, planned.style, opts);

  const snapshot: Snapshot = {
    schemaVersion: 1,
    values: snapshotValues,
    appliedAt: clock(env)().toISOString(),
    ...(meta?.manifestRevision === undefined ? {} : { manifestRevision: meta.manifestRevision }),
  };
  // Rethrows on failure: a settings file we wrote without a matching snapshot
  // reads as drift next time, which preserves the user's file. That is the
  // failure we want.
  await env.snapshotStore.save(snapshot);

  return { written: true, backup, changes, drift };
}

/**
 * Put a backup's bytes back, having first backed up what is there now so the
 * restore is itself undoable.
 *
 * The snapshot is deliberately left alone: the provenance of restored content
 * is unknown, so the next plan reports every managed key that differs as drift
 * and preserves it. Adopting it would be a guess about who wrote it.
 */
export async function restore(
  env: ConfigEnv,
  session: ApplySession,
  backupPath: string,
): Promise<void> {
  const file = settingsPath(env.claudeDir);
  const opts = writeOptions(env);
  assertOutsideWorkspace(file, opts.workspaceFolders, opts.platform);

  await backupOnce(env, session, opts);
  await restoreBackup(backupPath, file, opts);
}

/**
 * FR-2.8: Claude Code rewrites `settings.json` itself and does not preserve its
 * mode, so this runs on every health check rather than only after our writes.
 */
export async function repairPermissions(
  env: ConfigEnv,
): Promise<{ repaired: boolean } | { unsupported: true }> {
  const platform = env.platform ?? process.platform;
  if (platform === "win32") {
    // Windows ACL repair is M6 (plan Q-K); mode bits mean nothing there.
    return { unsupported: true };
  }
  const { repaired } = await ensureMode0600(settingsPath(env.claudeDir), platform);
  return { repaired };
}

async function backupOnce(
  env: ConfigEnv,
  session: ApplySession,
  opts: WriteOptions,
): Promise<BackupInfo | undefined> {
  if (session.backedUp) {
    return undefined;
  }
  const dir = backupsDir(env.claudeDir);
  const info = await backupSettings(settingsPath(env.claudeDir), dir, clock(env)(), opts);
  // Marked even when there was nothing to copy: on a fresh install the
  // pre-session state *is* "no file", and a later write in the same session
  // must not back up a file we ourselves created.
  session.backedUp = true;
  if (info !== undefined) {
    await pruneBackups(dir, BACKUP_RETENTION);
  }
  return info;
}

function writeOptions(env: ConfigEnv): WriteOptions & { platform: NodeJS.Platform } {
  return {
    workspaceFolders: env.workspaceFolders,
    platform: env.platform ?? process.platform,
  };
}

function clock(env: ConfigEnv): () => Date {
  return env.now ?? (() => new Date());
}
