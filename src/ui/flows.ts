/**
 * The interactive credential flows (FR-4.2, FR-4.5, FR-4.7, FR-6).
 *
 * Every flow here handles the token value itself, which makes this the most
 * hard-rule-4-sensitive file in the extension. The rules it holds to:
 *
 * - the value is read from the input box or the store, passed to the three
 *   sinks that need it (keychain, terminal collection, settings file), and
 *   dropped. It is never interpolated into a message, a log line, or a
 *   `QuickPickItem` label;
 * - nothing is ever *displayed* to confirm a value — not the last four
 *   characters, not a length. A user who wants to know what they typed can
 *   retype it;
 * - the settings file is written through `plan`/`commit` like every other
 *   write, so a token we did not put there is drift, reported and preserved.
 *
 * The `vscode` dependency is the same narrow one `commands.ts` takes —
 * `window`, `commands` — with everything else injected, which is what lets
 * these run against the command stub in a unit test.
 */

import * as vscode from "vscode";
import type { ApplySession, CommitResult, ConfigEnv } from "../config/index.js";
import { getPath, readSettings, settingsPath } from "../config/index.js";
import { normalizeToken, SHAPE_MESSAGES, validateTokenShape } from "../credential/shape.js";
import type { ConnectionResult, TokenEnv, TokenStore } from "../credential/types.js";
import { testConnection as callBedrock } from "../credential/validate.js";
import {
  adoptTokenFromSettings,
  readTokenFromSettings,
  removeTokenFromSettings,
  syncTokenToSettings,
  TOKEN_SETTINGS_KEY,
} from "../credential/writeThrough.js";
import { LABELS } from "../health/labels.js";
import type { Manifest } from "../manifest/types.js";
import type { Logger } from "../util/log.js";

/** The credential-specific half of what the flows need, injected by the host. */
export interface CredentialFlowDeps {
  store: TokenStore;
  /** The integrated-terminal collection (FR-4.3). */
  terminal: TokenEnv;
  /** Hand the result to the host so `cred.valid` can report it (plan Q-T). */
  recordTest: (result: ConnectionResult) => void;
  /** Injected only by tests; production uses the global. */
  fetch?: typeof globalThis.fetch;
}

export interface FlowDeps {
  env: ConfigEnv;
  session: ApplySession;
  manifest: Manifest;
  log: Logger;
  runHealth: () => Promise<void>;
  markWrite: () => void;
  credential: CredentialFlowDeps;
  now?: () => Date;
}

const TEST_NOW = "Test connection now";
const REMOVE = "Remove key";
const USE_FILE = "Use the key in my settings file";
const USE_SAVED = "Use the key I saved";

/** FR-4.2's entry flow: prompt, store, mirror, and offer to prove it works. */
export async function setToken(deps: FlowDeps): Promise<void> {
  await enterToken(deps, {
    title: "Set Bedrock API Key",
    placeHolder: "Paste your Bedrock API key",
  });
}

/**
 * FR-4.5. Identical to `setToken` but for the wording — deliberately: rotation
 * has to be one command with no hand-editing, and the old value is neither
 * shown nor needed to replace it.
 */
export async function rotateToken(deps: FlowDeps): Promise<void> {
  await enterToken(deps, {
    title: "Update Bedrock API Key",
    placeHolder: "Paste your new Bedrock API key",
  });
}

async function enterToken(
  deps: FlowDeps,
  labels: { title: string; placeHolder: string },
): Promise<void> {
  const entered = await vscode.window.showInputBox({
    title: labels.title,
    placeHolder: labels.placeHolder,
    prompt: promptText(deps.manifest),
    // FR-4.2: masked, and proof against a click on another window losing a
    // value the user has already pasted out of a console page.
    password: true,
    ignoreFocusOut: true,
    validateInput,
  });
  if (entered === undefined) {
    deps.log.info("Key entry cancelled by the user.");
    return;
  }

  const token = normalizeToken(entered);
  await store(deps, token);
  deps.log.info("Saved a Bedrock API key to the system keychain.");
  if (await mirror(deps, token)) await offerTest(deps);
  await deps.runHealth();
}

/**
 * The one place the console URL and AWS's own recommendation are stated. A
 * long-term key survives restarts, which is what this audience needs; AWS's
 * production advice is short-term keys, and saying so here is cheaper than a
 * user discovering it from a security review later.
 */
function promptText(manifest: Manifest): string {
  return `Create a key at ${manifest.credential.consoleUrl} — a long-term key suits a setup you want to keep working; AWS recommends short-term keys for production use.`;
}

