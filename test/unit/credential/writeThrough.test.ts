import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ApplySession,
  type ConfigEnv,
  ConfigError,
  createSession,
  FileSnapshotStore,
  type Settings,
  settingsPath,
  snapshotPath,
} from "../../../src/config/index.js";
import {
  adoptTokenFromSettings,
  readTokenFromSettings,
  removeTokenFromSettings,
  syncTokenToSettings,
  TOKEN_SETTINGS_KEY,
} from "../../../src/credential/writeThrough.js";

const TOKEN = "ABSKQmVkcm9ja0FQSUtleUV4YW1wbGVWYWx1ZQ";
const ROTATED = "ABSKUm90YXRlZEJlZHJvY2tBUElLZXlWYWx1ZQ";
/** What Claude Code's own `/setup-bedrock` would have left in the file. */
const WIZARD_TOKEN = "bedrock-api-key-BQoJb3JpZ2luX2VjEHkaCXVzLWVhc3QtMQ";

const POSIX = process.platform !== "win32";

let tmp: string;
let claudeDir: string;
let workspace: string;
let file: string;
let env: ConfigEnv;
let session: ApplySession;
let clockMs: number;

function tick(): Date {
  clockMs += 1000;
  return new Date(clockMs);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scd-writethrough-"));
  claudeDir = join(tmp, ".claude");
  workspace = join(tmp, "ws");
  file = settingsPath(claudeDir);
  clockMs = Date.UTC(2026, 8, 10, 12, 0, 0);
  await mkdir(workspace, { recursive: true });
  env = {
    claudeDir,
    workspaceFolders: [workspace],
    snapshotStore: new FileSnapshotStore(snapshotPath(claudeDir), {
      workspaceFolders: [workspace],
    }),
    now: tick,
  };
  session = createSession();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function seed(settings: Settings): Promise<void> {
  await mkdir(claudeDir, { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readFileSettings(): Promise<Settings> {
  return JSON.parse(await readFile(file, "utf8")) as Settings;
}

function envBlock(settings: Settings): Record<string, unknown> {
  return (settings.env ?? {}) as Record<string, unknown>;
}

describe("syncTokenToSettings", () => {
  it("writes the token and the Bedrock flag to a fresh file at 0600", async () => {
    const result = await syncTokenToSettings(env, session, TOKEN);

    expect(result.written).toBe(true);
    expect(envBlock(await readFileSettings())).toEqual({
      AWS_BEARER_TOKEN_BEDROCK: TOKEN,
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    if (POSIX) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("rotates a token we already wrote without reporting drift", async () => {
    await syncTokenToSettings(env, session, TOKEN);
    const result = await syncTokenToSettings(env, session, ROTATED);

    expect(result.written).toBe(true);
    expect(result.drift).toEqual([]);
    expect(envBlock(await readFileSettings()).AWS_BEARER_TOKEN_BEDROCK).toBe(ROTATED);
  });

  it("is a no-op when the file already says what we want", async () => {
    await syncTokenToSettings(env, session, TOKEN);
    const result = await syncTokenToSettings(env, session, TOKEN);

    expect(result).toMatchObject({ written: false, reason: "noop" });
  });

  it("removes the token on clear and leaves the Bedrock flag alone", async () => {
    await syncTokenToSettings(env, session, TOKEN);
    const result = await syncTokenToSettings(env, session, undefined);

    expect(result.written).toBe(true);
    expect(envBlock(await readFileSettings())).toEqual({ CLAUDE_CODE_USE_BEDROCK: "1" });
    expect(result.changes.map((c) => [c.key, c.kind])).toContainEqual([
      TOKEN_SETTINGS_KEY,
      "remove",
    ]);
  });

  it("preserves everything else in the user's file", async () => {
    await seed({
      env: { AWS_REGION: "eu-central-1", MY_OWN_VAR: "keep me" },
      hooks: { PreToolUse: [] },
    });
    await syncTokenToSettings(env, session, TOKEN);

    const settings = await readFileSettings();
    expect(envBlock(settings)).toMatchObject({
      AWS_REGION: "eu-central-1",
      MY_OWN_VAR: "keep me",
      AWS_BEARER_TOKEN_BEDROCK: TOKEN,
    });
    expect(settings.hooks).toEqual({ PreToolUse: [] });
  });

  describe("hard rule 3: a value we did not write is never overwritten", () => {
    it("reports a hand-edited token as drift and leaves it in place", async () => {
      await syncTokenToSettings(env, session, TOKEN);
      const settings = await readFileSettings();
      // The user (or `/setup-bedrock`) puts a different value in the file.
      await seed({
        ...settings,
        env: { ...envBlock(settings), AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN },
      } as Settings);

      const result = await syncTokenToSettings(env, session, ROTATED);

      expect(envBlock(await readFileSettings()).AWS_BEARER_TOKEN_BEDROCK).toBe(WIZARD_TOKEN);
      expect(result.drift).toHaveLength(1);
      expect(result.drift[0]).toMatchObject({
        key: TOKEN_SETTINGS_KEY,
        current: WIZARD_TOKEN,
        recommended: ROTATED,
      });
    });

    it("reports a token we never wrote as drift on a first sync", async () => {
      await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN } });

      const result = await syncTokenToSettings(env, session, TOKEN);

      expect(envBlock(await readFileSettings()).AWS_BEARER_TOKEN_BEDROCK).toBe(WIZARD_TOKEN);
      expect(result.drift.map((d) => d.key)).toEqual([TOKEN_SETTINGS_KEY]);
    });

    it("does not remove a token we never wrote", async () => {
      await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN } });

      await syncTokenToSettings(env, session, undefined);

      expect(envBlock(await readFileSettings()).AWS_BEARER_TOKEN_BEDROCK).toBe(WIZARD_TOKEN);
    });
  });

  it("throws a config error, not a leaky one, on a malformed file", async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(file, `{"env": {"AWS_BEARER_TOKEN_BEDROCK": ${TOKEN}}`, "utf8");

    const error = await syncTokenToSettings(env, session, TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigError);
    // Hard rule 4: V8's parse message quotes the document around the fault,
    // which is exactly where an unquoted token sits.
    expect(String(error)).not.toContain(TOKEN);
  });

  it("passes the manifest revision through to the snapshot", async () => {
    await syncTokenToSettings(env, session, TOKEN, { manifestRevision: "2026-09-10" });
    const snapshot = JSON.parse(await readFile(snapshotPath(claudeDir), "utf8"));
    expect(snapshot.manifestRevision).toBe("2026-09-10");
  });
});

describe("readTokenFromSettings", () => {
  it("reads the token the file holds", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN } });
    await expect(readTokenFromSettings(env)).resolves.toBe(WIZARD_TOKEN);
  });

  it("is undefined when the file is absent", async () => {
    await expect(readTokenFromSettings(env)).resolves.toBeUndefined();
  });

  it("is undefined when the key is absent", async () => {
    await seed({ env: { AWS_REGION: "us-east-1" } });
    await expect(readTokenFromSettings(env)).resolves.toBeUndefined();
  });

  it("is undefined when the file is malformed", async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(file, "{not json", "utf8");
    await expect(readTokenFromSettings(env)).resolves.toBeUndefined();
  });

  it("is undefined when the value is not a string", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: 42 } });
    await expect(readTokenFromSettings(env)).resolves.toBeUndefined();
  });

  it("is undefined when the value is an empty string", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: "" } });
    await expect(readTokenFromSettings(env)).resolves.toBeUndefined();
  });

  it("writes nothing", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN } });
    const before = await readFile(file, "utf8");
    await readTokenFromSettings(env);
    expect(await readFile(file, "utf8")).toBe(before);
  });
});

