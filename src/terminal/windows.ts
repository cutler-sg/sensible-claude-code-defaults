import { win32 as path } from "node:path";

export type WindowsTerminalStatus =
  | { kind: "standalone"; version: string }
  | { kind: "available"; version: string }
  | { kind: "enabled"; version: string }
  | { kind: "blocked"; reason: "path" | "launcher" | "execution" | "bundle" | "environment" };

export type WindowsTerminalLaunch =
  | { kind: "ready"; file: string; version: string }
  | Extract<WindowsTerminalStatus, { kind: "blocked" }>;

export interface WindowsTerminalDeps {
  path: () => string;
  pathExt: () => string;
  extensionPath: () => string | undefined;
  enabled: () => boolean;
  workspaceFolders?: () => readonly string[];
  stat: (file: string) => Promise<{ isFile(): boolean }>;
  realpath: (file: string) => Promise<string>;
  execFile: (
    file: string,
    args: string[],
    options: { timeout: number; windowsHide: boolean; maxBuffer: number; cwd: string },
  ) => Promise<{ stdout: string }>;
  collection: { append(variable: string, value: string): void; delete(variable: string): void };
  pathVariable: string;
}

/** Only the registered extension, never a guessed version or a workspace executable. */
export class WindowsTerminalCli {
  private generation = 0;
  private latest: Promise<WindowsTerminalStatus> | undefined;

  constructor(private readonly deps: WindowsTerminalDeps) {}

  refresh(): Promise<WindowsTerminalStatus> {
    this.latest = this.inspectAndApply(++this.generation);
    return this.latest;
  }

  /** Re-resolve on every click, including after an extension update. No PATH mutation. */
  async prepareLaunch(): Promise<WindowsTerminalLaunch> {
    try {
      const result = await inspect(this.deps);
      return result.kind === "blocked"
        ? result
        : { kind: "ready", file: result.file, version: result.version };
    } catch {
      return { kind: "blocked", reason: "path" };
    }
  }

  private async inspectAndApply(generation: number): Promise<WindowsTerminalStatus> {
    if (!this.deps.enabled()) {
      try {
        this.deps.collection.delete(this.deps.pathVariable);
      } catch {
        return { kind: "blocked", reason: "environment" };
      }
    }
    let inspected: Awaited<ReturnType<typeof inspect>>;
    try {
      inspected = await inspect(this.deps);
    } catch {
      inspected = { kind: "blocked", reason: "path" };
    }
    // An older probe must not put back a path removed by a newer settings/update event.
    if (generation !== this.generation && this.latest !== undefined) return this.latest;
    try {
      if (inspected.kind === "available" && this.deps.enabled()) {
        // Append, never shadow a command introduced by a terminal profile or another extension.
        this.deps.collection.append(this.deps.pathVariable, `;${inspected.directory}`);
        return { kind: "enabled", version: inspected.version };
      }
      this.deps.collection.delete(this.deps.pathVariable);
    } catch {
      // Best effort rollback; the caller must never report this as enabled.
      try {
        this.deps.collection.delete(this.deps.pathVariable);
      } catch {}
      return { kind: "blocked", reason: "environment" };
    }
    return inspected.kind === "available" || inspected.kind === "standalone"
      ? { kind: inspected.kind, version: inspected.version }
      : inspected;
  }
}

type Inspection =
  | Extract<WindowsTerminalStatus, { kind: "blocked" }>
  | { kind: "standalone"; version: string; file: string }
  | { kind: "available"; version: string; directory: string; file: string };

async function inspect(deps: WindowsTerminalDeps): Promise<Inspection> {
  const extensions = deps
    .pathExt()
    .split(";")
    .map((ext) => ext.trim().toLowerCase());
  if (!extensions.includes(".exe") || extensions.some((ext) => !/^\.[a-z0-9]+$/.test(ext))) {
    return { kind: "blocked", reason: "path" };
  }
  const directories = [...new Set(deps.path().split(";").filter(Boolean).map(unquote))];
  // Network shares, relative entries and unresolved variables cannot be safely resolved here.
  if (directories.some((dir) => !localPath(dir))) return { kind: "blocked", reason: "path" };
  for (const directory of directories) {
    // PowerShell may resolve a .ps1 launcher independently of PATHEXT.
    for (const extension of [...new Set([...extensions, ".ps1"])]) {
      const file = path.join(directory, `claude${extension}`);
      if (!(await exists(deps, file))) continue;
      if (extension !== ".exe") return { kind: "blocked", reason: "launcher" };
      const realFile = await deps.realpath(file);
      if (!localPath(realFile) || inWorkspace(deps, realFile))
        return { kind: "blocked", reason: "path" };
      const version = await probe(deps, realFile);
      return version === undefined
        ? { kind: "blocked", reason: "execution" }
        : { kind: "standalone", version, file: realFile };
    }
  }
  const root = deps.extensionPath();
  if (root === undefined || !localPath(root)) return { kind: "blocked", reason: "bundle" };
  try {
    const file = path.join(root, "resources", "native-binary", "claude.exe");
    const [realRoot, realFile] = await Promise.all([deps.realpath(root), deps.realpath(file)]);
    const relative = path.relative(realRoot, realFile);
    if (
      !localPath(realRoot) ||
      !localPath(realFile) ||
      inWorkspace(deps, realFile) ||
      path.basename(realFile).toLowerCase() !== "claude.exe" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !(await exists(deps, realFile))
    )
      return { kind: "blocked", reason: "bundle" };
    const version = await probe(deps, realFile);
    return version === undefined
      ? { kind: "blocked", reason: "execution" }
      : { kind: "available", version, directory: path.dirname(realFile), file: realFile };
  } catch {
    return { kind: "blocked", reason: "bundle" };
  }
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function localPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) && !/[;"%\r\n\0]/.test(value);
}

function inWorkspace(deps: WindowsTerminalDeps, file: string): boolean {
  return (deps.workspaceFolders?.() ?? []).some((root) => {
    const relative = path.relative(root, file);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  });
}

async function exists(deps: WindowsTerminalDeps, file: string): Promise<boolean> {
  try {
    return (await deps.stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // An unreadable directory is not proof that no competing CLI exists.
    throw error;
  }
}

async function probe(deps: WindowsTerminalDeps, file: string): Promise<string | undefined> {
  try {
    const { stdout } = await deps.execFile(file, ["--version"], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 16 * 1024,
      cwd: path.dirname(file),
    });
    // Never put arbitrary executable output in diagnostics or a notification.
    return /^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s+\(Claude Code\)\s*$/.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}
