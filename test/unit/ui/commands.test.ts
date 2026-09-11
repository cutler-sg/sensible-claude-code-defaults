import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplySession } from "../../../src/config/apply.js";
import { backupsDir, settingsPath } from "../../../src/config/paths.js";
import { MemorySnapshotStore } from "../../../src/config/snapshot.js";
import type { ConfigEnv, JsonObject, Settings } from "../../../src/config/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import type { Manifest } from "../../../src/manifest/types.js";
import { registerCommands } from "../../../src/ui/commands.js";
import { messages, reset, run, state } from "./commandsHost.js";
import { fakeCredentialDeps } from "./credentialDeps.js";

// `vscode` is supplied by the extension host and never bundled, so a unit test
// has to stand it in. This stub is the *command* half of the API and is
// deliberately separate from `vscodeStub.ts`, which models the tree half.
vi.mock("vscode", async () => await import("./commandsHost.js"));

const RECOMMENDED_REGION = BUNDLED_MANIFEST.defaults.env.AWS_REGION;
const RECOMMENDED_OPUS = BUNDLED_MANIFEST.defaults.env.ANTHROPIC_DEFAULT_OPUS_MODEL;

let dir: string;
let env: ConfigEnv;
let session: ApplySession;
let logged: string[];
let healthRuns: number;
let disposable: { dispose(): void };

const log = {
  info: (message: string) => logged.push(`info ${message}`),
  warn: (message: string) => logged.push(`warn ${message}`),
  error: (message: string) => logged.push(`error ${message}`),
};

