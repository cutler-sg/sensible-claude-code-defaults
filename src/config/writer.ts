/**
 * Every byte the extension writes goes through this module.
 *
 * FR-2.3: never write in place. A truncated `settings.json` does not degrade
 * Claude Code, it breaks it for a user who cannot recover by hand — so a write
 * is temp file → fsync → rename, and the temp is removed on any failure.
 *
 * FR-2.6: every path is checked *after* symlink resolution. A guard applied to
 * the path the caller handed us proves nothing: `~/.claude` is a symlink into
 * the user's dotfiles repo often enough that "the path we were given" and "the
 * file we are about to replace" are routinely two different places.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertOutsideWorkspace } from "./paths.js";
import { serialize } from "./reader.js";
import { type BackupInfo, ConfigError, type FileStyle, type Settings } from "./types.js";
import { ensureWindowsAcl, type WindowsAclDeps } from "./windowsAcl.js";

const MODE_0600 = 0o600;
const BACKUP_PREFIX = "settings.";
const BACKUP_SUFFIX = ".json";
const DEFAULT_BACKUP_RETENTION = 10;

/**
 * `settings.<ISO timestamp with colons as dashes>.json`, and nothing else. A
 * hand-dropped `settings.handwritten.json` is not a backup: counting it would
 * give it a retention slot and let it evict a real one (F7).
 */
const BACKUP_NAME = /^settings\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)\.json$/;

export interface WriteOptions {
  /** Absolute workspace folder paths; a write resolving into any of them is refused. */
  workspaceFolders: readonly string[];
  /** Injected for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * How to reach `icacls`, for the win32 tightening after a write. Injected so
   * the Windows path is exercisable from a Linux test run, and so a test that
   * only sets `platform: "win32"` does not spawn a real process.
   */
  acl?: WindowsAclDeps;
}

/**
 * Outcome of a permission repair, on either kind of host.
 *
 * POSIX arm: `before` is the mode we found, and exists only when there was one
 * to read. Windows arm (`acl*`): the file has no mode bits, so the same
 * question — "can anybody but this user read the token?" — is answered from the
 * DACL, and `before`/`found` carry the broad principals by SID.
 *
 * `absent` and `unsupported` are shared, and deliberately distinct:
 * `unsupported` means we could not ask, `absent` means there is no file to ask
 * about. A caller that cannot tell those apart tells the user the wrong thing.
 */
export type ModeRepair =
  | { kind: "repaired"; before: number }
  | { kind: "ok"; before: number }
  | { kind: "absent" }
  | { kind: "unsupported" }
  | { kind: "aclOk" }
  | { kind: "aclRepaired"; before: readonly string[] }
  | { kind: "aclLoose"; found: readonly string[]; reason?: string }
  | { kind: "unverifiable"; reason: string };

/** Serialize `data` in the file's own style and replace the file atomically. */
export async function writeSettingsAtomic(
  file: string,
  data: Settings,
  style: FileStyle,
  opts: WriteOptions,
): Promise<void> {
  await writeRawAtomic(file, serialize(data, style), opts);
}

/**
 * Replace `file` with `text` atomically, at mode 0600.
 *
 * Shared by `writeSettingsAtomic` and `restoreBackup` so there is exactly one
 * code path that can create a settings file.
 */
export async function writeRawAtomic(
  file: string,
  text: string,
  opts: WriteOptions,
): Promise<void> {
  await writeBytesAtomic(file, Buffer.from(text, "utf8"), opts);
}

/** `writeRawAtomic` for callers that already hold bytes and must not transcode. */
async function writeBytesAtomic(file: string, bytes: Buffer, opts: WriteOptions): Promise<void> {
  const platform = opts.platform ?? process.platform;
  // Cheap first pass on the literal path, so an obviously-inside-a-workspace
  // target is refused without touching the filesystem at all.
  assertOutsideWorkspace(file, opts.workspaceFolders, platform);

  // Follow a symlink: dotfiles repos commonly link `~/.claude/settings.json`
  // at a checked-in file, and renaming over the link would replace the link
  // with a regular file and silently detach the user's dotfiles.
  const target = await resolveTarget(file);
  // …which is exactly why the guard has to run again here: the link may point
  // into a workspace folder (F1).
  assertOutsideWorkspace(target, opts.workspaceFolders, platform);

  await atomicReplace(target, bytes, platform, opts.acl);
}

