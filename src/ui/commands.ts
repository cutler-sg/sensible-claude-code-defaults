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
  type ModeRepair,
  plan,
  type ReadyPlan,
  redactChanges,
  repairPermissions,
  resetKeyPlan,
  restore,
} from "../config/index.js";
import type { Desired, ManagedKey, PlanResult } from "../config/types.js";
import { DIAGNOSTICS_EXCLUDES, DIAGNOSTICS_INCLUDES } from "../diagnostics/report.js";
import { keyDisplayName } from "../health/labels.js";
import { desiredFromManifest, type Manifest } from "../manifest/types.js";
import type { WindowsTerminalCli } from "../terminal/windows.js";
import type { Logger } from "../util/log.js";
import { redact } from "../util/redact.js";
import { collectDiagnostics, type DiagnosticsHostDeps } from "./diagnostics.js";
import { failureMessage, reportFailure } from "./failures.js";
import {
  adoptToken,
  type CredentialFlowDeps,
  clearToken,
  type FlowDeps,
  reapplyToken,
  resolveTokenConflict,
  rotateToken,
  setToken,
  testConnection,
} from "./flows.js";
import {
  describeChange,
  describeDroppedProtection,
  droppedProtections,
  pluralize,
  relativeAge,
} from "./present.js";
import { configureWindowsTerminal } from "./terminal.js";
import type { Node } from "./treeProvider.js";

export interface CommandDeps {
  windowsTerminal?: WindowsTerminalCli;
  env: ConfigEnv;
  session: ApplySession;
  /**
   * The manifest in force, read afresh on every invocation — a function for the
   * same reason the health runner takes one. The host re-resolves it on the
   * hourly boundary and on "Check for Updated Recommendations", and a value
   * captured at registration would leave `selectRegion` offering the regions
   * that shipped in the VSIX, and `applyDefaults` writing them, for the life of
   * the window.
   */
  manifest: () => Manifest;
  settingsFile: string;
  backupsDir: string;
  log: Logger;
  /** Re-run the checks and repaint the panel. */
  runHealth: () => Promise<void>;
  /** Open the watcher's suppression window; called after every write. */
  markWrite: () => void;
  /** The keychain, the terminal collection, and where a test result goes. */
  credential: CredentialFlowDeps;
  /**
   * FR-3.3's manual refresh: re-resolve the manifest ignoring the hourly
   * throttle. Optional so a host that has not wired the resolver still gets a
   * working command surface; the command then simply re-runs the checks.
   */
  refreshManifest?: (options: { force: true }) => Promise<boolean>;
  /**
   * FR-7.1's inputs, injected. Optional so a host that has not wired the
   * report — every test of another command, and the M0 shape of `activate` —
   * still gets a working command surface; `copyDiagnostics` then says the
   * checks have not run rather than throwing.
   */
  diagnostics?: Omit<DiagnosticsHostDeps, "extensionVersion" | "settingsFile" | "log">;
  /** This extension's version, for the diagnostics header. */
  extensionVersion?: string;
  now?: () => Date;
}

const OPEN_FILE = "Open file";
const RESTORE_BACKUP = "Restore backup";
const CONTINUE = "Continue";
const REPLACE = "Replace";
const CANCEL = "Cancel";

/** One retry, everywhere. See `commitSingle`. */
const MAX_STALE_RETRIES = 1;

/**
 * Every command this file registers, as data.
 *
 * Registration is derived from this table rather than written out beside it, so
 * the ids a test can read are the ids the extension actually registers — a
 * cross-check against `package.json` proves something only if there is no
 * second list for the two to drift apart on.
 */
