/**
 * Builds the `CheckContext` once per health run.
 *
 * Everything expensive or effectful happens here — the permission repair, the
 * file read, the snapshot load, the merge plan, the `claude --version` probe —
 * so each check stays a pure function of data and is testable without a
 * filesystem. Nothing in this file imports `vscode`; the host injects the two
 * things that need it (`detect`, and the `ConfigEnv`'s snapshot store).
 */

import { plan, repairPermissions, settingsPath } from "../config/index.js";
import type { ConfigEnv, Drift, PlanResult } from "../config/types.js";
import type { ConnectionResult, TokenPresence, TokenStore } from "../credential/types.js";
import type { Manifest } from "../manifest/types.js";
import { desiredFromManifest } from "../manifest/types.js";
import type { CheckContext, ClaudeCodeDetection, CredentialContext } from "./types.js";

export interface BuildContextInput {
  env: ConfigEnv;
  manifest: Manifest;
  platform: NodeJS.Platform;
  detect: () => Promise<ClaudeCodeDetection>;
  /**
   * Called when the silent permission repair actually wrote something. The
   * repair is a change to a file we are also watching, so without this the
   * watcher hears its own echo, reruns the checks, and repairs again — a panel
   * refreshing itself for as long as Claude Code keeps resetting the mode
   * (which is every `/model`). The host wires this to the watcher's
   * suppression window.
   */
  onSelfWrite?: () => void;
  /**
   * The credential sources, injected. Optional because the context predates the
   * credential checks: without it every `cred.*` check sees "nothing
   * configured", which is the truth for a host that has not wired a keychain.
   */
  credential?: CredentialDeps;
}

export interface CredentialDeps {
  store: TokenStore;
  /** `readTokenFromSettings(env)`, injected so the context stays testable. */
  readFromSettings: () => Promise<string | undefined>;
  /** The last user-initiated test call this window, held in memory by the host. */
  lastTest?: { at: string; result: ConnectionResult };
  now?: () => Date;
}

export async function buildContext(input: BuildContextInput): Promise<CheckContext> {
  const { env, manifest, platform, detect } = input;

  // FR-2.8: re-assert the mode before anything reads the file, and swallow the
  // failure into the context rather than out of the run. `config.perms` is the
  // one check that reports it (plan Q-N); every other check still wants to run.
  const permissions = await repairPermissions(env).catch(
    (error: unknown): CheckContext["permissions"] => ({ kind: "failed", error: message(error) }),
  );
  // Only `repaired` touched the file: `ok`, `absent`, `unsupported` and
  // `failed` all leave it exactly as it was, and suppressing the watcher for
  // those would drop a real edit that raced with the run.
  if (permissions.kind === "repaired") input.onSelfWrite?.();

  const planned: PlanResult = await plan(env, desiredFromManifest(manifest));
  const [snapshot, detection, credential] = await Promise.all([
    env.snapshotStore.load(),
    detect(),
    buildCredential(manifest, input.credential),
  ]);

  return {
    claudeDir: env.claudeDir,
    settingsFile: settingsPath(env.claudeDir),
    platform,
    read:
      planned.kind === "ready"
        ? planned.read
        : { kind: "malformed", raw: planned.raw, error: planned.error },
    snapshot,
    manifest,
    plan: planned,
    drift: driftOf(planned),
    detection,
    credential,
    permissions,
  };
}

/**
 * Reads both token locations and reduces them to presence, age and policy.
 *
 * The values themselves stop here: they are compared to produce `mismatch` and
 * then dropped, so nothing downstream of this function can render one (hard
 * rule 4, enforced by `CheckContext` having nowhere to put a token).
 *
 * A keychain that throws — Linux without libsecret — is recorded rather than
 * propagated. Letting it out would fail the whole run and blank the panel over
 * a condition that has its own check and its own message (plan Q-X).
 */
async function buildCredential(
  manifest: Manifest,
  deps: CredentialDeps | undefined,
): Promise<CredentialContext> {
  const now = (deps?.now ?? (() => new Date()))();
  const base = {
    policy: manifest.credential,
    now,
    ...(deps?.lastTest === undefined ? {} : { lastTest: deps.lastTest }),
  };
  if (deps === undefined) {
    return { ...base, presence: { source: "none", mismatch: false } };
  }

  const inFile = await deps.readFromSettings().catch(() => undefined);

  let stored: Awaited<ReturnType<TokenStore["get"]>>;
  try {
    stored = await deps.store.get();
  } catch (error) {
    return {
      ...base,
      presence: { source: inFile === undefined ? "none" : "settings-file", mismatch: false },
      keychainError: message(error),
    };
  }

  return {
    ...base,
    presence: presenceOf(stored?.token, inFile, stored?.setAt),
    ...(stored === undefined ? {} : { stored: { setAt: stored.setAt } }),
  };
}

function presenceOf(
  keychain: string | undefined,
  file: string | undefined,
  setAt: string | undefined,
): TokenPresence {
  const source =
    keychain === undefined
      ? file === undefined
        ? "none"
        : "settings-file"
      : file === undefined
        ? "keychain"
        : "both";
  return {
    source,
    mismatch: keychain !== undefined && file !== undefined && keychain !== file,
    ...(setAt === undefined ? {} : { setAt }),
  };
}

function driftOf(planned: PlanResult): Drift[] {
  return planned.kind === "ready" ? planned.merge.drift : [];
}

export interface DetectDeps {
  /** `vscode.extensions.getExtension('anthropic.claude-code')?.packageJSON.version`. */
  getExtensionVersion: () => string | undefined;
  execFile: (
    cmd: string,
    args: readonly string[],
    opts: { timeout: number },
  ) => Promise<{ stdout: string }>;
}

/** FR-1.4 signal 2's budget. Beyond this the CLI is simply "not found". */
const CLI_TIMEOUT_MS = 5000;

/**
 * FR-1.4 signals 1 and 2. Signal 3 (settings readability) is already in the
 * context as `read`, so it is not repeated here.
 *
 * A failing CLI probe is never an error: Claude Code's extension bundles its
 * own binary and does not always put one on PATH, so "extension yes, CLI no" is
 * the normal install and `install.cli` reports it as information only.
 */
export async function detectClaudeCode(deps: DetectDeps): Promise<ClaudeCodeDetection> {
  const version = deps.getExtensionVersion();
  return {
    extension: version === undefined ? { installed: false } : { installed: true, version },
    cli: await probeCli(deps.execFile),
  };
}

async function probeCli(execFile: DetectDeps["execFile"]): Promise<ClaudeCodeDetection["cli"]> {
  let stdout: string;
  try {
    ({ stdout } = await execFile("claude", ["--version"], { timeout: CLI_TIMEOUT_MS }));
  } catch {
    return { found: false };
  }
  const version = parseCliVersion(stdout);
  return version === undefined ? { found: false } : { found: true, version };
}

/**
 * `claude --version` prints `2.1.267 (Claude Code)`. Take the first
 * dotted-numeric token and ignore the rest, so a reworded banner still detects.
 * No token at all means the binary on PATH is not the one we think it is.
 */
function parseCliVersion(stdout: string): string | undefined {
  return /\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/.exec(stdout)?.[0];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