function register(manifest: Manifest = BUNDLED_MANIFEST): void {
  disposable = registerCommands({
    env,
    session,
    manifest,
    settingsFile: settingsPath(dir),
    backupsDir: backupsDir(dir),
    log: log as never,
    runHealth: async () => {
      healthRuns += 1;
    },
    markWrite: () => {},
    credential: fakeCredentialDeps(),
    now: () => new Date("2026-09-10T12:00:00Z"),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scd-cmds-"));
  env = {
    claudeDir: dir,
    workspaceFolders: [],
    snapshotStore: new MemorySnapshotStore(),
    platform: process.platform,
  };
  session = { backedUp: false };
  logged = [];
  healthRuns = 0;
  reset();
  register();
});

afterEach(async () => {
  disposable?.dispose();
  await rm(dir, { recursive: true, force: true });
});

async function seed(settings: unknown): Promise<void> {
  await writeFile(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function seedRaw(text: string): Promise<void> {
  await writeFile(settingsPath(dir), text, "utf8");
}

async function readSettings(): Promise<Settings> {
  return JSON.parse(await readFile(settingsPath(dir), "utf8")) as Settings;
}

async function readEnv(name: string): Promise<unknown> {
  return ((await readSettings()).env as JsonObject | undefined)?.[name];
}

async function backupCount(): Promise<number> {
  try {
    return (await readdir(backupsDir(dir))).length;
  } catch {
    return 0;
  }
}

/** Answer a QuickPick by the label of the item to choose. */
function pick(label: string): void {
  state.quickPickAnswer = (call) => call.items.find((item) => labelOf(item) === label) ?? undefined;
}

function labelOf(item: unknown): string {
  return typeof item === "string" ? item : ((item as { label?: string }).label ?? "");
}

function quickPickLabels(at = 0): string[] {
  return (state.quickPicks[at]?.items ?? []).map(labelOf);
}

describe("applyDefaults", () => {
  it("previews the changes and writes nothing when the user cancels", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    pick("Cancel");

    await run("sensibleDefaults.applyDefaults");

    expect(await readEnv("AWS_REGION")).toBe("eu-west-1");
    expect(await backupCount()).toBe(0);
    expect(logged).toContain("info applyDefaults cancelled by the user.");
  });

  it("puts Cancel first, so a stray Enter cannot write", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    // A QuickPick opens with the *first* item highlighted; answer with it.
    state.quickPickAnswer = (call) => call.items[0];

    await run("sensibleDefaults.applyDefaults");

    expect(quickPickLabels()[0]).toBe("Cancel");
    expect(await readEnv("AWS_REGION")).toBe("eu-west-1");
    expect(await backupCount()).toBe(0);
  });

  it("treats picking a change row as reading, not deciding", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    state.quickPickAnswer = (call) =>
      call.items.find((item) => labelOf(item).startsWith("Amazon region"));

    await run("sensibleDefaults.applyDefaults");

    expect(await readEnv("AWS_REGION")).toBe("eu-west-1");
  });

  it("writes and backs up when the user confirms", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    state.quickPickAnswer = (call) =>
      call.items.find((item) => labelOf(item).startsWith("Apply all"));

    await run("sensibleDefaults.applyDefaults");

    expect(await readEnv("CLAUDE_CODE_USE_BEDROCK")).toBe("1");
    // Hard rule 3: a value we never wrote is preserved, not overwritten, even
    // in the apply the user just accepted. It shows up as drift instead.
    expect(await readEnv("AWS_REGION")).toBe("eu-west-1");
    expect(await backupCount()).toBe(1);
    expect(messages().some((message) => /^Applied \d+ change/.test(message))).toBe(true);
    expect(healthRuns).toBe(1);
  });

  it("says so and asks nothing when there is nothing to do", async () => {
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));
    await run("sensibleDefaults.applyDefaults");
    reset();
    register();

    await run("sensibleDefaults.applyDefaults");

    expect(messages()).toEqual(["Already up to date."]);
    expect(state.quickPicks).toEqual([]);
  });

  it("refuses to touch a file it cannot parse, and offers a way out", async () => {
    await seedRaw('{\n  "env": {,\n}\n');
    const before = await readFile(settingsPath(dir), "utf8");

    await run("sensibleDefaults.applyDefaults");

    expect(state.error).toHaveLength(1);
    expect(state.error[0]?.message).toContain("can't be read");
    expect(state.error[0]?.items).toEqual(["Open file", "Restore backup"]);
    expect(await readFile(settingsPath(dir), "utf8")).toBe(before);
  });

  it("never logs the raw file, only the sanitized parse error (hard rule 4)", async () => {
    const token = "ABSKtest123456789012345678901234567890";
    await seedRaw(`{\n  "env": {\n    "AWS_BEARER_TOKEN_BEDROCK": ${token}\n  }\n}\n`);

    await run("sensibleDefaults.applyDefaults");

    const emitted = [...logged, ...messages()].join("\n");
    for (let at = 0; at + 8 <= token.length; at += 1) {
      expect(emitted).not.toContain(token.slice(at, at + 8));
    }
  });

  it("opens the settings file from the blocked dialog", async () => {
    await seedRaw("{,}");
    state.answer = (shown) => (shown.items.includes("Open file") ? "Open file" : undefined);

    await run("sensibleDefaults.applyDefaults");

    expect(state.opened).toEqual([settingsPath(dir)]);
  });

  it("offers the backup list from the blocked dialog", async () => {
    await seedRaw("{,}");
    state.answer = (shown) =>
      shown.items.includes("Restore backup") ? "Restore backup" : undefined;

    await run("sensibleDefaults.applyDefaults");

    expect(messages()).toContain("There are no saved copies to restore yet.");
  });

  it("retries a stale plan exactly once", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    // Every `plan` loads the snapshot; nudging the file there makes every
    // commit see a document that changed under it.
    env.snapshotStore = racingStore();
    reset();
    register();
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));

    await run("sensibleDefaults.applyDefaults");

    expect(staleWarnings()).toBe(2);
    expect(await backupCount()).toBe(0);
  });
});

const STALE_MESSAGE = "Settings changed while the preview was open — please review again.";

/** Warnings that are the stale notice, not the replace-confirmation modal. */
function staleWarnings(): number {
  return state.warn.filter((shown) => shown.message === STALE_MESSAGE).length;
}

/** A snapshot store whose `load` touches settings.json: every commit is stale. */
function racingStore(): ConfigEnv["snapshotStore"] {
  const inner = new MemorySnapshotStore();
  return {
    load: async () => {
      await writeFile(settingsPath(dir), `${await readFile(settingsPath(dir), "utf8")} `, "utf8");
      return inner.load();
    },
    save: (snapshot) => inner.save(snapshot),
  };
}