describe("adoptTokenFromSettings (plan Q-S)", () => {
  it("takes ownership of a value /setup-bedrock left behind, so a later sync updates it", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN, CLAUDE_CODE_USE_BEDROCK: "1" } });

    // Before adoption the value is unowned: a sync would report drift.
    const contested = await syncTokenToSettings(env, createSession(), ROTATED);
    expect(contested.drift.map((d) => d.key)).toEqual([TOKEN_SETTINGS_KEY]);
    expect(envBlock(await readFileSettings()).AWS_BEARER_TOKEN_BEDROCK).toBe(WIZARD_TOKEN);

    const adopted = await adoptTokenFromSettings(env, session, WIZARD_TOKEN);
    expect(adopted.reason).toBe("noop");

    // After adoption the same sync writes cleanly, with no drift.
    const after = await syncTokenToSettings(env, createSession(), ROTATED);
    expect(after.written).toBe(true);
    expect(after.drift).toEqual([]);
    expect(envBlock(await readFileSettings()).AWS_BEARER_TOKEN_BEDROCK).toBe(ROTATED);
  });

  it("touches only the token key, leaving other managed keys unowned", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN, AWS_REGION: "eu-central-1" } });

    await adoptTokenFromSettings(env, session, WIZARD_TOKEN);

    const snapshot = JSON.parse(await readFile(snapshotPath(claudeDir), "utf8"));
    expect(Object.keys(snapshot.values)).toEqual([TOKEN_SETTINGS_KEY]);
    expect(envBlock(await readFileSettings()).AWS_REGION).toBe("eu-central-1");
  });

  it("writes when the adopted value differs from what is in the file", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN } });

    const result = await adoptTokenFromSettings(env, session, ROTATED);

    expect(result.written).toBe(true);
    expect(envBlock(await readFileSettings()).AWS_BEARER_TOKEN_BEDROCK).toBe(ROTATED);
  });

  it("backs up before overwriting a value the user chose", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN } });
    // Consume the session's one backup, so only forceBackup can produce another.
    await syncTokenToSettings(env, session, undefined);

    const result = await adoptTokenFromSettings(env, session, ROTATED);

    expect(result.backup).toBeDefined();
  });

  it("preserves ownership of keys claimed earlier", async () => {
    await syncTokenToSettings(env, session, TOKEN);
    const before = JSON.parse(await readFile(snapshotPath(claudeDir), "utf8"));
    expect(Object.keys(before.values)).toContain("env.CLAUDE_CODE_USE_BEDROCK");

    await adoptTokenFromSettings(env, session, TOKEN);

    const after = JSON.parse(await readFile(snapshotPath(claudeDir), "utf8"));
    expect(Object.keys(after.values).sort()).toEqual(Object.keys(before.values).sort());
  });

  it("throws a config error, not a leaky one, on a malformed file", async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(file, `{"env": {"AWS_BEARER_TOKEN_BEDROCK": ${WIZARD_TOKEN}}`, "utf8");

    const error = await adoptTokenFromSettings(env, session, WIZARD_TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).not.toContain(WIZARD_TOKEN);
  });
});