/**
 * A shape problem blocks only when it is certain (FR-4.2, M3 risk note). The
 * `too-short` case comes back as a warning so a real key of an unexpected
 * length is never turned away: the cost of wrongly rejecting one is the user's
 * whole setup, and the cost of accepting a wrong value is one failed test call.
 */
export function validateInput(
  candidate: string,
): string | vscode.InputBoxValidationMessage | undefined {
  const verdict = validateTokenShape(candidate);
  if (verdict === undefined) {
    return undefined;
  }
  const message = SHAPE_MESSAGES[verdict.problem];
  return verdict.severity === "error"
    ? message
    : { message, severity: vscode.InputBoxValidationSeverity.Warning };
}

/**
 * FR-4.8's other half: forget it everywhere, in one command.
 *
 * The file goes first (F1). The settings file is the copy Claude Code actually
 * reads, and it is the one write that can fail — a lost race with
 * `/setup-bedrock`, a file that will not parse. Emptying the keychain before
 * knowing the file write landed produced the worst possible outcome: the token
 * still in `settings.json`, no copy left to put back, and a toast saying it was
 * removed. So the removal is only announced, and the other two copies only
 * dropped, once the file no longer holds it.
 */
export async function clearToken(deps: FlowDeps): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    "Remove your Bedrock API key from this computer?",
    {
      modal: true,
      // F14: the removal forces a backup, which is what makes it undoable — and
      // that backup is a plaintext copy of the key still on this computer.
      // Saying so is the difference between an undo the user knows about and a
      // copy of their credential they do not.
      detail:
        "Claude Code will stop working with Amazon Bedrock until you set a key again. A copy is kept in your Claude Code backups folder so this can be undone. The key itself is not cancelled — remove it in the Amazon console if you no longer want it to work anywhere.",
    },
    REMOVE,
  );
  if (confirmed !== REMOVE) {
    deps.log.info("Key removal cancelled by the user.");
    return;
  }

  if (!(await removeFromFile(deps))) return;

  await deps.credential.store.clear();
  deps.credential.terminal.clear();
  deps.log.info("Removed the Bedrock API key from the settings file, keychain and terminals.");
  await vscode.window.showInformationMessage("Removed your Bedrock API key.");
  await deps.runHealth();
}

/**
 * Take the token out of the file, with `sync`'s one retry on a stale commit.
 * Returns false when the file still holds it, in which case the caller must
 * leave the keychain alone: it is the only remaining copy of a key the user may
 * still need, and `cred.mirrored` will offer the removal again.
 *
 * Not `sync(undefined)`: that removes only a token we wrote, and a key left
 * behind by `/setup-bedrock` would survive a removal the user just asked for.
 */
async function removeFromFile(deps: FlowDeps, attempt = 0): Promise<boolean> {
  deps.markWrite();
  let result: CommitResult;
  try {
    result = await removeTokenFromSettings(deps.env, deps.session, {
      manifestRevision: deps.manifest.revision,
    });
  } catch (error) {
    // A file that will not parse cannot be edited at all. This used to throw
    // after the keychain had already been emptied, leaving no command able to
    // give the key back.
    deps.log.error(`Could not remove the key from the settings file: ${messageOf(error)}`);
    await vscode.window.showErrorMessage(
      "Your Claude Code settings file can't be read, so the key wasn't removed. Your saved key has been left alone.",
    );
    return false;
  }

  if (result.reason !== "stale") return true;

  deps.log.warn("The settings file changed while removing the key; retrying once.");
  if (attempt === 0) return removeFromFile(deps, attempt + 1);

  await vscode.window.showWarningMessage(
    "Your settings file kept changing, so the key wasn't removed. Your saved key has been left alone — try again in a moment.",
  );
  return false;
}

/**
 * Take the key Claude Code's own `/setup-bedrock` left in the settings file
 * (plan Q-S). The age clock starts now rather than when the wizard wrote it:
 * conservative, and honest about what we actually know.
 */
export async function adoptToken(deps: FlowDeps): Promise<void> {
  const fromFile = await readTokenFromSettings(deps.env);
  if (fromFile === undefined) {
    await vscode.window.showInformationMessage(
      "There's no Bedrock API key in your settings file to use.",
    );
    return;
  }

  await store(deps, fromFile);
  await takeOwnership(deps, fromFile);
  deps.log.info("Adopted the Bedrock API key already in the settings file.");
  await vscode.window.showInformationMessage("Saved that key to this computer's keychain.");
  await deps.runHealth();
}