/**
 * FR-2.8: re-assert that only this user can read `file`. Claude Code rewrites
 * it itself and does not preserve what we set.
 *
 * One entry point, two mechanisms: mode bits where they exist, the DACL on
 * Windows (plan Q-K, closed by Q-AF/Q-AG — see `windowsAcl.ts`). Callers get
 * one union back and do not branch on platform themselves; nothing above this
 * line should have to know which mechanism a host uses.
 *
 * The existence check happens *before* the platform split, and that ordering is
 * load-bearing. A fresh install has no `settings.json` yet and the first health
 * check runs before the first apply, so ENOENT is the normal case, not an
 * error (F10) — and it is the normal case on Windows too. Short-circuiting to
 * `unsupported` on win32 before the stat, as this used to, made a fresh Windows
 * install indistinguishable from one where we could not read the ACL, and every
 * caller above said the wrong thing about it.
 */
export async function ensurePrivate(
  file: string,
  platform: NodeJS.Platform = process.platform,
  acl: WindowsAclDeps = {},
): Promise<ModeRepair> {
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    throw error;
  }

  if (platform === "win32") {
    // `fs.stat().mode` on Windows is a fiction (0o666, or 0o444 for a
    // read-only file) that says nothing about who can read the file, so the
    // mode we just read is deliberately discarded here.
    return ensureWindowsAcl(file, acl);
  }

  const before = stats.mode & 0o777;
  if (before === MODE_0600) {
    return { kind: "ok", before };
  }
  await fs.chmod(file, MODE_0600);
  return { kind: "repaired", before };
}

/**
 * FR-2.4: copy the existing settings file into the backup directory before we
 * touch it. Returns `undefined` when there is nothing to back up.
 *
 * The copy is byte-for-byte: a settings file with invalid UTF-8 in it is still
 * the file the user needs back, and a backup that silently substituted U+FFFD
 * would be worse than no backup at all (F9).
 */
export async function backupSettings(
  file: string,
  backupsDir: string,
  now: Date = new Date(),
  opts?: WriteOptions,
): Promise<BackupInfo | undefined> {
  // A backup is a copy of the *user's* file into our own state dir; neither end
  // may sit inside a workspace folder (FR-2.6), before or after following any
  // symlink on the way. Callers that know the workspace pass it; the guard is a
  // no-op when they cannot.
  const platform = opts?.platform ?? process.platform;
  if (opts) {
    assertOutsideWorkspace(file, opts.workspaceFolders, platform);
    assertOutsideWorkspace(backupsDir, opts.workspaceFolders, platform);
    assertOutsideWorkspace(await resolveTarget(file), opts.workspaceFolders, platform);
    assertOutsideWorkspace(await resolveTarget(backupsDir), opts.workspaceFolders, platform);
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  await fs.mkdir(backupsDir, { recursive: true });
  const target = path.join(backupsDir, backupName(now));
  await atomicReplace(target, bytes, platform, opts?.acl);
  return { path: target, createdAt: now };
}

/** Newest first. An absent directory is "no backups", not an error. */
export async function listBackups(backupsDir: string): Promise<BackupInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(backupsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .flatMap((name) => {
      const createdAt = parseBackupName(name);
      return createdAt ? [{ path: path.join(backupsDir, name), createdAt }] : [];
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** FR-2.4: retain the `keep` most recent backups, delete the rest. */
export async function pruneBackups(
  backupsDir: string,
  keep: number = DEFAULT_BACKUP_RETENTION,
): Promise<string[]> {
  const backups = await listBackups(backupsDir);
  const doomed = backups.slice(Math.max(keep, 0));
  await Promise.all(doomed.map((backup) => fs.rm(backup.path, { force: true })));
  return doomed.map((backup) => backup.path);
}

/** FR-2.5 recovery path: put a backup's exact bytes back, atomically. */
export async function restoreBackup(
  backup: string,
  file: string,
  opts: WriteOptions,
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  // The backup we are told to read is a path from the UI; resolve it before
  // trusting it, the same as any destination (F1).
  assertOutsideWorkspace(backup, opts.workspaceFolders, platform);
  assertOutsideWorkspace(await resolveTarget(backup), opts.workspaceFolders, platform);

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError("BACKUP_NOT_FOUND", `No such backup: ${backup}`, { cause: error });
    }
    throw error;
  }
  // Bytes, not text: a restore that transcoded would hand back a file that is
  // not the one the user asked for (F9).
  await writeBytesAtomic(file, bytes, opts);
}

/**
 * temp file → fsync → rename → chmod → fsync(dir). `target` is already
 * resolved and already guarded; this function does no policy.
 */
async function atomicReplace(
  target: string,
  bytes: Buffer,
  platform: NodeJS.Platform,
  acl?: WindowsAclDeps,
): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });

  // A UUID, not pid+ms: two windows of the same extension host share a pid
  // clock, and a collision made one writer delete the other's temp (F8).
  const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    // `wx` fails rather than clobbering, so two concurrent writers cannot
    // interleave into one temp file.
    const handle = await fs.open(tmp, "wx", MODE_0600);
    created = true;
    try {
      await handle.writeFile(bytes);
      // fsync before rename: rename is atomic in the directory entry, but the
      // data behind it is not durable until it reaches the disk. Without this
      // a crash can leave a correctly-named, zero-length settings.json.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
    // rename preserves the temp file's mode, but the destination may have
    // pre-existed at a looser mode on some filesystems — be explicit (FR-2.8).
    await tighten(target, platform, acl);
    await syncDirectory(dir);
  } catch (error) {
    // Only ours to remove: before `open` succeeded, `tmp` is either absent or
    // somebody else's file.
    if (created) {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
    throw new ConfigError("ATOMIC_WRITE_FAILED", `Failed to write ${target}.`, { cause: error });
  }
}

