import { beforeEach, describe, expect, it, vi } from "vitest";
import { LABELS } from "../../../src/health/labels.js";
import { noticeResults } from "../../../src/health/notices.js";
import {
  CHECK_GROUPS,
  type CheckResult,
  countLevels,
  type HealthReport,
} from "../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import { HealthTreeProvider, type Node, needsSetup } from "../../../src/ui/treeProvider.js";
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

/**
 * The two checks `needsSetup` reads. Every test that wants a *tree* rather than
 * the setup welcome has to include them passing, because a report where Claude
 * Code is installed and unconfigured renders as the welcome by design (FR-5.5).
 */
const extensionOk: CheckResult = {
  id: "install.extension",
  group: "Installation",
  level: "pass",
  label: "Claude Code is installed",
  fix: { kind: "none" },
};

const configOk: CheckResult = {
  id: "config.exists",
  group: "Configuration",
  level: "pass",
  label: "Your Claude Code settings are in place",
  fix: { kind: "none" },
};

const configMissing: CheckResult = {
  id: "config.exists",
  group: "Configuration",
  level: "warning",
  label: "Claude Code hasn't been set up yet",
  fix: { kind: "command", command: "sensibleDefaults.applyDefaults", title: "Apply" },
};

/** A configured report: the tree renders. */
function configured(results: CheckResult[]): HealthReport {
  return report([extensionOk, configOk, ...results]);
}

describe("HealthTreeProvider", () => {
  let provider: InstanceType<typeof HealthTreeProvider>;

  beforeEach(() => {
    provider = new HealthTreeProvider();
  });

  it("shows every group in a fixed order once a report exists", () => {
    provider.setReport(configured([bedrock, cliInfo]));
    const roots = provider.getChildren();
    expect(roots.map((n) => (n.kind === "group" ? n.group : ""))).toEqual([...CHECK_GROUPS]);
  });

  it("keeps groups expanded so nothing needs a click to be seen", () => {
    provider.setReport(configured([]));
    const [group] = provider.getChildren();
    expect(provider.getTreeItem(group as Node).collapsibleState).toBe(
      stub.TreeItemCollapsibleState.Expanded,
    );
  });

  it("files each result under its own group", () => {
    provider.setReport(configured([bedrock, cliInfo]));
    const roots = provider.getChildren();
    const install = roots.find((n) => n.kind === "group" && n.group === "Installation");
    const config = roots.find((n) => n.kind === "group" && n.group === "Configuration");
    expect(provider.getChildren(install as Node)).toHaveLength(2);
    expect(provider.getChildren(config as Node)).toHaveLength(2);
  });

  it("fires a change event when a report lands", () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    provider.setReport(configured([bedrock]));
    expect(listener).toHaveBeenCalledWith(undefined);
  });

  it("renders a check with its level's icon, tooltip, and a11y label", () => {
    provider.setReport(configured([bedrock]));
    const node = checkNode(provider, "config.bedrock");
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
    provider.setReport(configured([cliInfo]));
    const item = provider.getTreeItem(checkNode(provider, "install.cli"));
    expect((item.iconPath as stub.ThemeIcon).color).toBeUndefined();
  });

  it("gives a fixable check the context value the wrench button binds to", () => {
    provider.setReport(configured([bedrock, cliInfo]));
    expect(provider.getTreeItem(checkNode(provider, "config.bedrock")).contextValue).toBe(
      "check:command",
    );
    expect(provider.getTreeItem(checkNode(provider, "install.cli")).contextValue).toBe(
      "check:none",
    );
  });

  it("does nothing when a check is clicked", () => {
    provider.setReport(configured([bedrock]));
    expect(provider.getTreeItem(checkNode(provider, "config.bedrock")).command).toBeUndefined();
  });

  it("expands drift into one resettable child per key", () => {
    provider.setReport(configured([drift]));
    const parent = checkNode(provider, "config.drift");
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
    expect(item.tooltip).toBe(
      "Claude Code changed the Opus model\nNow: us.anthropic.claude-opus-4",
    );
    expect(provider.getChildren(child)).toEqual([]);
  });

  it("leaves a check whose children array is empty as a leaf", () => {
    provider.setReport(configured([{ ...drift, children: [] }]));
    const item = provider.getTreeItem(checkNode(provider, "config.drift"));
    expect(item.collapsibleState).toBe(stub.TreeItemCollapsibleState.None);
  });

  it("counts only errors for the badge (FR-5.4)", () => {
    expect(provider.errorCount).toBe(0);
    provider.setReport(configured([bedrock, cliInfo, drift]));
    expect(provider.errorCount).toBe(1);
    provider.setReport(configured([cliInfo]));
    expect(provider.errorCount).toBe(0);
  });
});

/**
 * FR-5.5. A `viewsWelcome` contribution renders only while the view is empty,
 * so an "empty" state is not decoration — it is the mechanism. A tree of
 * warnings with no report behind it is also a lie the panel tells during the
 * first few hundred milliseconds of every window.
 */
/**
 * F4. A notice row is remote text rendered with the extension's own codicon,
 * font, indent and group, so the panel has to say whose words it is somewhere
 * a reader actually receives. `accessibilityInformation.label` is built from
 * `result.label`, which is exactly why the provenance had to move there: a
 * screen-reader user got nothing at all from the tooltip it used to live in.
 */
