import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { command, NO_FIX } from "./shared.js";

/**
 * FR-1.4 signal 2. Informational in both directions: the Claude Code extension
 * bundles its own binary and does not always place one on PATH, so a missing
 * CLI is a normal install and must never read as a fault.
 */
export const installCliCheck = {
  id: "install.cli",
  group: "Installation",
  run(ctx: CheckContext): CheckResult {
    const terminal = ctx.detection.windowsTerminal;
    if (terminal !== undefined && terminal.kind !== "standalone") {
      if (terminal.kind === "enabled")
        return {
          id: "install.cli",
          group: "Installation",
          level: "pass",
          label: "Claude is enabled for new VS Code terminals",
          detail: `Bundled version ${terminal.version}. Use Open Claude Terminal here; Claude Code's own launcher checks a different PATH and may still fail. External terminals are unchanged. Disable terminal repair from the Command Palette.`,
          fix: command("sensibleDefaults.openClaudeTerminal", "Open Claude Terminal"),
        };
      if (terminal.kind === "available")
        return {
          id: "install.cli",
          group: "Installation",
          level: "info",
          label: "Claude can be enabled in VS Code terminals",
          detail:
            "The extension's bundled command works. Enable it for new integrated terminals without installing another copy.",
          fix: command("sensibleDefaults.enableWindowsTerminalCli", "Enable in VS Code terminals"),
        };
      const details = {
        path: "Some command search locations could not be checked safely. Ask IT to check your PATH; no competing command will be replaced.",
        launcher:
          "An existing Claude script was found and left unchanged. Run claude --version in your terminal; ask IT for help if it fails.",
        execution:
          "Claude was found but could not be verified as runnable. Ask IT to check application controls or repair the installation. Security policies were not bypassed.",
        bundle:
          "The registered extension's bundled executable could not be located safely. Update or repair Claude Code, or ask IT for the standalone CLI.",
        environment:
          "The terminal environment could not be updated reliably. Reload VS Code and check again; do not assume existing terminals changed.",
      };
      return {
        id: "install.cli",
        group: "Installation",
        level: "info",
        label: "Claude terminal access needs checking",
        detail: details[terminal.reason],
        fix: command("sensibleDefaults.runHealthCheck", "Check again"),
      };
    }
    const cli = ctx.detection.cli;
    if (!cli.found) {
      return {
        id: "install.cli",
        group: "Installation",
        level: "info",
        label: LABELS["install.cli"].missing,
        fix: NO_FIX,
      };
    }
    return {
      id: "install.cli",
      group: "Installation",
      level: "pass",
      label: LABELS["install.cli"].pass,
      detail: `Version ${cli.version}`,
      fix: NO_FIX,
    };
  },
} satisfies Check;
