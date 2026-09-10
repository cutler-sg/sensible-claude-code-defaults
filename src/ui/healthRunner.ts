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
import { ALL_CHECKS } from "../health/catalogue.js";
import { buildContext } from "../health/context.js";
import { runAll, transition } from "../health/runner.js";
import type { Check, ClaudeCodeDetection, HealthReport } from "../health/types.js";
import type { Manifest } from "../manifest/types.js";
import type { Logger } from "../util/log.js";
import { APPLY_ACTION, decideNotification, type NotificationKind } from "./notify.js";

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
  manifest: Manifest;
  platform: NodeJS.Platform;
  detect: () => Promise<ClaudeCodeDetection>;
  log: Logger;
  /** Repaint the panel: the tree, the badge, anything else the view owns. */
  present: (report: HealthReport) => void;
  /** Survives the window, so a toast fires once per user, not once per window. */
  notified: NotifiedStore;
  /** Injected only so a test can run a small catalogue. */
  checks?: readonly Check[];
}

/**
 * Said when the run itself fails — a `settings.json` that is a directory, a
 * `~/.claude` we cannot stat. It names no path and quotes no error: the detail
 * is in the output channel, and this audience cannot act on an errno.
 */
export const HEALTH_FAILED_MESSAGE =
  "Couldn't check your Claude Code configuration — see the output log";

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
    const ctx = await buildContext({
      env: deps.env,
      manifest: deps.manifest,
      platform: deps.platform,
      detect: deps.detect,
    });
    const report = await runAll(checks, ctx);
    deps.present(report);
    await vscode.commands.executeCommand("setContext", "sensibleDefaults.hasReport", true);
    deps.log.info(`Health check: ${JSON.stringify(report.counts)}`);

    const kind = transition(previous, report);
    previous = report;
    await notify(deps, kind, report);
  };

  return async (): Promise<void> => {
    try {
      await run();
    } catch (error) {
      deps.log.error(`Health check failed: ${messageOf(error)}`);
      if (reportedFailure) return;
      reportedFailure = true;
      await vscode.window.showErrorMessage(HEALTH_FAILED_MESSAGE);
    }
  };
}

async function notify(
  deps: HealthRunnerDeps,
  kind: NotificationKind,
  report: HealthReport,
): Promise<void> {
  // FR-5.5: no toast at all when the user has opted out of the startup check.
  // The opt-out also skips the startup run itself (see `extension.ts`); this is
  // the same preference applied to the runs a file change triggers.
  if (!vscode.workspace.getConfiguration().get("sensibleDefaults.checkOnStartup", true)) return;

  const key = notifiedKey(deps.manifest.revision);
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
