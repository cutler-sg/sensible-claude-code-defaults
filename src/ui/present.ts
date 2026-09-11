/**
 * Presentation helpers that do not touch `vscode`.
 *
 * Everything the panel and the command messages render passes through here, so
 * the wording, the icon mapping, and the secret masking are all unit-testable
 * without an extension host — and there is exactly one place where a managed
 * key's value is turned into a string a human will read.
 */

import { REDACTED, SECRET_KEYS } from "../config/index.js";
import type { Change, JsonValue } from "../config/types.js";
import { keyDisplayName } from "../health/labels.js";
import type { CheckGroup, Level } from "../health/types.js";

/** A codicon id plus the theme colour token it is tinted with, if any. */
export interface IconSpec {
  readonly id: string;
  readonly color?: string;
}

const ICONS: Record<Level, IconSpec> = {
  pass: { id: "check", color: "testing.iconPassed" },
  warning: { id: "warning", color: "list.warningForeground" },
  error: { id: "error", color: "list.errorForeground" },
  info: { id: "info" },
  skipped: { id: "circle-outline", color: "disabledForeground" },
};

export function iconFor(level: Level): IconSpec {
  return ICONS[level];
}

/** FR-5 / §13 accessibility: the group is the context a screen reader loses. */
export function accessibilityLabel(group: CheckGroup, label: string, level: Level): string {
  return `${group}: ${label}, ${level}`;
}

/**
 * One diff line for the apply preview.
 *
 * Callers pass changes through `redactChanges` first; the secret check here is
 * the belt to that braces, because this function is the last thing between a
 * managed value and a notification, and a bearer token that reaches a toast is
 * not recoverable by any later fix.
 */
export function describeChange(change: Change): string {
  const secret = SECRET_KEYS.has(change.key);
  const before = secret && change.before !== undefined ? REDACTED : formatValue(change.before);
  const after =
    change.after === undefined ? "(removed)" : secret ? REDACTED : formatValue(change.after);
  return `${keyDisplayName(change.key)} — ${before} → ${after}`;
}

/**
 * The rules an apply would stop blocking (F2).
 *
 * `permissions.deny` is element-owned, so an element we wrote is ours to
 * remove: a manifest revision that simply stops listing `Read(./.env)` removes
 * it from every install at once, with `drift` empty because nothing was
 * contested, and `config.stale` saying only "there are newer recommended
 * settings to apply" — which the user presses.
 *
 * The removal is in `describeChange`'s output already, as a before-set and an
 * after-set joined by commas. Reading that means diffing two comma-separated
 * lists by eye, which is the exact task this extension exists because its
 * audience cannot do. So the losses are extracted here and rendered as their
 * own sentences, above everything else in the preview.
 *
 * Only removals: a list that grows is the update channel doing its job, and a
 * row per addition would bury the one row that matters.
 */
export function droppedProtections(changes: readonly Change[]): string[] {
  const dropped: string[] = [];
  for (const change of changes) {
    if (change.key !== "permissions.deny") continue;
    // A `before` that is not a list is a malformed file the merge engine
    // already refuses to touch; there is nothing to have lost.
    if (!Array.isArray(change.before)) continue;
    // `after === undefined` is the whole key being removed, which drops all of
    // it. Anything else non-list cannot happen, and reading it as "everything
    // is gone" would overstate rather than understate the loss.
    const after = Array.isArray(change.after) ? change.after : [];
    for (const rule of change.before) {
      if (!after.some((kept) => sameRule(kept, rule))) dropped.push(formatValue(rule));
    }
  }
  return dropped;
}

/**
 * By serialised value, matching `merge.ts`'s set semantics for this key: a deny
 * rule's identity *is* its value, so an element can only be added or removed.
 */
function sameRule(a: JsonValue, b: JsonValue): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** One dropped rule, as a sentence rather than as a diff the reader computes. */
export function describeDroppedProtection(rule: string): string {
  return `Stops blocking: ${rule}`;
}

/** Values are rendered for reading, not for round-tripping: no quotes on strings. */
export function formatValue(value: JsonValue | undefined): string {
  if (value === undefined) return "(not set)";
  if (typeof value === "string") return value === "" ? '""' : value;
  if (Array.isArray(value))
    return value.length === 0 ? "(none)" : value.map(formatValue).join(", ");
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length === 0 ? "(none)" : keys.join(", ");
  }
  return JSON.stringify(value);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 minutes ago" — backups are chosen by when, never by filename. */
export function relativeAge(from: Date, now: Date): string {
  const elapsed = now.getTime() - from.getTime();
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), "hour");
  return plural(Math.floor(elapsed / DAY), "day");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

export function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
