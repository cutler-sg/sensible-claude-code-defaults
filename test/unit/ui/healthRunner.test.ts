import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsPath } from "../../../src/config/paths.js";
import { MemorySnapshotStore } from "../../../src/config/snapshot.js";
import type { ConfigEnv } from "../../../src/config/types.js";
import type { ClaudeCodeDetection, HealthReport } from "../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import {
  createHealthRunner,
  HEALTH_FAILED_MESSAGE,
  type HealthRunnerDeps,
  type NotifiedStore,
  notifiedKey,
} from "../../../src/ui/healthRunner.js";
import { APPLY_ACTION, DETAILS_ACTION } from "../../../src/ui/notify.js";
import { messages, reset, state } from "./commandsHost.js";

vi.mock("vscode", async () => await import("./commandsHost.js"));

/** A `Memento`-shaped store that survives across runner instances, like the real one. */
function memento(): NotifiedStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T): T => (values.has(key) ? (values.get(key) as T) : fallback),
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

const INSTALLED: ClaudeCodeDetection = {
  extension: { installed: true, version: "2.1.267" },
  cli: { found: false },
};

let dir: string;
let env: ConfigEnv;
let logged: string[];
let reports: HealthReport[];
let notified: NotifiedStore;

const log = {
  info: (message: string) => logged.push(`info ${message}`),
  warn: (message: string) => logged.push(`warn ${message}`),
  error: (message: string) => logged.push(`error ${message}`),
};

function runner(overrides: Partial<HealthRunnerDeps> = {}): () => Promise<void> {
  return createHealthRunner({
    env,
    manifest: BUNDLED_MANIFEST,
    platform: process.platform,
    detect: async () => INSTALLED,
    log: log as never,
    notified,
    present: (report) => reports.push(report),
    ...overrides,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scd-health-"));
  env = {
    claudeDir: dir,
    workspaceFolders: [],
    snapshotStore: new MemorySnapshotStore(),
    platform: process.platform,
  };
  logged = [];
  reports = [];
  notified = memento();
  reset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(settings: unknown): Promise<void> {
  await writeFile(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

describe("a successful run", () => {
  it("presents a report and marks the panel as populated", async () => {
    await seed({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } });

    await runner()();

    expect(reports).toHaveLength(1);
    expect(state.executed[0]).toMatchObject({
      command: "setContext",
      args: ["sensibleDefaults.hasReport", true],
    });
    expect(logged.some((line) => line.startsWith("info Health check:"))).toBe(true);
  });
});

describe("a run that throws", () => {
  /** `settings.json` as a directory: `readSettings` propagates EISDIR. */
  async function breakSettings(): Promise<void> {
    await mkdir(settingsPath(dir), { recursive: true });
  }

  it("does not reject, so `void runHealth()` cannot go unhandled", async () => {
    await breakSettings();

    await expect(runner()()).resolves.toBeUndefined();

    expect(logged.some((line) => line.startsWith("error Health check failed:"))).toBe(true);
    expect(messages()).toEqual([HEALTH_FAILED_MESSAGE]);
  });

  it("shows the failure once per window, however many runs fail", async () => {
    await breakSettings();
    const run = runner();

    await run();
    await run();
    await run();

    expect(state.error).toHaveLength(1);
    // Every failure is still logged: the toast is throttled, the log is not.
    expect(logged.filter((line) => line.startsWith("error"))).toHaveLength(3);
  });

  it("describes a non-Error throw rather than stringifying it", async () => {
    await expect(
      runner({ detect: () => Promise.reject({ secret: "value" }) })(),
    ).resolves.toBeUndefined();

    expect(logged).toContain("error Health check failed: an unexpected failure");
  });

  it("presents nothing when the run failed", async () => {
    await breakSettings();

    await runner()();

    expect(reports).toEqual([]);
  });
});

describe("FR-5.5 notification gating", () => {
  it("fires the first-run toast when Claude Code is installed but unconfigured", async () => {
    await runner()();

    expect(state.info[0]?.message).toBe("Claude Code isn't set up for AWS Bedrock yet.");
    expect(state.info[0]?.items).toEqual([APPLY_ACTION]);
  });

  it("does not fire again in a second window sharing the same stored state", async () => {
    await runner()();
    expect(state.info).toHaveLength(1);

    reset();
    // A fresh runner over the same memento is exactly what a second window is.
    await runner()();

    expect(state.info).toEqual([]);
  });

  it("records the kind under the manifest revision", async () => {
    await runner()();

    expect(notified.get<string[]>(notifiedKey(BUNDLED_MANIFEST.revision), [])).toEqual([
      "first-run",
    ]);
    // New advice gets to speak once: a different revision has not fired.
    expect(notified.get<string[]>(notifiedKey("some-later-revision"), [])).toEqual([]);
  });

  it("stays silent when the user has opted out of the startup check", async () => {
    state.configuration.set("sensibleDefaults.checkOnStartup", false);

    await runner()();

    expect(state.info).toEqual([]);
    // The run itself still happened — this is a watcher-triggered run, and the
    // panel has to stay accurate whether or not we are allowed to interrupt.
    expect(reports).toHaveLength(1);
  });

  it("applies the recommended configuration when the toast is accepted", async () => {
    state.answer = () => APPLY_ACTION;

    await runner()();

    expect(state.executed.map((call) => call.command)).toContain("sensibleDefaults.applyDefaults");
  });

  it("focuses the panel for any other action", async () => {
    state.answer = () => DETAILS_ACTION;

    await runner()();

    expect(state.executed.map((call) => call.command)).toContain("sensibleDefaults.health.focus");
  });

  it("does nothing extra when the toast is dismissed", async () => {
    await runner()();

    expect(state.executed.map((call) => call.command)).toEqual(["setContext"]);
  });

  it("does not fire on a report with no notable transition", async () => {
    // A configured, healthy-enough install is not a first run.
    await seed({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } });

    await runner()();

    expect(state.info).toEqual([]);
  });

  it("fires healthy-to-fail once, and not on a repeat failure", async () => {
    let level: "pass" | "error" = "pass";
    const flipping = {
      id: "config.bedrock" as const,
      group: "Configuration" as const,
      run: () => ({
        id: "config.bedrock" as const,
        group: "Configuration" as const,
        level,
        label: "bedrock",
        fix: { kind: "none" as const },
      }),
    };
    const run = runner({ checks: [flipping] });

    await run();
    expect(state.info).toEqual([]);

    level = "error";
    await run();
    expect(state.info.map((shown) => shown.message)).toEqual([
      "Claude Code configuration needs attention.",
    ]);

    // Healthy, then failing again: the same transition, already spent.
    level = "pass";
    await run();
    level = "error";
    await run();
    expect(state.info).toHaveLength(1);
  });
});
