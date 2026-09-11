/**
 * Where the config engine is allowed to look and write.
 *
 * Invariant: nothing under `src/config/` imports `vscode` — the host injects
 * the environment and the workspace folders.
 */

import * as os from "node:os";
import * as path from "node:path";
import { ConfigError } from "./types.js";

/** `~/.claude/sensible-defaults` — our namespace inside Claude Code's home (plan Q-H). */
const STATE_DIR_NAME = "sensible-defaults";

/**
 * Resolve Claude Code's home directory.
 *
 * FR-1.2 says `path.join(os.homedir(), '.claude')`, but Claude Code honours
 * `$CLAUDE_CONFIG_DIR` and relocates `settings.json`, plugins and credentials
 * with it (plan Q-F). Ignoring it would write a file Claude Code never reads
 * and a health panel that lies, so the env var wins when set.
 */
export function resolveClaudeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    return path.resolve(expandHome(configured, homedir));
  }
  return path.join(homedir, ".claude");
}

/**
 * Expand a leading `~/` the way a shell would. A value exported from a shell
 * rc file is often written unexpanded and arrives here literally.
 */
function expandHome(target: string, homedir: string): string {
  if (target === "~") {
    return homedir;
  }
  if (target.startsWith("~/")) {
    return path.join(homedir, target.slice(2));
  }
  return target;
}

export function settingsPath(claudeDir: string): string {
  return path.join(claudeDir, "settings.json");
}

/** Our state namespace; keeps `state.json` and `backups/` out of Claude Code's own dirs. */
export function stateDir(claudeDir: string): string {
  return path.join(claudeDir, STATE_DIR_NAME);
}

/** Plan Q-H: not `~/.claude/backups/`, which Claude Code already owns. */
export function backupsDir(claudeDir: string): string {
  return path.join(stateDir(claudeDir), "backups");
}

/** Plan Q-D: the last-applied snapshot lives beside the file it describes. */
export function snapshotPath(claudeDir: string): string {
  return path.join(stateDir(claudeDir), "state.json");
}

/**
 * FR-2.6 / §10.4 assertion #2: refuse any write that resolves inside a
 * workspace folder. Every write path in `writer.ts` calls this — a
 * project-scoped `settings.local.json` is a per-repo copy of a per-device
 * credential, so it is refused by construction rather than by convention.
 */
export function assertOutsideWorkspace(
  target: string,
  workspaceFolders: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  // Pick the path flavour explicitly so tests can exercise Windows semantics
  // on POSIX. `path.win32` already compares case-insensitively, which is what
  // NTFS does — a workspace at `c:\proj` and a target at `C:\Proj` are one place.
  const p = platform === "win32" ? path.win32 : path.posix;
  const resolved = p.resolve(target);
  for (const folder of workspaceFolders) {
    if (!folder) {
      continue;
    }
    const root = p.resolve(folder);
    if (isAtOrInside(resolved, root, p)) {
      throw new ConfigError(
        "WRITE_INSIDE_WORKSPACE",
        `Refusing to write inside a workspace folder: ${resolved} is at or below ${root}`,
      );
    }
  }
}

function isAtOrInside(child: string, parent: string, p: path.PlatformPath): boolean {
  const relative = p.relative(parent, child);
  if (relative === "") {
    return true;
  }
  // `..` means the target escaped the folder; an absolute result means a
  // different root entirely (another Windows drive). Compare whole segments so
  // a sibling like `proj2` is never read as being inside `proj`.
  return !(relative === ".." || relative.startsWith(`..${p.sep}`) || p.isAbsolute(relative));
}
