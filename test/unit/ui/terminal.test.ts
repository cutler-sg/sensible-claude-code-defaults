import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowsTerminalCli } from "../../../src/terminal/windows.js";
import { configureWindowsTerminal, openWindowsTerminal } from "../../../src/ui/terminal.js";
import { reset, state } from "./commandsHost.js";

vi.mock("vscode", async () => import("./commandsHost.js"));
beforeEach(reset);
const SETTING = "sensibleDefaults.enableWindowsTerminalCli";
function support(kind = "available") {
  const refresh = vi.fn(async () => ({
    kind: state.configuration.get(SETTING) ? "enabled" : kind,
    version: "2.1.267",
  }));
  return { refresh, api: { refresh } as unknown as WindowsTerminalCli };
}
describe("Windows terminal commands", () => {
  it("does nothing on another host", async () => {
    await configureWindowsTerminal(undefined, true);
    expect(state.configuration.size).toBe(0);
    expect(state.info[0]?.message).toContain("native Windows");
  });
  it("requires explicit consent", async () => {
    const f = support();
    await configureWindowsTerminal(f.api, true);
    expect(state.configuration.size).toBe(0);
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it("persists opt-in then validates the applied environment", async () => {
    state.answer = () => "Enable";
    const f = support();
    await configureWindowsTerminal(f.api, true);
    expect(state.configuration.get(SETTING)).toBe(true);
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(state.info.at(-1)?.message).toContain("Reopen your terminal");
  });
  it("does not change preferences for an existing command or blocked bundle", async () => {
    state.answer = () => "Enable";
    await configureWindowsTerminal(support("standalone").api, true);
    expect(state.configuration.size).toBe(0);
    expect(state.warn[0]?.message).toContain("could not be repaired safely");
  });
  it("disables without requesting enable consent", async () => {
    state.configuration.set(SETTING, true);
    await configureWindowsTerminal(support().api, false);
    expect(state.configuration.get(SETTING)).toBe(false);
    expect(state.info.at(-1)?.message).toContain("disabled");
  });
});

describe("direct Windows Claude launcher", () => {
  const file = "C:\\Users\\O'Brien 日本語 & name\\.vscode\\extensions\\claude\\claude.exe";
  function launcher(kind = "ready") {
    const prepareLaunch = vi.fn(async () => ({ kind, file, version: "2.1.269", reason: "bundle" }));
    return { prepareLaunch, api: { prepareLaunch } as unknown as WindowsTerminalCli };
  }

  it("launches an absolute executable as the terminal process, with no shell text or flags", async () => {
    const f = launcher();
    await openWindowsTerminal(f.api);
    expect(f.prepareLaunch).toHaveBeenCalledTimes(1);
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0]).toMatchObject({
      shellPath: file,
      shellArgs: [],
      env: { NoDefaultCurrentDirectoryInExePath: "1" },
    });
    expect(state.executed).toEqual([]);
    expect(state.configuration.size).toBe(0);
  });

  it("refuses to launch in an untrusted workspace", async () => {
    state.trusted = false;
    const f = launcher();
    await openWindowsTerminal(f.api);
    expect(f.prepareLaunch).not.toHaveBeenCalled();
    expect(state.terminals).toEqual([]);
    expect(state.warn[0]?.message).toContain("trust");
  });

  it("does not launch when the executable is blocked or on a non-Windows host", async () => {
    await openWindowsTerminal(launcher("blocked").api);
    await openWindowsTerminal(undefined);
    expect(state.terminals).toEqual([]);
    expect(state.warn[0]?.message).toContain("could not be launched safely");
  });

  it("reports a terminal creation failure without exposing raw errors", async () => {
    state.terminalFailure = true;
    await openWindowsTerminal(launcher().api);
    expect(state.warn[0]?.message).toContain("could not open");
  });

  it("reports a nonzero exit and disposes its listener", async () => {
    await openWindowsTerminal(launcher().api);
    const terminal = state.terminals[0];
    expect(terminal).toBeDefined();
    if (terminal === undefined) return;
    terminal.exitStatus = { code: 1 };
    for (const listener of state.terminalCloseListeners) listener(terminal);
    expect(state.warn[0]?.message).toContain("exited with code 1");
    expect(state.terminalCloseListeners.size).toBe(0);
  });

  it("does not treat a normal exit as a failure", async () => {
    await openWindowsTerminal(launcher().api);
    for (const listener of state.terminalCloseListeners) listener(state.terminals[0]);
    expect(state.warn).toEqual([]);
    expect(state.terminalCloseListeners.size).toBe(0);
  });
});
