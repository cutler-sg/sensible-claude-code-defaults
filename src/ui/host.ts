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
import { detectClaudeCode } from "../health/context.js";
import type { ClaudeCodeDetection } from "../health/types.js";

const execFile = promisify(execFileCallback);

export interface Host {
  env: ConfigEnv;
  claudeDir: string;
  settingsFile: string;
  detect: () => Promise<ClaudeCodeDetection>;
}

export function createHost(): Host {
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
