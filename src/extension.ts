import * as vscode from "vscode";
import { backupsDir, createSession } from "./config/index.js";
import { BUNDLED_MANIFEST } from "./manifest/bundled.js";
import { registerCommands } from "./ui/commands.js";
import { createHealthRunner } from "./ui/healthRunner.js";
import { createHost } from "./ui/host.js";
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

  let suppressUntil = 0;

  const runHealth = createHealthRunner({
    env: host.env,
    manifest,
    platform: process.platform,
    detect: host.detect,
    log,
    notified: context.globalState,
    present: (report) => {
      provider.setReport(report);
      view.badge =
        provider.errorCount > 0
          ? { value: provider.errorCount, tooltip: `${provider.errorCount} problem(s) to fix` }
          : undefined;
    },
  });

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
  // after `activate` returns rather than inside it. The opt-out is read here,
  // not around the toast: someone who turns the startup check off is asking us
  // not to touch their configuration on startup at all, and "Check
  // Configuration" from the palette still works.
  setImmediate(() => {
    if (!vscode.workspace.getConfiguration().get("sensibleDefaults.checkOnStartup", true)) {
      log.info("Startup health check skipped: sensibleDefaults.checkOnStartup is off.");
      return;
    }
    void runHealth();
  });
}

export function deactivate(): void {
  // Nothing to tear down; all disposables are owned by the extension context.
}
