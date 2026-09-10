import { describe, expect, it } from "vitest";
import manifest from "../../package.json";

describe("package.json", () => {
  it("does not declare extensionKind (FR-1.3: host must run beside the CLI)", () => {
    expect((manifest as Record<string, unknown>).extensionKind).toBeUndefined();
  });

  it("depends on the Claude Code extension by bare id (FR-1.5)", () => {
    expect(manifest.extensionDependencies).toEqual(["anthropic.claude-code"]);
  });

  it("activates only on startup finished (FR-1.1)", () => {
    expect(manifest.activationEvents).toEqual(["onStartupFinished"]);
  });

  it("points main at the bundled entry point", () => {
    expect(manifest.main).toBe("./dist/extension.js");
  });

  it("supports untrusted workspaces", () => {
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(true);
  });

  it("contributes the sensibleDefaults activity bar container", () => {
    const containers = manifest.contributes.viewsContainers.activitybar;
    expect(containers.map((c) => c.id)).toContain("sensibleDefaults");
  });
});
