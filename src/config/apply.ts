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

import { getPath, isElementOwned, isJsonObject } from "./managedKeys.js";
import { deepEqual, merge } from "./merge.js";
import { assertOutsideWorkspace, backupsDir, settingsPath } from "./paths.js";
import { readSettings } from "./reader.js";
import {
  type BackupInfo,
  type Change,
  type ConfigEnv,
  ConfigError,
  DEFAULT_STYLE,
  type Desired,
  type Drift,
  type ElementOwnedKey,
  EMPTY_SNAPSHOT,
  type JsonObject,
  type JsonValue,
  MANAGED_KEYS,
  type ManagedKey,
  type PlanResult,
  type ReadResult,
  type Settings,
  type Snapshot,
} from "./types.js";
import {
  backupSettings,
  ensureMode0600,
  type ModeRepair,
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
  /**
   * Why nothing was written. `noop` means the plan asked for no changes;
   * `stale` means the file changed under us between `plan` and `commit`, so the
   * plan describes a document that no longer exists and must be recomputed.
   */
  reason?: "noop" | "stale" | undefined;
  /** The backup taken by this commit, if it was the first write of the session. */
  backup?: BackupInfo | undefined;
  changes: Change[];
  drift: Drift[];
}

export interface CommitMeta {
  /** Manifest revision that produced `desired`, recorded in the snapshot. */
  manifestRevision?: string;
  /**
   * Back up even when this session already has one.
   *
   * FR-2.4's one-backup-per-session rule assumes every write in a session
   * overwrites only values we ourselves wrote, so the session's first backup is
   * the last copy of anything the user typed. The reset paths break that
   * assumption: they exist precisely to overwrite a value the user chose, and a
   * second one in the same window would otherwise be destroyed with no copy
   * anywhere (hard rule 3's escape hatch has to leave the user a way back).
   */
  forceBackup?: boolean;
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

  let merged: ReturnType<typeof merge>;
  try {
    merged = merge(
      current,
      adopt === undefined ? snapshot : seed(snapshot, current, adopt, desired),
      desired,
    );
  } catch (error) {
    // The reader accepts a file whose `permissions` is a string: it is valid
    // JSON with an object at the top level. `managedKeys` refuses to guess what
    // that means, and `plan` is called from a health check that must never
    // throw, so a structural refusal becomes a blocked plan like any other.
    if (error instanceof ConfigError && error.code === "MALFORMED_SETTINGS") {
      return {
        kind: "blocked",
        reason: "malformed",
        error: error.message,
        raw: read.kind === "ok" ? read.raw : "",
      };
    }
    throw error;
  }

  return { kind: "ready", read, merge: merged, style, noop: merged.changes.length === 0 };
}

/** Claim `key`'s current value as ours. A key that is absent has nothing to claim. */
function seed(snapshot: Snapshot, current: Settings, key: ManagedKey, desired: Desired): Snapshot {
  const value = getPath(current, key);
  if (value === undefined) {
    return snapshot;
  }
  const claimed = isElementOwned(key) ? claimElements(key, value, desired[key]) : value;
  if (claimed === undefined) {
    return snapshot;
  }
  return { ...snapshot, values: { ...snapshot.values, [key]: claimed } };
}

/**
 * For an element-owned key the snapshot holds *the elements we wrote*, never
 * the whole container. Claiming the container would adopt the user's plugins
 * and deny rules along with ours — and the very next apply would then delete
 * them, because a manifest that no longer lists an element we "own" removes it.
 *
 * So a reset claims exactly the elements of `desired` that are already present:
 * by value for the list, by id for the maps. Elements the user added stay
 * unowned, which is what keeps them.
 */
function claimElements(
  key: ElementOwnedKey,
  current: JsonValue,
  desired: JsonValue | undefined,
): JsonValue | undefined {
  if (key === "permissions.deny") {
    if (!Array.isArray(current) || !Array.isArray(desired)) return undefined;
    const claimed = desired.filter((element) =>
      current.some((candidate) => deepEqual(candidate, element)),
    );
    return claimed.length > 0 ? claimed : undefined;
  }
  if (!isJsonObject(current) || !isJsonObject(desired)) return undefined;
  const claimed: JsonObject = {};
  for (const id of Object.keys(desired)) {
    if (Object.hasOwn(current, id)) claimed[id] = current[id] as JsonValue;
  }
  return Object.keys(claimed).length > 0 ? claimed : undefined;
}

