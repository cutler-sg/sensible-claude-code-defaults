import { describe, expect, it } from "vitest";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import {
  type CachedManifest,
  createManifestCache,
  MemoryManifestMemento,
} from "../../../src/manifest/cache.js";
import { type ResolveDeps, resolveManifest, THROTTLE_MS } from "../../../src/manifest/resolve.js";
import { validateManifest } from "../../../src/manifest/schema.js";
import type { Manifest } from "../../../src/manifest/types.js";

const URL_ = "https://example.com/defaults.json";
const NOW = new Date("2026-09-11T12:00:00.000Z");
const EXTENSION_VERSION = "0.1.0";

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return { ...structuredClone(BUNDLED_MANIFEST), ...overrides };
}

/** A fetch that always answers with this body, JSON-typed. */
function serving(body: unknown): typeof globalThis.fetch {
  return (() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    )) as typeof globalThis.fetch;
}

const offline = (() => Promise.reject(new Error("offline"))) as typeof globalThis.fetch;

function cacheWith(entry?: CachedManifest): ReturnType<typeof createManifestCache> {
  const memento = new MemoryManifestMemento();
  const cache = createManifestCache(memento);
  if (entry !== undefined) void cache.save(entry);
  return cache;
}

function deps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    url: URL_,
    extensionVersion: EXTENSION_VERSION,
    cache: cacheWith(),
    now: () => NOW,
    fetch: offline,
    ...overrides,
  };
}

