import { win32 as path } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WindowsTerminalCli, type WindowsTerminalDeps } from "../../src/terminal/windows.js";

const ROOT =
  "C:\\Users\\Example User\\.vscode\\extensions\\anthropic.claude-code-2.1.267-win32-x64";
const BINARY = path.join(ROOT, "resources", "native-binary", "claude.exe");

function fixture() {
  const files = new Set([BINARY]);
  const values = new Map<string, string>();
  let enabled = false;
  const deps: WindowsTerminalDeps = {
    path: () => 'C:\\Windows\\System32;"C:\\Users\\Example User\\bin";',
    pathExt: () => ".COM;.EXE;.BAT;.CMD",
    extensionPath: () => ROOT,
    enabled: () => enabled,
    stat: vi.fn(async (file) => {
      if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => true };
    }),
    realpath: vi.fn(async (file) => file),
    execFile: vi.fn(async () => ({ stdout: "2.1.267 (Claude Code)\r\n" })),
    collection: {
      append: vi.fn((key, value) => {
        values.set(key, value);
      }),
      delete: vi.fn((key) => {
        values.delete(key);
      }),
    },
    pathVariable: "Path",
  };
  return {
    files,
    values,
    deps,
    support: new WindowsTerminalCli(deps),
    enable: (value = true) => {
      enabled = value;
    },
  };
}

