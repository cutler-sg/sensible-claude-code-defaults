import { describe, expect, it } from "vitest";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import {
  type CachedManifest,
  createManifestCache,
  MEMENTO_MANIFEST_KEY,
  MemoryManifestMemento,
} from "../../../src/manifest/cache.js";

const URL_ = "https://example.com/defaults.json";
const FETCHED_AT = "2026-09-11T00:00:00.000Z";

function entry(overrides: Partial<CachedManifest> = {}): CachedManifest {
  return {
    manifest: structuredClone(BUNDLED_MANIFEST),
    fetchedAt: FETCHED_AT,
    url: URL_,
    ...overrides,
  };
}

function withStored(value: unknown): ReturnType<typeof createManifestCache> {
  const memento = new MemoryManifestMemento();
  void memento.update(MEMENTO_MANIFEST_KEY, value);
  return createManifestCache(memento);
}

describe("createManifestCache", () => {
  it("round-trips a saved entry", async () => {
    const cache = createManifestCache(new MemoryManifestMemento());
    await cache.save(entry());
    expect(cache.load(URL_)).toEqual(entry());
  });

  it("stores a clone, so a later mutation of the caller's object does not reach it", async () => {
    const cache = createManifestCache(new MemoryManifestMemento());
    const saved = entry();
    await cache.save(saved);
    saved.manifest.regions.push("xx-fake-1");
    expect(cache.load(URL_)?.manifest.regions).toEqual(BUNDLED_MANIFEST.regions);
  });

  it("uses a caller-supplied memento key", async () => {
    const memento = new MemoryManifestMemento();
    const cache = createManifestCache(memento, "other.key");
    await cache.save(entry());
    expect(memento.get("other.key")).toBeDefined();
    expect(memento.get(MEMENTO_MANIFEST_KEY)).toBeUndefined();
  });

  it("returns undefined when nothing is stored", () => {
    expect(createManifestCache(new MemoryManifestMemento()).load(URL_)).toBeUndefined();
  });

  it.each([
    ["a non-object", "not an object"],
    ["null", null],
    ["an array", []],
    ["a missing fetchedAt", { manifest: BUNDLED_MANIFEST, url: URL_ }],
    [
      "a non-string fetchedAt",
      { manifest: BUNDLED_MANIFEST, url: URL_, fetchedAt: 1_757_548_800_000 },
    ],
    ["an unparseable fetchedAt", { manifest: BUNDLED_MANIFEST, url: URL_, fetchedAt: "whenever" }],
    ["a missing url", { manifest: BUNDLED_MANIFEST, fetchedAt: FETCHED_AT }],
    ["a non-string url", { manifest: BUNDLED_MANIFEST, fetchedAt: FETCHED_AT, url: 7 }],
    ["a missing manifest", { fetchedAt: FETCHED_AT, url: URL_ }],
  ])("rejects %s", (_name, stored) => {
    expect(withStored(stored).load(URL_)).toBeUndefined();
  });

  it("rejects an entry cached from a different url", () => {
    expect(withStored(entry()).load("https://example.com/other.json")).toBeUndefined();
  });

  it("rejects an entry whose manifest no longer passes the schema", () => {
    const stale = { ...entry(), manifest: { ...BUNDLED_MANIFEST, schemaVersion: 0 } };
    expect(withStored(stale).load(URL_)).toBeUndefined();
  });

  it("returns the manifest the schema produced, not the raw stored object", () => {
    const withExtra = {
      ...entry(),
      manifest: { ...BUNDLED_MANIFEST, unknownFutureField: "dropped" },
    };
    const loaded = withStored(withExtra).load(URL_);
    expect(loaded?.manifest).toEqual(BUNDLED_MANIFEST);
    expect(loaded?.manifest).not.toHaveProperty("unknownFutureField");
  });
});

describe("MemoryManifestMemento", () => {
  it("reads back what it was given", async () => {
    const memento = new MemoryManifestMemento();
    expect(memento.get("k")).toBeUndefined();
    await memento.update("k", 42);
    expect(memento.get<number>("k")).toBe(42);
  });
});