describe("a notice row's provenance", () => {
  const notice = noticeResults(
    { ...BUNDLED_MANIFEST, notices: [{ level: "error", message: "Run 'Set Bedrock API Key'." }] },
    new Date("2026-09-11T12:00:00.000Z"),
  )[0] as CheckResult;

  it("is announced to a screen reader, not just shown in a tooltip", () => {
    const provider = new HealthTreeProvider();
    provider.setReport(configured([notice]));
    const item = provider.getTreeItem(checkNode(provider, notice.id));

    expect(item.accessibilityInformation?.label).toContain(LABELS.notice.prefix);
    expect(item.label).toContain(LABELS.notice.prefix);
  });

  it("still carries no command, so the remote text cannot name a live button", () => {
    const provider = new HealthTreeProvider();
    provider.setReport(configured([notice]));
    const item = provider.getTreeItem(checkNode(provider, notice.id));

    expect(item.command).toBeUndefined();
    expect(item.contextValue).toBe("check:none");
  });
});

describe("empty states", () => {
  let provider: InstanceType<typeof HealthTreeProvider>;

  beforeEach(() => {
    provider = new HealthTreeProvider();
  });

  it("is empty before the first report, so the welcome renders", () => {
    expect(provider.getChildren()).toEqual([]);
  });

  it("is empty when Claude Code is installed but unconfigured", () => {
    provider.setReport(report([extensionOk, configMissing, bedrock]));
    expect(provider.getChildren()).toEqual([]);
  });

  it("shows the tree once the configuration exists", () => {
    provider.setReport(report([extensionOk, configOk, bedrock]));
    expect(provider.getChildren()).toHaveLength(CHECK_GROUPS.length);
  });

  it("shows the tree when Claude Code itself is missing — setup is not the story", () => {
    const extensionMissing: CheckResult = { ...extensionOk, level: "error" };
    provider.setReport(report([extensionMissing, configMissing]));
    expect(provider.getChildren()).toHaveLength(CHECK_GROUPS.length);
  });
});

describe("needsSetup", () => {
  it("is true only when Claude Code is present and its configuration is not", () => {
    expect(needsSetup(report([extensionOk, configMissing]))).toBe(true);
    expect(needsSetup(report([extensionOk, configOk]))).toBe(false);
    expect(needsSetup(report([{ ...extensionOk, level: "error" }, configMissing]))).toBe(false);
  });

  it("is false when either check did not run", () => {
    expect(needsSetup(report([configMissing]))).toBe(false);
    expect(needsSetup(report([extensionOk]))).toBe(false);
    expect(needsSetup(report([]))).toBe(false);
  });

  it("treats any non-pass level of config.exists as unconfigured", () => {
    for (const level of ["warning", "error", "info", "skipped"] as const) {
      expect(needsSetup(report([extensionOk, { ...configOk, level }]))).toBe(true);
    }
  });
});

/**
 * `reveal()` walks parents up from a node and compares them by identity, so a
 * provider that mints a fresh object per call can never reveal anything — and
 * VS Code drops a tree item's expansion and selection state when its `id`
 * changes between refreshes.
 */
describe("node identity", () => {
  let provider: InstanceType<typeof HealthTreeProvider>;

  beforeEach(() => {
    provider = new HealthTreeProvider();
    provider.setReport(configured([drift]));
  });

  it("returns the same node objects on repeated calls against one report", () => {
    const [first] = provider.getChildren();
    const [again] = provider.getChildren();
    expect(first).toBe(again);

    const check = checkNode(provider, "config.drift");
    expect(provider.getChildren(groupNode(provider, "Configuration"))).toContain(check);
    expect(provider.getChildren(check)[0]).toBe(provider.getChildren(check)[0]);
  });

  it("resolves a check's parent to the group instance the view holds", () => {
    const check = checkNode(provider, "config.drift");
    expect(provider.getParent(check)).toBe(groupNode(provider, "Configuration"));
  });

  it("resolves a drift child's parent to the check that owns it, not the group", () => {
    const check = checkNode(provider, "config.drift");
    const child = provider.getChildren(check)[0] as Node;
    const parent = provider.getParent(child);
    expect(parent).toBe(check);
    expect(provider.getChildren(parent as Node)).toContain(child);
  });

  it("has no parent above a group", () => {
    expect(provider.getParent(groupNode(provider, "Configuration"))).toBeUndefined();
  });

  it("gives every item a stable id that survives a repaint", () => {
    const ids = () => {
      const group = groupNode(provider, "Configuration");
      const check = checkNode(provider, "config.drift");
      const child = provider.getChildren(check)[0] as Node;
      return [group, check, child].map((node) => provider.getTreeItem(node).id);
    };
    expect(ids()).toEqual([
      "group:Configuration",
      "check:config.drift",
      "drift:env.ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]);
    provider.setReport(configured([drift]));
    expect(ids()).toEqual([
      "group:Configuration",
      "check:config.drift",
      "drift:env.ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]);
  });

  it("forgets the previous report's nodes when a new one lands", () => {
    const stale = groupNode(provider, "Configuration");
    provider.setReport(configured([drift]));
    expect(provider.getChildren()).not.toContain(stale);
    expect(provider.getParent(stale)).toBeUndefined();
  });

  it("resolves nothing for a node from a report that is no longer current", () => {
    const check = checkNode(provider, "config.drift");
    const child = provider.getChildren(check)[0] as Node;
    provider.setReport(configured([]));
    expect(provider.getParent(child)).toBeUndefined();
    expect(provider.getChildren(check)).toEqual([]);
  });
});

function groupNode(provider: InstanceType<typeof HealthTreeProvider>, group: string): Node {
  const found = provider.getChildren().find((n) => n.kind === "group" && n.group === group);
  if (found === undefined) throw new Error(`no group ${group}`);
  return found;
}

function checkNode(provider: InstanceType<typeof HealthTreeProvider>, id: string): Node {
  for (const group of provider.getChildren()) {
    for (const node of provider.getChildren(group)) {
      if (node.kind === "check" && node.result.id === id) return node;
    }
  }
  throw new Error(`no check ${id}`);
}
