/**
 * One health run, end to end: build the context, run the catalogue, repaint the
 * panel, and decide whether the result is worth interrupting the user over.
 *
 * It lives here rather than as a closure inside `activate` for two reasons.
 * Both call sites invoke it as `void runHealth()` — from `setImmediate` at
 * activation and from the file watcher — so a rejection has nowhere to go and
 * lands as an unhandled rejection in the extension host's log, with the panel
 * stuck on "Checking your Claude Code configuration…" and no clue for the user.
 * The returned function therefore never rejects. And the FR-5.5 notification
 * gate is a rule worth testing, which a closure over `activate`'s locals is not.
 */

import * as vscode from "vscode";
import type { ConfigEnv } from "../config/types.js";
import type { TokenEnv } from "../credential/types.js";
import { ALL_CHECKS } from "../health/catalogue.js";
import type { CredentialDeps, LeakScanContextDeps } from "../health/context.js";
import { buildContext } from "../health/context.js";
import { runAll, transition } from "../health/runner.js";
import type { Check, ClaudeCodeDetection, HealthReport } from "../health/types.js";
import type { Manifest } from "../manifest/types.js";
import type { Logger } from "../util/log.js";
import { failureMessage, reportFailure } from "./failures.js";
import type { ResolvedManifest } from "./manifestHolder.js";
import { APPLY_ACTION, decideNotification, type NotificationKind } from "./notify.js";
import { needsSetup } from "./treeProvider.js";

/**
 * The `globalState` slice the runner needs. Narrower than `vscode.Memento` so a
 * test can stand one in, and satisfied by the real thing.
 */