const HANDLERS = {
  "sensibleDefaults.enableWindowsTerminalCli": async (deps) => {
    await configureWindowsTerminal(deps.windowsTerminal, true);
    await deps.runHealth();
  },
  "sensibleDefaults.disableWindowsTerminalCli": async (deps) => {
    await configureWindowsTerminal(deps.windowsTerminal, false);
    await deps.runHealth();
  },
  "sensibleDefaults.runHealthCheck": (deps) => deps.runHealth(),
  "sensibleDefaults.checkForUpdates": (deps) => checkForUpdates(deps),
  "sensibleDefaults.applyDefaults": (deps) => applyDefaults(deps, 0),
  "sensibleDefaults.openSettings": (deps) => openSettings(deps),
  "sensibleDefaults.restoreBackup": (deps) => restoreBackupCommand(deps),
  "sensibleDefaults.resetKey": (deps, node) => resetKey(deps, node, 0),
  "sensibleDefaults.selectRegion": (deps) => selectRegion(deps),
  "sensibleDefaults.repairPermissions": (deps) => repairPermissionsCommand(deps),
  "sensibleDefaults.runFix": (deps, node) => runFix(deps, node),
  "sensibleDefaults.copyDiagnostics": (deps) => copyDiagnostics(deps),
  "sensibleDefaults.openLeakedFile": (deps, file, line) => openLeakedFile(deps, file, line),
  // FR-4's flows. They take the same injected shape, so `CommandDeps` is a
  // `FlowDeps` and the two files share one dependency graph rather than two.
  "sensibleDefaults.setToken": (deps) => setToken(deps),
  "sensibleDefaults.rotateToken": (deps) => rotateToken(deps),
  "sensibleDefaults.clearToken": (deps) => clearToken(deps),
  "sensibleDefaults.testConnection": (deps) => testConnection(deps),
  "sensibleDefaults.adoptToken": (deps) => adoptToken(deps),
  "sensibleDefaults.reapplyToken": (deps) => reapplyToken(deps),
  "sensibleDefaults.resolveTokenConflict": (deps) => resolveTokenConflict(deps),
} satisfies Record<string, (deps: CommandDeps & FlowDeps, ...args: never[]) => Promise<void>>;

export const COMMAND_IDS = Object.keys(HANDLERS) as readonly (keyof typeof HANDLERS)[];

export function registerCommands(deps: CommandDeps): vscode.Disposable {
  const register = (id: keyof typeof HANDLERS): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      deps.log.info(`Command: ${id}`);
      try {
        await (HANDLERS[id] as (deps: CommandDeps, ...a: unknown[]) => Promise<void>)(
          deps,
          ...args,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await reportFailure(
          deps.log,
          failureMessage(error, redact(`That didn't work: ${message}`)),
        );
      }
    });

  return vscode.Disposable.from(...COMMAND_IDS.map(register));
}

/**
 * FR-6.1: preview, then write. A stale plan is recomputed, never forced.
 *
 * The manifest is captured once, at the top, and threaded through (F7). It used
 * to be read twice — for `desiredFromManifest` here, and again for the revision
 * stamp after the QuickPick resolved — and a QuickPick is modal to the user,
 * not to the event loop, so an hourly refresh lands between the two reads
 * happily. The file then held one revision's values while the snapshot recorded
 * another's, and `config.stale` compared the snapshot against the manifest in
 * force, found them equal, and reported the user up to date permanently.
 *
 * A retry re-reads deliberately: it recomputes the plan the user must accept
 * again, so it recomputes what that plan is against too.
 */
