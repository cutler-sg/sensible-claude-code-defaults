import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ESM module namespaces are frozen, so `vi.spyOn(fs, 'rename')` cannot work.
 * Wrap the real module once and let each test arm a single failure or count
 * calls through this handle instead.
 */
const hooks = vi.hoisted(() => ({
  renameFailure: null as Error | null,
  chmodCalls: 0,
  dirSyncFailure: null as Error | null,
  dirSyncs: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    rename: (...args: Parameters<typeof actual.rename>) => {
      const failure = hooks.renameFailure;
      if (failure) {
        hooks.renameFailure = null;
        return Promise.reject(failure);
      }
      return actual.rename(...args);
    },
    chmod: (...args: Parameters<typeof actual.chmod>) => {
      hooks.chmodCalls += 1;
      return actual.chmod(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      // The only read-mode open in the writer is the post-rename directory
      // fsync, so this hook can both count it and make it fail (F12).
      if (args[1] === "r") {
        hooks.dirSyncs += 1;
        const failure = hooks.dirSyncFailure;
        if (failure) {
          hooks.dirSyncFailure = null;
          throw failure;
        }
      }
      return actual.open(...args);
    },
  };
});

import { readSettings } from "../../src/config/reader.js";
import { ConfigError, DEFAULT_STYLE, type Settings } from "../../src/config/types.js";
import {
  backupSettings,
  ensureMode0600,
  listBackups,
  pruneBackups,
  restoreBackup,
  writeRawAtomic,
  writeSettingsAtomic,
} from "../../src/config/writer.js";

let dir: string;
let file: string;
let backups: string;

const OPTS = { workspaceFolders: [] as readonly string[] };
const SETTINGS: Settings = { env: { AWS_REGION: "us-east-1" }, model: "opus" };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "scd-writer-"));
  file = path.join(dir, "settings.json");
  backups = path.join(dir, "sensible-defaults", "backups");
});

afterEach(async () => {
  hooks.renameFailure = null;
  hooks.chmodCalls = 0;
  hooks.dirSyncFailure = null;
  hooks.dirSyncs = 0;
  await fs.rm(dir, { recursive: true, force: true });
});

async function mode(target: string): Promise<number> {
  return (await fs.stat(target)).mode & 0o777;
}

async function tempFiles(target = dir): Promise<string[]> {
  return (await fs.readdir(target)).filter((name) => name.endsWith(".tmp"));
}

