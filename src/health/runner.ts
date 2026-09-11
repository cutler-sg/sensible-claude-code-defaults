/**
 * Runs the catalogue and decides whether the result is worth interrupting the
 * user over.
 *
 * Sequential rather than parallel: every check reads the same prebuilt context
 * and none of them does I/O, so concurrency would buy nothing and cost a
 * deterministic result order.
 */

import { LABELS } from "./labels.js";
import type { Check, CheckContext, CheckResult, HealthReport } from "./types.js";
import { countLevels } from "./types.js";

export async function runAll(
  checks: readonly Check[],
  ctx: CheckContext,
  now: () => Date = () => new Date(),
): Promise<HealthReport> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await runOne(check, ctx));
  }
  return { at: now().toISOString(), results, counts: countLevels(results) };
}

/**
 * A check that throws becomes an error-level result rather than an empty panel.
 * Containment lives here, not in each check body, so a check added later cannot
 * forget it.
 */
async function runOne(check: Check, ctx: CheckContext): Promise<CheckResult> {
  try {
    return await check.run(ctx);
  } catch (error) {
    return {
      id: check.id,
      group: check.group,
      level: "error",
      label: LABELS.crashed,
      detail: error instanceof Error ? error.message : String(error),
      fix: { kind: "none" },
    };
  }
}

export type Transition = "first-run" | "healthy-to-fail" | "none";

/**
 * FR-5.5: the only two moments that earn a notification. Everything else — a
 * warning, a still-failing report, a second window opening — is silent, because
 * this audience disengages from repeated prompts faster than any other.
 */
export function transition(prev: HealthReport | undefined, next: HealthReport): Transition {
  if (prev === undefined) {
    // Plan Q-R: no point prompting someone to configure a tool they have not
    // installed — `install.extension` failing is its own, louder problem.
    return isFirstRun(next) ? "first-run" : "none";
  }
  return prev.counts.error === 0 && next.counts.error > 0 ? "healthy-to-fail" : "none";
}

function isFirstRun(report: HealthReport): boolean {
  return (
    levelOf(report, "config.exists") !== "pass" && levelOf(report, "install.extension") === "pass"
  );
}

function levelOf(report: HealthReport, id: CheckResult["id"]): CheckResult["level"] | undefined {
  return report.results.find((result) => result.id === id)?.level;
}