async function applyDefaults(deps: CommandDeps, attempt: number): Promise<void> {
  const manifest = deps.manifest();
  const desired = desiredFromManifest(manifest);
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
  // F2: protections this apply would drop, said as sentences and placed above
  // everything else. They are already in the change rows, as a before-set and
  // an after-set joined by commas — which is a diff the reader has to compute,
  // and computing it is the thing this audience cannot do. A QuickPick shows
  // only its first few items, so a loss below the fold is a loss unseen.
  const dropped = droppedProtections(changes);
  // Multi-step QuickPick rather than an untitled-document diff (plan Q-P): the
  // design target is a user for whom a JSON diff is not a readable object.
  // Only the first item confirms; the change rows are there to be read, so
  // picking one is treated as "I was reading, not deciding" — i.e. cancel.
  // That covers the loss rows too: they inform, they do not consent.
  const picked = await vscode.window.showQuickPick(
    [
      // Cancel is first so the highlighted item on open is the harmless one: a
      // stray Enter on a dialog the user has not read yet must never write.
      { label: CANCEL, description: "" },
      ...dropped.map((rule) => ({
        label: describeDroppedProtection(rule),
        description: PROTECTION_LOST,
      })),
      { label: confirmLabel, description: "Writes the changes listed below" },
      ...changes.map((change) => ({ label: describeChange(change), description: "" })),
    ],
    {
      canPickMany: false,
      title: applyTitle(count, dropped.length),
      placeHolder: "Review the changes, then choose Apply",
      ignoreFocusOut: true,
    },
  );
  if (picked?.label !== confirmLabel) {
    deps.log.info("applyDefaults cancelled by the user.");
    return;
  }

  const result = await commitPlan(deps, planned, { manifest });
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

/**
 * FR-3.3's manual refresh. The one path that bypasses the hourly throttle.
 *
 * It always re-runs the checks, even when nothing changed: the user pressed a
 * button, and a command that appears to do nothing is indistinguishable from a
 * broken one. What it *says* is decided by the revision, though — see below. It never reports a failed fetch (FR-3.2) — a network that is not
 * there produces "using the recommendations saved on this computer" in the
 * panel and a line in the log, which is the honest answer and the only one this
 * audience can act on.
 */
async function checkForUpdates(deps: CommandDeps): Promise<void> {
  // Compared by revision, not by the holder's boolean (F15). That boolean
  // answers "does the panel need repainting?", and the provenance is part of
  // it — so the first successful fetch after a run on the bundled copy
  // reported "Updated to the latest recommended settings" for a manifest
  // byte-identical to the one already in force. The revision is the manifest's
  // own answer to "am I a different set of recommendations?".
  const before = deps.manifest().revision;
  await deps.refreshManifest?.({ force: true });
  const updated = deps.manifest().revision !== before;
  await deps.runHealth();
  await vscode.window.showInformationMessage(
    updated
      ? "Updated to the latest recommended settings."
      : "You already have the latest recommended settings.",
  );
}

const PROTECTION_LOST = "Claude Code will be allowed to do this again";

/**
 * F2. The dialog is not neutral about a narrowing: the title says what is being
 * lost before the user reaches any row. `permissions.deny` is the only managed
 * key whose contents are a safety boundary, so this is the only apply that gets
 * a second sentence.
 */
function applyTitle(count: number, dropped: number): string {
  const ask = `Apply ${pluralize(count, "recommended change")}?`;
  return dropped === 0
    ? ask
    : `${ask} ${pluralize(dropped, "thing")} Claude Code cannot do today will stop being blocked.`;
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
  const manifest = deps.manifest();
  const desired = desiredFromManifest(manifest);
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
    manifest,
  });
}

async function selectRegion(deps: CommandDeps): Promise<void> {
  const regions = deps.manifest().regions;
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
  const manifest = deps.manifest();
  const desired: Desired = { "env.AWS_REGION": region };
  const planned = await resetKeyPlan(deps.env, desired, "env.AWS_REGION");
  await commitSingle(deps, planned, attempt, (next) => applyRegion(deps, region, next), {
    alreadyThere: `Your ${keyDisplayName("env.AWS_REGION")} is already ${region}.`,
    manifest,
  });
}

async function repairPermissionsCommand(deps: CommandDeps): Promise<void> {
  const outcome = await repairPermissions(deps.env);
  deps.log.info(`Permission repair: ${outcome.kind}`);
  // A verdict the user cannot act on is still information, but the three that
  // mean "we did not make this file private" are warnings, not notices: an
  // information toast is the same shape as success and reads as one.
  const settled = outcome.kind === "repaired" || outcome.kind === "aclRepaired";
  const show =
    settled || outcome.kind === "ok" || outcome.kind === "aclOk" || outcome.kind === "absent"
      ? vscode.window.showInformationMessage
      : vscode.window.showWarningMessage;
  await show(permissionMessage(outcome));
  await deps.runHealth();
}

/**
 * One sentence per outcome, in the user's terms rather than the platform's.
 *
 * Windows and POSIX share wording wherever they share a meaning: "private to
 * you" is the same promise whether it was kept by a mode bit or a DACL, and
 * naming the mechanism would only invite the user to go looking for a thing
 * their machine does not have.
 *
 * The two that are new in M6 are the ones that must not sound reassuring.
 * `unverifiable` used to be folded into "nothing to change", which told a user
 * whose ACL we could not read that everything was fine (plan Q-AG). Nothing
 * here quotes a path or an ACL entry — that detail belongs in the panel row's
 * tooltip, and the file's contents never reach a message at all (hard rule 4).
 */
function permissionMessage(outcome: ModeRepair): string {
  switch (outcome.kind) {
    case "repaired":
    case "aclRepaired":
      return "Your settings file is now readable only by you.";
    case "ok":
    case "aclOk":
      return "Your settings file was already private to you.";
    case "absent":
      return "There's no settings file yet, so there's nothing to protect.";
    case "aclLoose":
      return "Other people using this computer can still read your settings file, and we couldn't change that.";
    case "unverifiable":
      return "We couldn't tell who else can read your settings file on this computer.";
    case "unsupported":
      return "This computer doesn't offer a way to check who can read your settings file.";
  }
}