/** `cred.mirrored`'s fix: the keychain has it, the file does not (FR-4.4). */
export async function reapplyToken(deps: FlowDeps): Promise<void> {
  const stored = await deps.credential.store.get();
  if (stored === undefined) {
    await vscode.window.showInformationMessage(
      "There's no saved Bedrock API key to copy. Set one first.",
    );
    return;
  }

  deps.credential.terminal.apply(stored.token);
  await mirror(deps, stored.token);
  await deps.runHealth();
}

/**
 * Two keys, two places, and only the user knows which is current. Both options
 * are described by where the key came from, never by its value — there is
 * nothing safe to show that would tell them apart, and showing a prefix of each
 * would put two secrets in a QuickPick to save one question.
 */
export async function resolveTokenConflict(deps: FlowDeps): Promise<void> {
  const [stored, inFile] = await Promise.all([
    deps.credential.store.get(),
    readTokenFromSettings(deps.env),
  ]);
  if (stored === undefined || inFile === undefined) {
    // The conflict resolved itself between the health run and the click.
    await vscode.window.showInformationMessage("There's no longer a conflict to resolve.");
    await deps.runHealth();
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: USE_FILE,
        description: "Claude Code is using this one now",
      },
      {
        label: USE_SAVED,
        description: "The key you last entered here",
      },
    ],
    {
      canPickMany: false,
      title: "Which Bedrock API key should Claude Code use?",
      placeHolder: "Both places hold a key, and they're different",
      ignoreFocusOut: true,
    },
  );
  if (picked === undefined) {
    deps.log.info("Key conflict left unresolved by the user.");
    return;
  }

  const winner = picked.label === USE_FILE ? inFile : stored.token;
  await store(deps, winner);
  // Either direction is an ownership transfer: the file holds a value we did
  // not write, so a plain sync would report drift and change nothing.
  await takeOwnership(deps, winner);
  deps.log.info(
    `Resolved the key conflict in favour of the ${picked.label === USE_FILE ? "settings file" : "keychain"}.`,
  );
  await deps.runHealth();
}

/**
 * FR-4.7. The only outbound request the extension makes with the token, and it
 * happens only here — never from a health check (plan Q-T).
 */
export async function testConnection(deps: FlowDeps): Promise<void> {
  const stored = await deps.credential.store.get();
  if (stored === undefined) {
    await vscode.window.showInformationMessage(
      "There's no Bedrock API key to test yet. Set one first.",
    );
    return;
  }

  const configuredRegion = await region(deps);
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Testing your Bedrock API key…" },
    () =>
      callBedrock({
        token: stored.token,
        region: configuredRegion,
        models: modelsToTry(deps.manifest),
        ...(deps.credential.fetch === undefined ? {} : { fetch: deps.credential.fetch }),
      }),
  );

  deps.credential.recordTest(result);
  // The kind, never the body and never the token: `ConnectionResult` carries
  // only a status, a region, or a model id we supplied ourselves.
  deps.log.info(`Connection test: ${result.kind}`);
  await announce(result);
  await deps.runHealth();
}

/** Q-U: Haiku first because Claude Code uses it for background work. */
function modelsToTry(manifest: Manifest): string[] {
  const env = manifest.defaults.env;
  return [env.ANTHROPIC_DEFAULT_HAIKU_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL].filter(
    (model): model is string => model !== undefined && model !== "",
  );
}

/**
 * The region Claude Code would actually use, falling back to the recommended
 * one. Testing against a region the user has not configured would report a
 * setup that does not exist.
 */
async function region(deps: FlowDeps): Promise<string> {
  const read = await readSettings(settingsPath(deps.env.claudeDir)).catch(() => undefined);
  const value = read?.kind === "ok" ? getPath(read.data, "env.AWS_REGION") : undefined;
  return typeof value === "string" && value !== ""
    ? value
    : (deps.manifest.defaults.env.AWS_REGION ?? "");
}

/**
 * The same sentences `cred.valid` puts in the panel. One wording per outcome,
 * in one place, so the toast and the tree never disagree about what happened.
 */