/**
 * Re-read, back up once, write the file, then advance the snapshot.
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
    return { written: false, reason: "noop", backup: undefined, changes, drift };
  }

  const file = settingsPath(env.claudeDir);
  const opts = writeOptions(env);
  // The writer asserts this too; asserting here means a refused write also
  // means a refused backup, so nothing at all lands inside a workspace — and it
  // comes first, so a forbidden target is refused without even being read.
  assertOutsideWorkspace(file, opts.workspaceFolders, opts.platform);

  // `planned.merge.next` is the whole document, computed from the bytes `plan`
  // read. Between the two phases a diff preview sits in front of a human, and
  // Claude Code's own `/setup-bedrock` may write the file in that window —
  // writing `next` would then destroy that write with no drift to show for it
  // and, after the session's one backup, no copy of it anywhere.
  if (await hasChangedSince(file, planned.read)) {
    return { written: false, reason: "stale", backup: undefined, changes, drift };
  }

  const backup = await backupOnce(env, session, opts, meta?.forceBackup === true);
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

  return { written: true, reason: undefined, backup, changes, drift };
}

/**
 * Compare the file against what the plan was built from: raw bytes when it read
 * one, mere existence when it did not. Bytes rather than parsed content, so a
 * reformat or a comment-shaped edit still counts — the plan's `next` carries
 * the whole document, so any difference makes it the wrong thing to write.
 *
 * This narrows the race rather than closing it: nothing here holds a lock, so a
 * write landing between this read and the rename is still lost. That is the
 * same exposure Claude Code itself has, and closing it needs a lock protocol
 * both sides honour (plan Q-J).
 */
async function hasChangedSince(file: string, read: ReadResult): Promise<boolean> {
  const now = await readSettings(file).catch(() => undefined);
  if (now === undefined) {
    // The file became unreadable for a host reason (EACCES, EISDIR). Treat it
    // as changed: the write would fail or clobber something we cannot see.
    return true;
  }
  if (read.kind === "absent") {
    return now.kind !== "absent";
  }
  return now.kind === "absent" || now.raw !== read.raw;
}

/**
 * Put a backup's bytes back, having first backed up what is there now so the
 * restore is itself undoable, then forget everything we thought we owned.
 *
 * Dropping the snapshot is what makes the undo stick. Keeping it would leave
 * the restored file looking like "our keys are missing but the snapshot says we
 * wrote them" — the `absent` + snapshot-present row, which is a plain re-add,
 * so the next apply would silently undo the restore with nothing in the diff
 * preview to show for it. With the snapshot dropped, every key the restore
 * brought back is unowned (preserved, reported as drift) and every key it
 * removed is an ordinary add the user sees and accepts.
 */
export async function restore(
  env: ConfigEnv,
  session: ApplySession,
  backupPath: string,
): Promise<void> {
  const file = settingsPath(env.claudeDir);
  const opts = writeOptions(env);
  assertOutsideWorkspace(file, opts.workspaceFolders, opts.platform);

  // Always, never once-per-session: the restore confirmation tells the user
  // their current settings are saved first, and that has to be true on the
  // second restore of a window as well as the first.
  await backupOnce(env, session, opts, true);
  await restoreBackup(backupPath, file, opts);
  await forgetOwnership(env);
}

/**
 * Drop every managed key from the snapshot, along with the `appliedAt` and
 * `manifestRevision` that described the apply we just undid. The envelope
 * stays so a later load sees a schema-version-1 document rather than a missing
 * file, and any key a future version stopped managing is carried through.
 */
async function forgetOwnership(env: ConfigEnv): Promise<void> {
  const snapshot = await env.snapshotStore.load();
  const values: Snapshot["values"] = { ...snapshot.values };
  for (const key of MANAGED_KEYS) delete values[key];
  await env.snapshotStore.save({ ...EMPTY_SNAPSHOT, values });
}

/**
 * FR-2.8: Claude Code rewrites `settings.json` itself and does not preserve its
 * mode, so this runs on every health check rather than only after our writes.
 *
 * The writer's outcome is passed through unchanged, `absent` included: the
 * first health check of a fresh install runs before the user has applied
 * anything, and "there is no file yet" is a state the panel reports rather than
 * a failure that should throw out of it. Windows ACL repair is M6 (plan Q-K);
 * mode bits mean nothing there, so it reports `unsupported`.
 */
export async function repairPermissions(env: ConfigEnv): Promise<ModeRepair> {
  return ensureMode0600(settingsPath(env.claudeDir), env.platform ?? process.platform);
}

async function backupOnce(
  env: ConfigEnv,
  session: ApplySession,
  opts: WriteOptions,
  force = false,
): Promise<BackupInfo | undefined> {
  if (session.backedUp && !force) {
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
