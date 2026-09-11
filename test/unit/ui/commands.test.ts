import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplySession } from "../../../src/config/apply.js";
import { backupsDir, settingsPath } from "../../../src/config/paths.js";
import { MemorySnapshotStore } from "../../../src/config/snapshot.js";
import type { ConfigEnv, JsonObject, Settings } from "../../../src/config/types.js";
import type { HealthReport } from "../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import type { Manifest } from "../../../src/manifest/types.js";
import { registerCommands } from "../../../src/ui/commands.js";
import { aclFake } from "../config/windowsAclFake.js";
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

/**
 * The `Logger` surface the commands use, plus the FR-7.1 ring buffer — a fake
 * that only recorded lines would let `copyDiagnostics` pass without ever
 * reaching the log section of the report.
 */
const log = {
  info: (message: string) => logged.push(`info ${message}`),
  warn: (message: string) => logged.push(`warn ${message}`),
  error: (message: string) => logged.push(`error ${message}`),
  recent: () =>
    logged.map((line) => {
      const space = line.indexOf(" ");
      return {
        level: line.slice(0, space) as "info" | "warn" | "error",
        message: line.slice(space + 1),
      };
    }),
};

/**
 * The manifest the registered commands see. A `let` rather than a parameter
 * because the point of `CommandDeps.manifest` being a function is that the host
 * can swap it *after* registration, and a test that cannot swap it proves
 * nothing about that.
 */
let currentManifest: Manifest;
let forcedRefreshes: number;
/** What `refreshManifest` reports back: does the panel need repainting? */
let refreshChanged: boolean;
/** The manifest the refresh puts in force, if it changes one. */
let refreshResolves: Manifest | undefined;
/** The last health report the diagnostics command should render, if any. */
let lastReport: HealthReport | undefined;

function register(manifest: Manifest = BUNDLED_MANIFEST): void {
  currentManifest = manifest;
  disposable = registerCommands({
    env,
    session,
    manifest: () => currentManifest,
    // Models the real holder: a refresh may swap the manifest in force, and
    // its boolean answers "repaint?" rather than "is this a new revision?".
    refreshManifest: async (options) => {
      expect(options).toEqual({ force: true });
      forcedRefreshes += 1;
      if (refreshResolves !== undefined) currentManifest = refreshResolves;
      return refreshChanged;
    },
    settingsFile: settingsPath(dir),
    backupsDir: backupsDir(dir),
    log: log as never,
    runHealth: async () => {
      healthRuns += 1;
    },
    markWrite: () => {},
    credential: fakeCredentialDeps(),
    extensionVersion: "0.1.0",
    diagnostics: {
      manifest: () => ({ revision: currentManifest.revision, source: "bundled" }),
      report: () => lastReport,
      cliVersion: () => "2.1.267",
      now: () => new Date("2026-09-10T12:00:00Z"),
    },
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
    // Only consulted on win32, where permissions are a DACL question. Injected
    // so the Windows leg says the same thing every run — see `windowsAclFake`.
    acl: aclFake(dir).deps,
  };
  session = { backedUp: false };
  logged = [];
  healthRuns = 0;
  forcedRefreshes = 0;
  refreshChanged = false;
  refreshResolves = undefined;
  lastReport = undefined;
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
});

/**
 * F2, the critical one. `permissions.deny` is element-owned, so an element we
 * wrote is ours to remove: a manifest revision that simply stops listing
 * `Read(./.env)` and `Read(./.aws/**)` removes them from every install at once.
 * `drift` stays empty (nothing was contested), nothing reports it, and
 * `config.stale` says only "there are newer recommended settings to apply" —
 * which the user presses. Claude Code can then read `.env` and `.aws/**`.
 *
 * The removal is technically in the preview already, as a before-set and an
 * after-set joined by commas. Reading that means diffing two comma-separated
 * lists by eye, which is the exact task this extension exists because its
 * audience cannot do. A protection being dropped has to be a sentence.
 */
