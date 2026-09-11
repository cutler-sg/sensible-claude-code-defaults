/**
 * The host adapter for the FR-7.1 report.
 *
 * `src/diagnostics/report.ts` is `vscode`-free so §10.4 assertion #1 can be a
 * unit test; this is where that costs something. Everything the report needs
 * that only the editor knows — its own version, the remote name, Claude Code's
 * installed version — is read here and handed over as data.
 */

import * as vscode from "vscode";
import { readSettings } from "../config/index.js";
import { buildDiagnostics, type SettingsForReport } from "../diagnostics/report.js";
import type { HealthReport, ManifestStatus } from "../health/types.js";
import type { RecentLog } from "../util/log.js";

export interface DiagnosticsHostDeps {
  extensionVersion: string;
  settingsFile: string;
  /** The manifest in force, read per invocation like every other holder read. */
  manifest: () => ManifestStatus;
  /** The last health run, or undefined before the first one finishes. */
  report: () => HealthReport | undefined;
  log: RecentLog;
  /** `claude --version`'s answer, cached by the host from the last detection. */
  cliVersion: () => string | undefined;
  now?: () => Date;
}

export async function collectDiagnostics(deps: DiagnosticsHostDeps): Promise<string> {
  // Read once each: `exactOptionalPropertyTypes` means an optional field has to
  // be *absent* rather than explicitly undefined, so each of these is spread in
  // conditionally — and calling the getter twice inside that spread would let
  // the two reads disagree.
  const claudeCode = claudeCodeVersion();
  const cli = deps.cliVersion();
  const report = deps.report();
  return buildDiagnostics({
    extensionVersion: deps.extensionVersion,
    vscodeVersion: vscode.version,
    platform: process.platform,
    arch: process.arch,
    // `remoteName` is undefined in a local window, and `exactOptionalPropertyTypes`
    // means the field has to be absent rather than explicitly undefined.
    ...(vscode.env.remoteName === undefined ? {} : { remoteName: vscode.env.remoteName }),
    ...(claudeCode === undefined ? {} : { claudeCodeExtensionVersion: claudeCode }),
    ...(cli === undefined ? {} : { claudeCliVersion: cli }),
    manifest: deps.manifest(),
    settings: await readSettingsForReport(deps.settingsFile),
    ...(report === undefined ? {} : { report }),
    log: deps.log,
    now: (deps.now ?? (() => new Date()))(),
    settingsPath: deps.settingsFile,
  });
}

function claudeCodeVersion(): string | undefined {
  const version = vscode.extensions.getExtension("anthropic.claude-code")?.packageJSON?.version;
  return typeof version === "string" ? version : undefined;
}

/**
 * A file we cannot even stat reads as absent rather than throwing. The report
 * is what a user reaches for when something is broken, so it must be
 * obtainable in the states where reading the file is the broken thing —
 * `config.parses` and `config.exists` are the checks that say which.
 */
async function readSettingsForReport(file: string): Promise<SettingsForReport> {
  let read: Awaited<ReturnType<typeof readSettings>>;
  try {
    read = await readSettings(file);
  } catch {
    return { kind: "absent" };
  }
  switch (read.kind) {
    case "ok":
      return { kind: "ok", data: read.data };
    case "malformed":
      return { kind: "malformed", raw: read.raw };
    case "absent":
      return { kind: "absent" };
  }
}