/**
 * FR-7.1. To the clipboard, not a file (plan Q-AC): the report is a
 * redacted-but-still-revealing dump of a user's configuration, and writing it
 * to disk creates a second artefact nobody remembers to delete — one that would
 * also have to live somewhere, and the one place hard rule 1 forbids is the
 * folder the user is looking at.
 *
 * The confirmation names what went in and what came out. A user who is about to
 * paste this into a public issue is entitled to know before they do, and
 * "diagnostics copied" tells them nothing they can act on.
 */
async function copyDiagnostics(deps: CommandDeps): Promise<void> {
  if (deps.diagnostics === undefined || deps.extensionVersion === undefined) {
    deps.log.warn("copyDiagnostics: the report is not wired in this host.");
    await vscode.window.showInformationMessage(
      "Diagnostics aren't available in this window yet — run Check Configuration first.",
    );
    return;
  }

  const text = await collectDiagnostics({
    ...deps.diagnostics,
    extensionVersion: deps.extensionVersion,
    settingsFile: deps.settingsFile,
    log: deps.log,
  });
  await vscode.env.clipboard.writeText(text);
  deps.log.info("Copied the diagnostics report to the clipboard.");
  await vscode.window.showInformationMessage(
    `Diagnostics copied. It includes ${listOf(DIAGNOSTICS_INCLUDES)}. It does not include ${DIAGNOSTICS_EXCLUDES}.`,
  );
}

/** An Oxford-comma list, so the confirmation reads as a sentence. */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/**
 * `cred.leak`'s fix (FR-4.8): open the file at the line, and change nothing.
 *
 * Hard rule 1 and plan Q-AD: the extension never writes inside a workspace
 * folder, so it cannot take the key out of the user's file — and would not want
 * to, because rotation is the real remedy and an edit that looks like a fix
 * discourages one. The file is opened, the user removes the line.
 */
async function openLeakedFile(deps: CommandDeps, file: unknown, line: unknown): Promise<void> {
  if (typeof file !== "string" || file === "") {
    deps.log.warn("openLeakedFile called without a file; ignoring.");
    return;
  }
  const at = typeof line === "number" && line > 0 ? line : 1;
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    // `selection` puts the cursor on the line without selecting its text: a
    // selected credential is one Ctrl+C from being somewhere else again.
    const position = new vscode.Position(at - 1, 0);
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(position, position),
    });
  } catch (error) {
    // The file was moved or removed between the scan and the click — which is
    // the good outcome, so it is said as information rather than as an error.
    deps.log.info(`Could not open the file the key was found in: ${messageOf(error)}`);
    await vscode.window.showInformationMessage(
      "That file isn't there any more. Run the check again to see if the key is still in your project.",
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "an unexpected failure";
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
  say: { alreadyThere: string; manifest: Manifest },
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
  const result = await commitPlan(deps, planned, { forceBackup: true, manifest: say.manifest });
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
  // F2, on the other write path: a reset of the blocked-commands list restores
  // the manifest's list over the user's, which can drop rules. Same
  // unreadable before/after set, same fix — the losses stated first, as
  // sentences, above the diff they would otherwise be buried in.
  const lost = droppedProtections(changes).map(describeDroppedProtection);
  const detail = [...lost, ...changes.map(describeChange)].join("\n");
  const choice = await vscode.window.showWarningMessage(
    `Replace your ${name} with the recommended value?`,
    { modal: true, detail: `${detail}\n\nYour current settings are saved first.` },
    REPLACE,
  );
  return choice === REPLACE;
}

/**
 * `meta.manifest` is the one the plan was built from, passed in rather than
 * re-read (F7): the stamp has to name the revision whose values are being
 * written, and the user's decision took long enough for a refresh to land.
 */
async function commitPlan(
  deps: CommandDeps,
  planned: ReadyPlan,
  meta: { manifest: Manifest; forceBackup?: true },
): Promise<CommitResult> {
  const { manifest, ...rest } = meta;
  // Suppression opens *before* the write, not after: the rename lands during
  // the call, so a window opened afterwards is already too late for the event.
  deps.markWrite();
  const result = await commit(deps.env, deps.session, planned, {
    manifestRevision: manifest.revision,
    ...rest,
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
