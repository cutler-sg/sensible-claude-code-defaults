/**
 * The health panel (FR-5.1, FR-5.2).
 *
 * A TreeView rather than a webview (D5): status glyphs, inline command buttons,
 * a count badge, theming, and accessibility all come from the platform. The
 * provider is a pure projection of the last `HealthReport` — it runs no checks
 * and reads no files, so a slow or crashed run can never leave the tree in a
 * half-built state.
 *
 * The projection is built once per report rather than per `getChildren` call.
 * `reveal()` walks parents and compares nodes by identity, and VS Code drops a
 * row's expansion and selection state when its `id` changes between refreshes;
 * both need the same object and the same id to come back every time.
 */

import * as vscode from "vscode";
import type { ManagedKey } from "../config/types.js";
import { needsSetup as needsSetupFn } from "../health/setup.js";
import {
  CHECK_GROUPS,
  type CheckGroup,
  type CheckResult,
  type DriftChild,
  type HealthReport,
  type Remediation,
} from "../health/types.js";
import { redact } from "../util/redact.js";
import { accessibilityLabel, iconFor } from "./present.js";

export interface GroupNode {
  readonly kind: "group";
  readonly group: CheckGroup;
  readonly results: readonly CheckResult[];
}

export interface CheckNode {
  readonly kind: "check";
  readonly group: CheckGroup;
  readonly result: CheckResult;
}

export interface DriftNode {
  readonly kind: "drift";
  readonly group: CheckGroup;
  readonly key: ManagedKey;
  readonly child: DriftChild;
}

export type Node = GroupNode | CheckNode | DriftNode;

/**
 * FR-5.5: Claude Code is installed but has never been configured — the one
 * state where the whole panel reduces to a single sentence and a button. The
 * host mirrors this into a `when` context for the `viewsWelcome` contribution.
 *
 * The extension check has to pass for this to be the story: with Claude Code
 * itself missing, "apply the recommended configuration" configures a tool that
 * is not there, and the tree of checks says something truer.
 */
export { needsSetup } from "../health/setup.js";

export class HealthTreeProvider implements vscode.TreeDataProvider<Node> {
  private report: HealthReport | undefined;
  private roots: Node[] = [];
  private children = new Map<Node, Node[]>();
  private parents = new Map<Node, Node>();
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();

  readonly onDidChangeTreeData: vscode.Event<Node | undefined> = this.emitter.event;

  setReport(report: HealthReport): void {
    this.report = report;
    this.build(report);
    this.emitter.fire(undefined);
  }

  /** FR-5.4: the badge counts errors only — warnings badging is badge fatigue. */
  get errorCount(): number {
    return this.report?.counts.error ?? 0;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "group":
        return groupItem(node);
      case "check":
        return checkItem(node);
      case "drift":
        return driftItem(node);
    }
  }

  getChildren(node?: Node): Node[] {
    // An empty root is what makes `viewsWelcome` render, so both first-run
    // states are expressed by having nothing to show rather than by a tree of
    // placeholder rows the user cannot act on.
    if (node === undefined) return this.roots;
    return this.children.get(node) ?? [];
  }

  getParent(node: Node): Node | undefined {
    return this.parents.get(node);
  }

  private build(report: HealthReport): void {
    this.children = new Map();
    this.parents = new Map();

    if (needsSetupFn(report)) {
      this.roots = [];
      return;
    }

    this.roots = CHECK_GROUPS.map((group) => {
      const results = report.results.filter((result) => result.group === group);
      const groupNode: Node = { kind: "group", group, results };
      this.children.set(
        groupNode,
        results.map((result) => this.buildCheck(groupNode, group, result)),
      );
      return groupNode;
    });
  }

  private buildCheck(parent: Node, group: CheckGroup, result: CheckResult): Node {
    const node: Node = { kind: "check", group, result };
    this.parents.set(node, parent);
    this.children.set(
      node,
      (result.children ?? []).map((child) => {
        const driftNode: Node = { kind: "drift", group, key: child.key, child };
        this.parents.set(driftNode, node);
        return driftNode;
      }),
    );
    return node;
  }
}

function groupItem(node: GroupNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.group, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `group:${node.group}`;
  item.contextValue = "group";
  return item;
}

function checkItem(node: CheckNode): vscode.TreeItem {
  const { result } = node;
  const hasChildren = (result.children?.length ?? 0) > 0;
  const item = new vscode.TreeItem(
    result.label,
    hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
  );
  item.id = `check:${result.id}`;
  const icon = iconFor(result.level);
  item.iconPath = new vscode.ThemeIcon(
    icon.id,
    icon.color === undefined ? undefined : new vscode.ThemeColor(icon.color),
  );
  item.tooltip = tooltip(result.label, result.detail);
  item.accessibilityInformation = {
    label: accessibilityLabel(node.group, result.label, result.level),
  };
  item.contextValue = contextValue(result.fix);
  // `item.command` is deliberately left unset: the remediation is the inline
  // button, so a stray click on a row can never write to a config file.
  return item;
}

function driftItem(node: DriftNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.child.label, vscode.TreeItemCollapsibleState.None);
  item.id = `drift:${node.key}`;
  item.iconPath = new vscode.ThemeIcon("info");
  item.tooltip = tooltip(node.child.label, node.child.detail);
  item.accessibilityInformation = {
    label: accessibilityLabel(node.group, node.child.label, "info"),
  };
  item.contextValue = "drift";
  return item;
}

/** `check:command` is what `view/item/context` binds the wrench button to. */
export function contextValue(fix: Remediation): string {
  return `check:${fix.kind}`;
}

function tooltip(label: string, detail: string | undefined): string {
  return detail === undefined ? label : `${label}\n${redact(detail)}`;
}
