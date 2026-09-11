import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ESM module namespaces are frozen, so `vi.spyOn(writer, 'writeSettingsAtomic')`
 * cannot work. Wrap the real module once and let a single test arm a failure
 * through this handle (same pattern as `test/unit/writer.test.ts`).
 */
const hooks = vi.hoisted(() => ({ writeFailure: null as Error | null }));

vi.mock("../../src/config/writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/writer.js")>();
  return {
    ...actual,
    writeSettingsAtomic: (...args: Parameters<typeof actual.writeSettingsAtomic>) => {
      const failure = hooks.writeFailure;
      if (failure) {
        hooks.writeFailure = null;
        return Promise.reject(failure);
      }
      return actual.writeSettingsAtomic(...args);
    },
  };
});

import {
  type ApplySession,
  commit,
  createSession,
  plan,
  type ReadyPlan,
  repairPermissions,
  resetKeyPlan,
  restore,
} from "../../src/config/apply.js";
import { getPath } from "../../src/config/managedKeys.js";
import { backupsDir, settingsPath, snapshotPath } from "../../src/config/paths.js";
import { FileSnapshotStore } from "../../src/config/snapshot.js";
import type {
  ConfigEnv,
  Desired,
  JsonObject,
  JsonValue,
  ManagedKey,
  PlanResult,
  Settings,
  Snapshot,
} from "../../src/config/types.js";
import { listBackups } from "../../src/config/writer.js";

const OPUS_V1 = "us.anthropic.claude-opus-4-5-20260115-v1:0";
const OPUS_V2 = "us.anthropic.claude-opus-5-20260701-v1:0";

/** All nine managed keys with realistic values (PRD §5 FR-3 manifest shape). */
function desiredFixture(overrides: Desired = {}): Desired {
  return {
    "env.CLAUDE_CODE_USE_BEDROCK": "1",
    "env.AWS_REGION": "us-east-1",
    "env.ANTHROPIC_DEFAULT_OPUS_MODEL": OPUS_V1,
    "env.ANTHROPIC_DEFAULT_SONNET_MODEL": "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "env.ANTHROPIC_DEFAULT_HAIKU_MODEL": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "env.AWS_BEARER_TOKEN_BEDROCK": "ABSKQmVkcm9ja0FQSUtleS1leGFtcGxl",
    "permissions.deny": ["Bash(rm -rf:*)", "Read(./.env)"],
    extraKnownMarketplaces: {
      "sensible-defaults": { source: { source: "github", repo: "cutler-sg/marketplace" } },
    },
    enabledPlugins: { "health@sensible-defaults": true },
    ...overrides,
  };
}

let tmp: string;
let claudeDir: string;
let workspace: string;
let file: string;
let env: ConfigEnv;
let session: ApplySession;
let clockMs: number;

/** Backup filenames are ISO timestamps; advance a second per call so two never collide. */
function tick(): Date {
  clockMs += 1000;
  return new Date(clockMs);
}

function makeEnv(dir: string): ConfigEnv {
  return {
    claudeDir: dir,
    workspaceFolders: [workspace],
    snapshotStore: new FileSnapshotStore(snapshotPath(dir), { workspaceFolders: [workspace] }),
    now: tick,
  };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scd-apply-"));
  claudeDir = join(tmp, ".claude");
  workspace = join(tmp, "ws");
  file = settingsPath(claudeDir);
  clockMs = Date.UTC(2026, 8, 10, 12, 0, 0);
  await mkdir(workspace, { recursive: true });
  env = makeEnv(claudeDir);
  session = createSession();
});

afterEach(async () => {
  hooks.writeFailure = null;
  await rm(tmp, { recursive: true, force: true });
});

async function seedSettings(text: string): Promise<void> {
  await mkdir(claudeDir, { recursive: true });
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
}

async function readText(target: string = file): Promise<string> {
  return readFile(target, "utf8");
}

async function readJson(target: string = file): Promise<Settings> {
  return JSON.parse(await readText(target)) as Settings;
}