async function resolveTarget(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch {
    // Not there yet (fresh install), or a dangling link: resolve the parent
    // instead so the temp file still lands on the destination filesystem.
    const parent = path.dirname(file);
    const base = path.basename(file);
    try {
      return path.join(await fs.realpath(parent), base);
    } catch {
      return path.resolve(file);
    }
  }
}

/**
 * Make the file we just wrote private to this user, by whichever mechanism the
 * host has: mode bits, or the DACL (M6 Part B).
 *
 * The Windows arm is best-effort *by design*, and the asymmetry is deliberate.
 * A failed `chmod` means the filesystem refused an operation we own the file
 * for, and failing the write is right. An `icacls` that could not answer means
 * we could not read an ACL that may well already be correct — the bytes are on
 * disk either way, and turning that into ATOMIC_WRITE_FAILED would tell the
 * caller the write did not happen when it did.
 *
 * It is not silent: `config.perms` re-asks the same question on every health
 * check and is the one place the answer is reported. This is the tightening,
 * not the telling.
 */
async function tighten(
  target: string,
  platform: NodeJS.Platform,
  acl?: WindowsAclDeps,
): Promise<void> {
  if (platform !== "win32") {
    await fs.chmod(target, MODE_0600);
    return;
  }
  await ensureWindowsAcl(target, acl ?? {}).catch(() => undefined);
}

/**
 * The rename itself is only durable once the *directory entry* is on disk; a
 * crash between the two can lose the file the rename just created (F12).
 *
 * Best-effort by design. Windows cannot open a directory as a file at all
 * (EISDIR/EPERM/EBADF depending on the layer), and by the time we get here the
 * rename has already succeeded — reporting a failed fsync as ATOMIC_WRITE_FAILED
 * would tell the caller the write did not happen when it did.
 */
async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch {
    // Durability is weaker than we wanted; the file is still in place.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function backupName(now: Date): string {
  return `${BACKUP_PREFIX}${now.toISOString().replaceAll(":", "-")}${BACKUP_SUFFIX}`;
}

/** The `createdAt` a backup name encodes, or `undefined` if it is not one. */
function parseBackupName(name: string): Date | undefined {
  const match = BACKUP_NAME.exec(name);
  if (!match) {
    return undefined;
  }
  // Colons were replaced with dashes to keep the name portable to Windows, and
  // only the time half was affected — put them back before parsing.
  const iso = (match[1] as string).replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
