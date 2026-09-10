/**
 * Three-way merge between the user's `settings.json`, the last-applied
 * snapshot, and the defaults we want (FR-2.2, plan Q-E and Q-G).
 *
 * Pure: no I/O, no mutation of the inputs. The snapshot is the state file in
 * the Terraform analogy — without it, drift is indistinguishable from user
 * intent, so anything we cannot prove we wrote is preserved and reported.
 */

import { deletePath, getPath, isElementOwned, isJsonObject, setPath } from "./managedKeys.js";
import {
  type Change,
  ConfigError,
  type Desired,
  type Drift,
  type ElementOwnedKey,
  type JsonObject,
  type JsonValue,
  MANAGED_KEYS,
  type ManagedKey,
  type MergeResult,
  type Settings,
  type Snapshot,
} from "./types.js";

export function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((element, index) => deepEqual(element, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  // `Object.hasOwn`, never `in`: a key named `toString` would otherwise match
  // against `Object.prototype` and compare equal to a function.
  return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/** What the caller wants for one slot: a value, or its removal (Q-G). */
type Wanted = { kind: "value"; value: JsonValue } | { kind: "removal" };

const REMOVAL: Wanted = { kind: "removal" };

function wantedOf(value: JsonValue | undefined): Wanted {
  return value === undefined ? REMOVAL : { kind: "value", value };
}

function recommendedOf(want: Wanted): JsonValue | undefined {
  return want.kind === "value" ? want.value : undefined;
}

/** How a slot's current value relates to what we last wrote there. */
type Provenance =
  /** Nothing there — we are free to write. */
  | "absent"
  /** Present, but we never wrote it: unknown provenance, so hands off. */
  | "unowned"
  /** Present and byte-identical to our snapshot: ours, untouched. */
  | "ours"
  /** Present, we wrote it, and someone (user or Claude Code) changed it. */
  | "contested";

interface Outcome {
  readonly action: "write" | "remove" | "keep";
  readonly drift: boolean;
  /** `desired` records what we wrote, `carry` keeps the existing entry. */
  readonly snapshot: "desired" | "carry" | "drop";
}

const WRITE: Outcome = { action: "write", drift: false, snapshot: "desired" };
const REMOVE: Outcome = { action: "remove", drift: false, snapshot: "drop" };
const KEEP: Outcome = { action: "keep", drift: false, snapshot: "carry" };
/** Nothing to remove and nothing to own: forget the stale snapshot entry. */
const FORGET: Outcome = { action: "keep", drift: false, snapshot: "drop" };
const CONTEST: Outcome = { action: "keep", drift: true, snapshot: "carry" };

interface Row {
  /** `matchesDesired` is deep equality between the current and desired value. */
  readonly wanted: (matchesDesired: boolean) => Outcome;
  readonly unwanted: Outcome;
}

/** FR-2.2's decision table, one row per provenance. The whole engine is here. */
const TABLE: Record<Provenance, Row> = {
  absent: { wanted: () => WRITE, unwanted: FORGET },
  unowned: { wanted: (matches) => (matches ? KEEP : CONTEST), unwanted: KEEP },
  ours: { wanted: (matches) => (matches ? KEEP : WRITE), unwanted: REMOVE },
  contested: { wanted: () => CONTEST, unwanted: CONTEST },
};

function resolve(
  current: JsonValue | undefined,
  lastApplied: JsonValue | undefined,
  want: Wanted,
): Outcome {
  const provenance: Provenance =
    current === undefined
      ? "absent"
      : lastApplied === undefined
        ? "unowned"
        : deepEqual(current, lastApplied)
          ? "ours"
          : "contested";
  const row = TABLE[provenance];
  return want.kind === "value" ? row.wanted(deepEqual(current, want.value)) : row.unwanted;
}

/** How one managed key changes the accumulators of `merge`. */
interface KeyOutcome {
  readonly next: Settings;
  readonly change: Change | undefined;
  readonly drift: Drift | undefined;
  readonly snapshot: { kind: "carry" } | { kind: "drop" } | { kind: "set"; value: JsonValue };
}

export function merge(current: Settings, snapshot: Snapshot, desired: Desired): MergeResult {
  let next = current;
  const changes: Change[] = [];
  const drift: Drift[] = [];
  // Start from the whole snapshot: keys we are not asked about this round are
  // still ours, and unknown keys are carried through untouched.
  const snapshotValues: Snapshot["values"] = { ...snapshot.values };

  for (const key of MANAGED_KEYS) {
    if (!(key in desired)) continue;
    const want = wantedOf(desired[key]);
    const lastApplied = snapshot.values[key];
    const outcome = isElementOwned(key)
      ? mergeElementOwned(next, key, lastApplied, want)
      : mergeScalar(next, key, lastApplied, want);

    next = outcome.next;
    if (outcome.change !== undefined) changes.push(outcome.change);
    if (outcome.drift !== undefined) drift.push(outcome.drift);
    if (outcome.snapshot.kind === "set") snapshotValues[key] = outcome.snapshot.value;
    else if (outcome.snapshot.kind === "drop") delete snapshotValues[key];
  }

  return { next, changes, drift, snapshotValues };
}

function mergeScalar(
  settings: Settings,
  key: ManagedKey,
  lastApplied: JsonValue | undefined,
  want: Wanted,
): KeyOutcome {
  const current = getPath(settings, key);
  const outcome = resolve(current, lastApplied, want);
  const drift = outcome.drift
    ? { key, current, lastApplied, recommended: recommendedOf(want) }
    : undefined;

  if (outcome.action === "keep") {
    const snapshot =
      outcome.snapshot === "drop" ? ({ kind: "drop" } as const) : ({ kind: "carry" } as const);
    return { next: settings, change: undefined, drift, snapshot };
  }
  if (want.kind === "value") {
    return {
      next: setPath(settings, key, want.value),
      change: {
        key,
        kind: current === undefined ? "add" : "update",
        before: current,
        after: want.value,
      },
      drift,
      snapshot: { kind: "set", value: want.value },
    };
  }
  return {
    next: deletePath(settings, key),
    change: { key, kind: "remove", before: current, after: undefined },
    drift,
    snapshot: { kind: "drop" },
  };
}

/** The merged container plus the element-level bookkeeping it produced. */
interface ElementMerge {
  readonly value: JsonValue;
  /** True when `value` differs from what is in the file today. */
  readonly changed: boolean;
  /** The subset of elements we own afterwards; `undefined` when we own none. */
  readonly owned: JsonValue | undefined;
  readonly contested: Omit<Drift, "key"> | undefined;
}

/**
 * Element-owned keys (plan Q-E): the snapshot holds the subset of elements we
 * wrote, and each element runs through the same table. Elements the user added
 * are preserved and never removed; a whole-key removal (`desired = undefined`)
 * removes only the elements we own.
 */
function mergeElementOwned(
  settings: Settings,
  key: ElementOwnedKey,
  lastApplied: JsonValue | undefined,
  want: Wanted,
): KeyOutcome {
  // A non-object `permissions` throws out of `getPath`, deliberately: that is
  // the same class of malformation as a non-object `env`, and merge may assert
  // on structure the reader should already have rejected.
  const current = getPath(settings, key);
  const isList = key === "permissions.deny";
  const wellShaped = (value: JsonValue): boolean =>
    isList ? Array.isArray(value) : isJsonObject(value);

  if (current !== undefined && !wellShaped(current)) {
    // A managed key of the wrong shape is the user's problem, not ours: leave
    // it exactly as it is and let the health panel offer a reset.
    return {
      next: settings,
      change: undefined,
      drift: { key, current, lastApplied, recommended: recommendedOf(want) },
      snapshot: { kind: "carry" },
    };
  }
  if (want.kind === "value" && !wellShaped(want.value)) {
    throw new ConfigError(
      "MALFORMED_SETTINGS",
      `Desired value for "${key}" must be ${isList ? "an array" : "an object"}.`,
    );
  }

  const merged = isList
    ? mergeList(asList(current), asList(lastApplied), asList(recommendedOf(want)))
    : mergeMap(asMap(current), asMap(lastApplied), asMap(recommendedOf(want)));

  return {
    next: merged.changed ? setPath(settings, key, merged.value) : settings,
    change: merged.changed
      ? {
          key,
          kind: current === undefined ? "add" : "update",
          before: current,
          after: merged.value,
        }
      : undefined,
    drift: merged.contested === undefined ? undefined : { key, ...merged.contested },
    snapshot: merged.owned === undefined ? { kind: "drop" } : { kind: "set", value: merged.owned },
  };
}

/** A wrong-shaped snapshot means we can prove we own nothing — the safe read. */
function asList(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function asMap(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

/**
 * Element ids are user data, and `Object.prototype` has real values at
 * `toString`, `constructor` and `valueOf`. Reading `map[id]` there would invent
 * provenance the snapshot never recorded and put a function into the document,
 * which `JSON.stringify` then drops — a silent deletion of the user's entry.
 */
function own(map: JsonObject, id: string): JsonValue | undefined {
  return Object.hasOwn(map, id) ? map[id] : undefined;
}

/** An accumulator that can hold any id, `__proto__` included. */
function emptyMap(): JsonObject {
  return Object.create(null) as JsonObject;
}

/**
 * Back to an ordinary object for the document. Spreading *defines* each key, so
 * an entry named `__proto__` stays an own property instead of reassigning the
 * prototype and vanishing.
 */
function plainMap(map: JsonObject): JsonObject {
  return { ...map };
}

function has(list: readonly JsonValue[], element: JsonValue): boolean {
  return list.some((candidate) => deepEqual(candidate, element));
}

/**
 * `permissions.deny` is a set: an element's identity *is* its value, so an
 * element can only be added or removed, never edited — the `contested` row is
 * unreachable per element. Order is insignificant, so existing order is kept
 * and new rules append.
 */
function mergeList(
  current: readonly JsonValue[],
  lastApplied: readonly JsonValue[],
  desired: readonly JsonValue[],
): ElementMerge {
  const next: JsonValue[] = [];
  const owned: JsonValue[] = [];
  let changed = false;

  for (const element of current) {
    const mine = has(lastApplied, element) ? element : undefined;
    const want: Wanted = has(desired, element) ? { kind: "value", value: element } : REMOVAL;
    if (resolve(element, mine, want).action === "remove") {
      changed = true;
      continue;
    }
    next.push(element);
    if (mine !== undefined) owned.push(element);
  }

  for (const element of desired) {
    if (has(current, element)) continue;
    // Table row `absent` + wanted: add it, and record it as ours.
    next.push(element);
    owned.push(element);
    changed = true;
  }

  return {
    value: next,
    changed,
    owned: owned.length > 0 ? owned : undefined,
    contested: undefined,
  };
}

function mergeMap(current: JsonObject, lastApplied: JsonObject, desired: JsonObject): ElementMerge {
  const next = emptyMap();
  const owned = emptyMap();
  const contestedCurrent = emptyMap();
  const contestedLastApplied = emptyMap();
  const contestedRecommended = emptyMap();
  let contestedCount = 0;
  let changed = false;

  for (const id of Object.keys(current)) {
    const value = current[id] as JsonValue;
    const mine = own(lastApplied, id);
    const want = wantedOf(own(desired, id));
    const outcome = resolve(value, mine, want);

    if (outcome.drift) {
      contestedCount += 1;
      contestedCurrent[id] = value;
      if (mine !== undefined) contestedLastApplied[id] = mine;
      if (want.kind === "value") contestedRecommended[id] = want.value;
    }

    if (outcome.action === "remove") {
      changed = true;
      continue;
    }
    if (outcome.action === "write" && want.kind === "value") {
      next[id] = want.value;
      owned[id] = want.value;
      changed = true;
      continue;
    }
    next[id] = value;
    // Carry our old entry, never the user's value: ownership is only ever
    // acquired by writing, so a preserved value stays unowned.
    if (mine !== undefined) owned[id] = mine;
  }

  for (const id of Object.keys(desired)) {
    if (Object.hasOwn(current, id)) continue;
    // Table row `absent` + wanted: add it, and record it as ours.
    const value = desired[id] as JsonValue;
    next[id] = value;
    owned[id] = value;
    changed = true;
  }

  return {
    value: plainMap(next),
    changed,
    owned: Object.keys(owned).length > 0 ? plainMap(owned) : undefined,
    contested:
      contestedCount === 0
        ? undefined
        : {
            current: plainMap(contestedCurrent),
            lastApplied: plainMap(contestedLastApplied),
            recommended: plainMap(contestedRecommended),
          },
  };
}