/**
 * The one path that overwrites a token we did not write. It exists because
 * "Remove Bedrock API Key" has to mean removed: a plain sync would leave a key
 * `/setup-bedrock` wrote sitting in the file for Claude Code to keep using.
 */
describe("removeTokenFromSettings", () => {
  it("removes a token we wrote", async () => {
    await syncTokenToSettings(env, session, TOKEN);

    await removeTokenFromSettings(env, session);

    expect(envBlock(await readFileSettings())).not.toHaveProperty(TOKEN_SETTINGS_KEY.slice(4));
  });

  it("removes a token the CLI wizard wrote, which a plain sync would keep", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN } });

    // The ordinary removal path preserves it: unowned value, hands off.
    await syncTokenToSettings(env, session, undefined);
    expect(envBlock(await readFileSettings()).AWS_BEARER_TOKEN_BEDROCK).toBe(WIZARD_TOKEN);

    await removeTokenFromSettings(env, session);

    expect(envBlock(await readFileSettings())).not.toHaveProperty("AWS_BEARER_TOKEN_BEDROCK");
  });

  it("leaves the Bedrock routing flag alone — that is not a credential", async () => {
    await seed({
      env: { AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN, CLAUDE_CODE_USE_BEDROCK: "1" },
    });

    await removeTokenFromSettings(env, session);

    expect(envBlock(await readFileSettings()).CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });

  it("backs the file up first, so a removal is recoverable", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: WIZARD_TOKEN } });

    const result = await removeTokenFromSettings(env, session);

    expect(result.written).toBe(true);
    expect(result.backup).toBeDefined();
  });

  it("is a no-op when there is nothing to remove", async () => {
    await seed({ env: { AWS_REGION: "us-east-1" } });

    const result = await removeTokenFromSettings(env, session);

    expect(result.written).toBe(false);
    expect(result.reason).toBe("noop");
  });
});
