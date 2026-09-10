/**
 * The health panel (FR-5.1, FR-5.2).
 *
 * A TreeView rather than a webview (D5): status glyphs, inline command buttons,
 * a count badge, theming, and accessibility all come from the platform. The
 * provider is a pure projection of the last `HealthReport` — it runs no checks
 * and reads no files, so a slow or crashed run can never leave the tree in a
 * half-built state.
 */

import * as vscode from "vscode";
import type { ManagedKey } from "../config/types.js";
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

export class HealthTreeProvider implements vscode.TreeDataProvider<Node> {
  private report: HealthReport | undefined;
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();

  readonly onDidChangeTreeData: vscode.Event<Node | undefined> = this.emitter.event;

  setReport(report: HealthReport): void {
    this.report = report;
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
    if (node === undefined) {
      // The groups are fixed and always shown, even before the first report:
      // a tree whose shape changes as checks land reads as instability to the
      // user this panel is for.
      return CHECK_GROUPS.map((group) => ({
        kind: "group",
        group,
        results: this.report?.results.filter((r) => r.group === group) ?? [],
      }));
    }
    if (node.kind === "group") {
      return node.results.map((result) => ({ kind: "check", group: node.group, result }));
    }
    if (node.kind === "check") {
      return (node.result.children ?? []).map((child) => ({
        kind: "drift",
        group: node.group,
        key: child.key,
        child,
      }));
    }
    return [];
  }

  getParent(node: Node): Node | undefined {
    if (node.kind === "group") return undefined;
    return {
      kind: "group",
      group: node.group,
      results: this.report?.results.filter((r) => r.group === node.group) ?? [],
    };
  }
}

function groupItem(node: GroupNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.group, vscode.TreeItemCollapsibleState.Expanded);
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
