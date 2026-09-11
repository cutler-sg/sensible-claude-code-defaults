/**
 * The cached manifest in `globalState` (FR-3.3).
 *
 * The cache is the middle rung of the fallback chain: when the network is gone,
 * this is what the user's defaults come from. So `load` is a validator, not a
 * reader — every path that cannot prove the entry is a manifest we ourselves
 * stored, for the URL currently configured, returns `undefined` and lets the
 * caller drop to the bundled copy.
 *
 * Rejecting is always safe here (the bundled floor is one step below) and
 * accepting something wrong is not, so every doubt resolves to `undefined`.
 *
 * The Memento is structurally typed, as in `src/config/snapshot.ts`, so nothing
 * under `src/manifest/` imports `vscode`.
 */

import { validateManifest } from "./schema.js";
import type { Manifest } from "./types.js";

/** The slice of `vscode.Memento` we need, declared structurally. */
export interface ManifestMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface CachedManifest {
  manifest: Manifest;
  /** ISO 8601. When we fetched it, which is what "saved defaults from <date>" names. */
  fetchedAt: string;
  /** The URL it came from, so a changed setting invalidates rather than misleads. */
  url: string;
}

export interface ManifestCache {
  load(url: string): CachedManifest | undefined;
  save(entry: CachedManifest): Promise<void>;
}

export const MEMENTO_MANIFEST_KEY = "sensibleDefaults.manifest";

export function createManifestCache(
  memento: ManifestMemento,
  key: string = MEMENTO_MANIFEST_KEY,
): ManifestCache {
  return {
    load(url: string): CachedManifest | undefined {
      return parseEntry(memento.get<unknown>(key), url);
    },
    async save(entry: CachedManifest): Promise<void> {
      await memento.update(key, structuredClone(entry));
    },
  };
}

function parseEntry(candidate: unknown, url: string): CachedManifest | undefined {
  if (!isPlainObject(candidate)) return undefined;
  if (typeof candidate.fetchedAt !== "string" || Number.isNaN(Date.parse(candidate.fetchedAt))) {
    return undefined;
  }
  // A manifest cached from a different URL is not ours. The setting is
  // user-editable and a fork's manifest surviving a switch back to the default
  // would be the update channel quietly still pointing at the fork.
  if (typeof candidate.url !== "string" || candidate.url !== url) return undefined;

  // Re-validated on every load, not trusted because we wrote it: the schema
  // tightens between releases, and an entry stored by an older extension may
  // hold a shape this one has since decided it will not act on.
  const result = validateManifest(candidate.manifest);
  if (!result.ok) return undefined;

  return { manifest: result.manifest, fetchedAt: candidate.fetchedAt, url: candidate.url };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** In-memory Memento for testing anything that takes a `ManifestCache`. */
export class MemoryManifestMemento implements ManifestMemento {
  readonly #values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.#values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.#values.set(key, value);
  }
}
