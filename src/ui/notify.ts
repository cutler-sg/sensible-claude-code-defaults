/**
 * FR-5.5 notification discipline, as a pure function.
 *
 * The rule is a product decision, not a UI detail — non-technical users
 * disengage from repeated prompts faster than any other cohort — so it lives
 * somewhere it can be tested exhaustively rather than inside a callback.
 */

import type { Transition } from "../health/runner.js";
import type { HealthReport } from "../health/types.js";

/** The runner decides *when*; this file decides *what to say*. */
export type NotificationKind = Transition;

export interface Notification {
  message: string;
  actions: string[];
}

export const APPLY_ACTION = "Apply recommended configuration";
export const DETAILS_ACTION = "Show details";

export function decideNotification(
  kind: NotificationKind,
  report: HealthReport,
): Notification | undefined {
  switch (kind) {
    case "first-run":
      return {
        message: "Claude Code isn't set up for AWS Bedrock yet.",
        actions: [APPLY_ACTION],
      };
    case "healthy-to-fail":
      // Defensive: a healthy→fail transition with nothing failing would be a
      // runner bug, and a toast pointing at an all-green panel is worse than
      // silence.
      return report.counts.error === 0
        ? undefined
        : { message: "Claude Code configuration needs attention.", actions: [DETAILS_ACTION] };
    case "none":
      return undefined;
  }
}
