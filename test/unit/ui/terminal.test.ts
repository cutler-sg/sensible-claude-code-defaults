import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowsTerminalCli } from "../../../src/terminal/windows.js";
import { configureWindowsTerminal } from "../../../src/ui/terminal.js";
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
