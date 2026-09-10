import * as vscode from "vscode";
import { Logger } from "./util/log.js";

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("Sensible Claude Code Defaults", {
    log: true,
  });
  const log = new Logger(channel);
  const version = String(context.extension.packageJSON.version);
  log.info(`Sensible Claude Code Defaults ${version} activated.`);

  const runHealthCheck = vscode.commands.registerCommand(
    "sensibleDefaults.runHealthCheck",
    async () => {
      log.info("Health check requested; no checks are implemented yet.");
      await vscode.window.showInformationMessage("Health checks arrive in the next milestone.");
    },
  );

  context.subscriptions.push(channel, runHealthCheck);
}

export function deactivate(): void {
  // Nothing to tear down; all disposables are owned by the extension context.
}