describe("resetKey", () => {
  const OPUS = "env.ANTHROPIC_DEFAULT_OPUS_MODEL";

  it("ignores a call with no drifted key", async () => {
    await run("sensibleDefaults.resetKey", undefined);

    expect(messages()).toEqual([]);
    expect(logged).toContain("warn resetKey called without a drifted key; ignoring.");
  });

  it("confirms with a modal before replacing a value the user chose", async () => {
    await seed({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "my-carefully-chosen-opus" } });

    await run("sensibleDefaults.resetKey", OPUS);

    expect(state.warn).toHaveLength(1);
    const shown = state.warn[0];
    expect(shown?.message).toContain("Opus model");
    expect(shown?.options).toMatchObject({ modal: true });
    expect(String((shown?.options as { detail?: string } | undefined)?.detail)).toContain(
      "my-carefully-chosen-opus",
    );
    expect(shown?.items).toEqual(["Replace"]);
    // Dismissed: nothing written.
    expect(await readEnv("ANTHROPIC_DEFAULT_OPUS_MODEL")).toBe("my-carefully-chosen-opus");
    expect(await backupCount()).toBe(0);
  });

  it("writes only when the user picks Replace", async () => {
    await seed({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "my-carefully-chosen-opus" } });
    state.answer = () => "Replace";

    await run("sensibleDefaults.resetKey", OPUS);

    expect(await readEnv("ANTHROPIC_DEFAULT_OPUS_MODEL")).toBe(RECOMMENDED_OPUS);
    expect(healthRuns).toBe(1);
  });

  it("saves the replaced value even when the session already backed up", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));
    await run("sensibleDefaults.applyDefaults");
    expect(await backupCount()).toBe(1);

    await seed({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "my-carefully-chosen-opus" } });
    state.answer = () => "Replace";

    await run("sensibleDefaults.resetKey", OPUS);

    expect(await backupCount()).toBe(2);
    const newest = (await readdir(backupsDir(dir))).sort().at(-1) as string;
    expect(await readFile(join(backupsDir(dir), newest), "utf8")).toContain(
      "my-carefully-chosen-opus",
    );
  });

  it("accepts a drift node from the inline button", async () => {
    await seed({ env: { AWS_REGION: "eu-west-9" } });
    state.answer = () => "Replace";
    const node = {
      kind: "drift",
      group: "Configuration",
      key: "env.AWS_REGION",
      child: { key: "env.AWS_REGION", label: "You changed it", fix: { kind: "none" } },
    };

    await run("sensibleDefaults.resetKey", node);

    expect(await readEnv("AWS_REGION")).toBe(RECOMMENDED_REGION);
  });

  it("explains when the manifest has no recommended value for the key", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: "ABSKnot-a-real-token" } });

    await run("sensibleDefaults.resetKey", "env.AWS_BEARER_TOKEN_BEDROCK");

    expect(messages()).toEqual(["There's no recommended value for Amazon Bedrock API key yet."]);
    expect(await readEnv("AWS_BEARER_TOKEN_BEDROCK")).toBe("ABSKnot-a-real-token");
  });

  it("says the value already matches rather than rerunning silently", async () => {
    await seed({ env: { AWS_REGION: RECOMMENDED_REGION } });

    await run("sensibleDefaults.resetKey", "env.AWS_REGION");

    expect(messages()).toEqual(["Your Amazon region already matches the recommended value."]);
    expect(state.warn).toEqual([]);
  });

  it("retries a stale plan exactly once, not unboundedly", async () => {
    await seed({ env: { AWS_REGION: "eu-west-9" } });
    env.snapshotStore = racingStore();
    reset();
    register();
    state.answer = () => "Replace";

    await run("sensibleDefaults.resetKey", "env.AWS_REGION");

    // Two attempts: the original and one retry. The bug was `attempt` being
    // reset to 0 by the retry closure, which recursed until the stack blew.
    expect(staleWarnings()).toBe(2);
    expect(state.info).toHaveLength(0);
  });

  it("reports a malformed file rather than writing", async () => {
    await seedRaw("{,}");

    await run("sensibleDefaults.resetKey", "env.AWS_REGION");

    expect(state.error[0]?.message).toContain("can't be read");
  });
});

