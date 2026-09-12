import * as vscode from "vscode";
import type { WindowsTerminalCli } from "../terminal/windows.js";

const SETTING = "sensibleDefaults.enableWindowsTerminalCli";
const pendingLaunches = new WeakSet<WindowsTerminalCli>();

export async function openWindowsTerminal(support: WindowsTerminalCli | undefined): Promise<void> {
  if (support === undefined) {
    void vscode.window.showInformationMessage(
      "This launcher is available in native Windows VS Code windows only. Use Claude Code's terminal command on other hosts.",
    );
    return;
  }
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      "Review and trust this workspace before launching Claude. No terminal was opened.",
    );
    return;
  }
  if (pendingLaunches.has(support)) return;
  pendingLaunches.add(support);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Checking Claude before opening the terminal…",
      },
      async () => {
        const result = await support.prepareLaunch();
        if (!vscode.workspace.isTrusted) return;
        if (result.kind !== "ready") {
          void vscode.window.showWarningMessage(
            "Claude could not be launched safely. Check Installation in Details, or ask IT to check the Claude installation and application controls. No system settings were changed.",
          );
          return;
        }
        try {
          // Direct executable launch: no shell command, quoting, workspace lookup, or
          // dependency on the PATH seen by another extension's pre-launch check.
          const terminal = vscode.window.createTerminal({
            name: "Claude Code (Sensible Defaults)",
            shellPath: result.file,
            shellArgs: [],
            isTransient: true,
            env: { NoDefaultCurrentDirectoryInExePath: "1" },
          });
          const closed = vscode.window.onDidCloseTerminal((ended) => {
            if (ended !== terminal) return;
            closed.dispose();
            const code = ended.exitStatus?.code;
            if (code !== undefined && code !== 0)
              void vscode.window.showWarningMessage(
                `Claude exited with code ${code}. Check the terminal output; if Windows blocked execution, ask IT to review application controls. No security policy was changed.`,
              );
          });
          terminal.show();
        } catch {
          void vscode.window.showWarningMessage(
            "VS Code could not open the Claude terminal. Check terminal settings and ask IT whether application controls allow the installed Claude executable.",
          );
        }
      },
    );
  } finally {
    pendingLaunches.delete(support);
  }
}

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
  void vscode.window.showInformationMessage(
    enabled
      ? "Claude is enabled for new VS Code terminals. Reopen your terminal, then run claude --version, or use Sensible Defaults: Open Claude Terminal. Claude Code's own Launch in terminal button checks a different PATH and may still fail."
      : "Claude terminal repair is disabled. Reopen your terminals to remove the added search path.",
  );
}
