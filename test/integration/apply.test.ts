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
    "env.ANTHROPIC_DEFAULT_HAIKU_MODEL": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
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
    snapshotStore: new FileSnapshotStore(snapshotPath(dir)),
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
      manifestRevision: "2026-09-10T00:00:00Z",
    });

    expect(result).toMatchObject({ written: true, backup: undefined });
    expect(await readJson()).toEqual(planned.merge.next);
    expect(await mode(file)).toBe(0o600);

    const snapshot = await readSnapshotFile();
    expect(Object.keys(snapshot.values)).toHaveLength(9);
    expect(snapshot.manifestRevision).toBe("2026-09-10T00:00:00Z");
    expect(snapshot.appliedAt).toBe(new Date(clockMs).toISOString());
    expect(await listBackups(backupsDir(claudeDir))).toEqual([]);
  });

  it("works without injected platform or clock", async () => {
    const bare: ConfigEnv = {
      claudeDir,
      workspaceFolders: [workspace],
      snapshotStore: new FileSnapshotStore(snapshotPath(claudeDir)),
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

  it("repairs the file mode, and reports no repair the second time", async () => {
    expect(await repairPermissions(env)).toEqual({ repaired: true });
    expect(await mode(file)).toBe(0o600);
    expect(await repairPermissions(env)).toEqual({ repaired: false });
  });

  it("reports Windows as unsupported rather than repairing mode bits", async () => {
    expect(await repairPermissions({ ...env, platform: "win32" })).toEqual({ unsupported: true });
    expect(await mode(file)).toBe(0o664);
  });
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

    const snapshotBefore = await readSnapshotFile();
    await restore(env, createSession(), target.path);

    expect(await readText()).toBe(v1);
    expect(await listBackups(dir)).toHaveLength(3);
    expect(await readSnapshotFile()).toEqual(snapshotBefore);

    const planned = ready(
      await plan(env, desiredFixture({ "env.ANTHROPIC_DEFAULT_OPUS_MODEL": OPUS_V2 })),
    );
    expect(planned.merge.drift.map((entry) => entry.key)).toEqual([
      "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]);
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

    expect(result).toEqual({ written: false, backup: undefined, changes: [], drift: [] });
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