async function announce(result: ConnectionResult): Promise<void> {
  const labels = LABELS["cred.valid"];
  switch (result.kind) {
    case "ok":
      await vscode.window.showInformationMessage(labels.pass);
      return;
    case "ok-without-haiku":
      await vscode.window.showWarningMessage(labels.withoutHaiku);
      return;
    case "bad-credential":
      await vscode.window.showErrorMessage(labels.badCredential);
      return;
    case "model-not-enabled":
      await vscode.window.showErrorMessage(labels.modelNotEnabled);
      return;
    case "wrong-region":
      await vscode.window.showErrorMessage(labels.wrongRegion);
      return;
    case "network":
      await vscode.window.showErrorMessage(labels.network);
      return;
    case "unknown":
      await vscode.window.showErrorMessage(labels.unknown);
  }
}

async function offerTest(deps: FlowDeps): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Saved your Bedrock API key. Try it now?",
    TEST_NOW,
  );
  if (choice === TEST_NOW) await testConnection(deps);
}

/** Keychain first, terminals second: the canonical copy is written before any derived one. */
async function store(deps: FlowDeps, token: string): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  await deps.credential.store.set({ token, setAt: now.toISOString() });
  deps.credential.terminal.apply(token);
}

/**
 * Write the token through and say only what actually happened (F2, F3).
 *
 * `merge` preserves a value at the token key that we did not write — hard rule
 * 3, and correct — so a commit can come back `written: true` for the
 * `CLAUDE_CODE_USE_BEDROCK` half while the token itself never moved. Announcing
 * success off the commit alone therefore told the user Claude Code could see a
 * key it could not, and left `reapplyToken` as a fix button that changed
 * nothing and reappeared on the next health run for ever.
 *
 * So the result is inspected rather than discarded: the token key appearing in
 * `drift` means the file kept someone else's value, which is a conflict only
 * the user can settle. Returns whether the file now holds the token, so callers
 * do not follow a failed mirror with an offer that assumes it worked.
 */
async function mirror(deps: FlowDeps, token: string): Promise<boolean> {
  const result = await sync(deps, token);
  if (result === undefined || result.reason === "stale") return false;

  if (result.drift.some((entry) => entry.key === TOKEN_SETTINGS_KEY)) {
    await offerTakeOver(deps, token);
    return false;
  }

  deps.log.info("Copied the saved Bedrock API key into the settings file.");
  await vscode.window.showInformationMessage("Claude Code can now see your Bedrock API key.");
  return true;
}

/**
 * The file holds a token we did not write. Overwriting it silently is exactly
 * what hard rule 3 forbids, and leaving the user with a button that does
 * nothing is what made this a bug — so the one thing that can end it is asked
 * for directly, in the same words `resolveTokenConflict` uses.
 *
 * The two keys are described by where they came from and never by their value:
 * there is nothing safe to show that would tell them apart.
 */
async function offerTakeOver(deps: FlowDeps, token: string): Promise<void> {
  deps.log.warn("The settings file holds a different Bedrock API key; it was not overwritten.");
  const choice = await vscode.window.showWarningMessage(
    "Your key wasn't copied into your settings file, because it already holds a different one. Which should Claude Code use?",
    USE_SAVED,
  );
  if (choice !== USE_SAVED) {
    deps.log.info("The user left the settings file's Bedrock API key in place.");
    return;
  }

  await takeOwnership(deps, token);
  deps.log.info("Replaced the settings file's Bedrock API key with the saved one.");
}

/**
 * Write-through with one retry. A `stale` commit means something else wrote the
 * settings file between plan and commit — Claude Code's `/setup-bedrock` is the
 * one that does this — and the answer is to re-plan against the new file, never
 * to force our document over theirs.
 */
async function sync(
  deps: FlowDeps,
  token: string | undefined,
  attempt = 0,
): Promise<CommitResult | undefined> {
  deps.markWrite();
  const result = await syncTokenToSettings(deps.env, deps.session, token, {
    manifestRevision: deps.manifest.revision,
  });
  if (result.reason !== "stale") return result;

  deps.log.warn("The settings file changed while writing the key; retrying once.");
  if (attempt === 0) return sync(deps, token, attempt + 1);

  await vscode.window.showWarningMessage(
    "Your settings file kept changing, so the key wasn't copied into it. Try again in a moment.",
  );
  return result;
}

/**
 * Claim the token key and write `value` into it. This is the only path that
 * overwrites a token the extension did not write, and both its callers are an
 * explicit choice the user just made.
 */
async function takeOwnership(deps: FlowDeps, value: string): Promise<void> {
  deps.markWrite();
  await adoptTokenFromSettings(deps.env, deps.session, value);
}

/**
 * `Logger` redacts what it writes, so this only keeps a non-`Error` throw from
 * being stringified into the channel as whatever it happens to be.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "an unexpected failure";
}
