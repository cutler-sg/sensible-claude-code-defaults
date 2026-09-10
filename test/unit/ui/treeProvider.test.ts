import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_GROUPS,
  type CheckResult,
  countLevels,
  type HealthReport,
} from "../../../src/health/types.js";
import { HealthTreeProvider, type Node } from "../../../src/ui/treeProvider.js";
import * as stub from "./vscodeStub.js";

// `vscode` is supplied by the extension host: never bundled (see esbuild.js),
// never installed as a package, so a unit test has to stand one in. The stub is
// the real API's shape for exactly the surface `treeProvider.ts` touches.
vi.mock("vscode", async () => await import("./vscodeStub.js"));

function report(results: CheckResult[]): HealthReport {
  return { at: "2026-09-10T00:00:00Z", results, counts: countLevels(results) };
}

const bedrock: CheckResult = {
  id: "config.bedrock",
  group: "Configuration",
  level: "error",
  label: "Claude Code isn't pointed at AWS Bedrock",
  detail: "Turn this on to use your company's AWS account.",
  fix: { kind: "command", command: "sensibleDefaults.applyDefaults", title: "Fix" },
};

const cliInfo: CheckResult = {
  id: "install.cli",
  group: "Installation",
  level: "info",
  label: "The claude command isn't on your PATH",
  fix: { kind: "none" },
};

const drift: CheckResult = {
  id: "config.drift",
  group: "Configuration",
  level: "info",
  label: "Some settings differ from the recommended ones",
  fix: { kind: "none" },
  children: [
    {
      key: "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
      label: "Claude Code changed the Opus model",
      detail: "Now: us.anthropic.claude-opus-4",
      fix: { kind: "command", command: "sensibleDefaults.resetKey", title: "Reset" },
    },
  ],
};

describe("HealthTreeProvider", () => {
  let provider: InstanceType<typeof HealthTreeProvider>;

  beforeEach(() => {
    provider = new HealthTreeProvider();
  });

  it("shows every group in a fixed order before any report exists", () => {
    const roots = provider.getChildren();
    expect(roots.map((n) => (n.kind === "group" ? n.group : ""))).toEqual([...CHECK_GROUPS]);
    for (const root of roots) expect(provider.getChildren(root)).toEqual([]);
  });

  it("keeps groups expanded so nothing needs a click to be seen", () => {
    const [group] = provider.getChildren();
    expect(provider.getTreeItem(group as Node).collapsibleState).toBe(
      stub.TreeItemCollapsibleState.Expanded,
    );
  });

  it("files each result under its own group", () => {
    provider.setReport(report([bedrock, cliInfo]));
    const roots = provider.getChildren();
    const install = roots.find((n) => n.kind === "group" && n.group === "Installation");
    const config = roots.find((n) => n.kind === "group" && n.group === "Configuration");
    expect(provider.getChildren(install as Node)).toHaveLength(1);
    expect(provider.getChildren(config as Node)).toHaveLength(1);
  });

  it("fires a change event when a report lands", () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.setReport(report([bedrock]));
    expect(listener).toHaveBeenCalledWith(undefined);
  });

  it("renders a check with its level's icon, tooltip, and a11y label", () => {
    provider.setReport(report([bedrock]));
    const node = checkNode(provider, "Configuration");
    const item = provider.getTreeItem(node);

    expect(item.label).toBe(bedrock.label);
    expect(item.iconPath).toBeInstanceOf(stub.ThemeIcon);
    expect((item.iconPath as stub.ThemeIcon).id).toBe("error");
    expect((item.iconPath as stub.ThemeIcon).color?.id).toBe("list.errorForeground");
    expect(item.tooltip).toBe(`${bedrock.label}\n${bedrock.detail}`);
    expect(item.accessibilityInformation?.label).toBe(
      "Configuration: Claude Code isn't pointed at AWS Bedrock, error",
    );
  });

  it("leaves info-level icons untinted", () => {
    provider.setReport(report([cliInfo]));
    const item = provider.getTreeItem(checkNode(provider, "Installation"));
    expect((item.iconPath as stub.ThemeIcon).color).toBeUndefined();
  });

  it("gives a fixable check the context value the wrench button binds to", () => {
    provider.setReport(report([bedrock, cliInfo]));
    expect(provider.getTreeItem(checkNode(provider, "Configuration")).contextValue).toBe(
      "check:command",
    );
    expect(provider.getTreeItem(checkNode(provider, "Installation")).contextValue).toBe(
      "check:none",
    );
  });

  it("does nothing when a check is clicked", () => {
    provider.setReport(report([bedrock]));
    expect(provider.getTreeItem(checkNode(provider, "Configuration")).command).toBeUndefined();
  });

  it("expands drift into one resettable child per key", () => {
    provider.setReport(report([drift]));
    const parent = checkNode(provider, "Configuration");
    expect(provider.getTreeItem(parent).collapsibleState).toBe(
      stub.TreeItemCollapsibleState.Collapsed,
    );

    const children = provider.getChildren(parent);
    expect(children).toHaveLength(1);
    const child = children[0] as Node;
    expect(child.kind).toBe("drift");
    const item = provider.getTreeItem(child);
    expect(item.contextValue).toBe("drift");
    expect(item.label).toBe("Claude Code changed the Opus model");
    expect(provider.getChildren(child)).toEqual([]);
  });

  it("counts only errors for the badge (FR-5.4)", () => {
    expect(provider.errorCount).toBe(0);
    provider.setReport(report([bedrock, cliInfo, drift]));
    expect(provider.errorCount).toBe(1);
    provider.setReport(report([cliInfo]));
    expect(provider.errorCount).toBe(0);
  });

  it("resolves a leaf's parent group for reveal()", () => {
    provider.setReport(report([bedrock]));
    const node = checkNode(provider, "Configuration");
    const parent = provider.getParent(node);
    expect(parent?.kind).toBe("group");
    expect(parent && parent.kind === "group" && parent.group).toBe("Configuration");
    expect(provider.getParent(provider.getChildren()[0] as Node)).toBeUndefined();
  });
});

function checkNode(provider: InstanceType<typeof HealthTreeProvider>, group: string): Node {
  const root = provider.getChildren().find((n) => n.kind === "group" && n.group === group);
  const [first] = provider.getChildren(root as Node);
  if (first === undefined) throw new Error(`no check under ${group}`);
  return first;
}
