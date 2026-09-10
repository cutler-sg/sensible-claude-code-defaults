/**
 * The FR-6 command surface.
 *
 * Everything that writes goes through `plan` → preview → `commit`, so there is
 * no path from a menu item to the writer that skips the diff a human accepted.
 * The VS Code dependency here is only `window`/`commands`/`workspace`; the
 * config engine and the manifest arrive as injected data (see `host.ts`), which
 * is what keeps this file testable and the engine `vscode`-free.
 */

import * as vscode from "vscode";
import {
  type ApplySession,
  type CommitResult,
  type ConfigEnv,
  commit,
  listBackups,
  plan,
  type ReadyPlan,
  redactChanges,
  repairPermissions,
  resetKeyPlan,
  restore,
} from "../config/index.js";
import type { Desired, ManagedKey, PlanResult } from "../config/types.js";
import { keyDisplayName } from "../health/labels.js";
import { desiredFromManifest, type Manifest } from "../manifest/types.js";
import type { Logger } from "../util/log.js";
import { redact } from "../util/redact.js";
import { describeChange, pluralize, relativeAge } from "./present.js";
import type { Node } from "./treeProvider.js";

export interface CommandDeps {
  env: ConfigEnv;
  session: ApplySession;
  manifest: Manifest;
  settingsFile: string;
  backupsDir: string;
  log: Logger;
  /** Re-run the checks and repaint the panel. */
  runHealth: () => Promise<void>;
  /** Open the watcher's suppression window; called after every write. */
  markWrite: () => void;
  now?: () => Date;
}

const OPEN_FILE = "Open file";
const RESTORE_BACKUP = "Restore backup";
const CONTINUE = "Continue";
const REPLACE = "Replace";
const CANCEL = "Cancel";

/** One retry, everywhere. See `commitSingle`. */
const MAX_STALE_RETRIES = 1;

export function registerCommands(deps: CommandDeps): vscode.Disposable {
  const register = (id: string, handler: (...args: never[]) => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      deps.log.info(`Command: ${id}`);
      try {
        await (handler as (...a: unknown[]) => Promise<void>)(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log.error(`${id} failed: ${message}`);
        await vscode.window.showErrorMessage(redact(`That didn't work: ${message}`));
      }
    });

  return vscode.Disposable.from(
    register("sensibleDefaults.runHealthCheck", () => deps.runHealth()),
    register("sensibleDefaults.applyDefaults", () => applyDefaults(deps, 0)),
    register("sensibleDefaults.openSettings", () => openSettings(deps)),
    register("sensibleDefaults.restoreBackup", () => restoreBackupCommand(deps)),
    register("sensibleDefaults.resetKey", (node: unknown) => resetKey(deps, node, 0)),
    register("sensibleDefaults.selectRegion", () => selectRegion(deps)),
    register("sensibleDefaults.repairPermissions", () => repairPermissionsCommand(deps)),
    register("sensibleDefaults.runFix", (node: unknown) => runFix(deps, node)),
  );
}

/** FR-6.1: preview, then write. A stale plan is recomputed, never forced. */
async function applyDefaults(deps: CommandDeps, attempt: number): Promise<void> {
  const desired = desiredFromManifest(deps.manifest);
  const planned = await plan(deps.env, desired);

  if (planned.kind === "blocked") {
    await reportBlocked(deps, planned.error);
    return;
  }
  if (planned.noop) {
    await vscode.window.showInformationMessage("Already up to date.");
    return;
  }

  const changes = redactChanges(planned.merge.changes);
  const count = changes.length;
  const confirmLabel = `Apply all ${pluralize(count, "change")}`;
  // Multi-step QuickPick rather than an untitled-document diff (plan Q-P): the
  // design target is a user for whom a JSON diff is not a readable object.
  // Only the first item confirms; the change rows are there to be read, so
  // picking one is treated as "I was reading, not deciding" — i.e. cancel.
  const picked = await vscode.window.showQuickPick(
    [
      // Cancel is first so the highlighted item on open is the harmless one: a
      // stray Enter on a dialog the user has not read yet must never write.
      { label: CANCEL, description: "" },
      { label: confirmLabel, description: "Writes the changes listed below" },
      ...changes.map((change) => ({ label: describeChange(change), description: "" })),
    ],
    {
      canPickMany: false,
      title: `Apply ${pluralize(count, "recommended change")}?`,
      placeHolder: "Review the changes, then choose Apply",
      ignoreFocusOut: true,
    },
  );
  if (picked?.label !== confirmLabel) {
    deps.log.info("applyDefaults cancelled by the user.");
    return;
  }

  const result = await commitPlan(deps, planned);
  if (result.reason === "stale") {
    await warnStale();
    // One retry: the preview the user accepted described a document that no
    // longer exists, so they have to accept the new one. Looping without a
    // bound would spin against a process writing the file continuously.
    if (attempt === 0) await applyDefaults(deps, attempt + 1);
    return;
  }
  if (result.written) {
    await vscode.window.showInformationMessage(
      `Applied ${pluralize(result.changes.length, "change")}.`,
    );
  }
  await deps.runHealth();
}

