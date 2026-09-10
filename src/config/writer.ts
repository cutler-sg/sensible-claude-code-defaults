/**
 * Every byte the extension writes goes through this module.
 *
 * FR-2.3: never write in place. A truncated `settings.json` does not degrade
 * Claude Code, it breaks it for a user who cannot recover by hand — so a write
 * is temp file → fsync → rename, and the temp is removed on any failure.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertOutsideWorkspace } from "./paths.js";
import { serialize } from "./reader.js";
import { type BackupInfo, ConfigError, type FileStyle, type Settings } from "./types.js";

const MODE_0600 = 0o600;
const BACKUP_PREFIX = "settings.";
const BACKUP_SUFFIX = ".json";
const DEFAULT_BACKUP_RETENTION = 10;

export interface WriteOptions {
  /** Absolute workspace folder paths; a write resolving into any of them is refused. */
  workspaceFolders: readonly string[];
  /** Injected for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

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
  const platform = opts.platform ?? process.platform;
  assertOutsideWorkspace(file, opts.workspaceFolders, platform);

  // Follow a symlink: dotfiles repos commonly link `~/.claude/settings.json`
  // at a checked-in file, and renaming over the link would replace the link
  // with a regular file and silently detach the user's dotfiles.
  const target = await resolveTarget(file);
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `.settings.json.${process.pid}.${Date.now()}.tmp`);
  try {
    // `wx` fails rather than clobbering, so two concurrent writers cannot
    // interleave into one temp file.
    const handle = await fs.open(tmp, "wx", MODE_0600);
    try {
      await handle.writeFile(text, "utf8");
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
    await chmod0600(target, platform);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new ConfigError("ATOMIC_WRITE_FAILED", `Failed to write ${target}.`, { cause: error });
  }
}

/**
 * FR-2.8: re-assert mode 0600. Claude Code rewrites this file itself and can
 * reset its permissions. Windows ACL repair is deferred to M6 (plan Q-K).
 */
export async function ensureMode0600(
  file: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ repaired: boolean; before: number }> {
  if (platform === "win32") {
    return { repaired: false, before: 0 };
  }
  const stats = await fs.stat(file);
  const before = stats.mode & 0o777;
  if (before === MODE_0600) {
    return { repaired: false, before };
  }
  await fs.chmod(file, MODE_0600);
  return { repaired: true, before };
}

/**
 * FR-2.4: copy the existing settings file into the backup directory before we
 * touch it. Returns `undefined` when there is nothing to back up.
 */
export async function backupSettings(
  file: string,
  backupsDir: string,
  now: Date = new Date(),
  opts?: WriteOptions,
): Promise<BackupInfo | undefined> {
  // A backup is a copy of the *user's* file into our own state dir; neither end
  // may sit inside a workspace folder (FR-2.6). Callers that know the workspace
  // pass it; the guard is a no-op when they cannot.
  if (opts) {
    const platform = opts.platform ?? process.platform;
    assertOutsideWorkspace(file, opts.workspaceFolders, platform);
    assertOutsideWorkspace(backupsDir, opts.workspaceFolders, platform);
  }

  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  await fs.mkdir(backupsDir, { recursive: true });
  const target = path.join(backupsDir, backupName(now));
  await fs.writeFile(target, text, { encoding: "utf8", mode: MODE_0600 });
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

  return (
    entries
      .filter(isBackupName)
      // The filename is an ISO timestamp at fixed width, so lexical order is
      // chronological order — no stat() call per file.
      .sort((a, b) => b.localeCompare(a))
      .map((name) => ({ path: path.join(backupsDir, name), createdAt: parseBackupName(name) }))
  );
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
  let text: string;
  try {
    text = await fs.readFile(backup, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError("BACKUP_NOT_FOUND", `No such backup: ${backup}`, { cause: error });
    }
    throw error;
  }
  await writeRawAtomic(file, text, opts);
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

async function chmod0600(target: string, platform: NodeJS.Platform): Promise<void> {
  // Windows has no POSIX mode bits; ACL hardening is M6 (plan Q-K).
  if (platform !== "win32") {
    await fs.chmod(target, MODE_0600);
  }
}

function backupName(now: Date): string {
  return `${BACKUP_PREFIX}${now.toISOString().replaceAll(":", "-")}${BACKUP_SUFFIX}`;
}

function isBackupName(name: string): boolean {
  return name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX);
}

function parseBackupName(name: string): Date {
  // Colons were replaced with dashes to keep the name portable to Windows, and
  // only the time half was affected — put them back before parsing.
  const stamp = name.slice(BACKUP_PREFIX.length, -BACKUP_SUFFIX.length);
  const iso = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  const parsed = new Date(iso);
  // A hand-dropped file can match the naming pattern without being a timestamp;
  // dating it to the epoch sorts it last rather than poisoning the list.
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}
