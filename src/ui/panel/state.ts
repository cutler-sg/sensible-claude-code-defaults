/**
 * The panel's state, as a pure function of what the extension knows.
 *
 * Plan M8: one screen, three states. The HTML is a function of this value and
 * nothing else, so every rule about what a non-technical user sees is decided
 * here, where it can be tested without a webview.
 *
 * Invariant: nothing in `PanelState` ever contains the token. The reducer is
 * handed a `StoredToken` for its timestamp and deliberately copies only that.
 */

import type { ConnectionResult, StoredToken } from "../../credential/types.js";
import { LABELS, networkGuidance } from "../../health/labels.js";
import { needsSetup } from "../../health/setup.js";
import type { CheckGroup, CheckResult, HealthReport, Level } from "../../health/types.js";

/** Where the user is in the two-step flow, held by the provider between renders. */
export type SetupProgress =
  | { step: "key"; shape: ShapeFeedback; problem?: string; busy?: boolean }
  | { step: "testing" }
  | { step: "result"; result: ConnectionResult };

export type ShapeFeedback =
  | { kind: "empty" }
  | { kind: "ok" }
  | { kind: "warning"; message: string }
  | { kind: "error"; message: string };

export interface Action {
  /** A command id from `ALLOWED_ACTIONS`, run by the extension. */
  command: string;
  title: string;
}

export type PanelState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "unconfigured" }
  | { kind: "setup"; progress: SetupProgress; consoleUrl: string }
  | {
      kind: "healthy";
      keySetAt: string | undefined;
      lastTestedAt: string | undefined;
      interruption: Interruption | undefined;
      counts: Record<Level, number>;
      detailsOpen: boolean;
    };

export interface Interruption {
  level: "error" | "warning";
  sentence: string;
  action: Action | undefined;
}

export interface Inputs {
  report: HealthReport | undefined;
  stored: Pick<StoredToken, "setAt"> | undefined;
  lastTestedAt: string | undefined;
  progress: SetupProgress | undefined;
  consoleUrl: string;
  detailsOpen: boolean;
}

/**
 * The only commands the webview may ask the extension to run. A message naming
 * anything else is dropped and logged: the page is ours, but its script runs in
 * a renderer, and the allowlist is what keeps a compromised page from reaching
 * a command it was never meant to.
 */
export const ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "sensibleDefaults.enableWindowsTerminalCli",
  "sensibleDefaults.disableWindowsTerminalCli",
  "sensibleDefaults.testConnection",
  "sensibleDefaults.rotateToken",
  "sensibleDefaults.selectRegion",
  "sensibleDefaults.adoptToken",
  "sensibleDefaults.applyDefaults",
  "sensibleDefaults.runHealthCheck",
  "sensibleDefaults.repairPermissions",
  "sensibleDefaults.reapplyToken",
  "sensibleDefaults.resolveTokenConflict",
  "sensibleDefaults.copyDiagnostics",
  "sensibleDefaults.openSettings",
]);

export function derive(inputs: Inputs): PanelState {
  if (inputs.progress !== undefined) {
    return { kind: "setup", progress: inputs.progress, consoleUrl: inputs.consoleUrl };
  }
  if (inputs.report === undefined) {
    return { kind: "loading" };
  }
  if (needsSetup(inputs.report) || inputs.stored === undefined) {
    return { kind: "unconfigured" };
  }
  return {
    kind: "healthy",
    keySetAt: inputs.stored.setAt,
    lastTestedAt: inputs.lastTestedAt,
    interruption: interruptionFor(inputs.report),
    counts: inputs.report.counts,
    detailsOpen: inputs.detailsOpen,
  };
}

/**
 * Error before warning; within a level, credential before configuration before
 * installation, because a missing key blocks everything else. Info never
 * interrupts (plan Q-AL: drift stays in Details — Claude Code's own
 * `/setup-bedrock` causes most of it, and a non-technical user did not do it
 * on purpose). Plugins never interrupt either; nothing there blocks a session.
 */
const GROUP_PRIORITY: readonly CheckGroup[] = ["Credential", "Configuration", "Installation"];

export function interruptionFor(report: HealthReport): Interruption | undefined {
  for (const level of ["error", "warning"] as const) {
    for (const group of GROUP_PRIORITY) {
      const hit = report.results.find((r) => r.level === level && r.group === group);
      if (hit !== undefined) return toInterruption(level, hit);
    }
  }
  return undefined;
}

function toInterruption(level: "error" | "warning", check: CheckResult): Interruption {
  const action =
    check.fix.kind === "command" && ALLOWED_ACTIONS.has(check.fix.command)
      ? { command: check.fix.command, title: check.fix.title }
      : undefined;
  return { level, sentence: check.label, action };
}