describe("a manifest that narrows the blocked commands list (F2)", () => {
  const DENY = ["Bash(rm -rf:*)", "Read(./.env)", "Read(./.aws/**)"];

  function narrowedTo(deny: string[]): Manifest {
    return {
      ...BUNDLED_MANIFEST,
      revision: "remote-2",
      defaults: { ...BUNDLED_MANIFEST.defaults, permissions: { deny } },
    };
  }

  /** Put the full list in the file, owned by us, so a narrower manifest removes from it. */
  async function seedApplied(): Promise<void> {
    currentManifest = narrowedTo(DENY);
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));
    await run("sensibleDefaults.applyDefaults");
    reset();
    register();
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));
  }

  it("says which protections stop being blocked, in its own row", async () => {
    await seedApplied();
    currentManifest = narrowedTo(["Bash(rm -rf:*)"]);

    await run("sensibleDefaults.applyDefaults");

    expect(quickPickLabels()).toContain("Stops blocking: Read(./.env)");
    expect(quickPickLabels()).toContain("Stops blocking: Read(./.aws/**)");
  });

  /**
   * Above the change rows and above the confirm item, so it is on screen before
   * the user has scrolled or decided — a QuickPick shows only its first few
   * items, and this is the one item nobody may miss.
   */
  it("puts the losses above the confirmation, not below the diff", async () => {
    await seedApplied();
    currentManifest = narrowedTo(["Bash(rm -rf:*)"]);

    await run("sensibleDefaults.applyDefaults");

    const labels = quickPickLabels();
    const firstLoss = labels.findIndex((label) => label.startsWith("Stops blocking:"));
    const confirm = labels.findIndex((label) => label.startsWith("Apply all"));
    expect(firstLoss).toBeGreaterThan(-1);
    expect(firstLoss).toBeLessThan(confirm);
  });

  it("says so in the title, so the dialog itself is not neutral about it", async () => {
    await seedApplied();
    currentManifest = narrowedTo(["Bash(rm -rf:*)"]);

    await run("sensibleDefaults.applyDefaults");

    const options = state.quickPicks[0]?.options as { title?: string } | undefined;
    expect(options?.title).toContain("stop being blocked");
  });

  it("adds no such row to an ordinary apply that drops nothing", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));

    await run("sensibleDefaults.applyDefaults");

    expect(quickPickLabels().some((label) => label.startsWith("Stops blocking:"))).toBe(false);
    const options = state.quickPicks[0]?.options as { title?: string } | undefined;
    expect(options?.title).not.toContain("stop being blocked");
  });

  it("still writes what the user accepted, so the row informs rather than blocks", async () => {
    await seedApplied();
    currentManifest = narrowedTo(["Bash(rm -rf:*)"]);

    await run("sensibleDefaults.applyDefaults");

    const written = (await readSettings()).permissions as { deny?: string[] } | undefined;
    expect(written?.deny).toEqual(["Bash(rm -rf:*)"]);
  });

  it("keeps Cancel first, so the loud dialog still cannot be Entered through", async () => {
    await seedApplied();
    currentManifest = narrowedTo(["Bash(rm -rf:*)"]);
    state.quickPickAnswer = (call) => call.items[0];

    await run("sensibleDefaults.applyDefaults");

    expect(quickPickLabels()[0]).toBe("Cancel");
    const written = (await readSettings()).permissions as { deny?: string[] } | undefined;
    expect(written?.deny).toEqual(DENY);
  });

  /** A "Stops blocking:" row is text to read, not a decision — like every change row. */
  it("treats picking a loss row as reading, not as consent", async () => {
    await seedApplied();
    currentManifest = narrowedTo(["Bash(rm -rf:*)"]);
    state.quickPickAnswer = (call) =>
      call.items.find((item) => labelOf(item).startsWith("Stops blocking:"));

    await run("sensibleDefaults.applyDefaults");

    const written = (await readSettings()).permissions as { deny?: string[] } | undefined;
    expect(written?.deny).toEqual(DENY);
  });
});

