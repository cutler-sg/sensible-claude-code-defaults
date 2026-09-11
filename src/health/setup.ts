/**
 * FR-5.5: Claude Code is installed but has never been configured for Bedrock.
 * This is the one report shape both the tree and the panel branch on, and it
 * lives here rather than in either so the panel's reducer stays free of the
 * `vscode` module and can be unit-tested without a stub.
 */

import type { HealthReport } from "./types.js";

export function needsSetup(report: HealthReport): boolean {
  const level = (id: string): string | undefined =>
    report.results.find((result) => result.id === id)?.level;
  return level("install.extension") === "pass" && isUnconfigured(level("config.exists"));
}

function isUnconfigured(level: string | undefined): boolean {
  return level !== undefined && level !== "pass";
}