async function openSettings(deps: CommandDeps): Promise<void> {
  const uri = vscode.Uri.file(deps.settingsFile);
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
  } catch {
    const choice = await vscode.window.showInformationMessage(
      "There's no settings file yet. Create one with the recommended settings?",
      "Apply recommended configuration",
    );
    if (choice !== undefined) await applyDefaults(deps, 0);
  }
}

async function restoreBackupCommand(deps: CommandDeps): Promise<void> {
  const backups = await listBackups(deps.backupsDir);
  if (backups.length === 0) {
    await vscode.window.showInformationMessage("There are no saved copies to restore yet.");
    return;
  }

  const now = (deps.now ?? (() => new Date()))();
  // `listBackups` is newest-first, and a backup is taken *before* each write —
  // so `backups[0]` is the configuration as it was before the most recent
  // change, which is what "restore previous configuration" means.
  const picked = await vscode.window.showQuickPick(
    backups.map((backup) => ({
      label: `Saved ${relativeAge(backup.createdAt, now)}`,
      description: backup.createdAt.toLocaleString(),
      backup,
    })),
    { canPickMany: false, title: "Restore a previous configuration", ignoreFocusOut: true },
  );
  if (picked === undefined) return;

  const confirmed = await vscode.window.showWarningMessage(
    "Replace your current Claude Code settings with this saved copy?",
    {
      modal: true,
      detail: `Restoring ${picked.backup.path}. Your current settings are saved first.`,
    },
    CONTINUE,
  );
  if (confirmed !== CONTINUE) return;

  deps.markWrite();
  await restore(deps.env, deps.session, picked.backup.path);
  deps.log.info(`Restored settings from ${picked.backup.path}`);
  await vscode.window.showInformationMessage("Restored your previous configuration.");
  await deps.runHealth();
}

/**
 * The only path that transfers ownership of a key back to us (M1 plan note), so
 * it is always an explicit per-key decision — never a side effect of an apply.
 *
 * "Explicit" has to mean confirmed as well as per-key: this is the inline
 * button next to a drift row, one mis-click away at all times, and the value it
 * replaces is by definition one the user chose (hard rule 3).
 */
async function resetKey(deps: CommandDeps, arg: unknown, attempt: number): Promise<void> {
  const key = managedKeyFrom(arg);
  if (key === undefined) {
    deps.log.warn("resetKey called without a drifted key; ignoring.");
    return;
  }
  const desired = desiredFromManifest(deps.manifest);
  if (!(key in desired)) {
    // A managed key the manifest says nothing about: the reset would plan no
    // change at all, and clicking a button that does nothing reads as a bug.
    await vscode.window.showInformationMessage(
      `There's no recommended value for ${keyDisplayName(key)} yet.`,
    );
    return;
  }
  const planned = await resetKeyPlan(deps.env, desired, key);
  await commitSingle(deps, planned, attempt, (next) => resetKey(deps, key, next), {
    alreadyThere: `Your ${keyDisplayName(key)} already matches the recommended value.`,
  });
}

async function selectRegion(deps: CommandDeps): Promise<void> {
  const regions = deps.manifest.regions;
  if (regions.length === 0) {
    // An empty QuickPick renders as a blank list with no explanation. It only
    // happens with a manifest that carries no regions, which M4's remote fetch
    // makes reachable in the field.
    deps.log.warn("selectRegion: the manifest lists no regions.");
    await vscode.window.showInformationMessage(
      "There are no Amazon regions to choose from in the current recommendations.",
    );
    return;
  }
  const region = await vscode.window.showQuickPick(regions, {
    canPickMany: false,
    title: "Change AWS Region",
    placeHolder: "Pick the AWS region closest to you",
    ignoreFocusOut: true,
  });
  if (region === undefined) return;
  await applyRegion(deps, region, 0);
}

async function applyRegion(deps: CommandDeps, region: string, attempt: number): Promise<void> {
  // A region the user just chose is theirs by definition, so it goes through
  // the ownership-transferring reset path rather than a plain apply, which
  // would report the hand-picked value as drift forever.
  const desired: Desired = { "env.AWS_REGION": region };
  const planned = await resetKeyPlan(deps.env, desired, "env.AWS_REGION");
  await commitSingle(deps, planned, attempt, (next) => applyRegion(deps, region, next), {
    alreadyThere: `Your ${keyDisplayName("env.AWS_REGION")} is already ${region}.`,
  });
}