describe("applyDefaults, continued", () => {
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

/**
 * F2's other write path, and why it is not one. `resetKey` on the blocked
 * commands list restores the manifest's list over the user's — but
 * `claimElements` claims only the rules the manifest still lists, so rules the
 * user added stay unowned and the merge engine preserves them (hard rule 3).
 *
 * That makes a reset structurally incapable of narrowing the list, which is
 * worth pinning: it is the reason F2's fix lives on the apply path, and a
 * future change to `claimElements` that claimed the container would reopen the
 * hole silently.
 */
describe("resetting the blocked commands list cannot narrow it (F2)", () => {
  const denying = (deny: string[]): Manifest => ({
    ...BUNDLED_MANIFEST,
    defaults: { ...BUNDLED_MANIFEST.defaults, permissions: { deny } },
  });

  it("keeps a rule the manifest no longer lists, rather than removing it", async () => {
    await seed({ permissions: { deny: ["Bash(rm -rf:*)", "Read(./.env)"] } });
    register(denying(["Bash(rm -rf:*)"]));
    state.answer = (shown) => (shown.items.includes("Replace") ? "Replace" : undefined);

    await run("sensibleDefaults.resetKey", "permissions.deny");

    const written = (await readSettings()).permissions as { deny?: string[] } | undefined;
    expect(written?.deny).toContain("Read(./.env)");
  });

  /**
   * And the confirmation is wired to report a loss if one ever did occur — the
   * belt to `claimElements`' braces, on the shared modal every single-key write
   * goes through.
   */
  it("says nothing about losses when there are none to report", async () => {
    await seed({ env: { AWS_REGION: "eu-west-9" } });
    state.answer = (shown) => (shown.items.includes("Replace") ? "Replace" : undefined);

    await run("sensibleDefaults.resetKey", "env.AWS_REGION");

    const detail = (state.warn[0]?.options as { detail?: string } | undefined)?.detail ?? "";
    expect(detail).not.toContain("Stops blocking:");
    expect(detail).toContain("Amazon region");
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
    // One wording on every platform: "private to you" is the same promise
    // whether a mode bit or a DACL keeps it, and naming the mechanism would
    // only send the user looking for something their machine does not have.
    await seed({});
    await run("sensibleDefaults.repairPermissions");
    reset();
    register();

    await run("sensibleDefaults.repairPermissions");

    expect(messages()).toEqual(["Your settings file was already private to you."]);
  });

  it("reports a repair once the file exists", async () => {
    await seed({});

    await run("sensibleDefaults.repairPermissions");

    expect(messages()).toEqual(["Your settings file is now readable only by you."]);
  });

  it("warns rather than reassures when the ACL could not be read", async () => {
    // Plan Q-AG, at the command surface. An information toast is the same
    // shape as success, so an unreadable ACL on the file holding the token
    // must not arrive as one.
    await seed({});
    env.platform = "win32";
    env.acl = { scratchDir: dir, run: async () => ({ kind: "ok", code: 5, stdout: "" }) };

    await run("sensibleDefaults.repairPermissions");

    // `messages()` flattens every level, so the assertion is on the level
    // itself: that is the whole point of this test.
    expect(state.warn.map((shown) => shown.message)).toEqual([
      "We couldn't tell who else can read your settings file on this computer.",
    ]);
    expect(state.info).toEqual([]);
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

describe("checkForUpdates (FR-3.3)", () => {
  it("bypasses the throttle and re-runs the checks", async () => {
    refreshChanged = true;
    refreshResolves = { ...BUNDLED_MANIFEST, revision: "remote-2" };

    await run("sensibleDefaults.checkForUpdates");

    expect(forcedRefreshes).toBe(1);
    expect(healthRuns).toBe(1);
    expect(messages()).toEqual(["Updated to the latest recommended settings."]);
  });

  /**
   * F15. The message reported `refreshManifest`'s boolean, which answers "does
   * the panel need repainting?" — and the provenance is part of that. So the
   * first successful fetch after a run on the bundled copy said "Updated to the
   * latest recommended settings" for a manifest byte-identical to the one
   * already in force: bundled → cached is a status change and not an update.
   *
   * The report is now about the revision, which is the manifest's own answer to
   * "am I a different set of recommendations?".
   */
  it("does not claim an update when only the provenance moved (F15)", async () => {
    // The holder repainted — bundled to cached — but the revision is the one
    // already in force.
    refreshChanged = true;

    await run("sensibleDefaults.checkForUpdates");

    expect(messages()).toEqual(["You already have the latest recommended settings."]);
  });

  it("claims an update when the revision actually changed (F15)", async () => {
    // A revision change the holder reports no repaint for is the F8 case: the
    // user is still being held to different recommendations, and should be told.
    refreshChanged = false;
    refreshResolves = { ...BUNDLED_MANIFEST, revision: "remote-2" };

    await run("sensibleDefaults.checkForUpdates");

    expect(messages()).toEqual(["Updated to the latest recommended settings."]);
  });

  it("says so, rather than nothing, when there was no update", async () => {
    // A command that appears to do nothing is indistinguishable from a broken
    // one, and this one is only ever reached by a deliberate press.
    await run("sensibleDefaults.checkForUpdates");

    expect(messages()).toEqual(["You already have the latest recommended settings."]);
    expect(healthRuns).toBe(1);
  });

  /**
   * FR-3.2: a failed fetch is never user-visible. The holder swallows it and
   * reports "nothing changed", so from here an unreachable network and an
   * unchanged manifest are the same sentence — which is the point.
   */
  it("reports no failure when the fetch could not happen at all", async () => {
    await run("sensibleDefaults.checkForUpdates");

    expect(state.error).toEqual([]);
    expect(state.warn).toEqual([]);
  });

  it("still re-runs the checks in a host with no resolver wired", async () => {
    disposable.dispose();
    reset();
    disposable = registerCommands({
      env,
      session,
      manifest: () => BUNDLED_MANIFEST,
      settingsFile: settingsPath(dir),
      backupsDir: backupsDir(dir),
      log: log as never,
      runHealth: async () => {
        healthRuns += 1;
      },
      markWrite: () => {},
      credential: fakeCredentialDeps(),
    });

    await run("sensibleDefaults.checkForUpdates");

    expect(healthRuns).toBe(1);
  });
});

/**
 * The trap M4 was wired around: the manifest used to be captured at
 * registration, so a window that fetched newer recommendations went on
 * offering — and writing — the ones that shipped in the VSIX.
 */
describe("reading the manifest afresh on every invocation", () => {
  it("offers the regions of the manifest in force now, not at registration", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    currentManifest = { ...BUNDLED_MANIFEST, regions: ["eu-west-1", "eu-west-2"] };

    await run("sensibleDefaults.selectRegion");

    expect(quickPickLabels()).toEqual(["eu-west-1", "eu-west-2"]);
  });

  it("applies the values of the manifest in force now", async () => {
    // No region in the file: an existing one is the user's, and hard rule 3
    // would rightly preserve it as drift whatever the manifest says.
    await seed({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
    currentManifest = {
      ...BUNDLED_MANIFEST,
      defaults: {
        ...BUNDLED_MANIFEST.defaults,
        env: { ...BUNDLED_MANIFEST.defaults.env, AWS_REGION: "ap-southeast-1" },
      },
    };
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));

    await run("sensibleDefaults.applyDefaults");

    expect(await readEnv("AWS_REGION")).toBe("ap-southeast-1");
  });

  /**
   * F7. `desiredFromManifest(deps.manifest())` was read at the top and
   * `deps.manifest().revision` read again after the QuickPick resolved. The
   * QuickPick is modal to the *user*, not to the event loop, so an hourly
   * refresh lands between the two reads perfectly happily — and the file then
   * holds one revision's values while the snapshot records another's.
   *
   * The consequence is permanent and silent: `config.stale` compares the
   * snapshot's revision against the manifest in force, sees them equal, and
   * reports the user as up to date forever, while the values on disk are the
   * ones from before the refresh.
   */
  it("stamps the revision whose values it wrote, not the one that arrived mid-preview (F7)", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    currentManifest = {
      ...BUNDLED_MANIFEST,
      revision: "remote-1",
      defaults: {
        ...BUNDLED_MANIFEST.defaults,
        env: { ...BUNDLED_MANIFEST.defaults.env, ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-from-1" },
      },
    };
    // A refresh lands while the preview is on screen.
    state.quickPickAnswer = (call) => {
      currentManifest = {
        ...BUNDLED_MANIFEST,
        revision: "remote-2",
        defaults: {
          ...BUNDLED_MANIFEST.defaults,
          env: { ...BUNDLED_MANIFEST.defaults.env, ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-from-2" },
        },
      };
      return call.items.find((item) => labelOf(item).startsWith("Apply all"));
    };

    await run("sensibleDefaults.applyDefaults");

    // The values written are revision 1's — they are what the user was shown
    // and accepted — so the stamp must be revision 1's too.
    expect(await readEnv("ANTHROPIC_DEFAULT_OPUS_MODEL")).toBe("opus-from-1");
    expect((await env.snapshotStore.load()).manifestRevision).toBe("remote-1");
  });

  it("shows the user the changes it then writes, whatever arrives mid-preview (F7)", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    currentManifest = {
      ...BUNDLED_MANIFEST,
      revision: "remote-1",
      defaults: {
        ...BUNDLED_MANIFEST.defaults,
        permissions: { deny: ["Read(./.env)"] },
      },
    };
    state.quickPickAnswer = (call) => {
      currentManifest = {
        ...BUNDLED_MANIFEST,
        revision: "remote-2",
        defaults: { ...BUNDLED_MANIFEST.defaults, permissions: { deny: [] } },
      };
      return call.items.find((item) => labelOf(item).startsWith("Apply all"));
    };

    await run("sensibleDefaults.applyDefaults");

    const written = (await readSettings()).permissions as { deny?: string[] } | undefined;
    expect(written?.deny).toEqual(["Read(./.env)"]);
  });

  it("stamps the snapshot with the revision in force now", async () => {
    await seed({ env: { AWS_REGION: "eu-west-1" } });
    currentManifest = { ...BUNDLED_MANIFEST, revision: "remote-2" };
    state.quickPickAnswer = (call) => call.items.find((i) => labelOf(i).startsWith("Apply all"));

    await run("sensibleDefaults.applyDefaults");

    expect((await env.snapshotStore.load()).manifestRevision).toBe("remote-2");
  });
});

describe("the command wrapper", () => {
  it("turns a thrown failure into a message rather than an unhandled rejection", async () => {
    disposable.dispose();
    reset();
    disposable = registerCommands({
      env,
      session,
      manifest: () => BUNDLED_MANIFEST,
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
      manifest: () => BUNDLED_MANIFEST,
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

/**
 * FR-7.1. Clipboard, not a file (plan Q-AC) — a file is one more artefact
 * carrying a redacted-but-still-sensitive dump of a user's configuration.
 */
describe("copyDiagnostics (FR-7.1)", () => {
  const TOKEN = "ABSKQ29tbWFuZExlYWtUZXN0S2V5VmFsdWVIZXJl";

  it("puts a report on the clipboard rather than writing a file", async () => {
    const before = await readdir(dir);

    await run("sensibleDefaults.copyDiagnostics");

    expect(state.clipboard).toContain("Sensible Claude Code Defaults — diagnostics");
    expect(state.clipboard).toContain("| Extension | 0.1.0 |");
    // No new artefact: the report exists only on the clipboard.
    expect(await readdir(dir)).toEqual(before);
  });

  it("names what it included and what it removed", async () => {
    await run("sensibleDefaults.copyDiagnostics");

    const message = state.info.at(-1)?.message ?? "";
    expect(message).toContain("Diagnostics copied");
    expect(message).toContain("your Claude Code settings file");
    expect(message).toContain("the last 50 lines from the output log");
    expect(message).toContain("does not include your Bedrock API key");
  });

  it("includes the settings file with the key replaced", async () => {
    await seed({ env: { AWS_BEARER_TOKEN_BEDROCK: TOKEN, AWS_REGION: "us-east-1" } });

    await run("sensibleDefaults.copyDiagnostics");

    expect(state.clipboard).toContain("us-east-1");
    expect(state.clipboard).toContain('"AWS_BEARER_TOKEN_BEDROCK": "«redacted»"');
    expect(state.clipboard).not.toContain(TOKEN);
  });

  it("includes the health results when a run has finished", async () => {
    lastReport = {
      at: "2026-09-10T11:59:00.000Z",
      results: [
        {
          id: "cred.present",
          group: "Credential",
          level: "error",
          label: "No Bedrock API key is saved",
          fix: { kind: "none" },
        },
      ],
      counts: { pass: 0, info: 0, warning: 0, error: 1, skipped: 0 },
    };

    await run("sensibleDefaults.copyDiagnostics");

    expect(state.clipboard).toContain("| cred.present | error | No Bedrock API key is saved |");
  });

  it("reads the VS Code and Claude Code versions from the host", async () => {
    state.claudeCodeVersion = "2.1.267";
    state.remoteName = "wsl";

    await run("sensibleDefaults.copyDiagnostics");

    expect(state.clipboard).toContain("| VS Code | 1.98.2 |");
    expect(state.clipboard).toContain("| Claude Code extension | 2.1.267 |");
    expect(state.clipboard).toContain("| Remote | wsl |");
  });

  it("still produces a report when the settings file cannot be parsed", async () => {
    await seedRaw("{ not json");

    await run("sensibleDefaults.copyDiagnostics");

    // The report is what a user reaches for when something is broken, so a
    // broken file must not be the thing that stops them getting one.
    expect(state.clipboard).toContain("could not be read as JSON");
    expect(state.error).toEqual([]);
  });

  it("still produces a report when the settings file cannot even be read", async () => {
    // A directory where the file should be: `readSettings` throws EISDIR
    // rather than reporting a content problem, and the command must survive it
    // — this is one of the states a user copies diagnostics *because* of.
    await rm(settingsPath(dir), { force: true });
    await mkdir(settingsPath(dir));

    await run("sensibleDefaults.copyDiagnostics");

    expect(state.clipboard).toContain("There is no settings file yet.");
    expect(state.error).toEqual([]);
  });

  it("says so rather than throwing when the host has not wired the report", async () => {
    disposable.dispose();
    reset();
    disposable = registerCommands({
      env,
      session,
      manifest: () => BUNDLED_MANIFEST,
      settingsFile: settingsPath(dir),
      backupsDir: backupsDir(dir),
      log: log as never,
      runHealth: async () => {},
      markWrite: () => {},
      credential: fakeCredentialDeps(),
    });

    await run("sensibleDefaults.copyDiagnostics");

    expect(state.clipboard).toBe("");
    expect(state.info.at(-1)?.message).toContain("aren't available in this window yet");
    expect(state.error).toEqual([]);
  });
});

/**
 * `cred.leak`'s fix (FR-4.8). Hard rule 1 and plan Q-AD: it opens, and never
 * edits — the extension does not write inside a workspace folder, and rotation
 * is the real remedy anyway.
 */
describe("openLeakedFile (FR-4.8)", () => {
  it("opens the file at the offending line", async () => {
    const leaked = join(dir, "project.env.json");
    await writeFile(leaked, "x", "utf8");

    await run("sensibleDefaults.openLeakedFile", leaked, 4);

    expect(state.opened).toEqual([leaked]);
    // Zero-based, and a cursor rather than a selection: a selected credential
    // is one keystroke from being somewhere else again.
    expect(state.showOptions).toEqual([
      { selection: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } } },
    ]);
  });

  it("changes nothing on disk", async () => {
    const leaked = join(dir, "leak.json");
    await writeFile(leaked, "the file as it was", "utf8");

    await run("sensibleDefaults.openLeakedFile", leaked, 1);

    expect(await readFile(leaked, "utf8")).toBe("the file as it was");
  });

  it("falls back to the first line when no line is given", async () => {
    const leaked = join(dir, "leak.json");
    await writeFile(leaked, "x", "utf8");

    await run("sensibleDefaults.openLeakedFile", leaked);

    expect(state.showOptions).toEqual([
      { selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    ]);
  });

  it("ignores a call with no file rather than throwing", async () => {
    await run("sensibleDefaults.openLeakedFile", undefined, 1);

    expect(state.opened).toEqual([]);
    expect(logged.at(-1)).toContain("without a file");
    expect(state.error).toEqual([]);
  });

  it("says so gently when the file has already gone", async () => {
    state.openFailure = new Error("ENOENT");

    await run("sensibleDefaults.openLeakedFile", join(dir, "gone.json"), 2);

    // The good outcome — the user removed the file — so it is information,
    // not an error.
    expect(state.info.at(-1)?.message).toContain("isn't there any more");
    expect(state.error).toEqual([]);
  });
});
