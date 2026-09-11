/**
 * The one place VS Code is adapted to the injected dependencies the rest of the
 * extension takes. Everything below `src/config/` and `src/health/` is
 * `vscode`-free by invariant; this file is where that invariant is paid for.
 */

import { execFile as execFileCallback } from "node:child_process";
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
}

export function createHost(context: vscode.ExtensionContext): Host {
  const claudeDir = resolveClaudeDir();
  const workspaceFolders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const platform = process.platform;

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
    detect: () =>
      detectClaudeCode({
        getExtensionVersion: () => {
          const version =
            vscode.extensions.getExtension("anthropic.claude-code")?.packageJSON?.version;
          return typeof version === "string" ? version : undefined;
        },
        execFile,
      }),
  };
}