async function repairPermissionsCommand(deps: CommandDeps): Promise<void> {
  const outcome = await repairPermissions(deps.env);
  const message = permissionMessage(outcome.kind);
  deps.log.info(`Permission repair: ${outcome.kind}`);
  await vscode.window.showInformationMessage(message);
  await deps.runHealth();
}

function permissionMessage(kind: "repaired" | "ok" | "absent" | "unsupported"): string {
  switch (kind) {
    case "repaired":
      return "Your settings file is now readable only by you.";
    case "ok":
      return "Your settings file was already private to you.";
    case "absent":
      return "There's no settings file yet, so there's nothing to protect.";
    case "unsupported":
      return "File permissions work differently on this system; nothing to change.";
  }
}

/** The wrench button: run whatever command the check nominated as its fix. */
async function runFix(deps: CommandDeps, node: unknown): Promise<void> {
  const fix = fixFrom(node);
  if (fix === undefined) {
    deps.log.warn("runFix called on a node with no fix; ignoring.");
    return;
  }
  await vscode.commands.executeCommand(fix.command, ...(fix.args ?? []));
}

/**
 * Confirm, then write, for the single-key paths that take a value away from the
 * user. `attempt` is threaded through the retry rather than restarted, so every
 * path is bounded at `MAX_STALE_RETRIES` even when the file is being rewritten
 * continuously by something else.
 */
async function commitSingle(
  deps: CommandDeps,
  planned: PlanResult,
  attempt: number,
  retry: (attempt: number) => Promise<void>,
  say: { alreadyThere: string },
): Promise<void> {
  if (planned.kind === "blocked") {
    await reportBlocked(deps, planned.error);
    return;
  }
  if (planned.noop) {
    await vscode.window.showInformationMessage(say.alreadyThere);
    return;
  }
  if (!(await confirmReplace(planned))) {
    deps.log.info("Reset cancelled by the user.");
    return;
  }

  // `forceBackup`: this write overwrites a value the *user* set, so the
  // session's one backup — which may already be spent on a routine apply — is
  // not enough to make it undoable (FR-2.4, hard rule 3).
  const result = await commitPlan(deps, planned, { forceBackup: true });
  if (result.reason === "stale") {
    await warnStale();
    if (attempt < MAX_STALE_RETRIES) await retry(attempt + 1);
    return;
  }
  await deps.runHealth();
}

/**
 * The modal in front of every ownership transfer. Modal rather than a toast
 * because a notification can be missed entirely, and this one is the user's
 * only chance to keep a value they chose on purpose.
 */
async function confirmReplace(planned: ReadyPlan): Promise<boolean> {
  const changes = redactChanges(planned.merge.changes);
  const first = changes[0];
  const name = first === undefined ? "these settings" : keyDisplayName(first.key);
  const detail = changes.map(describeChange).join("\n");
  const choice = await vscode.window.showWarningMessage(
    `Replace your ${name} with the recommended value?`,
    { modal: true, detail: `${detail}\n\nYour current settings are saved first.` },
    REPLACE,
  );
  return choice === REPLACE;
}

async function commitPlan(
  deps: CommandDeps,
  planned: ReadyPlan,
  meta?: { forceBackup: true },
): Promise<CommitResult> {
  // Suppression opens *before* the write, not after: the rename lands during
  // the call, so a window opened afterwards is already too late for the event.
  deps.markWrite();
  const result = await commit(deps.env, deps.session, planned, {
    manifestRevision: deps.manifest.revision,
    ...meta,
  });
  if (result.written) {
    deps.log.info(`Wrote ${result.changes.length} change(s) to settings.json.`);
  } else {
    deps.log.info(`Nothing written (${result.reason ?? "unknown"}).`);
  }
  return result;
}

async function warnStale(): Promise<void> {
  await vscode.window.showWarningMessage(
    "Settings changed while the preview was open — please review again.",
  );
}

async function reportBlocked(deps: CommandDeps, error: string): Promise<void> {
  deps.log.error(`Settings file is unreadable: ${error}`);
  const choice = await vscode.window.showErrorMessage(
    redact(
      `Your Claude Code settings file can't be read, so nothing was changed: ${deps.settingsFile}`,
    ),
    OPEN_FILE,
    RESTORE_BACKUP,
  );
  if (choice === OPEN_FILE) await openSettings(deps);
  if (choice === RESTORE_BACKUP) await restoreBackupCommand(deps);
}

function managedKeyFrom(arg: unknown): ManagedKey | undefined {
  if (typeof arg === "string") return arg as ManagedKey;
  const node = arg as Node | undefined;
  return node?.kind === "drift" ? node.key : undefined;
}

function fixFrom(arg: unknown): { command: string; args?: readonly unknown[] } | undefined {
  const node = arg as Node | undefined;
  if (node?.kind === "check" && node.result.fix.kind === "command") return node.result.fix;
  if (node?.kind === "drift" && node.child.fix.kind === "command") return node.child.fix;
  return undefined;
}