describe("Windows terminal repair", () => {
  it("offers the registered bundle without modifying PATH before consent", async () => {
    const f = fixture();
    expect(await f.support.refresh()).toEqual({ kind: "available", version: "2.1.267" });
    expect(f.values.size).toBe(0);
    expect(f.deps.execFile).toHaveBeenCalledWith(BINARY, ["--version"], {
      timeout: 5000,
      maxBuffer: 16384,
      windowsHide: true,
      cwd: path.dirname(BINARY),
    });
  });

  it("appends idempotently after consent and removes only its PATH mutation when disabled", async () => {
    const f = fixture();
    f.values.set("AWS_BEARER_TOKEN_BEDROCK", "synthetic");
    f.enable();
    expect((await f.support.refresh()).kind).toBe("enabled");
    await f.support.refresh();
    expect(f.values.get("Path")).toBe(`;${path.dirname(BINARY)}`);
    f.enable(false);
    expect((await f.support.refresh()).kind).toBe("available");
    expect(f.values.has("Path")).toBe(false);
    expect(f.values.get("AWS_BEARER_TOKEN_BEDROCK")).toBe("synthetic");
  });

  it("preserves an existing executable and removes a previous repair", async () => {
    const f = fixture();
    f.enable();
    await f.support.refresh();
    const standalone = "C:\\Windows\\System32\\claude.exe";
    f.files.add(standalone);
    expect(await f.support.refresh()).toEqual({ kind: "standalone", version: "2.1.267" });
    expect(f.values.has("Path")).toBe(false);
    expect(f.deps.execFile).toHaveBeenLastCalledWith(standalone, ["--version"], expect.anything());
  });

  it.each([".cmd", ".bat", ".ps1", ".com"])(
    "preserves an existing %s launcher without invoking a shell",
    async (extension) => {
      const f = fixture();
      f.files.add(`C:\\Windows\\System32\\claude${extension}`);
      f.enable();
      expect(await f.support.refresh()).toEqual({ kind: "blocked", reason: "launcher" });
      expect(f.deps.execFile).not.toHaveBeenCalled();
      expect(f.values.size).toBe(0);
    },
  );

  it.each(["EACCES", "EPERM", "ETIMEDOUT"])(
    "does not mistake %s for an absent PATH command",
    async (code) => {
      const f = fixture();
      f.deps.stat = async () => {
        throw Object.assign(new Error("private path"), { code });
      };
      f.enable();
      expect(await f.support.refresh()).toEqual({ kind: "blocked", reason: "path" });
      expect(f.deps.execFile).not.toHaveBeenCalled();
    },
  );

  it.each([".", "bin", "\\\\server\\share", "%UNKNOWN%\\bin", "C:\\bad\npath"])(
    "declines unsafe PATH entry %s",
    async (entry) => {
      const f = fixture();
      f.deps.path = () => entry;
      expect(await f.support.refresh()).toEqual({ kind: "blocked", reason: "path" });
      expect(f.deps.stat).not.toHaveBeenCalled();
    },
  );

  it("does not claim a CLI works if PATHEXT excludes executables", async () => {
    const f = fixture();
    f.deps.pathExt = () => ".CMD";
    expect(await f.support.refresh()).toEqual({ kind: "blocked", reason: "path" });
  });

  it.each(["denied", "timeout", "bad output"])(
    "reports %s without leaking child output or stderr",
    async (failure) => {
      const f = fixture();
      f.enable();
      f.deps.execFile = async () => {
        if (failure === "bad output") return { stdout: "private text 2.1.267" };
        throw new Error("private stderr");
      };
      expect(await f.support.refresh()).toEqual({ kind: "blocked", reason: "execution" });
      expect(f.values.size).toBe(0);
    },
  );

  it.each([undefined, "C:\\missing"])("handles a missing extension or binary", async (root) => {
    const f = fixture();
    f.deps.extensionPath = () => root;
    f.enable();
    expect(await f.support.refresh()).toEqual({ kind: "blocked", reason: "bundle" });
  });

  it("rejects a binary junction that escapes the registered extension", async () => {
    const f = fixture();
    f.deps.realpath = async (file) => (file === BINARY ? "C:\\workspace\\claude.exe" : file);
    expect(await f.support.refresh()).toEqual({ kind: "blocked", reason: "bundle" });
    expect(f.deps.execFile).not.toHaveBeenCalled();
  });

  it("does not execute a PATH command resolving into an open workspace", async () => {
    const f = fixture();
    f.files.add("C:\\Windows\\System32\\claude.exe");
    f.deps.realpath = async () => "C:\\project\\claude.exe";
    f.deps.workspaceFolders = () => ["C:\\project"];
    expect(await f.support.refresh()).toEqual({ kind: "blocked", reason: "path" });
    expect(f.deps.execFile).not.toHaveBeenCalled();
  });

  it("does not execute a development extension from an open workspace", async () => {
    const f = fixture();
    f.deps.workspaceFolders = () => [ROOT];
    expect(await f.support.refresh()).toEqual({ kind: "blocked", reason: "bundle" });
    expect(f.deps.execFile).not.toHaveBeenCalled();
  });

  it("re-resolves updates and clears the obsolete path after uninstall", async () => {
    const f = fixture();
    f.enable();
    await f.support.refresh();
    const next = ROOT.replace("2.1.267", "2.2.0");
    const binary = path.join(next, "resources", "native-binary", "claude.exe");
    f.files.add(binary);
    f.deps.extensionPath = () => next;
    await f.support.refresh();
    expect(f.values.get("Path")).toBe(`;${path.dirname(binary)}`);
    f.deps.extensionPath = () => undefined;
    await f.support.refresh();
    expect(f.values.size).toBe(0);
  });

  it("reports failed environment mutation, attempts rollback, and never reports success", async () => {
    const f = fixture();
    f.enable();
    f.deps.collection.append = () => {
      throw new Error("denied");
    };
    expect(await f.support.refresh()).toEqual({ kind: "blocked", reason: "environment" });
    expect(f.deps.collection.delete).toHaveBeenCalledWith("Path");
  });

  it("does not let an older probe restore a path after disable", async () => {
    const f = fixture();
    f.enable();
    let resume!: (result: { stdout: string }) => void;
    f.deps.execFile = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resume = resolve;
          }),
      )
      .mockResolvedValue({ stdout: "2.1.267 (Claude Code)" });
    const first = f.support.refresh();
    await vi.waitFor(() => expect(resume).toBeDefined());
    f.enable(false);
    await f.support.refresh();
    resume({ stdout: "2.1.267 (Claude Code)" });
    await first;
    expect(f.values.size).toBe(0);
  });
});