describe("selectRegion", () => {
  it("explains itself when the manifest lists no regions", async () => {
    reset();
    register({ ...BUNDLED_MANIFEST, regions: [] });

    await run("sensibleDefaults.selectRegion");

    expect(state.quickPicks).toEqual([]);
    expect(messages()).toEqual([
      "There are no Amazon regions to choose from in the current recommendations.",
    ]);
  });

  it("writes nothing when the region picker is dismissed", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });

    await run("sensibleDefaults.selectRegion");

    expect(quickPickLabels()).toEqual([...BUNDLED_MANIFEST.regions]);
    expect(await readEnv("AWS_REGION")).toBe("eu-west-1");
  });

  it("confirms with a modal before replacing the current region", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    pick("ap-southeast-1");

    await run("sensibleDefaults.selectRegion");

    expect(state.warn[0]?.options).toMatchObject({ modal: true });
    expect(await readEnv("AWS_REGION")).toBe("eu-west-1");
  });

  it("writes the chosen region on Replace, with a backup", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    pick("ap-southeast-1");
    state.answer = () => "Replace";

    await run("sensibleDefaults.selectRegion");

    expect(await readEnv("AWS_REGION")).toBe("ap-southeast-1");
    expect(await backupCount()).toBe(1);
    expect(healthRuns).toBe(1);
  });

  it("says the region is already set rather than writing nothing silently", async () => {
    await seed({ env: { AWS_REGION: "us-west-2" } });
    pick("us-west-2");

    await run("sensibleDefaults.selectRegion");

    expect(messages()).toEqual(["Your Amazon region is already us-west-2."]);
  });

  it("retries a stale plan exactly once", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    env.snapshotStore = racingStore();
    reset();
    register();
    pick("ap-southeast-1");
    state.answer = () => "Replace";

    await run("sensibleDefaults.selectRegion");

    expect(staleWarnings()).toBe(2);
  });
});

describe("restoreBackup", () => {
  it("says there is nothing to restore when there are no backups", async () => {
    await run("sensibleDefaults.restoreBackup");

    expect(messages()).toEqual(["There are no saved copies to restore yet."]);
    expect(state.quickPicks).toEqual([]);
  });

  it("restores the chosen copy after a modal confirmation", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));
    await run("sensibleDefaults.applyDefaults");

    reset();
    register();
    state.quickPickAnswer = (call) => call.items[0];
    state.answer = () => "Continue";

    await run("sensibleDefaults.restoreBackup");

    expect(await readEnv("AWS_REGION")).toBe("eu-west-1");
    expect(state.warn[0]?.options).toMatchObject({ modal: true });
    expect(messages()).toContain("Restored your previous configuration.");
  });

  it("writes nothing when the confirmation is dismissed", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));
    await run("sensibleDefaults.applyDefaults");
    const applied = await readEnv("AWS_REGION");

    reset();
    register();
    state.quickPickAnswer = (call) => call.items[0];

    await run("sensibleDefaults.restoreBackup");

    expect(await readEnv("AWS_REGION")).toBe(applied);
  });

  it("writes nothing when the backup picker is dismissed", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));
    await run("sensibleDefaults.applyDefaults");

    reset();
    register();

    await run("sensibleDefaults.restoreBackup");

    expect(state.quickPicks).toHaveLength(1);
    expect(state.warn).toEqual([]);
  });

  it("saves the current file first even in a session that already wrote", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));
    await run("sensibleDefaults.applyDefaults");
    expect(await backupCount()).toBe(1);

    // Same session — the promise in the modal has to hold here too.
    state.quickPickAnswer = (call) => call.items[0];
    state.answer = () => "Continue";
    await run("sensibleDefaults.restoreBackup");

    expect(await backupCount()).toBe(2);
  });
});

describe("openSettings", () => {
  it("opens the file when it exists", async () => {
    await seed({});

    await run("sensibleDefaults.openSettings");

    expect(state.opened).toEqual([settingsPath(dir)]);
    expect(state.shownDocuments).toHaveLength(1);
  });

  it("offers to create the file when there is none", async () => {
    state.openFailure = new Error("cannot open");
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));
    state.answer = (shown) => shown.items[0] as string | undefined;

    await run("sensibleDefaults.openSettings");

    expect(state.info[0]?.message).toContain("no settings file yet");
    expect(await readEnv("AWS_REGION")).toBe(RECOMMENDED_REGION);
  });

  it("does nothing when the offer to create it is dismissed", async () => {
    state.openFailure = new Error("cannot open");

    await run("sensibleDefaults.openSettings");

    expect(state.quickPicks).toEqual([]);
  });
});

