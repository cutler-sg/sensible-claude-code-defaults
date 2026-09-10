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
import type { Manifest } from "../manifest/types.js";
import { desiredFromManifest } from "../manifest/types.js";
import type { CheckContext, ClaudeCodeDetection } from "./types.js";

export interface BuildContextInput {
  env: ConfigEnv;
  manifest: Manifest;
  platform: NodeJS.Platform;
  detect: () => Promise<ClaudeCodeDetection>;
}

export async function buildContext(input: BuildContextInput): Promise<CheckContext> {
  const { env, manifest, platform, detect } = input;

  // FR-2.8: re-assert the mode before anything reads the file, and swallow the
  // failure into the context rather than out of the run. `config.perms` is the
  // one check that reports it (plan Q-N); every other check still wants to run.
  const permissions = await repairPermissions(env).catch(
    (error: unknown): CheckContext["permissions"] => ({ kind: "failed", error: message(error) }),
  );

  const planned: PlanResult = await plan(env, desiredFromManifest(manifest));
  const [snapshot, detection] = await Promise.all([env.snapshotStore.load(), detect()]);

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
    permissions,
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
