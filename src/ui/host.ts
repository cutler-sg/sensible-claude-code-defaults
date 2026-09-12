/**
 * The one place VS Code is adapted to the injected dependencies the rest of the
 * extension takes. Everything below `src/config/` and `src/health/` is
 * `vscode`-free by invariant; this file is where that invariant is paid for.
 */

import { execFile as execFileCallback } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import {
  FileSnapshotStore,
  resolveClaudeDir,
  settingsPath,
  snapshotPath,
} from "../config/index.js";
import type { ConfigEnv } from "../config/types.js";
import { TerminalTokenEnv } from "../credential/env.js";
import { SecretTokenStore } from "../credential/store.js";
import type { TokenStore } from "../credential/types.js";
import { detectClaudeCode } from "../health/context.js";
import type { ClaudeCodeDetection } from "../health/types.js";
import { WindowsTerminalCli } from "../terminal/windows.js";

const execFile = promisify(execFileCallback);

export interface Host {
  env: ConfigEnv;
  claudeDir: string;
  settingsFile: string;
  detect: () => Promise<ClaudeCodeDetection>;
  /** FR-4.1: the OS keychain, behind the `vscode`-free `TokenStore` contract. */
  store: TokenStore;
  /** FR-4.3: the integrated-terminal collection, with `persistent` off. */
  terminal: TerminalTokenEnv;
  windowsTerminal: WindowsTerminalCli | undefined;
  /**
   * FR-4.8's scan inputs, read per call. `isTrusted` in particular must not be
   * captured: VS Code grants trust to a running window, so a value read at
   * activation would leave the scan permanently disabled in a folder the user
   * has since trusted.
   */
  leakScan: () => LeakScanHostDeps;
}

/** The `LeakScanDeps` a host can supply — everything but the token itself. */
export interface LeakScanHostDeps {
  folders: readonly string[];
  isTrusted: boolean;
  isTracked: (file: string) => Promise<boolean | undefined>;
}

/**
 * Whether git tracks a path (FR-4.8).
 *
 * `git ls-files --error-unmatch` is the question stated exactly: it exits 0 for
 * a tracked path and non-zero for anything else, including "not a repository"
 * and "git is not installed". Those two are indistinguishable from "not
 * tracked" at the exit code, which is why a non-zero answer becomes `false`
 * rather than a claim — and why `cred.leak`'s untracked wording still tells the
 * user to rotate.
 *
 * `--` separates the path from any option, so a file named `-n` cannot become
 * a flag.
 */
async function gitTracks(file: string): Promise<boolean | undefined> {
  try {
    await execFile("git", ["ls-files", "--error-unmatch", "--", file], {
      cwd: dirname(file),
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/** Past this, the answer is not worth the wait — the scan has its own budget. */
const GIT_TIMEOUT_MS = 2000;

export function createHost(context: vscode.ExtensionContext): Host {
  const claudeDir = resolveClaudeDir();
  const workspaceFolders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const platform = process.platform;
  const pathVariable =
    Object.keys(process.env)
      .sort()
      .find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const windowsTerminal =
    platform === "win32"
      ? new WindowsTerminalCli({
          path: () => process.env[pathVariable] ?? "",
          pathExt: () => process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
          extensionPath: () =>
            vscode.extensions.getExtension("anthropic.claude-code")?.extensionPath,
          workspaceFolders: () =>
            vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
          enabled: () =>
            vscode.workspace
              .getConfiguration()
              .get("sensibleDefaults.enableWindowsTerminalCli", false),
          stat,
          realpath,
          execFile,
          collection: context.environmentVariableCollection,
          pathVariable,
        })
      : undefined;

  const env: ConfigEnv = {
    claudeDir,
    workspaceFolders,
    snapshotStore: new FileSnapshotStore(snapshotPath(claudeDir), {
      workspaceFolders,
      platform,
    }),
    platform,
  };

  return {
    env,
    claudeDir,
    settingsFile: settingsPath(claudeDir),
    store: new SecretTokenStore(context.secrets),
    // Constructing this asserts `persistent === false` (§10.4 #4). It throws
    // if the collection refuses, which is deliberate: a collection VS Code
    // caches to disk must not receive the token at all.
    terminal: new TerminalTokenEnv(context.environmentVariableCollection),
    windowsTerminal,
    // Read per call, never captured: trust is granted to a running window, and
    // a folder can be added to a window after activation.
    leakScan: () => ({
      folders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
      isTrusted: vscode.workspace.isTrusted,
      isTracked: gitTracks,
    }),
    detect: async () => {
      if (windowsTerminal !== undefined) {
        const terminal = await windowsTerminal.refresh();
        const version =
          vscode.extensions.getExtension("anthropic.claude-code")?.packageJSON?.version;
        return {
          extension:
            typeof version === "string" ? { installed: true, version } : { installed: false },
          cli:
            terminal.kind === "standalone"
              ? { found: true, version: terminal.version }
              : { found: false },
          windowsTerminal: terminal,
        };
      }
      return detectClaudeCode({
        getExtensionVersion: () => {
          const version =
            vscode.extensions.getExtension("anthropic.claude-code")?.packageJSON?.version;
          return typeof version === "string" ? version : undefined;
        },
        execFile,
      });
    },
  };
}
