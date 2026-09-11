import { describe, expect, it } from "vitest";
import { installCliCheck } from "../../../src/health/checks/install.cli.js";
import { installExtensionCheck } from "../../../src/health/checks/install.extension.js";
import { installVersionCheck } from "../../../src/health/checks/install.version.js";
import { makeCtx } from "./fixture.js";

describe("install.extension", () => {
  it("passes when the extension is installed", () => {
    const result = installExtensionCheck.run(makeCtx());
    expect(result).toMatchObject({ level: "pass", fix: { kind: "none" } });
  });

  it("errors with an install command when it is not", () => {
    const result = installExtensionCheck.run(
      makeCtx({ detection: { extension: { installed: false }, cli: { found: false } } }),
    );
    expect(result.level).toBe("error");
    expect(result.fix).toEqual({
      kind: "command",
      command: "workbench.extensions.installExtension",
      title: "Install Claude Code",
      args: ["anthropic.claude-code"],
    });
  });
});

describe("install.version", () => {
  it("skips when the extension is absent", () => {
    const result = installVersionCheck.run(
      makeCtx({ detection: { extension: { installed: false }, cli: { found: false } } }),
    );
    expect(result.level).toBe("skipped");
  });

  it("passes at or above the floor", () => {
    const ctx = makeCtx();
    ctx.detection.extension = { installed: true, version: "2.9.0" };
    expect(installVersionCheck.run(ctx).level).toBe("pass");
  });

  it("warns below the floor and offers the extension page", () => {
    const ctx = makeCtx();
    ctx.detection.extension = { installed: true, version: "2.0.9" };
    const result = installVersionCheck.run(ctx);
    expect(result.level).toBe("warning");
    expect(result.detail).toContain("2.0.9");
    expect(result.fix).toEqual({
      kind: "command",
      command: "extension.open",
      title: "Open the Claude Code page",
      args: ["anthropic.claude-code"],
    });
  });
});

describe("install.cli", () => {
  it("passes when the CLI is on PATH", () => {
    const result = installCliCheck.run(makeCtx());
    expect(result).toMatchObject({ level: "pass", detail: "Version 2.1.267" });
  });

  it("is informational, never a failure, when it is not", () => {
    const ctx = makeCtx();
    ctx.detection.cli = { found: false };
    const result = installCliCheck.run(ctx);
    expect(result.level).toBe("info");
    expect(result.fix).toEqual({ kind: "none" });
  });
});
