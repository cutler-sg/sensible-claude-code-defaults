import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySnapshotStore } from "../../../src/config/snapshot.js";
import type { ConfigEnv } from "../../../src/config/types.js";
import type { DetectDeps } from "../../../src/health/context.js";
import { buildContext, detectClaudeCode } from "../../../src/health/context.js";
import type { ClaudeCodeDetection } from "../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";

/**
 * `ensureMode0600` only rejects for host reasons that are impractical to stage
 * on a real filesystem (and that root ignores entirely), so the failure path is
 * injected instead of provoked. Everything else in these tests is real I/O.
 */
const failRepairIn = new Set<string>();
let repairRejection: unknown = new Error("EPERM: operation not permitted");

vi.mock("../../../src/config/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/index.js")>();
  return {
    ...actual,
    repairPermissions: async (env: ConfigEnv) => {
      if (failRepairIn.has(env.claudeDir)) throw repairRejection;
      return actual.repairPermissions(env);
    },
  };
});

const POSIX = process.platform !== "win32";

let dir: string;
let env: ConfigEnv;

const DETECTED: ClaudeCodeDetection = {
  extension: { installed: true, version: "2.1.267" },
  cli: { found: true, version: "2.1.267" },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "health-ctx-"));
  env = {
    claudeDir: dir,
    workspaceFolders: [],
    snapshotStore: new MemorySnapshotStore(),
    platform: process.platform,
  };
});

afterEach(async () => {
  failRepairIn.clear();
  repairRejection = new Error("EPERM: operation not permitted");
  await rm(dir, { recursive: true, force: true });
});

async function build(overrides: Partial<Parameters<typeof buildContext>[0]> = {}) {
  return buildContext({
    env,
    manifest: BUNDLED_MANIFEST,
    platform: process.platform,
    detect: async () => DETECTED,
    ...overrides,
  });
}

async function writeSettings(body: string): Promise<void> {
  await writeFile(join(dir, "settings.json"), body, "utf8");
}

describe("buildContext", () => {
  it("reports an absent settings file without failing", async () => {
    const ctx = await build();
    expect(ctx.read.kind).toBe("absent");
    expect(ctx.permissions).toEqual({ kind: "absent" });
    expect(ctx.plan?.kind).toBe("ready");
    expect(ctx.drift).toEqual([]);
    expect(ctx.settingsFile).toBe(join(dir, "settings.json"));
    expect(ctx.claudeDir).toBe(dir);
  });

  it("passes a readable file through with its parsed data", async () => {
    await writeSettings('{\n  "env": { "AWS_REGION": "us-east-1" }\n}\n');
    const ctx = await build();
    expect(ctx.read).toMatchObject({ kind: "ok", data: { env: { AWS_REGION: "us-east-1" } } });
    expect(ctx.detection).toEqual(DETECTED);
    expect(ctx.manifest).toBe(BUNDLED_MANIFEST);
  });

  it("keeps a malformed file readable to the checks and blocks the plan", async () => {
    await writeSettings("{ not json");
    const ctx = await build();
    expect(ctx.read.kind).toBe("malformed");
    expect(ctx.plan).toMatchObject({ kind: "blocked", reason: "malformed" });
    expect(ctx.drift).toEqual([]);
  });

  it("surfaces drift computed against the snapshot", async () => {
    await env.snapshotStore.save({
      schemaVersion: 1,
      values: { "env.AWS_REGION": "us-east-1" },
    });
    await writeSettings('{ "env": { "AWS_REGION": "eu-central-1" } }');
    const ctx = await build();
    expect(ctx.drift).toEqual([
      {
        key: "env.AWS_REGION",
        current: "eu-central-1",
        lastApplied: "us-east-1",
        recommended: "us-east-1",
      },
    ]);
    expect(ctx.snapshot.values["env.AWS_REGION"]).toBe("us-east-1");
  });

  it.runIf(POSIX)("repairs the file mode silently before the checks run", async () => {
    await writeSettings("{}");
    await chmod(join(dir, "settings.json"), 0o664);
    const ctx = await build();
    expect(ctx.permissions).toEqual({ kind: "repaired", before: 0o664 });
    expect((await stat(join(dir, "settings.json"))).mode & 0o777).toBe(0o600);
  });

  it.runIf(POSIX)("reports an already-correct mode as ok", async () => {
    await writeSettings("{}");
    await chmod(join(dir, "settings.json"), 0o600);
    expect((await build()).permissions).toEqual({ kind: "ok", before: 0o600 });
  });

  it("reports Windows as unsupported rather than repairing", async () => {
    await writeSettings("{}");
    const ctx = await buildContext({
      env: { ...env, platform: "win32" },
      manifest: BUNDLED_MANIFEST,
      platform: "win32",
      detect: async () => DETECTED,
    });
    expect(ctx.permissions).toEqual({ kind: "unsupported" });
    expect(ctx.platform).toBe("win32");
  });

  it("catches a failed repair into the context rather than losing the whole run", async () => {
    await writeSettings("{}");
    failRepairIn.add(dir);
    const ctx = await build();
    expect(ctx.permissions).toEqual({ kind: "failed", error: "EPERM: operation not permitted" });
    // Everything else still ran: one unrepairable mode must not blank the panel.
    expect(ctx.read.kind).toBe("ok");
  });

  it("stringifies a non-Error repair rejection", async () => {
    await writeSettings("{}");
    failRepairIn.add(dir);
    repairRejection = "chmod said no";
    expect((await build()).permissions).toEqual({ kind: "failed", error: "chmod said no" });
  });
});

