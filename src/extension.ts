import * as vscode from "vscode";
import { backupsDir, createSession } from "./config/index.js";
import { ALL_CHECKS } from "./health/catalogue.js";
import { buildContext } from "./health/context.js";
import { runAll, transition } from "./health/runner.js";
import type { HealthReport } from "./health/types.js";
import { BUNDLED_MANIFEST } from "./manifest/bundled.js";
import { registerCommands } from "./ui/commands.js";
import { createHost } from "./ui/host.js";
import { APPLY_ACTION, decideNotification, type NotificationKind } from "./ui/notify.js";
import { HealthTreeProvider } from "./ui/treeProvider.js";
import { watchSettings } from "./ui/watcher.js";
import { Logger } from "./util/log.js";

/** How long after our own write the watcher ignores the directory (plan Q-Q). */
const SUPPRESS_MS = 1500;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("Sensible Claude Code Defaults", { log: true });
  const log = new Logger(channel);
  log.info(`Sensible Claude Code Defaults ${context.extension.packageJSON.version} activated.`);

  const host = createHost();
  const manifest = BUNDLED_MANIFEST;
  const provider = new HealthTreeProvider();
  const view = vscode.window.createTreeView("sensibleDefaults.health", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  let previous: HealthReport | undefined;
  let suppressUntil = 0;
  const fired = new Set<NotificationKind>();

  const runHealth = async (): Promise<void> => {
    const ctx = await buildContext({
      env: host.env,
      manifest,
      platform: process.platform,
      detect: host.detect,
    });
    const report = await runAll(ALL_CHECKS, ctx);
    provider.setReport(report);
    view.badge =
      provider.errorCount > 0
        ? { value: provider.errorCount, tooltip: `${provider.errorCount} problem(s) to fix` }
        : undefined;
    await vscode.commands.executeCommand("setContext", "sensibleDefaults.hasReport", true);
    log.info(`Health check: ${JSON.stringify(report.counts)}`);

    const kind = transition(previous, report);
    previous = report;
    // FR-5.5: at most one toast of each kind per window, and none at all when
    // the user has opted out of the startup check.
    if (
      fired.has(kind) ||
      !vscode.workspace.getConfiguration().get("sensibleDefaults.checkOnStartup", true)
    )
      return;
    const notification = decideNotification(kind, report);
    if (notification === undefined) return;
    fired.add(kind);
    const choice = await vscode.window.showInformationMessage(
      notification.message,
      ...notification.actions,
    );
    if (choice === APPLY_ACTION) {
      await vscode.commands.executeCommand("sensibleDefaults.applyDefaults");
    } else if (choice !== undefined) {
      await vscode.commands.executeCommand("sensibleDefaults.health.focus");
    }
  };

  const commands = registerCommands({
    env: host.env,
    session: createSession(),
    manifest,
    settingsFile: host.settingsFile,
    backupsDir: backupsDir(host.claudeDir),
    log,
    runHealth,
    markWrite: () => {
      suppressUntil = Date.now() + SUPPRESS_MS;
    },
  });

  const watcher = watchSettings(host.claudeDir, host.settingsFile, () => void runHealth(), {
    suppress: () => Date.now() < suppressUntil,
  });

  context.subscriptions.push(channel, view, commands, watcher);
  // §13: activation must add < 100 ms to startup, so the first run happens
  // after `activate` returns rather than inside it.
  setImmediate(() => void runHealth());
}

export function deactivate(): void {
  // Nothing to tear down; all disposables are owned by the extension context.
}