describe("repairPermissions", () => {
  it("reports that there is nothing to protect when the file is absent", async () => {
    await run("sensibleDefaults.repairPermissions");

    expect(messages()).toEqual(["There's no settings file yet, so there's nothing to protect."]);
    expect(healthRuns).toBe(1);
  });

  it("reports that the file was already private when it is", async () => {
    await seed({});
    await run("sensibleDefaults.repairPermissions");
    reset();
    register();

    await run("sensibleDefaults.repairPermissions");

    const expected =
      process.platform === "win32"
        ? "File permissions work differently on this system; nothing to change."
        : "Your settings file was already private to you.";
    expect(messages()).toEqual([expected]);
  });

  it("reports a repair once the file exists", async () => {
    await seed({});

    await run("sensibleDefaults.repairPermissions");

    const expected =
      process.platform === "win32"
        ? "File permissions work differently on this system; nothing to change."
        : "Your settings file is now readable only by you.";
    expect(messages()).toEqual([expected]);
  });
});

describe("runFix", () => {
  it("says nothing and runs nothing for a node with no fix", async () => {
    await run("sensibleDefaults.runFix", undefined);

    expect(state.executed).toEqual([]);
    expect(logged).toContain("warn runFix called on a node with no fix; ignoring.");
  });

  it("runs the command a check nominated", async () => {
    const node = {
      kind: "check",
      group: "Configuration",
      result: {
        id: "config.bedrock",
        group: "Configuration",
        level: "error",
        label: "x",
        fix: { kind: "command", command: "sensibleDefaults.repairPermissions", title: "Fix" },
      },
    };

    await run("sensibleDefaults.runFix", node);

    expect(state.executed[0]?.command).toBe("sensibleDefaults.repairPermissions");
  });

  it("runs the command a drift row nominated, with its arguments", async () => {
    const node = {
      kind: "drift",
      group: "Configuration",
      key: "env.AWS_REGION",
      child: {
        key: "env.AWS_REGION",
        label: "x",
        fix: {
          kind: "command",
          command: "sensibleDefaults.resetKey",
          title: "Reset",
          args: ["env.AWS_REGION"],
        },
      },
    };

    await run("sensibleDefaults.runFix", node);

    expect(state.executed[0]).toMatchObject({
      command: "sensibleDefaults.resetKey",
      args: ["env.AWS_REGION"],
    });
  });
});

describe("the command wrapper", () => {
  it("turns a thrown failure into a message rather than an unhandled rejection", async () => {
    disposable.dispose();
    reset();
    disposable = registerCommands({
      env,
      session,
      manifest: BUNDLED_MANIFEST,
      settingsFile: settingsPath(dir),
      backupsDir: backupsDir(dir),
      log: log as never,
      runHealth: async () => {
        throw new Error("the panel exploded");
      },
      markWrite: () => {},
      credential: fakeCredentialDeps(),
    });

    await expect(run("sensibleDefaults.runHealthCheck")).resolves.toBeUndefined();

    expect(state.error[0]?.message).toBe("That didn't work: the panel exploded");
    expect(logged).toContain("error sensibleDefaults.runHealthCheck failed: the panel exploded");
  });

  it("describes a non-Error throw without stringifying an object", async () => {
    disposable.dispose();
    reset();
    disposable = registerCommands({
      env,
      session,
      manifest: BUNDLED_MANIFEST,
      settingsFile: settingsPath(dir),
      backupsDir: backupsDir(dir),
      log: log as never,
      runHealth: () => Promise.reject("plain string"),
      markWrite: () => {},
      credential: fakeCredentialDeps(),
    });

    await run("sensibleDefaults.runHealthCheck");

    expect(state.error[0]?.message).toContain("plain string");
  });

  it("runs the health check on demand", async () => {
    await run("sensibleDefaults.runHealthCheck");

    expect(healthRuns).toBe(1);
  });
});