/**
 * The FR-2.8 repair is a write we make silently, on every run, to a file we are
 * also watching. Unannounced, its rename wakes the watcher, which runs the
 * checks, which repairs again — the panel refreshing itself in a loop for as
 * long as Claude Code keeps resetting the mode (which is every `/model`).
 */
describe("self-write notification", () => {
  it.runIf(POSIX)("announces a repair so the watcher can ignore its own echo", async () => {
    await writeSettings("{}");
    await chmod(join(dir, "settings.json"), 0o664);
    const onSelfWrite = vi.fn();
    const ctx = await build({ onSelfWrite });
    expect(ctx.permissions.kind).toBe("repaired");
    expect(onSelfWrite).toHaveBeenCalledTimes(1);
  });

  it.runIf(POSIX)("stays quiet when the mode was already right", async () => {
    await writeSettings("{}");
    await chmod(join(dir, "settings.json"), 0o600);
    const onSelfWrite = vi.fn();
    await build({ onSelfWrite });
    expect(onSelfWrite).not.toHaveBeenCalled();
  });

  it("stays quiet when there is no file to repair", async () => {
    const onSelfWrite = vi.fn();
    await build({ onSelfWrite });
    expect(onSelfWrite).not.toHaveBeenCalled();
  });

  it("stays quiet when the repair failed — nothing was written", async () => {
    await writeSettings("{}");
    failRepairIn.add(dir);
    const onSelfWrite = vi.fn();
    await build({ onSelfWrite });
    expect(onSelfWrite).not.toHaveBeenCalled();
  });

  it("stays quiet on a platform where the repair does not apply", async () => {
    await writeSettings("{}");
    const onSelfWrite = vi.fn();
    await buildContext({
      env: { ...env, platform: "win32" },
      manifest: BUNDLED_MANIFEST,
      platform: "win32",
      detect: async () => DETECTED,
      onSelfWrite,
    });
    expect(onSelfWrite).not.toHaveBeenCalled();
  });

  it.runIf(POSIX)("runs without one, since the caller may not be watching", async () => {
    await writeSettings("{}");
    await chmod(join(dir, "settings.json"), 0o664);
    expect((await build()).permissions.kind).toBe("repaired");
  });
});

function deps(overrides: Partial<DetectDeps> = {}): DetectDeps {
  return {
    getExtensionVersion: () => "2.1.267",
    execFile: async () => ({ stdout: "2.1.267 (Claude Code)\n" }),
    ...overrides,
  };
}

describe("detectClaudeCode", () => {
  it("reports both signals when both are present", async () => {
    expect(await detectClaudeCode(deps())).toEqual({
      extension: { installed: true, version: "2.1.267" },
      cli: { found: true, version: "2.1.267" },
    });
  });

  it("reports an absent extension", async () => {
    const result = await detectClaudeCode(deps({ getExtensionVersion: () => undefined }));
    expect(result.extension).toEqual({ installed: false });
  });

  it("treats a failing CLI as not found, never an error", async () => {
    const result = await detectClaudeCode(
      deps({
        execFile: async () => {
          throw new Error("spawn claude ENOENT");
        },
      }),
    );
    expect(result).toEqual({
      extension: { installed: true, version: "2.1.267" },
      cli: { found: false },
    });
  });

  it("treats a timeout as not found", async () => {
    const result = await detectClaudeCode(
      deps({
        execFile: async () => {
          const error: NodeJS.ErrnoException = new Error("Command timed out");
          error.code = "ETIMEDOUT";
          throw error;
        },
      }),
    );
    expect(result.cli).toEqual({ found: false });
  });

  it("gives the CLI a five-second budget", async () => {
    const execFile = vi.fn(async () => ({ stdout: "2.1.267" }));
    await detectClaudeCode(deps({ execFile }));
    expect(execFile).toHaveBeenCalledWith("claude", ["--version"], { timeout: 5000 });
  });

  it("treats output with no version in it as not found", async () => {
    const result = await detectClaudeCode(deps({ execFile: async () => ({ stdout: "???\n" }) }));
    expect(result.cli).toEqual({ found: false });
  });

  it("finds the version inside a reworded banner", async () => {
    const result = await detectClaudeCode(
      deps({ execFile: async () => ({ stdout: "Claude Code, version 2.1.267-beta.1 (linux)\n" }) }),
    );
    expect(result.cli).toEqual({ found: true, version: "2.1.267-beta.1" });
  });

  it("accepts a two-segment version", async () => {
    const result = await detectClaudeCode(deps({ execFile: async () => ({ stdout: "3.0\n" }) }));
    expect(result.cli).toEqual({ found: true, version: "3.0" });
  });
});
