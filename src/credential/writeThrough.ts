/**
 * Mirroring the token into `~/.claude/settings.json` (FR-4.4).
 *
 * The keychain is canonical; the file is a derived artefact. It exists because
 * the Claude Code panel spawns its binary from the extension host and inherits
 * VS Code's process environment, which `environmentVariableCollection` never
 * touches — the panel is the primary persona's surface, so the file is not
 * optional.
 *
 * Everything goes through `plan`/`commit`, so hard rule 3 holds here as it does
 * everywhere else: a token in the file that we did not write is drift, reported
 * and preserved, never overwritten. `adoptTokenFromSettings` is the one door out
 * of that, and it is an explicit user choice.
 *
 * Hard rule 4: the returned `CommitResult` carries real values in `changes` and
 * `drift` because the engine redacts at the render boundary (`redactChanges` /
 * `redactDrift`), not at the source — `commit` has to write the value. Callers
 * must not log this result raw.
 */

import {
  type ApplySession,
  type CommitMeta,
  type CommitResult,
  type ConfigEnv,
  ConfigError,
  commit,
  type Desired,
  getPath,
  type ManagedKey,
  type PlanResult,
  plan,
  type ReadyPlan,
  readSettings,
  resetKeyPlan,
  settingsPath,
} from "../config/index.js";
import { register } from "../util/redact.js";

/** The `settings.json` home of `AWS_BEARER_TOKEN_BEDROCK`. */
export const TOKEN_SETTINGS_KEY: ManagedKey = "env.AWS_BEARER_TOKEN_BEDROCK";
const BEDROCK_SETTINGS_KEY: ManagedKey = "env.CLAUDE_CODE_USE_BEDROCK";

/**
 * Write the token through to the file, or remove it when `token` is undefined
 * (merge Q-G). `CLAUDE_CODE_USE_BEDROCK` rides along in both directions: a
 * token in the file that Claude Code is not told to use for Bedrock is inert.
 *
 * The `CommitResult` is returned unchanged. `stale` in particular is the
 * caller's to handle — Claude Code's own `/setup-bedrock` can write the file
 * between plan and commit, and the answer is to re-plan, not to force.
 */
export async function syncTokenToSettings(
  env: ConfigEnv,
  session: ApplySession,
  token: string | undefined,
  opts?: CommitMeta,
): Promise<CommitResult> {
  const desired: Desired = {
    [TOKEN_SETTINGS_KEY]: token,
    [BEDROCK_SETTINGS_KEY]: "1",
  };
  return commit(env, session, ready(await plan(env, desired)), opts);
}

/**
 * Take ownership of a token already in the file — the state Claude Code's
 * `/setup-bedrock` leaves behind, and the common first-run state for anyone who
 * tried the CLI wizard first (plan Q-S). Without this the extension would nag
 * the user to re-enter a key they already have.
 *
 * `resetKeyPlan` seeds the snapshot with the file's current value so the merge
 * sees the key as ours, which is exactly what adoption means. Only the token key
 * is touched: adoption is an ownership transfer, not an apply.
 */
export async function adoptTokenFromSettings(
  env: ConfigEnv,
  session: ApplySession,
  value: string,
): Promise<CommitResult> {
  const planned = ready(
    await resetKeyPlan(env, { [TOKEN_SETTINGS_KEY]: value }, TOKEN_SETTINGS_KEY),
  );
  const result = await commit(env, session, planned, { forceBackup: true });

  if (result.reason === "noop") {
    // Adopting the value that is already in the file changes no bytes, so
    // `commit` returns early and never advances the snapshot — leaving the key
    // unowned and the adoption a no-op in every sense. Persisting the claim
    // here is the whole point of the call, and it is the only case where this
    // module writes the snapshot itself.
    await claimOwnership(env, planned);
  }
  return result;
}

async function claimOwnership(env: ConfigEnv, planned: ReadyPlan): Promise<void> {
  const snapshot = await env.snapshotStore.load();
  // `snapshotValues` is the loaded snapshot plus the seeded claim, so this
  // preserves every other managed key's ownership.
  await env.snapshotStore.save({ ...snapshot, values: planned.merge.snapshotValues });
}

/**
 * Take the token out of the file, whoever put it there.
 *
 * The one deliberate exception to "a value we did not write is preserved". A
 * plain removal only removes a token we own, which would leave a key the user
 * has just asked us to delete sitting in the file for Claude Code to keep
 * using — the opposite of what "Remove Bedrock API Key" promises, and a worse
 * outcome than the drift rule protects against. So the key is claimed and then
 * removed, in one commit, with a forced backup so the value is recoverable.
 *
 * `CLAUDE_CODE_USE_BEDROCK` is untouched: it is a routing choice, not a
 * credential, and `config.bedrock` owns it.
 */
export async function removeTokenFromSettings(
  env: ConfigEnv,
  session: ApplySession,
  opts?: CommitMeta,
): Promise<CommitResult> {
  const planned = ready(
    await resetKeyPlan(env, { [TOKEN_SETTINGS_KEY]: undefined }, TOKEN_SETTINGS_KEY),
  );
  return commit(env, session, planned, { forceBackup: true, ...opts });
}

/**
 * Read the token the file currently holds, without writing anything.
 *
 * Absent, malformed, or a non-string value all read as "no token": this feeds
 * `cred.mirrored`, which must never throw, and a file that will not parse is
 * already reported by `config.parses` with its own fix.
 */
export async function readTokenFromSettings(env: ConfigEnv): Promise<string | undefined> {
  const read = await readSettings(settingsPath(env.claudeDir));
  if (read.kind !== "ok") {
    return undefined;
  }
  // `getPath` throws only when `env` is present and not an object, and a `kind:
  // "ok"` read already guarantees it is one — the reader refuses that file.
  const value = getPath(read.data, TOKEN_SETTINGS_KEY);
  if (typeof value !== "string" || value === "") return undefined;
  // FR-4.9: the file is the second door a token value comes through, and the
  // one behind `/setup-bedrock` and every hand-edit — i.e. values the keychain
  // has never held. Registering here is what lets `redact` scrub a key this
  // extension did not choose, in a diagnostics report that quotes the file.
  register(value);
  return value;
}

/**
 * A blocked plan cannot be committed by construction (FR-2.5). Turning it into
 * a throw here keeps the return type a plain `CommitResult`, and the message is
 * the reader's — which names a line and column, never file content (hard rule 4).
 */
function ready(planned: PlanResult): ReadyPlan {
  if (planned.kind === "blocked") {
    throw new ConfigError("MALFORMED_SETTINGS", planned.error);
  }
  return planned;
}