export interface NotifiedStore {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface HealthRunnerDeps {
  env: ConfigEnv;
  /**
   * The manifest in force, read afresh on every run — a function, not a value,
   * for the same reason `credential` is one. The host re-resolves it on the
   * hourly boundary and on "Check for Updated Recommendations", and a copy
   * captured at wiring time would pin the panel to whatever the first run
   * resolved (usually the bundled floor) for the life of the window.
   */
  manifest: () => ResolvedManifest;
  platform: NodeJS.Platform;
  detect: () => Promise<ClaudeCodeDetection>;
  log: Logger;
  /** Repaint the panel: the tree, the badge, anything else the view owns. */
  present: (report: HealthReport) => void;
  onFailure?: (message: string) => void;
  /** Survives the window, so a toast fires once per user, not once per window. */
  notified: NotifiedStore;
  /** Called when the silent permission repair touched the file (F14). */
  onSelfWrite?: () => void;
  /**
   * The credential sources, read afresh on every run. A function rather than a
   * value because `lastTest` changes between runs: the host holds it in memory
   * and a stale copy captured at wiring time would leave `cred.valid` reporting
   * "not tested yet" immediately after a test.
   */
  credential?: () => CredentialDeps;
  /**
   * The integrated-terminal collection, re-derived from the keychain on every
   * run (F13). The collection is a per-window copy of the token that only the
   * flow which changed the key used to touch, so a second window went on
   * exporting a key the first had cleared, into every terminal it opened.
   */
  terminal?: TokenEnv;
  /**
   * FR-4.8's scan inputs, read afresh on every run for the same reason
   * `credential` is: trust is granted to a running window, and folders can be
   * added to one. A copy captured at wiring time would leave the scan disabled
   * for the life of a window the user has since trusted.
   */
  leakScan?: () => LeakScanContextDeps;
  /** Injected only so a test can run a small catalogue. */
  checks?: readonly Check[];
}

/**
 * Said when the run itself fails — a `settings.json` that is a directory, a
 * `~/.claude` we cannot stat. It names no path and quotes no raw exception.
 */
export const HEALTH_FAILED_MESSAGE =
  "Couldn't check your Claude Code configuration. Use Copy Diagnostics for support, then try Check Configuration again.";

/** FR-5.5 bookkeeping, keyed by manifest revision so new advice can speak once. */
export function notifiedKey(manifestRevision: string): string {
  return `sensibleDefaults.notified.${manifestRevision}`;
}

export function createHealthRunner(deps: HealthRunnerDeps): () => Promise<void> {
  const checks = deps.checks ?? ALL_CHECKS;
  let previous: HealthReport | undefined;
  // One failure toast per window. A broken `~/.claude` makes every watcher
  // event fail the same way, and a queue of identical toasts is what makes
  // people uninstall an extension.
  let reportedFailure = false;

  const run = async (): Promise<void> => {
    const resolved = deps.manifest();
    const ctx = await buildContext({
      env: deps.env,
      manifest: resolved.manifest,
      manifestStatus: resolved.status,
      platform: deps.platform,
      detect: deps.detect,
      ...(deps.onSelfWrite ? { onSelfWrite: deps.onSelfWrite } : {}),
      ...(deps.credential ? { credential: deps.credential() } : {}),
      ...(deps.leakScan ? { leakScan: deps.leakScan() } : {}),
    });
    const report = await runAll(checks, ctx);
    await syncTerminals(deps);
    deps.present(report);
    await vscode.commands.executeCommand("setContext", "sensibleDefaults.hasReport", true);
    await vscode.commands.executeCommand(
      "setContext",
      "sensibleDefaults.needsSetup",
      needsSetup(report),
    );
    deps.log.info(`Health check: ${JSON.stringify(report.counts)}`);

    const kind = transition(previous, report);
    previous = report;
    await notify(deps, kind, report, resolved.manifest);
  };

  return async (): Promise<void> => {
    try {
      await run();
    } catch (error) {
      const notify = !reportedFailure;
      reportedFailure = true;
      const message = failureMessage(error, HEALTH_FAILED_MESSAGE);
      try {
        deps.onFailure?.(message);
      } catch {
        // A failed renderer must not prevent the independent notification.
      }
      await reportFailure(deps.log, message, notify);
    }
  };
}

/**
 * Bring the terminal collection back in line with the keychain (F13).
 *
 * The keychain is read here rather than taken from the context on purpose: a
 * `CheckContext` has no field a token value can go into, which is what makes
 * hard rule 4 structural for every check. So this is a second read — the same
 * one `pushTokenToTerminals` does at activation, and cheap enough at the rate
 * health runs happen.
 *
 * A keychain that will not open leaves the collection exactly as it is: "we
 * could not ask" is not evidence the key is gone, and `cred.present` already
 * reports that condition with a message the user can act on.
 */
async function syncTerminals(deps: HealthRunnerDeps): Promise<void> {
  const terminal = deps.terminal;
  const credential = deps.credential?.();
  if (terminal === undefined || credential === undefined) return;

  let stored: Awaited<ReturnType<CredentialDeps["store"]["get"]>>;
  try {
    stored = await credential.store.get();
  } catch (error) {
    deps.log.warn(`Could not read the system keychain: ${messageOf(error)}`);
    return;
  }

  if (stored === undefined) {
    terminal.clear();
    return;
  }
  terminal.apply(stored.token);
}

async function notify(
  deps: HealthRunnerDeps,
  kind: NotificationKind,
  report: HealthReport,
  manifest: Manifest,
): Promise<void> {
  // FR-5.5: no toast at all when the user has opted out of the startup check.
  // The opt-out also skips the startup run itself (see `extension.ts`); this is
  // the same preference applied to the runs a file change triggers.
  if (!vscode.workspace.getConfiguration().get("sensibleDefaults.checkOnStartup", true)) return;

  const key = notifiedKey(manifest.revision);
  const fired = deps.notified.get<string[]>(key, []);
  if (fired.includes(kind)) return;

  const notification = decideNotification(kind, report);
  if (notification === undefined) return;

  // Recorded before the toast is shown, not after: `showInformationMessage`
  // resolves when the user dismisses it, and a second run in that window would
  // otherwise stack a duplicate on top of the one already on screen.
  await deps.notified.update(key, [...fired, kind]);

  const choice = await vscode.window.showInformationMessage(
    notification.message,
    ...notification.actions,
  );
  if (choice === APPLY_ACTION) {
    await vscode.commands.executeCommand("sensibleDefaults.applyDefaults");
  } else if (choice !== undefined) {
    await vscode.commands.executeCommand("sensibleDefaults.health.focus");
  }
}

/**
 * `Logger` redacts everything it writes, so the only job here is to keep a
 * non-`Error` throw from being stringified into the channel as whatever it is.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "an unexpected failure";
}
