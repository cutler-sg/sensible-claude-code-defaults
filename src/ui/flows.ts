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
  await mirror(deps, token);
  await offerTest(deps);
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

/** FR-4.8's other half: forget it everywhere, in one command. */
export async function clearToken(deps: FlowDeps): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    "Remove your Bedrock API key from this computer?",
    {
      modal: true,
      detail:
        "Claude Code will stop working with Amazon Bedrock until you set a key again. The key itself is not cancelled — remove it in the Amazon console if you no longer want it to work anywhere.",
    },
    REMOVE,
  );
  if (confirmed !== REMOVE) {
    deps.log.info("Key removal cancelled by the user.");
    return;
  }

  await deps.credential.store.clear();
  deps.credential.terminal.clear();
  deps.markWrite();
  // Not `sync(undefined)`: that removes only a token we wrote, and a key left
  // behind by `/setup-bedrock` would survive a removal the user just asked for.
  await removeTokenFromSettings(deps.env, deps.session, {
    manifestRevision: deps.manifest.revision,
  });
  deps.log.info("Removed the Bedrock API key from the keychain, terminals and settings.");
  await vscode.window.showInformationMessage("Removed your Bedrock API key.");
  await deps.runHealth();
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
  await sync(deps, stored.token);
  deps.log.info("Copied the saved Bedrock API key into the settings file.");
  await vscode.window.showInformationMessage("Claude Code can now see your Bedrock API key.");
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

async function mirror(deps: FlowDeps, token: string): Promise<void> {
  const result = await sync(deps, token);
  if (result?.reason === "stale") return;
  await vscode.window.showInformationMessage("Claude Code can now see your Bedrock API key.");
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
