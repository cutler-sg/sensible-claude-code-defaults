/**
 * Persistence for the last-applied snapshot (plan Q-D).
 *
 * The snapshot is the extension's Terraform state: it records exactly what we
 * last wrote to `settings.json`, so the merge engine can tell "we wrote this"
 * from "the user (or Claude Code) wrote this". Losing it is recoverable — every
 * managed key then reads as unowned and is preserved — but corrupting it
 * silently is not, so a file we cannot read is renamed aside rather than
 * deleted.
 *
 * Invariant: nothing here imports `vscode`. The Memento-backed store is
 * structurally typed so it stays on this side of the line.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assertOutsideWorkspace } from "./paths.js";
import { EMPTY_SNAPSHOT, type JsonValue, type Snapshot, type SnapshotStore } from "./types.js";

/** A fresh empty snapshot. Never hand out `EMPTY_SNAPSHOT` itself. */
function emptySnapshot(): Snapshot {
  return structuredClone(EMPTY_SNAPSHOT);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Anything `JSON.stringify` can write and `JSON.parse` can read back. */
function isJsonValue(value: unknown, seen: Set<object> = new Set()): value is JsonValue {
  if (value === null) {
    return true;
  }
  const type = typeof value;
  if (type === "string" || type === "boolean") {
    return true;
  }
  if (type === "number") {
    // NaN and ±Infinity stringify to `null`, so they are not round-trippable.
    return Number.isFinite(value);
  }
  if (type !== "object") {
    return false;
  }
  // A cycle would make `structuredClone` succeed and `JSON.stringify` throw,
  // which is the worst possible split (F17).
  const object = value as object;
  if (seen.has(object)) {
    return false;
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return object.every((element) => isJsonValue(element, seen));
    }
    if (Object.getPrototypeOf(object) !== Object.prototype) {
      return false;
    }
    return Object.values(object).every((element) => isJsonValue(element, seen));
  } finally {
    seen.delete(object);
  }
}

/**
 * Validate an untrusted value into a snapshot, or `undefined` if it is not one.
 *
 * Keys no longer in `MANAGED_KEYS` are kept, not dropped: a future version may
 * stop managing a key, and forgetting on load then writing back on save turns
 * "we still own this" into "nobody wrote this" — the record of a value we
 * placed in the user's file, gone (F13). Unmanaged entries are inert, since
 * `merge` only consults keys present in `desired`.
 *
 * A value that is not JSON invalidates the whole snapshot rather than being
 * cast through: the file store quarantines it, the memento store starts empty.
 */
function parseSnapshot(candidate: unknown): Snapshot | undefined {
  if (!isPlainObject(candidate)) {
    return undefined;
  }
  if (candidate.schemaVersion !== 1) {
    return undefined;
  }
  if (!isPlainObject(candidate.values)) {
    return undefined;
  }
  if (!isJsonValue(candidate.values)) {
    return undefined;
  }

  // The cast is the passthrough: entries whose key is not a `ManagedKey` do not
  // fit `Snapshot["values"]`, and carrying them is the point.
  const values = structuredClone(candidate.values) as Snapshot["values"];

  const snapshot: Snapshot = { schemaVersion: 1, values };
  if (typeof candidate.manifestRevision === "string") {
    snapshot.manifestRevision = candidate.manifestRevision;
  }
  if (typeof candidate.appliedAt === "string") {
    snapshot.appliedAt = candidate.appliedAt;
  }
  return snapshot;
}

/**
 * Snapshot on disk, next to the `settings.json` it describes.
 *
 * Mode `0600` throughout: the snapshot records the value we wrote to
 * `env.AWS_BEARER_TOKEN_BEDROCK`, so it is as sensitive as the settings file.
 */
export interface SnapshotStoreOptions {
  /** Absolute workspace folder paths; a write resolving into any of them is refused. */
  workspaceFolders: readonly string[];
  /** Injected for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

export class FileSnapshotStore implements SnapshotStore {
  constructor(
    private readonly file: string,
    private readonly opts: SnapshotStoreOptions = { workspaceFolders: [] },
  ) {}

  async load(): Promise<Snapshot> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return emptySnapshot();
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }

    const snapshot = parseSnapshot(parsed);
    if (snapshot !== undefined) {
      return snapshot;
    }

    await this.quarantine();
    return emptySnapshot();
  }

  async save(snapshot: Snapshot): Promise<void> {
    // FR-2.6: the snapshot holds the value we wrote to
    // `env.AWS_BEARER_TOKEN_BEDROCK`, so it is exactly as unwelcome inside a
    // workspace folder as `settings.json` is (F14).
    await this.assertOutside(this.file);
    const body = `${JSON.stringify(snapshot, null, 2)}\n`;
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let created = false;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const handle = await open(temp, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(body, "utf8");
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.file);
    } catch (error) {
      if (created) await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** Move an unreadable snapshot aside so a support request can still see it. */
  private async quarantine(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = `${this.file}.corrupt-${stamp}`;
    try {
      await this.assertOutside(target);
      await rename(this.file, target);
    } catch {
      // The snapshot is advisory; failing to set it aside — including because
      // it would land inside a workspace folder — must not fail a load.
    }
  }

  /** Guard the literal path and the path a symlink actually leads to (F1, F14). */
  private async assertOutside(target: string): Promise<void> {
    const platform = this.opts.platform ?? process.platform;
    assertOutsideWorkspace(target, this.opts.workspaceFolders, platform);
    assertOutsideWorkspace(await resolveTarget(target), this.opts.workspaceFolders, platform);
  }
}

/** The file a path really names, falling back to its parent when it does not exist yet. */
async function resolveTarget(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    try {
      return join(await realpath(dirname(file)), basename(file));
    } catch {
      return resolve(file);
    }
  }
}

/** In-memory store for testing modules that take a `SnapshotStore`. */
export class MemorySnapshotStore implements SnapshotStore {
  private snapshot: Snapshot;

  constructor(initial: Snapshot = EMPTY_SNAPSHOT) {
    this.snapshot = structuredClone(initial);
  }

  async load(): Promise<Snapshot> {
    return structuredClone(this.snapshot);
  }

  async save(snapshot: Snapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }
}

/** The slice of `vscode.Memento` we need, declared structurally. */
export interface SnapshotMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const MEMENTO_SNAPSHOT_KEY = "sensibleDefaults.snapshot";

/**
 * Snapshot in the editor's `globalState`. Kept as the alternative if plan Q-D
 * is overruled; note that it is per-editor-install, so two editors on one
 * machine each see the other's applies as drift.
 */
export function createMementoSnapshotStore(
  memento: SnapshotMemento,
  key: string = MEMENTO_SNAPSHOT_KEY,
): SnapshotStore {
  return {
    async load(): Promise<Snapshot> {
      return parseSnapshot(memento.get<unknown>(key)) ?? emptySnapshot();
    },
    async save(snapshot: Snapshot): Promise<void> {
      await memento.update(key, structuredClone(snapshot));
    },
  };
}