describe("resolveManifest — the fallback chain", () => {
  it("prefers a fetched manifest and reports when it was fetched", async () => {
    const remote = manifest({ revision: "remote-1" });
    const resolution = await resolveManifest(deps({ fetch: serving(remote) }));
    expect(resolution.source).toBe("fetched");
    expect(resolution.manifest.revision).toBe("remote-1");
    expect(resolution.fetchedAt).toBe(NOW.toISOString());
    expect(resolution.problems).toEqual([]);
  });

  it("caches what it fetched, under the url it fetched from", async () => {
    const cache = cacheWith();
    await resolveManifest(deps({ cache, fetch: serving(manifest({ revision: "remote-1" })) }));
    expect(cache.load(URL_)).toEqual({
      manifest: manifest({ revision: "remote-1" }),
      fetchedAt: NOW.toISOString(),
      url: URL_,
    });
  });

  it("falls back to the cache when the fetch fails", async () => {
    const cached: CachedManifest = {
      manifest: manifest({ revision: "cached-1" }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
      url: URL_,
    };
    const resolution = await resolveManifest(deps({ cache: cacheWith(cached) }));
    expect(resolution.source).toBe("cached");
    expect(resolution.manifest.revision).toBe("cached-1");
    expect(resolution.fetchedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(resolution.problems).toEqual([{ source: "fetched", problem: "network" }]);
  });

  it("falls back to the bundled copy when the fetch fails and the cache is empty", async () => {
    const resolution = await resolveManifest(deps());
    expect(resolution.source).toBe("bundled");
    expect(resolution.manifest).toEqual(BUNDLED_MANIFEST);
    expect(resolution.fetchedAt).toBeUndefined();
  });

  it("prefers the cache when the fetched manifest fails the schema", async () => {
    const cached: CachedManifest = {
      manifest: manifest({ revision: "cached-1" }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
      url: URL_,
    };
    const resolution = await resolveManifest(
      deps({ cache: cacheWith(cached), fetch: serving({ ...BUNDLED_MANIFEST, regions: [] }) }),
    );
    expect(resolution.source).toBe("cached");
    expect(resolution.problems).toEqual([
      { source: "fetched", problem: "invalid-manifest" },
      { source: "fetched", problem: "regions: must be a non-empty array" },
    ]);
  });

  it("does not overwrite a good cache entry with an invalid fetch", async () => {
    const cached: CachedManifest = {
      manifest: manifest({ revision: "cached-1" }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
      url: URL_,
    };
    const cache = cacheWith(cached);
    await resolveManifest(deps({ cache, fetch: serving("{ not json") }));
    expect(cache.load(URL_)?.manifest.revision).toBe("cached-1");
  });

  it("falls through to the bundled copy when the cached entry is invalid", async () => {
    const memento = new MemoryManifestMemento();
    void memento.update("sensibleDefaults.manifest", {
      manifest: { ...BUNDLED_MANIFEST, schemaVersion: 99 },
      fetchedAt: "2026-09-01T00:00:00.000Z",
      url: URL_,
    });
    const resolution = await resolveManifest(deps({ cache: createManifestCache(memento) }));
    expect(resolution.source).toBe("bundled");
  });

  it("ignores a cache entry stored under a different url", async () => {
    const cached: CachedManifest = {
      manifest: manifest({ revision: "cached-1" }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
      url: "https://elsewhere.example/defaults.json",
    };
    const resolution = await resolveManifest(deps({ cache: cacheWith(cached) }));
    expect(resolution.source).toBe("bundled");
  });

  it("treats a 304 as no news rather than a problem", async () => {
    const cached: CachedManifest = {
      manifest: manifest({ revision: "cached-1" }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
      url: URL_,
    };
    const notModified = (() =>
      Promise.resolve(new Response(null, { status: 304 }))) as typeof globalThis.fetch;
    const resolution = await resolveManifest(
      deps({ cache: cacheWith(cached), fetch: notModified }),
    );
    expect(resolution.source).toBe("cached");
    expect(resolution.problems).toEqual([]);
  });

  it("always has a valid last resort", async () => {
    expect(validateManifest(BUNDLED_MANIFEST).ok).toBe(true);
    const resolution = await resolveManifest(deps());
    expect(validateManifest(resolution.manifest).ok).toBe(true);
  });

  it("returns an invalid bundled copy anyway, but says so", async () => {
    // Only reachable if the VSIX itself shipped a bad manifest — the CI test on
    // manifest/defaults.json exists to make that unreachable in practice.
    const broken = { ...BUNDLED_MANIFEST, regions: [] } as unknown as Manifest;
    const resolution = await resolveManifest(deps({ bundled: broken }));
    expect(resolution.source).toBe("bundled");
    expect(resolution.manifest).toBe(broken);
    expect(resolution.problems).toContainEqual({
      source: "bundled",
      problem: "regions: must be a non-empty array",
    });
  });
});

describe("resolveManifest — FR-3.5 minExtensionVersion gate", () => {
  it("keeps the cached manifest when the fetched one demands a newer extension", async () => {
    const cached: CachedManifest = {
      manifest: manifest({ revision: "cached-1" }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
      url: URL_,
    };
    const resolution = await resolveManifest(
      deps({
        cache: cacheWith(cached),
        fetch: serving(manifest({ revision: "remote-1", minExtensionVersion: "0.2.0" })),
      }),
    );
    expect(resolution.source).toBe("cached");
    expect(resolution.manifest.revision).toBe("cached-1");
    expect(resolution.needsExtensionVersion).toBe("0.2.0");
    expect(resolution.problems).toEqual([
      { source: "fetched", problem: "minExtensionVersion: needs 0.2.0" },
    ]);
  });

  it("does not cache a manifest the gate rejected", async () => {
    const cache = cacheWith();
    await resolveManifest(
      deps({ cache, fetch: serving(manifest({ minExtensionVersion: "0.2.0" })) }),
    );
    expect(cache.load(URL_)).toBeUndefined();
  });

  it("falls to the bundled copy when the cache is also gated", async () => {
    const cached: CachedManifest = {
      manifest: manifest({ revision: "cached-1", minExtensionVersion: "0.3.0" }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
      url: URL_,
    };
    const resolution = await resolveManifest(
      deps({
        cache: cacheWith(cached),
        fetch: serving(manifest({ minExtensionVersion: "0.9.0" })),
      }),
    );
    expect(resolution.source).toBe("bundled");
    // The freshest demand is the one worth showing: it is the newest.
    expect(resolution.needsExtensionVersion).toBe("0.9.0");
  });

  /**
   * F12. `minExtensionVersion` is the one field a manifest can use to disable
   * the update channel permanently. `"999.999.999"` gates every install to the
   * bundled copy for good — no future manifest can lift it, because the gate is
   * evaluated *before* the manifest is used — while `config.stale` tells every
   * user that an extension update with newer recommendations is available. It
   * is not, and never will be.
   *
   * The gate is a compatibility signal, not an off switch. A demand a plausible
   * release could never satisfy is not a compatibility signal, so it is ignored
   * and the manifest is admitted on its merits.
   */
  it("ignores a version gate no release could ever satisfy (F12)", async () => {
    const resolution = await resolveManifest(
      deps({
        fetch: serving(manifest({ revision: "remote-1", minExtensionVersion: "999.999.999" })),
      }),
    );

    expect(resolution.source).toBe("fetched");
    expect(resolution.manifest.revision).toBe("remote-1");
    expect(resolution.needsExtensionVersion).toBeUndefined();
  });

  it("logs the absurd gate rather than swallowing it", async () => {
    const resolution = await resolveManifest(
      deps({ fetch: serving(manifest({ minExtensionVersion: "999.999.999" })) }),
    );

    expect(resolution.problems).toContainEqual({
      source: "fetched",
      problem: "minExtensionVersion: ignoring an implausible 999.999.999",
    });
  });

  it("caches a manifest admitted past an absurd gate, so it survives a restart", async () => {
    const cache = cacheWith();

    await resolveManifest(
      deps({
        cache,
        fetch: serving(manifest({ revision: "remote-1", minExtensionVersion: "999.999.999" })),
      }),
    );

    expect(cache.load(URL_)?.manifest.revision).toBe("remote-1");
  });

  /**
   * The gate still has to work for the thing it is for: a real next release.
   * A cap that swallowed every demand would be its own bug — the FR-3.5 story
   * exists so a manifest can safely use fields this extension cannot read yet.
   */
  it("still honours a gate a real next release would satisfy", async () => {
    // Within `isEnforceableExtensionFloor`'s window of plausible releases
    // ahead of the running 0.1.0.
    for (const wanted of ["0.2.0", "1.0.0", "2.4.1"]) {
      const resolution = await resolveManifest(
        deps({ fetch: serving(manifest({ minExtensionVersion: wanted })) }),
      );
      expect(resolution.source).toBe("bundled");
      expect(resolution.needsExtensionVersion).toBe(wanted);
    }
  });

  it("ignores an absurd gate on the cached copy too, not only the fetched one", async () => {
    const cached: CachedManifest = {
      manifest: manifest({ revision: "cached-1", minExtensionVersion: "999.0.0" }),
      fetchedAt: "2026-09-01T00:00:00.000Z",
      url: URL_,
    };

    const resolution = await resolveManifest(deps({ cache: cacheWith(cached), fetch: offline }));

    expect(resolution.source).toBe("cached");
    expect(resolution.manifest.revision).toBe("cached-1");
  });

  it("admits a manifest whose minExtensionVersion equals the running version", async () => {
    const resolution = await resolveManifest(
      deps({ fetch: serving(manifest({ minExtensionVersion: EXTENSION_VERSION })) }),
    );
    expect(resolution.source).toBe("fetched");
    expect(resolution.needsExtensionVersion).toBeUndefined();
  });
});

describe("resolveManifest — FR-3.3 throttle", () => {
  function counting(): { fetch: typeof globalThis.fetch; calls: () => number } {
    let calls = 0;
    const fetch = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify(BUNDLED_MANIFEST), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch;
    return { fetch, calls: () => calls };
  }

  it("fetches when there is no record of a previous attempt", async () => {
    const { fetch, calls } = counting();
    const resolution = await resolveManifest(deps({ fetch }));
    expect(calls()).toBe(1);
    expect(resolution.attemptedAt).toBe(NOW.toISOString());
  });

  it("skips the fetch inside the hour and reports no attempt", async () => {
    const { fetch, calls } = counting();
    const cached: CachedManifest = {
      manifest: manifest({ revision: "cached-1" }),
      fetchedAt: "2026-09-11T11:30:00.000Z",
      url: URL_,
    };
    const resolution = await resolveManifest(
      deps({ fetch, cache: cacheWith(cached), lastAttemptAt: "2026-09-11T11:30:00.000Z" }),
    );
    expect(calls()).toBe(0);
    expect(resolution.source).toBe("cached");
    expect(resolution.attemptedAt).toBeUndefined();
  });

  it("fetches again once the hour has elapsed", async () => {
    const { fetch, calls } = counting();
    const lastAttemptAt = new Date(NOW.getTime() - THROTTLE_MS).toISOString();
    await resolveManifest(deps({ fetch, lastAttemptAt }));
    expect(calls()).toBe(1);
  });

  it("force bypasses the throttle", async () => {
    const { fetch, calls } = counting();
    await resolveManifest(deps({ fetch, lastAttemptAt: "2026-09-11T11:59:59.000Z", force: true }));
    expect(calls()).toBe(1);
  });

  it("fetches when the recorded attempt time is unparseable", async () => {
    const { fetch, calls } = counting();
    await resolveManifest(deps({ fetch, lastAttemptAt: "not a date" }));
    expect(calls()).toBe(1);
  });

  it("carries attemptedAt on a throttled-then-failed resolution too", async () => {
    const resolution = await resolveManifest(deps());
    expect(resolution.source).toBe("bundled");
    expect(resolution.attemptedAt).toBe(NOW.toISOString());
  });

  it("uses the wall clock when no clock is injected", async () => {
    const before = Date.now();
    const resolution = await resolveManifest({
      url: URL_,
      extensionVersion: EXTENSION_VERSION,
      cache: cacheWith(),
      fetch: offline,
    });
    expect(Date.parse(resolution.attemptedAt ?? "")).toBeGreaterThanOrEqual(before);
  });

  it("passes the timeout through to the fetch layer", async () => {
    const never = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof globalThis.fetch;
    const resolution = await resolveManifest(deps({ fetch: never, timeoutMs: 1 }));
    expect(resolution.problems).toEqual([{ source: "fetched", problem: "timeout" }]);
  });

  it("uses the global fetch when none is injected", async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      return Promise.reject(new Error("offline"));
    }) as typeof globalThis.fetch;
    try {
      const resolution = await resolveManifest({
        url: URL_,
        extensionVersion: EXTENSION_VERSION,
        cache: cacheWith(),
        now: () => NOW,
      });
      expect(called).toBe(true);
      expect(resolution.source).toBe("bundled");
    } finally {
      globalThis.fetch = original;
    }
  });
});