/**
 * One sentence and one primary action per outcome. The sentences are the
 * `cred.valid` labels so the panel and the toast never disagree; only the
 * action differs, because here the user is mid-flow and the next click is
 * known.
 */
export interface ResultView {
  ok: boolean;
  sentence: string;
  hint: string | undefined;
  primary: { label: string; message: SetupMessage } | Action;
  secondary: Action | undefined;
}

/** The setup-flow messages a result's primary button may post. */
export type SetupMessage = "setup.finish" | "setup.restart" | "setup.retest";

export function resultView(result: ConnectionResult): ResultView {
  const L = LABELS["cred.valid"];
  switch (result.kind) {
    case "ok":
      return {
        ok: true,
        sentence: L.pass,
        hint: "Claude Code is set up.",
        primary: { label: "Done", message: "setup.finish" },
        secondary: undefined,
      };
    case "ok-without-haiku":
      return {
        ok: true,
        sentence: L.withoutHaiku,
        hint: "Everything else works. You can turn it on later in the Amazon console.",
        primary: { label: "Done", message: "setup.finish" },
        secondary: undefined,
      };
    case "bad-credential":
      return {
        ok: false,
        sentence: L.badCredential,
        hint: "Check it in the Amazon console and paste it again. Keys can expire.",
        primary: { label: "Try a different key", message: "setup.restart" },
        secondary: { command: "sensibleDefaults.testConnection", title: "Test again" },
      };
    case "insufficient-permissions":
      return {
        ok: false,
        sentence: L.insufficientPermissions,
        hint: undefined,
        primary: { label: "Try a different key", message: "setup.restart" },
        secondary: {
          command: "sensibleDefaults.copyDiagnostics",
          title: "Copy details for whoever issued it",
        },
      };
    case "model-not-enabled":
      return {
        ok: false,
        sentence: L.modelNotEnabled,
        hint: "In the Amazon Bedrock console, open Model catalog, pick a Claude model and submit the form. Then test again.",
        primary: { label: "Test again", message: "setup.retest" },
        secondary: undefined,
      };
    case "wrong-region":
      return {
        ok: false,
        sentence: L.wrongRegion,
        hint: undefined,
        primary: { label: "Test again", message: "setup.retest" },
        secondary: { command: "sensibleDefaults.selectRegion", title: "Change region" },
      };
    case "network":
      return {
        ok: false,
        ...networkGuidance(result.reason),
        primary: { label: "Test again", message: "setup.retest" },
        secondary: { command: "sensibleDefaults.copyDiagnostics", title: "Copy diagnostics" },
      };
    case "unknown":
      return {
        ok: false,
        sentence: `${L.unknown} (HTTP ${result.status})`,
        hint: undefined,
        primary: { label: "Test again", message: "setup.retest" },
        secondary: { command: "sensibleDefaults.copyDiagnostics", title: "Copy diagnostics" },
      };
  }
}

/** Webview → extension. The key is validated/submitted and is never sent back. */
export type WebviewInbound =
  | { type: "ready" }
  | { type: "setup.start" }
  | { type: "setup.check" }
  | { type: "key.changed"; value: string }
  | { type: "key.submit"; value: string }
  | { type: "setup.retest" }
  | { type: "setup.restart" }
  | { type: "setup.finish" }
  | { type: "console.open" }
  | { type: "details.toggle" }
  | { type: "action.run"; command: string };

/** Extension → webview. */
export type WebviewOutbound =
  | { type: "state"; state: PanelState }
  | ({ type: "key.feedback" } & Extract<SetupProgress, { step: "key" }>);

const INBOUND_TYPES: ReadonlySet<string> = new Set([
  "ready",
  "setup.start",
  "setup.check",
  "key.changed",
  "key.submit",
  "setup.retest",
  "setup.restart",
  "setup.finish",
  "console.open",
  "details.toggle",
  "action.run",
]);

/**
 * Accept only the shapes above. Everything a renderer sends is untrusted; a
 * malformed message is dropped rather than thrown on, and never reaches a
 * command.
 */
export function parseInbound(raw: unknown): WebviewInbound | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string" || !INBOUND_TYPES.has(type)) return undefined;
  if (type === "key.changed" || type === "key.submit") {
    const value = (raw as { value?: unknown }).value;
    return typeof value === "string" ? { type, value } : undefined;
  }
  if (type === "action.run") {
    const command = (raw as { command?: unknown }).command;
    return typeof command === "string" && ALLOWED_ACTIONS.has(command)
      ? { type, command }
      : undefined;
  }
  return { type } as WebviewInbound;
}