describe("writeSettingsAtomic (FR-2.3)", () => {
  it("writes JSON in the given style", async () => {
    await writeSettingsAtomic(file, SETTINGS, { indent: "\t", trailingNewline: true }, OPTS);
    expect(await fs.readFile(file, "utf8")).toBe(
      '{\n\t"env": {\n\t\t"AWS_REGION": "us-east-1"\n\t},\n\t"model": "opus"\n}\n',
    );
  });

  it("round-trips through the reader", async () => {
    await writeSettingsAtomic(file, SETTINGS, DEFAULT_STYLE, OPTS);
    const result = await readSettings(file);
    expect(result.kind === "ok" && result.data).toEqual(SETTINGS);
  });

  it("creates the parent directory on a fresh install", async () => {
    const nested = path.join(dir, ".claude", "settings.json");
    await writeSettingsAtomic(nested, SETTINGS, DEFAULT_STYLE, OPTS);
    expect((await readSettings(nested)).kind).toBe("ok");
  });

  it("leaves the file at mode 0600 (§10.4)", async () => {
    await writeSettingsAtomic(file, SETTINGS, DEFAULT_STYLE, OPTS);
    expect(await mode(file)).toBe(0o600);
  });

  it("tightens a pre-existing 0664 file to 0600", async () => {
    await fs.writeFile(file, "{}\n");
    // Explicit chmod: `mode:` on writeFile is masked by umask (022 on CI runners).
    await fs.chmod(file, 0o664);
    expect(await mode(file)).toBe(0o664);
    await writeSettingsAtomic(file, SETTINGS, DEFAULT_STYLE, OPTS);
    expect(await mode(file)).toBe(0o600);
  });

  it("leaves no temp files behind", async () => {
    await writeSettingsAtomic(file, SETTINGS, DEFAULT_STYLE, OPTS);
    expect(await tempFiles()).toEqual([]);
  });

  it("overwrites an existing file rather than appending", async () => {
    await writeSettingsAtomic(file, { a: 1 }, DEFAULT_STYLE, OPTS);
    await writeSettingsAtomic(file, { b: 2 }, DEFAULT_STYLE, OPTS);
    expect(await fs.readFile(file, "utf8")).toBe('{\n  "b": 2\n}\n');
  });

  it("follows a symlink and replaces the link target, not the link", async () => {
    const realDir = path.join(dir, "dotfiles");
    await fs.mkdir(realDir);
    const real = path.join(realDir, "claude-settings.json");
    await fs.writeFile(real, '{"old": true}\n', { mode: 0o600 });
    await fs.symlink(real, file, "file");

    await writeSettingsAtomic(file, SETTINGS, DEFAULT_STYLE, OPTS);

    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    const viaLink = await readSettings(file);
    expect(viaLink.kind === "ok" && viaLink.data).toEqual(SETTINGS);
    const direct = await readSettings(real);
    expect(direct.kind === "ok" && direct.data).toEqual(SETTINGS);
    // The temp file must land beside the *target*, and be cleaned up there.
    expect(await tempFiles(realDir)).toEqual([]);
  });

  it("refuses to write inside a workspace folder (§10.4 assertion #2)", async () => {
    const workspace = path.join(dir, "proj");
    await fs.mkdir(path.join(workspace, ".claude"), { recursive: true });
    const target = path.join(workspace, ".claude", "settings.local.json");
    await expect(
      writeSettingsAtomic(target, SETTINGS, DEFAULT_STYLE, { workspaceFolders: [workspace] }),
    ).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the original intact and removes the temp when rename fails", async () => {
    const original = '{\n  "keep": "me"\n}\n';
    await fs.writeFile(file, original, { mode: 0o600 });
    hooks.renameFailure = new Error("EXDEV: simulated");

    await expect(writeSettingsAtomic(file, SETTINGS, DEFAULT_STYLE, OPTS)).rejects.toBeInstanceOf(
      ConfigError,
    );

    expect(await fs.readFile(file, "utf8")).toBe(original);
    expect(await tempFiles()).toEqual([]);
  });

  it("reports the failure as ATOMIC_WRITE_FAILED with the cause attached", async () => {
    const cause = new Error("ENOSPC: simulated");
    hooks.renameFailure = cause;
    try {
      await writeSettingsAtomic(file, SETTINGS, DEFAULT_STYLE, OPTS);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("ATOMIC_WRITE_FAILED");
      expect((error as ConfigError).cause).toBe(cause);
    }
  });

  it("skips chmod on win32 but still writes (plan Q-K)", async () => {
    hooks.chmodCalls = 0;
    await writeRawAtomic(file, "{}\n", { workspaceFolders: [], platform: "win32" });
    expect(hooks.chmodCalls).toBe(0);
    expect(await fs.readFile(file, "utf8")).toBe("{}\n");
  });
});