async function readSnapshotFile(): Promise<Snapshot> {
  return JSON.parse(await readFile(snapshotPath(claudeDir), "utf8")) as Snapshot;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function mode(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

/**
 * Windows reports 0o666 from `fs.stat` regardless of the DACL, so a POSIX-mode
 * assertion says nothing there. The security property still holds — it is a
 * DACL question on Windows, asserted through the injected `icacls` runner in
 * `test/unit/writer.test.ts` and `test/unit/config/windowsAcl.test.ts` — so
 * these gates are about the *mechanism*, not about the guarantee.
 */
const POSIX = process.platform !== "win32";

async function envValue(key: string): Promise<unknown> {
  return ((await readJson()).env as JsonObject)[key];
}

/** Narrow a plan to the committable variant, failing the test if it is blocked. */
function ready(result: PlanResult): ReadyPlan {
  if (result.kind !== "ready") {
    throw new Error(`expected a ready plan, got blocked: ${result.error}`);
  }
  return result;
}

async function applyFixture(desired: Desired = desiredFixture()): Promise<void> {
  await commit(env, session, ready(await plan(env, desired)));
}

describe("fresh install", () => {
  it("creates the directory, writes every key, and records the snapshot", async () => {
    const planned = ready(await plan(env, desiredFixture()));

    expect(planned.noop).toBe(false);
    expect(planned.read.kind).toBe("absent");
    expect(planned.merge.changes).toHaveLength(9);
    expect(planned.merge.changes.every((change) => change.kind === "add")).toBe(true);
    expect(planned.merge.drift).toEqual([]);

    const result = await commit(env, session, planned, {
      manifestRevision: "2026-09-11T00:00:00Z",
    });

    expect(result).toMatchObject({ written: true, backup: undefined });
    expect(await readJson()).toEqual(planned.merge.next);
    if (POSIX) expect(await mode(file)).toBe(0o600);

    const snapshot = await readSnapshotFile();
    expect(Object.keys(snapshot.values)).toHaveLength(9);
    expect(snapshot.manifestRevision).toBe("2026-09-11T00:00:00Z");
    expect(snapshot.appliedAt).toBe(new Date(clockMs).toISOString());
    expect(await listBackups(backupsDir(claudeDir))).toEqual([]);
  });

  it("works without injected platform or clock", async () => {
    const bare: ConfigEnv = {
      claudeDir,
      workspaceFolders: [workspace],
      snapshotStore: new FileSnapshotStore(snapshotPath(claudeDir), {
        workspaceFolders: [workspace],
      }),
    };
    const result = await commit(bare, createSession(), ready(await plan(bare, desiredFixture())));

    expect(result.written).toBe(true);
    expect(Date.parse((await readSnapshotFile()).appliedAt ?? "")).not.toBeNaN();
  });
});

describe("hand-written existing config", () => {
  // Four-space indent, `$schema` first, and one of our keys already set by hand.
  const EXISTING = `{
    "$schema": "https://json.schemastore.org/claude-code-settings.json",
    "model": "opus",
    "env": {
        "FOO": "bar",
        "AWS_REGION": "eu-west-1"
    },
    "hooks": {
        "PreToolUse": []
    }
}
`;

  beforeEach(async () => {
    await seedSettings(EXISTING);
  });

  it("preserves the user's value as drift and adds the rest", async () => {
    const planned = ready(await plan(env, desiredFixture()));

    expect(planned.merge.changes).toHaveLength(8);
    expect(planned.merge.changes.map((change) => change.key)).not.toContain("env.AWS_REGION");
    expect(planned.merge.drift).toContainEqual({
      key: "env.AWS_REGION",
      current: "eu-west-1",
      lastApplied: undefined,
      recommended: "us-east-1",
    });

    const result = await commit(env, session, planned);

    expect(result.backup?.path).toMatch(/settings\..*\.json$/);
    expect(await envValue("AWS_REGION")).toBe("eu-west-1");
    expect(await envValue("FOO")).toBe("bar");
    expect((await readSnapshotFile()).values["env.AWS_REGION"]).toBeUndefined();
  });

  it("preserves unmanaged key order and indentation", async () => {
    await applyFixture();
    const written = await readText();

    expect(Object.keys(JSON.parse(written) as Settings).slice(0, 4)).toEqual([
      "$schema",
      "model",
      "env",
      "hooks",
    ]);
    expect(written).toContain('\n    "model"');
    expect(written).not.toContain('\n  "model"');
    expect(written.endsWith("\n")).toBe(true);
  });

  it("backs up once per session, and again in the next session", async () => {
    const dir = backupsDir(claudeDir);

    await applyFixture();
    await applyFixture(desiredFixture({ "env.ANTHROPIC_DEFAULT_OPUS_MODEL": OPUS_V2 }));
    expect(await listBackups(dir)).toHaveLength(1);

    session = createSession();
    await applyFixture(desiredFixture({ "env.ANTHROPIC_DEFAULT_OPUS_MODEL": OPUS_V1 }));
    expect(await listBackups(dir)).toHaveLength(2);
  });
});

/**
 * The one-backup-per-session rule assumes every write in a session overwrites
 * only values we ourselves wrote. The reset paths exist to overwrite a value
 * the *user* chose, so they opt out of it: hard rule 3 lets the user hand a key
 * back to us, but it has to leave them a way to undo that.
 */
describe("forceBackup", () => {
  it("takes a second backup in a session that already spent its one", async () => {
    const dir = backupsDir(claudeDir);
    await seedSettings('{\n  "env": {\n    "AWS_REGION": "eu-west-1"\n  }\n}\n');

    await applyFixture();
    expect(await listBackups(dir)).toHaveLength(1);

    // The user hand-edits, then asks for exactly that key to be reset.
    await seedSettings('{\n  "env": {\n    "AWS_REGION": "ap-southeast-1"\n  }\n}\n');
    const planned = ready(await resetKeyPlan(env, desiredFixture(), "env.AWS_REGION"));
    const result = await commit(env, session, planned, { forceBackup: true });

    expect(result.written).toBe(true);
    expect(result.backup?.path).toMatch(/settings\..*\.json$/);
    const backups = await listBackups(dir);
    expect(backups).toHaveLength(2);
    // The newest copy holds the value the reset just destroyed.
    expect(await readText(backups[0]?.path)).toContain("ap-southeast-1");
    expect(await envValue("AWS_REGION")).toBe("us-east-1");
  });

  it("still takes only one backup when it is not asked to force one", async () => {
    const dir = backupsDir(claudeDir);
    await seedSettings('{\n  "env": {\n    "AWS_REGION": "eu-west-1"\n  }\n}\n');

    await applyFixture();
    await seedSettings('{\n  "env": {\n    "AWS_REGION": "ap-southeast-1"\n  }\n}\n');
    await commit(env, session, ready(await resetKeyPlan(env, desiredFixture(), "env.AWS_REGION")));

    expect(await listBackups(dir)).toHaveLength(1);
  });

  it("does not force a backup on a noop plan", async () => {
    await applyFixture();
    const before = await listBackups(backupsDir(claudeDir));
    const planned = ready(await plan(env, desiredFixture()));
    expect(planned.noop).toBe(true);

    const result = await commit(env, session, planned, { forceBackup: true });

    expect(result).toMatchObject({ written: false, reason: "noop", backup: undefined });
    expect(await listBackups(backupsDir(claudeDir))).toHaveLength(before.length);
  });

  it("does not force a backup on a stale plan", async () => {
    await seedSettings('{\n  "env": {\n    "AWS_REGION": "eu-west-1"\n  }\n}\n');
    await applyFixture();
    const before = await listBackups(backupsDir(claudeDir));

    const planned = ready(await resetKeyPlan(env, desiredFixture(), "env.AWS_REGION"));
    await seedSettings('{\n  "env": {\n    "AWS_REGION": "somewhere-else"\n  }\n}\n');
    const result = await commit(env, session, planned, { forceBackup: true });

    expect(result).toMatchObject({ written: false, reason: "stale", backup: undefined });
    expect(await listBackups(backupsDir(claudeDir))).toHaveLength(before.length);
    expect(await envValue("AWS_REGION")).toBe("somewhere-else");
  });
});

describe("malformed settings", () => {
  const MALFORMED = '{\n  "model": "opus",\n}\n';

  it("blocks the plan and touches nothing", async () => {
    await seedSettings(MALFORMED);
    const result = await plan(env, desiredFixture());

    expect(result).toMatchObject({ kind: "blocked", reason: "malformed" });
    if (result.kind !== "blocked") {
      throw new Error("unreachable");
    }
    expect(result.raw).toBe(MALFORMED);

    // FR-2.5 is enforced by the type system, not a runtime check: a blocked
    // plan is simply not assignable to `commit`'s third parameter, so the
    // `@ts-expect-error` below fails the build if that ever stops being true.
    // @ts-expect-error a blocked plan can never be committed
    const refused: ReadyPlan = result;
    void refused;

    expect(await readText()).toBe(MALFORMED);
    expect(await exists(snapshotPath(claudeDir))).toBe(false);
    expect(await listBackups(backupsDir(claudeDir))).toEqual([]);
    expect((await readdir(claudeDir)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});

describe("drift from a hand edit", () => {
  beforeEach(async () => {
    await applyFixture();
    const settings = await readJson();
    (settings.env as JsonObject).AWS_REGION = "ap-southeast-1";
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  });

  it("reports the edited key, leaves it alone, and still applies other changes", async () => {
    const planned = ready(
      await plan(env, desiredFixture({ "env.ANTHROPIC_DEFAULT_OPUS_MODEL": OPUS_V2 })),
    );

    expect(planned.merge.drift).toEqual([
      {
        key: "env.AWS_REGION",
        current: "ap-southeast-1",
        lastApplied: "us-east-1",
        recommended: "us-east-1",
      },
    ]);
    expect(planned.merge.changes).toEqual([
      {
        key: "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
        kind: "update",
        before: OPUS_V1,
        after: OPUS_V2,
      },
    ]);

    await commit(env, session, planned);

    expect(await envValue("AWS_REGION")).toBe("ap-southeast-1");
    expect(await envValue("ANTHROPIC_DEFAULT_OPUS_MODEL")).toBe(OPUS_V2);
    // The snapshot records what we wrote, never what we found.
    expect((await readSnapshotFile()).values["env.AWS_REGION"]).toBe("us-east-1");
  });

  it("resets one key on request and adopts it into the snapshot", async () => {
    const planned = ready(await resetKeyPlan(env, desiredFixture(), "env.AWS_REGION"));

    expect(planned.merge.changes).toEqual([
      {
        key: "env.AWS_REGION",
        kind: "update",
        before: "ap-southeast-1",
        after: "us-east-1",
      },
    ]);

    await commit(env, session, planned);

    expect(await envValue("AWS_REGION")).toBe("us-east-1");
    const snapshot = await readSnapshotFile();
    expect(snapshot.values["env.AWS_REGION"]).toBe("us-east-1");
    expect(Object.keys(snapshot.values)).toHaveLength(9);
  });

  it("resets a key that is absent from the file", async () => {
    const settings = await readJson();
    delete (settings.env as JsonObject).AWS_REGION;
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    const planned = ready(await resetKeyPlan(env, desiredFixture(), "env.AWS_REGION"));

    expect(planned.merge.changes).toEqual([
      { key: "env.AWS_REGION", kind: "add", before: undefined, after: "us-east-1" },
    ]);
  });
});

describe("/setup-bedrock-style rewrite", () => {
  beforeEach(async () => {
    await applyFixture();
    // Claude Code rewrites the whole file itself and does not preserve the mode.
    const settings = await readJson();
    (settings.env as JsonObject).ANTHROPIC_DEFAULT_OPUS_MODEL = OPUS_V2;
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8" });
    await chmod(file, 0o664);
  });

  it("reports drift on the rewritten key only", async () => {
    const planned = ready(await plan(env, desiredFixture()));

    expect(planned.merge.drift.map((entry) => entry.key)).toEqual([
      "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]);
    expect(planned.merge.changes).toEqual([]);
    expect(planned.noop).toBe(true);
  });

  it.runIf(POSIX)("repairs the file mode, and reports the mode it found", async () => {
    expect(await repairPermissions(env)).toEqual({ kind: "repaired", before: 0o664 });
    expect(await mode(file)).toBe(0o600);
    expect(await repairPermissions(env)).toEqual({ kind: "ok", before: 0o600 });
  });

  it("answers from the DACL on Windows rather than from mode bits", async () => {
    // The Windows half of the assertion above: the same "is this file private
    // to me" question, asked the only way Windows can answer it (M6 Part B,
    // closing plan Q-K). An unreadable ACL is never a pass — see the
    // `unverifiable` cases in `test/unit/config/windowsAcl.test.ts`.
    const result = await repairPermissions({
      ...env,
      platform: "win32",
      acl: { scratchDir: tmp, run: async () => ({ kind: "missing" }) },
    });
    expect(result).toEqual({ kind: "unsupported" });
    if (POSIX) expect(await mode(file)).toBe(0o664);
  });
});

describe("a fresh install with no settings.json", () => {
  it.each(["linux", "win32"] as const)(
    "reports the file as absent on %s rather than throwing out of the health check",
    async (platform) => {
      // FR-2.8 runs on every health check, and the first one happens before the
      // user has ever applied anything: ENOENT is the normal case, not an error.
      // On win32 this used to report `unsupported` — the platform check ran
      // before the stat — so a fresh install was indistinguishable from an
      // unreadable ACL, and the panel said the wrong thing about both.
      expect(await repairPermissions({ ...env, platform })).toEqual({ kind: "absent" });
    },
  );
});

describe("backup and restore", () => {
  it("round-trips to an earlier configuration without adopting it", async () => {
    await seedSettings('{\n  "model": "opus"\n}\n');

    await applyFixture();
    const v1 = await readText();

    session = createSession();
    await applyFixture(desiredFixture({ "env.ANTHROPIC_DEFAULT_OPUS_MODEL": OPUS_V2 }));

    const dir = backupsDir(claudeDir);
    const backups = await listBackups(dir);
    expect(backups).toHaveLength(2);
    expect(backups[0]?.createdAt.getTime()).toBeGreaterThan(backups[1]?.createdAt.getTime() ?? 0);

    // `backups[0]` is the newer *file* but the older *configuration*: it was
    // taken immediately before the v2 write, so it holds v1 verbatim.
    const target = backups[0];
    if (target === undefined) {
      throw new Error("expected a backup");
    }
    expect(await readText(target.path)).toBe(v1);

    await restore(env, createSession(), target.path);

    expect(await readText()).toBe(v1);
    expect(await listBackups(dir)).toHaveLength(3);
    // Restoring disclaims ownership of everything: the file's provenance is
    // now unknown, so the snapshot must not keep claiming we wrote any of it.
    expect(await readSnapshotFile()).toEqual({ schemaVersion: 1, values: {} });

    const planned = ready(
      await plan(env, desiredFixture({ "env.ANTHROPIC_DEFAULT_OPUS_MODEL": OPUS_V2 })),
    );
    // Every restored key is unowned and preserved; only the one the manifest
    // has moved on from reads as drift.
    expect(planned.merge.drift.map((entry) => entry.key)).toEqual([
      "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]);
    expect(planned.merge.changes).toEqual([]);
  });

  it("saves the current file first even in a session that already backed up", async () => {
    // The restore confirmation promises "your current settings are saved
    // first". In a session that has already applied something, the one
    // session-scoped backup is spent, and without forcing one the promise is a
    // lie exactly when it matters: the file being replaced is the user's.
    await seedSettings('{\n  "model": "opus"\n}\n');
    await applyFixture();
    const dir = backupsDir(claudeDir);
    const target = (await listBackups(dir))[0];
    if (target === undefined) {
      throw new Error("expected a backup");
    }

    await seedSettings('{\n  "model": "precious-hand-written"\n}\n');
    await restore(env, session, target.path);

    const after = await listBackups(dir);
    expect(after).toHaveLength(2);
    expect(await readText(after[0]?.path)).toContain("precious-hand-written");
  });
});

describe("write failure", () => {
  it("rejects and leaves the snapshot untouched", async () => {
    hooks.writeFailure = new Error("disk full");

    await expect(commit(env, session, ready(await plan(env, desiredFixture())))).rejects.toThrow(
      "disk full",
    );

    expect(await exists(snapshotPath(claudeDir))).toBe(false);
    expect(await exists(file)).toBe(false);
  });
});

describe("workspace guard", () => {
  it("plans happily but refuses to commit inside a workspace folder", async () => {
    const inside = join(workspace, ".claude");
    const guarded = makeEnv(inside);

    const planned = ready(await plan(guarded, desiredFixture()));
    expect(planned.merge.changes).toHaveLength(9);

    await expect(commit(guarded, createSession(), planned)).rejects.toMatchObject({
      name: "ConfigError",
      code: "WRITE_INSIDE_WORKSPACE",
    });
    expect(await exists(settingsPath(inside))).toBe(false);
    expect(await exists(backupsDir(inside))).toBe(false);
  });
});

describe("no-op apply", () => {
  it("does not rewrite the file when nothing would change", async () => {
    await applyFixture();
    const before = await stat(file);

    const planned = ready(await plan(env, desiredFixture()));
    expect(planned.noop).toBe(true);

    const result = await commit(env, createSession(), planned);

    expect(result).toEqual({
      written: false,
      reason: "noop",
      backup: undefined,
      changes: [],
      drift: [],
    });
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await listBackups(backupsDir(claudeDir))).toEqual([]);
  });
});

describe("malformed containers inside a well-formed file", () => {
  // The reader accepts these: the file is valid JSON with an object at the top
  // level. `managedKeys` refuses to guess what a non-object `permissions` means,
  // and `plan` has to turn that into a blocked plan rather than an exception —
  // it is called from a health check that must never crash the panel.
  it.each([
    ['"permissions": "none"', '{\n  "permissions": "none"\n}\n'],
    ['"permissions": null', '{\n  "permissions": null\n}\n'],
    ['"permissions": []', '{\n  "permissions": []\n}\n'],
  ])("blocks the plan when %s", async (_label, text) => {
    await seedSettings(text);

    const result = await plan(env, desiredFixture());

    expect(result).toMatchObject({ kind: "blocked", reason: "malformed" });
    if (result.kind !== "blocked") {
      throw new Error("unreachable");
    }
    expect(result.error).toMatch(/"permissions" must be a JSON object/);
    expect(result.raw).toBe(text);
    expect(await readText()).toBe(text);
    expect(await exists(snapshotPath(claudeDir))).toBe(false);
  });

  it("blocks on a wrong-shaped desired value, with no file to quote", async () => {
    // The manifest, not the file, is malformed here: nothing has been read, so
    // the blocked result carries no raw text.
    const result = await plan(env, desiredFixture({ enabledPlugins: ["not-a-map"] }));

    expect(result).toMatchObject({ kind: "blocked", reason: "malformed", raw: "" });
  });

  it("does not swallow a failure that is not about the file's shape", async () => {
    // Only MALFORMED_SETTINGS becomes a blocked plan. Anything else is a bug
    // or a host failure, and must reach the caller rather than being reported
    // to the user as "your settings.json is malformed".
    const boom = new Error("snapshot store returned nonsense");
    const values = {
      get "env.AWS_REGION"(): never {
        throw boom;
      },
    } as unknown as Snapshot["values"];
    const broken: ConfigEnv = {
      ...env,
      snapshotStore: {
        load: () => Promise.resolve({ schemaVersion: 1, values }),
        save: () => Promise.resolve(),
      },
    };

    await expect(plan(broken, desiredFixture())).rejects.toThrow(boom);
  });

  it("blocks a reset of the offending key too", async () => {
    await seedSettings('{\n  "permissions": "none"\n}\n');

    expect(await resetKeyPlan(env, desiredFixture(), "permissions.deny")).toMatchObject({
      kind: "blocked",
      reason: "malformed",
    });
  });

  /**
   * A wrong-typed *element-owned* key is not the same class of problem as a
   * wrong-typed parent: the value is entirely the user's, so it is preserved
   * and reported as drift, and the rest of the apply still goes through.
   */
  it.each<[ManagedKey, string, JsonValue]>([
    ["extraKnownMarketplaces", '{\n  "extraKnownMarketplaces": 3\n}\n', 3],
    ["enabledPlugins", '{\n  "enabledPlugins": "x"\n}\n', "x"],
    ["permissions.deny", '{\n  "permissions": { "deny": "Read(./.env)" }\n}\n', "Read(./.env)"],
  ])("preserves a wrong-typed %s as drift and applies the rest", async (key, text, kept) => {
    await seedSettings(text);

    const planned = ready(await plan(env, desiredFixture()));

    expect(planned.merge.drift.map((entry) => entry.key)).toEqual([key]);
    expect(planned.merge.changes.map((change) => change.key)).not.toContain(key);

    await commit(env, session, planned);

    expect(getPath(await readJson(), key)).toEqual(kept);
    expect((await readSnapshotFile()).values[key]).toBeUndefined();
    expect(await envValue("AWS_REGION")).toBe("us-east-1");
  });
});

describe("resetting an element-owned key", () => {
  const USER_DENY = "Bash(sudo:*)";

  it("adopts only the deny rules we recommend, never the user's", async () => {
    await seedSettings(
      `${JSON.stringify({ permissions: { deny: [USER_DENY, "Bash(rm -rf:*)"] } }, null, 2)}\n`,
    );

    const planned = ready(await resetKeyPlan(env, desiredFixture(), "permissions.deny"));
    await commit(env, session, planned);

    // "Read(./.env)" is missing and gets added; the user's rule is untouched.
    expect(getPath(await readJson(), "permissions.deny")).toEqual([
      USER_DENY,
      "Bash(rm -rf:*)",
      "Read(./.env)",
    ]);
    expect((await readSnapshotFile()).values["permissions.deny"]).toEqual([
      "Bash(rm -rf:*)",
      "Read(./.env)",
    ]);

    // The next apply must not treat the adopted set as licence to remove the
    // user's rule, and must not report it as drift.
    const next = ready(await plan(env, desiredFixture()));
    expect(next.merge.changes.map((change) => change.key)).not.toContain("permissions.deny");
    expect(next.merge.drift).toEqual([]);
    expect(getPath(next.merge.next, "permissions.deny")).toEqual([
      USER_DENY,
      "Bash(rm -rf:*)",
      "Read(./.env)",
    ]);
  });

  it("takes over the plugins we recommend and leaves the user's enabled", async () => {
    await seedSettings(
      `${JSON.stringify(
        { enabledPlugins: { "user@theirs": true, "health@sensible-defaults": false } },
        null,
        2,
      )}\n`,
    );

    const planned = ready(await resetKeyPlan(env, desiredFixture(), "enabledPlugins"));
    await commit(env, session, planned);

    expect(getPath(await readJson(), "enabledPlugins")).toEqual({
      "user@theirs": true,
      "health@sensible-defaults": true,
    });
    expect((await readSnapshotFile()).values.enabledPlugins).toEqual({
      "health@sensible-defaults": true,
    });

    const next = ready(await plan(env, desiredFixture()));
    expect(next.merge.drift).toEqual([]);
    expect(getPath(next.merge.next, "enabledPlugins")).toEqual({
      "user@theirs": true,
      "health@sensible-defaults": true,
    });
  });

  it("takes over one marketplace without adopting the user's", async () => {
    const theirs = { source: { source: "github", repo: "someone/else" } };
    await seedSettings(
      `${JSON.stringify(
        {
          extraKnownMarketplaces: {
            theirs,
            "sensible-defaults": { source: { source: "github", repo: "stale/repo" } },
          },
        },
        null,
        2,
      )}\n`,
    );

    const planned = ready(await resetKeyPlan(env, desiredFixture(), "extraKnownMarketplaces"));
    await commit(env, session, planned);

    const written = getPath(await readJson(), "extraKnownMarketplaces") as JsonObject;
    expect(written.theirs).toEqual(theirs);
    expect(written["sensible-defaults"]).toEqual({
      source: { source: "github", repo: "cutler-sg/marketplace" },
    });
    expect(
      Object.keys((await readSnapshotFile()).values.extraKnownMarketplaces as JsonObject),
    ).toEqual(["sensible-defaults"]);

    // A later manifest that drops the marketplace removes ours and only ours.
    session = createSession();
    const shrunk = ready(await plan(env, desiredFixture({ extraKnownMarketplaces: {} })));
    await commit(env, session, shrunk);
    expect(getPath(await readJson(), "extraKnownMarketplaces")).toEqual({ theirs });
  });

  it("claims nothing when the file's value is the wrong shape", async () => {
    await seedSettings(`${JSON.stringify({ permissions: { deny: "Read(./.env)" } }, null, 2)}\n`);

    const planned = ready(await resetKeyPlan(env, desiredFixture(), "permissions.deny"));

    // There is nothing to take ownership of, so the string is preserved and
    // reported as drift — a reset is not a licence to reshape the file.
    expect(planned.merge.changes).toEqual([]);
    expect(planned.merge.drift.map((entry) => entry.key)).toEqual(["permissions.deny"]);
  });

  it("claims nothing when none of the recommended rules are present yet", async () => {
    await seedSettings(`${JSON.stringify({ permissions: { deny: [USER_DENY] } }, null, 2)}\n`);

    const planned = ready(await resetKeyPlan(env, desiredFixture(), "permissions.deny"));
    await commit(env, session, planned);

    // Nothing to adopt, so the reset degenerates into the ordinary add of both
    // recommended rules alongside the user's.
    expect(getPath(await readJson(), "permissions.deny")).toEqual([
      USER_DENY,
      "Bash(rm -rf:*)",
      "Read(./.env)",
    ]);
    expect((await readSnapshotFile()).values["permissions.deny"]).toEqual([
      "Bash(rm -rf:*)",
      "Read(./.env)",
    ]);
  });

  it("claims nothing when the manifest does not mention the key", async () => {
    await seedSettings(`${JSON.stringify({ enabledPlugins: { "user@theirs": true } }, null, 2)}\n`);

    const withoutPlugins: Desired = { ...desiredFixture() };
    delete withoutPlugins.enabledPlugins;
    const planned = ready(await resetKeyPlan(env, withoutPlugins, "enabledPlugins"));

    expect(planned.noop).toBe(true);
    expect(planned.merge.snapshotValues.enabledPlugins).toBeUndefined();
  });

  it("claims nothing when the recommended value is a removal", async () => {
    await seedSettings(`${JSON.stringify({ enabledPlugins: { "user@theirs": true } }, null, 2)}\n`);

    const planned = ready(
      await resetKeyPlan(env, desiredFixture({ enabledPlugins: undefined }), "enabledPlugins"),
    );

    // A reset can only adopt elements we recommend; recommending none leaves
    // the user's plugin unowned rather than adopting it in order to delete it.
    expect(planned.merge.changes).toEqual([]);
    expect(getPath(planned.merge.next, "enabledPlugins")).toEqual({ "user@theirs": true });
  });

  it("never adopts an element the manifest does not ask for", async () => {
    await seedSettings(`${JSON.stringify({ enabledPlugins: { "user@theirs": true } }, null, 2)}\n`);

    const planned = ready(await resetKeyPlan(env, desiredFixture(), "enabledPlugins"));
    await commit(env, session, planned);

    // Ownership covers our plugin only, so a manifest that later wants nothing
    // enabled cannot take the user's plugin down with it.
    session = createSession();
    await commit(env, session, ready(await plan(env, desiredFixture({ enabledPlugins: {} }))));
    expect(getPath(await readJson(), "enabledPlugins")).toEqual({ "user@theirs": true });
  });
});

describe("a concurrent write between plan and commit", () => {
  const BEFORE = `${JSON.stringify({ model: "opus", env: { MY: "x" } }, null, 2)}\n`;
  /** What `/setup-bedrock` leaves behind while the diff preview is open. */
  const CLAUDE_CODE = `${JSON.stringify(
    { model: "opus", env: { MY: "x", AWS_BEARER_TOKEN_BEDROCK: "ABSK-real-user-token" } },
    null,
    2,
  )}\n`;

  it("refuses to commit a plan built from a file that has since changed", async () => {
    await seedSettings(BEFORE);
    const planned = ready(await plan(env, { "env.AWS_REGION": "us-east-1" }));

    await writeFile(file, CLAUDE_CODE, "utf8");
    const result = await commit(env, session, planned);

    expect(result).toMatchObject({ written: false, reason: "stale", backup: undefined });
    expect(await readText()).toBe(CLAUDE_CODE);
    expect(await exists(snapshotPath(claudeDir))).toBe(false);
    expect(await listBackups(backupsDir(claudeDir))).toEqual([]);
  });

  it("refuses even when the session has already taken its one backup", async () => {
    // The unrecoverable case: with the session's backup already spent, an
    // overwrite here would destroy the token with no copy of it anywhere.
    await seedSettings(BEFORE);
    await applyFixture({ "env.AWS_REGION": "us-east-1" });

    const planned = ready(await plan(env, { "env.ANTHROPIC_DEFAULT_OPUS_MODEL": OPUS_V1 }));
    await writeFile(file, CLAUDE_CODE, "utf8");
    const result = await commit(env, session, planned);

    expect(result.written).toBe(false);
    expect(await readJson()).toMatchObject({
      env: { AWS_BEARER_TOKEN_BEDROCK: "ABSK-real-user-token" },
    });
  });

  it("refuses when the file appeared after a plan that read no file", async () => {
    const planned = ready(await plan(env, { "env.AWS_REGION": "us-east-1" }));

    await seedSettings(CLAUDE_CODE);
    const result = await commit(env, session, planned);

    expect(result).toMatchObject({ written: false, reason: "stale" });
    expect(await readText()).toBe(CLAUDE_CODE);
  });

  it("refuses when the file was deleted after the plan read it", async () => {
    await seedSettings(BEFORE);
    const planned = ready(await plan(env, { "env.AWS_REGION": "us-east-1" }));

    await rm(file);
    const result = await commit(env, session, planned);

    expect(result).toMatchObject({ written: false, reason: "stale" });
    expect(await exists(file)).toBe(false);
  });

  it("refuses when the file became unparseable after the plan read it", async () => {
    await seedSettings(BEFORE);
    const planned = ready(await plan(env, { "env.AWS_REGION": "us-east-1" }));

    await writeFile(file, "{ oops", "utf8");
    const result = await commit(env, session, planned);

    expect(result).toMatchObject({ written: false, reason: "stale" });
    expect(await readText()).toBe("{ oops");
  });

  it("refuses when the file became unreadable for a host reason", async () => {
    await seedSettings(BEFORE);
    const planned = ready(await plan(env, { "env.AWS_REGION": "us-east-1" }));

    // EISDIR rather than a content problem: we cannot see what is there, so we
    // must not write over it.
    await rm(file);
    await mkdir(file);
    const result = await commit(env, session, planned);

    expect(result).toMatchObject({ written: false, reason: "stale" });
    expect(await readdir(file)).toEqual([]);
  });

  it("commits when a rewrite left the bytes identical", async () => {
    await seedSettings(BEFORE);
    const planned = ready(await plan(env, { "env.AWS_REGION": "us-east-1" }));

    await writeFile(file, BEFORE, "utf8");
    const result = await commit(env, session, planned);

    expect(result.written).toBe(true);
    expect(await envValue("AWS_REGION")).toBe("us-east-1");
  });

  it("reports a no-op as such, not as stale", async () => {
    await applyFixture();
    const result = await commit(env, createSession(), ready(await plan(env, desiredFixture())));

    expect(result).toEqual({
      written: false,
      reason: "noop",
      backup: undefined,
      changes: [],
      drift: [],
    });
  });
});

describe("restore then apply", () => {
  /**
   * FR-2.4's undo has to survive the next apply. Before the fix the restored
   * file looked like "our keys are missing but the snapshot says we wrote
   * them", which the table reads as a plain re-add — the undo was reverted
   * silently, with nothing in the diff preview to show for it.
   */
  it("shows the restored-away keys as visible adds, not a silent revert", async () => {
    await seedSettings(`${JSON.stringify({ model: "opus" }, null, 2)}\n`);
    const original = await readText();

    await applyFixture();
    const backups = await listBackups(backupsDir(claudeDir));
    const target = backups[0];
    if (target === undefined) {
      throw new Error("expected a backup");
    }

    await restore(env, createSession(), target.path);
    expect(await readText()).toBe(original);
    expect(await readSnapshotFile()).toEqual({ schemaVersion: 1, values: {} });

    const planned = ready(await plan(env, desiredFixture()));

    expect(planned.merge.changes).toHaveLength(9);
    expect(planned.merge.changes.every((change) => change.kind === "add")).toBe(true);
    expect(planned.merge.drift).toEqual([]);
    // Nothing is written until the user commits the plan they just saw.
    expect(await readText()).toBe(original);
  });

  it("treats keys the restore brought back as unowned: preserved and drifting", async () => {
    await seedSettings(`${JSON.stringify({ env: { AWS_REGION: "eu-west-1" } }, null, 2)}\n`);
    // Adopt the user's region so the snapshot claims it, then restore over it.
    await commit(env, session, ready(await resetKeyPlan(env, desiredFixture(), "env.AWS_REGION")));
    expect(await envValue("AWS_REGION")).toBe("us-east-1");

    const target = (await listBackups(backupsDir(claudeDir)))[0];
    if (target === undefined) {
      throw new Error("expected a backup");
    }
    await restore(env, createSession(), target.path);

    const planned = ready(await plan(env, desiredFixture()));

    expect(planned.merge.drift).toContainEqual({
      key: "env.AWS_REGION",
      current: "eu-west-1",
      lastApplied: undefined,
      recommended: "us-east-1",
    });
    expect(planned.merge.changes.map((change) => change.key)).not.toContain("env.AWS_REGION");

    await commit(env, session, planned);
    expect(await envValue("AWS_REGION")).toBe("eu-west-1");
  });
});
