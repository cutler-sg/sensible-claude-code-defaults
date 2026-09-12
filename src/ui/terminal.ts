import * as vscode from "vscode";
import type { WindowsTerminalCli } from "../terminal/windows.js";

const SETTING = "sensibleDefaults.enableWindowsTerminalCli";

export async function configureWindowsTerminal(
  support: WindowsTerminalCli | undefined,
  enabled: boolean,
): Promise<void> {
  if (support === undefined) {
    await vscode.window.showInformationMessage(
      "This terminal repair is available in native Windows VS Code windows only. WSL and remote hosts are unchanged.",
    );
    return;
  }
  if (enabled) {
    const state = await support.refresh();
    if (state.kind !== "available" && state.kind !== "enabled") {
      await vscode.window.showWarningMessage(
        "Claude terminal access could not be repaired safely. Check Installation in Details for the reason. Existing commands and system settings have been left alone.",
      );
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      "Enable Claude in new VS Code terminals?",
      {
        modal: true,
        detail:
          "Uses the installed Claude Code extension's bundled executable. No launcher files, administrator access, or system PATH changes. Existing terminals must be reopened. External terminals are unchanged. Turn this off with Disable Claude Terminal Repair.",
      },
      "Enable",
    );
    if (choice !== "Enable") return;
  }
  await vscode.workspace
    .getConfiguration()
    .update(SETTING, enabled, vscode.ConfigurationTarget.Global);
  const state = await support.refresh();
  if (enabled && state.kind !== "enabled") {
    await vscode.window.showWarningMessage(
      "The preference was saved, but Claude could not be enabled. Check Installation in Details; your device may restrict execution or terminal changes.",
    );
    return;
  }
  if (!enabled && state.kind === "blocked" && state.reason === "environment") {
    await vscode.window.showWarningMessage(
      "The preference was disabled, but the terminal environment could not be cleared. Reload VS Code before opening another terminal.",
    );
    return;
  }
  await vscode.window.showInformationMessage(
    enabled
      ? "Claude is enabled for new VS Code terminals. Reopen your terminal, then run claude --version. Shell profiles can still override command resolution."
      : "Claude terminal repair is disabled. Reopen your terminals to remove the added search path.",
  );
}