describe("ensureMode0600 (FR-2.8)", () => {
  it("reports ok when the file is already 0600", async () => {
    await fs.writeFile(file, "{}\n");
    await fs.chmod(file, 0o600);
    expect(await ensureMode0600(file, "linux")).toEqual({ kind: "ok", before: 0o600 });
  });

  it("repairs a world-readable file and reports the previous mode", async () => {
    await fs.writeFile(file, "{}\n");
    await fs.chmod(file, 0o644);
    expect(await ensureMode0600(file, "linux")).toEqual({ kind: "repaired", before: 0o644 });
    expect(await mode(file)).toBe(0o600);
  });

  it("reports unsupported on win32 rather than a fabricated mode (plan Q-K, F10)", async () => {
    await fs.writeFile(file, "{}\n");
    await fs.chmod(file, 0o644);
    expect(await ensureMode0600(file, "win32")).toEqual({ kind: "unsupported" });
    expect(await mode(file)).toBe(0o644);
  });

  it("reports absent for a missing file rather than throwing (F10)", async () => {
    expect(await ensureMode0600(file, "linux")).toEqual({ kind: "absent" });
  });

  it("propagates an error that is not ENOENT", async () => {
    await fs.writeFile(file, "{}\n");
    await expect(ensureMode0600(path.join(file, "nested.json"), "linux")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });
});

describe("backups (FR-2.4, plan Q-H)", () => {
  const at = (iso: string) => new Date(iso);

  it("returns undefined when there is nothing to back up", async () => {
    expect(await backupSettings(file, backups)).toBeUndefined();
    await expect(fs.stat(backups)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies the file verbatim at mode 0600 with a colon-free name", async () => {
    const raw = '{\n  "env": {}\n}\n';
    await fs.writeFile(file, raw, { mode: 0o600 });

    const info = await backupSettings(file, backups, at("2026-09-10T12:34:56.000Z"));
    expect(info).toBeDefined();
    if (!info) {
      return;
    }
    expect(path.basename(info.path)).toBe("settings.2026-09-10T12-34-56.000Z.json");
    expect(path.basename(info.path)).not.toContain(":");
    expect(await fs.readFile(info.path, "utf8")).toBe(raw);
    expect(await mode(info.path)).toBe(0o600);
  });

  it("backs up a malformed file byte-for-byte", async () => {
    const raw = '{ "a": 1, }\n// broken\n';
    await fs.writeFile(file, raw);
    const info = await backupSettings(file, backups);
    expect(info && (await fs.readFile(info.path, "utf8"))).toBe(raw);
  });

  it("refuses to back up into a workspace folder when the workspace is known", async () => {
    await fs.writeFile(file, "{}\n");
    const workspace = path.join(dir, "proj");
    await expect(
      backupSettings(file, path.join(workspace, "backups"), new Date(), {
        workspaceFolders: [workspace],
      }),
    ).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
  });

  it("propagates a non-ENOENT read error from the source file", async () => {
    const asDir = path.join(dir, "adir");
    await fs.mkdir(asDir);
    await expect(backupSettings(asDir, backups)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("propagates a non-ENOENT error when listing", async () => {
    await fs.mkdir(path.dirname(backups), { recursive: true });
    await fs.writeFile(backups, "not a directory");
    await expect(listBackups(backups)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("propagates a non-ENOENT error when reading a backup", async () => {
    const asDir = path.join(dir, "backup-dir");
    await fs.mkdir(asDir);
    await expect(restoreBackup(asDir, file, OPTS)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("ignores a file whose name is not a parseable timestamp (F7)", async () => {
    await fs.mkdir(backups, { recursive: true });
    await fs.writeFile(path.join(backups, "settings.handwritten.json"), "{}");
    await fs.writeFile(path.join(backups, "settings.2026-13-45T99-99-99.000Z.json"), "{}");
    expect(await listBackups(backups)).toEqual([]);
  });

  it("never prunes a junk file, and never lets one evict a real backup (F7)", async () => {
    const stamps = Array.from(
      { length: 11 },
      (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}T00-00-00.000Z`,
    );
    await seed(stamps);
    // Sorts after every real name lexically, so the old filename sort put it
    // first and gave it the newest slot.
    await fs.writeFile(path.join(backups, "settings.handwritten.json"), "JUNK");

    const deleted = await pruneBackups(backups, 10);

    expect(deleted.map((p) => path.basename(p))).toEqual([
      "settings.2026-09-01T00-00-00.000Z.json",
    ]);
    const remaining = await listBackups(backups);
    expect(remaining).toHaveLength(10);
    expect(path.basename(remaining[0]?.path ?? "")).toBe("settings.2026-09-11T00-00-00.000Z.json");
    // Untouched, but not ours to count or delete either.
    expect(await fs.readFile(path.join(backups, "settings.handwritten.json"), "utf8")).toBe("JUNK");
  });

  it("lists nothing when the backup directory does not exist", async () => {
    expect(await listBackups(backups)).toEqual([]);
  });

  it("lists backups newest first and ignores unrelated files", async () => {
    await seed([
      "2026-09-01T00-00-00.000Z",
      "2026-09-03T00-00-00.000Z",
      "2026-09-02T00-00-00.000Z",
    ]);
    await fs.writeFile(path.join(backups, "README.md"), "not a backup");

    const listed = await listBackups(backups);
    expect(listed.map((b) => path.basename(b.path))).toEqual([
      "settings.2026-09-03T00-00-00.000Z.json",
      "settings.2026-09-02T00-00-00.000Z.json",
      "settings.2026-09-01T00-00-00.000Z.json",
    ]);
    expect(listed[0]?.createdAt.toISOString()).toBe("2026-09-03T00:00:00.000Z");
  });

  it("keeps exactly the 10 newest of 13", async () => {
    const stamps = Array.from(
      { length: 13 },
      (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}T00-00-00.000Z`,
    );
    await seed(stamps);

    const deleted = await pruneBackups(backups);
    expect(deleted).toHaveLength(3);

    const remaining = await listBackups(backups);
    expect(remaining).toHaveLength(10);
    expect(path.basename(remaining[0]?.path ?? "")).toBe("settings.2026-09-13T00-00-00.000Z.json");
    expect(path.basename(remaining[9]?.path ?? "")).toBe("settings.2026-09-04T00-00-00.000Z.json");
  });

  it("honours a custom retention count", async () => {
    await seed([
      "2026-09-01T00-00-00.000Z",
      "2026-09-02T00-00-00.000Z",
      "2026-09-03T00-00-00.000Z",
    ]);
    await pruneBackups(backups, 1);
    expect(await listBackups(backups)).toHaveLength(1);
  });

  it("prunes nothing when under the retention count", async () => {
    await seed(["2026-09-01T00-00-00.000Z"]);
    expect(await pruneBackups(backups)).toEqual([]);
  });

  it("prunes an absent directory without error", async () => {
    expect(await pruneBackups(backups)).toEqual([]);
  });

  it("restores a backup over the live file", async () => {
    const original = '{\n  "env": {\n    "AWS_REGION": "eu-central-1"\n  }\n}\n';
    await fs.writeFile(file, original, { mode: 0o600 });
    const info = await backupSettings(file, backups);
    if (!info) {
      throw new Error("expected a backup");
    }

    await writeSettingsAtomic(file, { env: { AWS_REGION: "us-east-1" } }, DEFAULT_STYLE, OPTS);
    await restoreBackup(info.path, file, OPTS);

    expect(await fs.readFile(file, "utf8")).toBe(original);
    expect(await mode(file)).toBe(0o600);
  });

  it("throws BACKUP_NOT_FOUND for a missing backup", async () => {
    await expect(
      restoreBackup(path.join(backups, "settings.nope.json"), file, OPTS),
    ).rejects.toMatchObject({ code: "BACKUP_NOT_FOUND" });
  });

  it("refuses to restore into a workspace folder", async () => {
    await fs.writeFile(file, "{}\n");
    const info = await backupSettings(file, backups);
    const workspace = path.join(dir, "proj");
    await fs.mkdir(workspace, { recursive: true });
    await expect(
      restoreBackup(info?.path ?? "", path.join(workspace, "settings.json"), {
        workspaceFolders: [workspace],
      }),
    ).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
  });

  async function seed(stamps: readonly string[]): Promise<void> {
    await fs.mkdir(backups, { recursive: true });
    await Promise.all(
      stamps.map((stamp) =>
        fs.writeFile(path.join(backups, `settings.${stamp}.json`), `{"at":"${stamp}"}`, {
          mode: 0o600,
        }),
      ),
    );
  }
});

/**
 * Every `symlink` here passes an explicit `"dir"` or `"file"` type. On POSIX the
 * argument is ignored; on Windows it is the difference between a link the walk
 * can follow and one it cannot, because Node defaults to a *file* link and a
 * file link to a directory resolves to nothing. Omitting it made these guard
 * tests pass on Windows for the wrong reason: no link, so nothing to defeat.
 */
describe("workspace guard follows symlinks (F1, §10.4 assertion #2)", () => {
  it("refuses when the claude dir is a symlink into a workspace", async () => {
    const workspace = path.join(dir, "proj");
    const real = path.join(workspace, ".claude");
    await fs.mkdir(real, { recursive: true });
    const home = path.join(dir, "home");
    await fs.mkdir(home);
    const link = path.join(home, ".claude");
    await fs.symlink(real, link, "dir");

    await expect(
      writeRawAtomic(path.join(link, "settings.json"), '{"pwned":true}\n', {
        workspaceFolders: [workspace],
      }),
    ).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
    expect(await fs.readdir(real)).toEqual([]);
  });

  it("refuses when the workspace root itself is reached through a symlink", async () => {
    // The symlink is on the *workspace* side, not ours. VS Code reports the
    // path the user opened, which on macOS is routinely `/var/...` for a
    // directory that really lives at `/private/var/...`. Resolving only the
    // target left the comparison against an unresolved root, and the write
    // landed inside the workspace. Found by the macOS CI leg.
    const real = path.join(dir, "real-proj");
    await fs.mkdir(path.join(real, ".claude"), { recursive: true });
    const link = path.join(dir, "proj-link");
    await fs.symlink(real, link, "dir");
    const target = path.join(real, ".claude", "settings.json");

    await expect(
      writeRawAtomic(target, '{"pwned":true}\n', { workspaceFolders: [link] }),
    ).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
    expect(await fs.readdir(path.join(real, ".claude"))).toEqual([]);
  });

  it("refuses when settings.json itself is a symlink into a workspace", async () => {
    const workspace = path.join(dir, "proj");
    await fs.mkdir(workspace, { recursive: true });
    const target = path.join(workspace, "settings.json");
    await fs.writeFile(target, "{}\n");
    await fs.symlink(target, file, "file");

    await expect(
      writeRawAtomic(file, '{"pwned":true}\n', { workspaceFolders: [workspace] }),
    ).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
    expect(await fs.readFile(target, "utf8")).toBe("{}\n");
    expect(await tempFiles(workspace)).toEqual([]);
  });

  it("refuses to back up through a symlinked backups dir", async () => {
    await fs.writeFile(file, "{}\n");
    const workspace = path.join(dir, "proj");
    await fs.mkdir(workspace, { recursive: true });
    const link = path.join(dir, "linked-backups");
    await fs.symlink(workspace, link, "dir");

    await expect(
      backupSettings(file, link, new Date(), { workspaceFolders: [workspace] }),
    ).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
    expect(await fs.readdir(workspace)).toEqual([]);
  });

  it("refuses to back up a source file that resolves into a workspace", async () => {
    const workspace = path.join(dir, "proj");
    await fs.mkdir(workspace, { recursive: true });
    const target = path.join(workspace, "settings.json");
    await fs.writeFile(target, "{}\n");
    await fs.symlink(target, file, "file");

    await expect(
      backupSettings(file, backups, new Date(), { workspaceFolders: [workspace] }),
    ).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
  });

  it("refuses to restore into a workspace reached through a symlink", async () => {
    await fs.writeFile(file, '{"orig":true}\n');
    const info = await backupSettings(file, backups);
    const workspace = path.join(dir, "proj");
    await fs.mkdir(workspace, { recursive: true });
    const victim = path.join(workspace, "settings.json");
    await fs.writeFile(victim, "{}\n");
    const link = path.join(dir, "linked-settings.json");
    await fs.symlink(victim, link, "file");

    await expect(
      restoreBackup(info?.path ?? "", link, { workspaceFolders: [workspace] }),
    ).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
    expect(await fs.readFile(victim, "utf8")).toBe("{}\n");
  });

  it("refuses to read a backup that resolves into a workspace", async () => {
    const workspace = path.join(dir, "proj");
    await fs.mkdir(workspace, { recursive: true });
    const planted = path.join(workspace, "settings.2026-09-10T00-00-00.000Z.json");
    await fs.writeFile(planted, '{"planted":true}\n');
    const link = path.join(dir, "linked-backup.json");
    await fs.symlink(planted, link, "file");

    await expect(
      restoreBackup(link, file, { workspaceFolders: [workspace] }),
    ).rejects.toMatchObject({ code: "WRITE_INSIDE_WORKSPACE" });
  });

  it("still allows a symlink that points outside every workspace folder", async () => {
    const workspace = path.join(dir, "proj");
    await fs.mkdir(workspace, { recursive: true });
    const real = path.join(dir, "dotfiles", "settings.json");
    await fs.mkdir(path.dirname(real), { recursive: true });
    await fs.writeFile(real, "{}\n");
    await fs.symlink(real, file, "file");

    await writeRawAtomic(file, '{"ok":true}\n', { workspaceFolders: [workspace] });

    expect(await fs.readFile(real, "utf8")).toBe('{"ok":true}\n');
  });
});

describe("concurrent writers (F8)", () => {
  it("three writers to one path all succeed and leave one intact payload", async () => {
    await fs.writeFile(file, '{"original":true}\n');
    const payloads = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n'];

    const results = await Promise.allSettled(
      payloads.map((text) => writeRawAtomic(file, text, OPTS)),
    );

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(payloads).toContain(await fs.readFile(file, "utf8"));
    expect(await tempFiles()).toEqual([]);
  });

  it("a failing write does not delete a concurrent writer's temp file", async () => {
    // The pre-fix cleanup `rm`'d a fixed temp name it did not create, so a
    // failure in one writer could remove a peer's in-flight temp.
    const foreign = path.join(dir, `.settings.json.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(foreign, "peer-in-flight");
    hooks.renameFailure = new Error("EXDEV: simulated");

    await expect(writeRawAtomic(file, "{}\n", OPTS)).rejects.toBeInstanceOf(ConfigError);

    expect(await fs.readFile(foreign, "utf8")).toBe("peer-in-flight");
  });
});

describe("backups are byte-exact and atomic (F9)", () => {
  it("round-trips bytes that are not valid UTF-8", async () => {
    const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d, 0x0a]);
    await fs.writeFile(file, bytes);

    const info = await backupSettings(file, backups);

    expect(info).toBeDefined();
    expect(await fs.readFile(info?.path ?? "")).toEqual(bytes);
  });

  it("writes the backup at mode 0600 even over a pre-existing looser file", async () => {
    await fs.writeFile(file, "{}\n");
    const at = new Date("2026-09-10T12:34:56.000Z");
    await fs.mkdir(backups, { recursive: true });
    const target = path.join(backups, "settings.2026-09-10T12-34-56.000Z.json");
    await fs.writeFile(target, "stale");
    await fs.chmod(target, 0o666);

    await backupSettings(file, backups, at);

    expect(await mode(target)).toBe(0o600);
    expect(await fs.readFile(target, "utf8")).toBe("{}\n");
  });

  it("leaves no temp file behind in the backups directory", async () => {
    await fs.writeFile(file, "{}\n");
    await backupSettings(file, backups);
    expect(await tempFiles(backups)).toEqual([]);
  });

  it("restores bytes that are not valid UTF-8 byte-for-byte", async () => {
    const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d, 0x0a]);
    await fs.writeFile(file, bytes);
    const info = await backupSettings(file, backups);
    await writeSettingsAtomic(file, { replaced: true }, DEFAULT_STYLE, OPTS);

    await restoreBackup(info?.path ?? "", file, OPTS);

    expect(await fs.readFile(file)).toEqual(bytes);
  });
});

describe("durability of the rename itself (F12)", () => {
  it("fsyncs the directory after the rename", async () => {
    hooks.dirSyncs = 0;
    await writeRawAtomic(file, "{}\n", OPTS);
    expect(hooks.dirSyncs).toBe(1);
  });

  it("does not fail the write when the directory cannot be fsynced", async () => {
    // Windows cannot open a directory as a file; the rename already succeeded,
    // so a failure here is weaker durability, not a failed write.
    hooks.dirSyncFailure = Object.assign(new Error("EPERM: simulated"), { code: "EPERM" });

    await writeRawAtomic(file, '{"written":true}\n', OPTS);

    expect(await fs.readFile(file, "utf8")).toBe('{"written":true}\n');
    expect(await tempFiles()).toEqual([]);
  });
});
