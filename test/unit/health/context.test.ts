import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySnapshotStore } from "../../../src/config/snapshot.js";
import type { ConfigEnv } from "../../../src/config/types.js";
import { MemoryTokenStore } from "../../../src/credential/store.js";
import type { CredentialDeps, DetectDeps } from "../../../src/health/context.js";
import { buildContext, detectClaudeCode } from "../../../src/health/context.js";
import type { ClaudeCodeDetection } from "../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import { aclFake } from "../config/windowsAclFake.js";

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

  it("answers the Windows question from the DACL, not from mode bits", async () => {
    // M6 Part B: `unsupported` used to be the *only* Windows answer, which
    // made "we cannot check" and "it is fine" the same row on the file holding
    // the token. The DACL now answers, and `unsupported` is reserved for a host
    // with no `icacls` at all.
    await writeSettings("{}");
    const ctx = await buildContext({
      env: { ...env, platform: "win32", acl: aclFake(dir).deps },
      manifest: BUNDLED_MANIFEST,
      platform: "win32",
      detect: async () => DETECTED,
    });
    expect(ctx.permissions).toEqual({ kind: "aclRepaired", before: ["S-1-1-0"] });
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
 * The credential slice is the one part of the context that reads a secret, so
 * every assertion here is as much about what it does *not* carry as what it
 * does. `CheckContext` has no field a token fits in; these tests prove the
 * builder does not smuggle one into the fields it does have.
 */
describe("buildContext credential", () => {
  const TOKEN = "ABSKQmVkcm9ja0FQSUtleUV4YW1wbGVWYWx1ZQ";
  const OTHER = "ABSKQW5vdGhlckJlZHJvY2tBUElLZXlWYWx1ZQ";
  const SET_AT = "2026-06-01T00:00:00.000Z";
  const NOW = new Date("2026-09-10T12:00:00.000Z");

  function credentialDeps(over: Partial<CredentialDeps> = {}): CredentialDeps {
    return {
      store: new MemoryTokenStore(),
      readFromSettings: async () => undefined,
      now: () => NOW,
      ...over,
    };
  }

  it("reports nothing configured when the host injects no credential deps", async () => {
    const ctx = await build();
    expect(ctx.credential.presence).toEqual({ source: "none", mismatch: false });
    expect(ctx.credential.stored).toBeUndefined();
    expect(ctx.credential.policy).toBe(BUNDLED_MANIFEST.credential);
    expect(ctx.credential.keychainError).toBeUndefined();
  });

  it("carries the token's age but never the token", async () => {
    const ctx = await build({
      credential: credentialDeps({
        store: new MemoryTokenStore({ token: TOKEN, setAt: SET_AT }),
        readFromSettings: async () => TOKEN,
      }),
    });
    expect(ctx.credential.presence).toEqual({ source: "both", mismatch: false, setAt: SET_AT });
    expect(ctx.credential.stored).toEqual({ setAt: SET_AT });
    expect(JSON.stringify(ctx.credential)).not.toContain(TOKEN);
  });

  it("reports the keychain alone when the file has no token", async () => {
    const ctx = await build({
      credential: credentialDeps({ store: new MemoryTokenStore({ token: TOKEN, setAt: SET_AT }) }),
    });
    expect(ctx.credential.presence.source).toBe("keychain");
    expect(ctx.credential.presence.mismatch).toBe(false);
  });

  it("reports the file alone — the state /setup-bedrock leaves behind", async () => {
    const ctx = await build({
      credential: credentialDeps({ readFromSettings: async () => TOKEN }),
    });
    expect(ctx.credential.presence).toEqual({ source: "settings-file", mismatch: false });
    expect(ctx.credential.stored).toBeUndefined();
  });

  it("flags a mismatch when the two hold different values", async () => {
    const ctx = await build({
      credential: credentialDeps({
        store: new MemoryTokenStore({ token: TOKEN, setAt: SET_AT }),
        readFromSettings: async () => OTHER,
      }),
    });
    expect(ctx.credential.presence.source).toBe("both");
    expect(ctx.credential.presence.mismatch).toBe(true);
    expect(JSON.stringify(ctx.credential)).not.toContain(OTHER);
  });

  it("records an unreachable keychain instead of failing the run (Q-X)", async () => {
    const store = {
      get: () => Promise.reject(new Error("Cannot autolaunch D-Bus without X11 $DISPLAY")),
      set: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    const ctx = await build({
      credential: credentialDeps({ store, readFromSettings: async () => TOKEN }),
    });
    expect(ctx.credential.keychainError).toContain("D-Bus");
    // The file's copy is still visible, so `cred.mirrored` has something to say.
    expect(ctx.credential.presence.source).toBe("settings-file");
    expect(ctx.credential.stored).toBeUndefined();
    // The rest of the context is intact.
    expect(ctx.plan.kind).toBe("ready");
  });

  it("stringifies a non-Error keychain rejection", async () => {
    const store = {
      get: () => Promise.reject("libsecret is not installed"),
      set: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    const ctx = await build({ credential: credentialDeps({ store }) });
    expect(ctx.credential.keychainError).toBe("libsecret is not installed");
    expect(ctx.credential.presence.source).toBe("none");
  });

  it("treats an unreadable settings file as no token in the file", async () => {
    const ctx = await build({
      credential: credentialDeps({
        store: new MemoryTokenStore({ token: TOKEN, setAt: SET_AT }),
        readFromSettings: () => Promise.reject(new Error("EACCES")),
      }),
    });
    expect(ctx.credential.presence.source).toBe("keychain");
  });

  it("does not call a trailing newline a different key (F10)", async () => {
    // `/setup-bedrock` writes the value into JSON; a paste can leave a newline
    // on either side. Surrounding whitespace is not a second key, and a
    // conflict warning the user cannot clear is worse than no warning.
    const ctx = await build({
      credential: credentialDeps({
        store: new MemoryTokenStore({ token: TOKEN, setAt: SET_AT }),
        readFromSettings: async () => `${TOKEN}\n`,
      }),
    });
    expect(ctx.credential.presence).toEqual({ source: "both", mismatch: false, setAt: SET_AT });
  });

  it("does not call surrounding whitespace a different key either", async () => {
    const ctx = await build({
      credential: credentialDeps({
        store: new MemoryTokenStore({ token: `  ${TOKEN}\t`, setAt: SET_AT }),
        readFromSettings: async () => TOKEN,
      }),
    });
    expect(ctx.credential.presence.mismatch).toBe(false);
  });

  it("still flags a genuinely different key", async () => {
    const ctx = await build({
      credential: credentialDeps({
        store: new MemoryTokenStore({ token: TOKEN, setAt: SET_AT }),
        readFromSettings: async () => `${OTHER}\n`,
      }),
    });
    expect(ctx.credential.presence.mismatch).toBe(true);
  });

  it("treats a whitespace-only file value as a present but empty one", async () => {
    // Normalising must not turn "   " into "no key in the file": the file does
    // hold a value, it is just not a usable one, and `cred.mirrored` says so.
    const ctx = await build({
      credential: credentialDeps({
        store: new MemoryTokenStore({ token: TOKEN, setAt: SET_AT }),
        readFromSettings: async () => "   ",
      }),
    });
    expect(ctx.credential.presence.source).toBe("both");
    expect(ctx.credential.presence.mismatch).toBe(true);
  });

  it("passes the last test result and the clock through untouched", async () => {
    const lastTest = {
      at: "2026-09-10T11:00:00.000Z",
      result: { kind: "ok", model: "haiku" },
    } satisfies NonNullable<CredentialDeps["lastTest"]>;
    const ctx = await build({ credential: credentialDeps({ lastTest }) });
    expect(ctx.credential.lastTest).toEqual(lastTest);
    expect(ctx.credential.now).toEqual(NOW);
  });

  it("carries the stamp of the key a test result was recorded against (F5)", async () => {
    const lastTest = {
      at: "2026-09-10T11:00:00.000Z",
      tokenSetAt: SET_AT,
      result: { kind: "ok", model: "haiku" },
    } satisfies NonNullable<CredentialDeps["lastTest"]>;
    const ctx = await build({ credential: credentialDeps({ lastTest }) });
    expect(ctx.credential.lastTest).toEqual(lastTest);
  });

  it("defaults the clock to now when the host injects none", async () => {
    const before = Date.now();
    const ctx = await build({
      credential: { store: new MemoryTokenStore(), readFromSettings: async () => undefined },
    });
    expect(ctx.credential.now.getTime()).toBeGreaterThanOrEqual(before);
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

  it("stays quiet on a Windows file that was already private", async () => {
    await writeSettings("{}");
    const onSelfWrite = vi.fn();
    await buildContext({
      env: { ...env, platform: "win32", acl: aclFake(dir, true).deps },
      manifest: BUNDLED_MANIFEST,
      platform: "win32",
      detect: async () => DETECTED,
      onSelfWrite,
    });
    expect(onSelfWrite).not.toHaveBeenCalled();
  });

  it("announces a Windows ACL repair, which is a write like any other", async () => {
    // The DACL change is a change to the file we are also watching, so the
    // suppression window has to open for it too (F14).
    await writeSettings("{}");
    const onSelfWrite = vi.fn();
    await buildContext({
      env: { ...env, platform: "win32", acl: aclFake(dir).deps },
      manifest: BUNDLED_MANIFEST,
      platform: "win32",
      detect: async () => DETECTED,
      onSelfWrite,
    });
    expect(onSelfWrite).toHaveBeenCalledTimes(1);
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
