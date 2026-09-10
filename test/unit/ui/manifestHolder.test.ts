import { beforeEach, describe, expect, it } from "vitest";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import { createManifestCache, MemoryManifestMemento } from "../../../src/manifest/cache.js";
import { THROTTLE_MS } from "../../../src/manifest/resolve.js";
import type { Manifest } from "../../../src/manifest/types.js";
import type { ManifestHolderDeps } from "../../../src/ui/manifestHolder.js";
import { createManifestHolder } from "../../../src/ui/manifestHolder.js";

const URL_ = "https://example.com/defaults.json";
const START = new Date("2026-09-11T12:00:00.000Z");

let logged: string[];
let clock: Date;
let requests: number;

const log = {
  info: (message: string) => logged.push(`info ${message}`),
  warn: (message: string) => logged.push(`warn ${message}`),
  error: (message: string) => logged.push(`error ${message}`),
};

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return { ...structuredClone(BUNDLED_MANIFEST), ...overrides };
}

/** A fetch that counts its calls, so the throttle can be observed rather than assumed. */
function serving(body: () => unknown): typeof globalThis.fetch {
  return (() => {
    requests += 1;
    return Promise.resolve(
      new Response(JSON.stringify(body()), { headers: { "content-type": "application/json" } }),
    );
  }) as typeof globalThis.fetch;
}

const offline = (() => {
  requests += 1;
  return Promise.reject(new Error("offline"));
}) as typeof globalThis.fetch;

function holder(overrides: Partial<ManifestHolderDeps> = {}) {
  return createManifestHolder({
    url: () => URL_,
    extensionVersion: "0.1.0",
    cache: createManifestCache(new MemoryManifestMemento()),
    log: log as never,
    now: () => clock,
    fetch: offline,
    ...overrides,
  });
}

beforeEach(() => {
  logged = [];
  clock = new Date(START);
  requests = 0;
});

describe("what the panel renders before anything is resolved", () => {
  it("starts on the bundled floor, so a run before the first fetch has defaults", () => {
    const held = holder().current();
    expect(held.manifest.revision).toBe(BUNDLED_MANIFEST.revision);
    expect(held.status).toEqual({ revision: BUNDLED_MANIFEST.revision, source: "bundled" });
  });
});

describe("refresh", () => {
  it("holds what it fetched and reports the change", async () => {
    const manifests = holder({ fetch: serving(() => manifest({ revision: "remote-1" })) });

    expect(await manifests.refresh()).toBe(true);

    expect(manifests.current().manifest.revision).toBe("remote-1");
    expect(manifests.current().status).toEqual({
      revision: "remote-1",
      source: "fetched",
      fetchedAt: START.toISOString(),
    });
  });

  it("reports no change when the same revision comes back again", async () => {
    const manifests = holder({ fetch: serving(() => manifest({ revision: "remote-1" })) });
    await manifests.refresh();

    clock = new Date(START.getTime() + THROTTLE_MS);

    // Fetched again — the hour is up — but it is the same manifest, so the
    // host has nothing to repaint.
    expect(await manifests.refresh({ force: true })).toBe(false);
    expect(requests).toBe(2);
  });

  it("falls back silently, holding the bundled copy, when the network is gone", async () => {
    const manifests = holder();

    // The source changed (bundled is now a *resolved* answer, not a
    // placeholder), but nothing user-visible failed.
    await manifests.refresh();

    expect(manifests.current().status.source).toBe("bundled");
    expect(logged.some((line) => line.startsWith("error"))).toBe(false);
  });

  /**
   * F8. A same-`revision` republish — the manifest edited without its revision
   * bumped, which is exactly what a hostile edit looks like — was dropped by
   * the window while still reaching the cache, so the two disagreed until the
   * window reloaded. `sameStatus` answers "is there anything to repaint?", not
   * "is this worth keeping": the newer resolution is always the held one.
   */
  it("holds the newer resolution even when nothing needs repainting (F8)", async () => {
    let deny = ["Read(./.env)"];
    const manifests = holder({
      fetch: serving(() =>
        manifest({
          revision: "remote-1",
          defaults: { ...BUNDLED_MANIFEST.defaults, permissions: { deny } },
        }),
      ),
    });

    await manifests.refresh();
    expect(manifests.current().manifest.defaults.permissions.deny).toEqual(["Read(./.env)"]);

    // Republished at the same revision with a protection removed. Nothing the
    // panel renders has changed, so `refresh` reports no repaint — but the
    // cache now holds this, and so must the window.
    deny = [];
    expect(await manifests.refresh({ force: true })).toBe(false);

    expect(manifests.current().manifest.defaults.permissions.deny).toEqual([]);
  });

  it("agrees with the cache after a same-revision republish (F8)", async () => {
    const cache = createManifestCache(new MemoryManifestMemento());
    let region = "us-east-1";
    const manifests = holder({
      cache,
      fetch: serving(() =>
        manifest({
          revision: "remote-1",
          defaults: {
            ...BUNDLED_MANIFEST.defaults,
            env: { ...BUNDLED_MANIFEST.defaults.env, AWS_REGION: region },
          },
        }),
      ),
    });

    await manifests.refresh();
    region = "eu-central-1";
    await manifests.refresh({ force: true });

    expect(manifests.current().manifest.defaults.env.AWS_REGION).toBe(
      cache.load(URL_)?.manifest.defaults.env.AWS_REGION,
    );
  });

  it("carries the FR-3.5 gate through to the status the checks see", async () => {
    const manifests = holder({
      fetch: serving(() => manifest({ revision: "remote-1", minExtensionVersion: "9.0.0" })),
    });

    await manifests.refresh();

    expect(manifests.current().status.needsExtensionVersion).toBe("9.0.0");
    // The gate rejected the fetched manifest, so the defaults in force are the
    // bundled ones — not the manifest that demanded the update.
    expect(manifests.current().manifest.revision).toBe(BUNDLED_MANIFEST.revision);
  });
});

/**
 * FR-3.3's throttle, which `resolveManifest` deliberately does not own: it is
 * given `lastAttemptAt` and hands back `attemptedAt`, and somebody has to be
 * the "per window". These tests exist because the write-back is exactly the
 * kind of bookkeeping that silently does nothing — drop the one assignment and
 * every one of these still *passes its user-visible assertion*, while the
 * extension fetches on every file change.
 */
describe("FR-3.3 — one fetch per hour per window", () => {
  it("does not fetch again within the hour", async () => {
    const manifests = holder({ fetch: serving(() => manifest({ revision: "remote-1" })) });

    await manifests.refresh();
    expect(requests).toBe(1);

    clock = new Date(START.getTime() + THROTTLE_MS - 1);
    await manifests.refresh();

    expect(requests).toBe(1);
  });

  it("fetches again once the hour is up", async () => {
    const manifests = holder({ fetch: serving(() => manifest({ revision: "remote-1" })) });

    await manifests.refresh();
    clock = new Date(START.getTime() + THROTTLE_MS);
    await manifests.refresh();

    expect(requests).toBe(2);
  });

  /**
   * The failure the write-back is really about. A fetch that fell through to
   * the bundled copy still made a request, so it still counts against the
   * hour — otherwise a machine with no network retries on every health run,
   * which on a busy `~/.claude` is a request per file change.
   */
  it("counts a failed attempt against the hour, not just a successful one", async () => {
    const manifests = holder({ fetch: offline });

    await manifests.refresh();
    expect(requests).toBe(1);

    clock = new Date(START.getTime() + THROTTLE_MS - 1);
    await manifests.refresh();
    await manifests.refresh();
    await manifests.refresh();

    expect(requests).toBe(1);
  });

  it("lets the manual check bypass the throttle", async () => {
    const manifests = holder({ fetch: serving(() => manifest({ revision: "remote-1" })) });

    await manifests.refresh();
    await manifests.refresh({ force: true });
    await manifests.refresh({ force: true });

    expect(requests).toBe(3);
  });

  /**
   * F6. The throttle stopped engaging when `globalState` misbehaved: a throw
   * from `cache.save`/`cache.load` left `resolveManifest` before it returned,
   * so `lastAttemptAt` was never assigned and every subsequent health run
   * fetched again — and every `settings.json` write by Claude Code triggers a
   * health run.
   *
   * The previous test for this case asserted only that `refresh()` resolves
   * `false` and never counted requests, which is precisely why the regression
   * was invisible.
   */
  it("still counts the attempt when the cache throws (F6)", async () => {
    // `offline`, so the chain reaches `cache.load` at all: a successful fetch
    // returns before the cache is consulted, which is what made the first
    // version of this test pass without the fix.
    const manifests = holder({
      fetch: offline,
      cache: {
        load: () => {
          throw new Error("globalState is unavailable");
        },
        save: async () => {},
      },
    });

    await manifests.refresh();
    expect(requests).toBe(1);

    clock = new Date(START.getTime() + THROTTLE_MS - 1);
    await manifests.refresh();
    await manifests.refresh();

    expect(requests).toBe(1);
  });

  it("still counts the attempt when saving to the cache throws (F6)", async () => {
    const manifests = holder({
      fetch: serving(() => manifest({ revision: "remote-1" })),
      cache: {
        load: () => undefined,
        save: () => Promise.reject(new Error("globalState is full")),
      },
    });

    await manifests.refresh();
    expect(requests).toBe(1);

    clock = new Date(START.getTime() + THROTTLE_MS - 1);
    await manifests.refresh();

    expect(requests).toBe(1);
  });

  /**
   * F6, second half. Three concurrent `refresh()` calls made three fetches:
   * nothing recorded an attempt until the first one *returned*, and a fetch
   * window is 5 s wide — plenty for activation and a watcher event to overlap.
   */
  it("makes one request when three refreshes overlap (F6)", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manifests = holder({
      fetch: (async () => {
        requests += 1;
        await gate;
        return new Response(JSON.stringify(manifest({ revision: "remote-1" })), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof globalThis.fetch,
    });

    const all = Promise.all([manifests.refresh(), manifests.refresh(), manifests.refresh()]);
    release();
    const changed = await all;

    expect(requests).toBe(1);
    // Every caller gets the answer, not just the one that did the work: a
    // `false` here would leave the host declining to repaint a panel that has
    // in fact just changed.
    expect(changed).toEqual([true, true, true]);
    expect(manifests.current().manifest.revision).toBe("remote-1");
  });

  it("joins a forced refresh to the one already in flight (F6)", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manifests = holder({
      fetch: (async () => {
        requests += 1;
        await gate;
        return new Response(JSON.stringify(manifest({ revision: "remote-1" })), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof globalThis.fetch,
    });

    const all = Promise.all([manifests.refresh(), manifests.refresh({ force: true })]);
    release();
    await all;

    expect(requests).toBe(1);
  });

  it("lets a later forced refresh through once the first has settled", async () => {
    const manifests = holder({ fetch: serving(() => manifest({ revision: "remote-1" })) });

    await manifests.refresh();
    await manifests.refresh({ force: true });

    expect(requests).toBe(2);
  });

  it("restarts the hour from a forced attempt, so a manual check is not free", async () => {
    const manifests = holder({ fetch: serving(() => manifest({ revision: "remote-1" })) });

    clock = new Date(START.getTime() + THROTTLE_MS);
    await manifests.refresh({ force: true });
    expect(requests).toBe(1);

    clock = new Date(START.getTime() + THROTTLE_MS + 1);
    await manifests.refresh();

    expect(requests).toBe(1);
  });
});

describe("FR-3.2 / FR-7.2 logging", () => {
  it("names the source and revision of every resolution", async () => {
    const manifests = holder({ fetch: serving(() => manifest({ revision: "remote-1" })) });

    await manifests.refresh();

    expect(logged).toContain("info Recommended settings: fetched (revision remote-1)");
  });

  it("logs a failed fetch as a warning and shows the user nothing", async () => {
    // FR-3.2 is explicit: never a toast, never an error row. The holder has no
    // access to `vscode` at all, which is how that is enforced structurally.
    await holder().refresh();

    expect(logged).toContain("warn Manifest (fetched): network");
    expect(logged.some((line) => line.startsWith("error"))).toBe(false);
  });

  it("logs schema problems by path, never by value", async () => {
    const manifests = holder({
      fetch: serving(() => ({ ...manifest(), regions: ["not a region"] })),
    });

    await manifests.refresh();

    expect(logged).toContain("warn Manifest (fetched): regions[0]: must be an AWS region name");
    for (const line of logged) expect(line).not.toContain("not a region");
  });

  it("names the version the FR-3.5 gate wants", async () => {
    const manifests = holder({
      fetch: serving(() => manifest({ minExtensionVersion: "9.0.0" })),
    });

    await manifests.refresh();

    expect(logged.some((line) => line.includes("needs extension 9.0.0"))).toBe(true);
  });

  /**
   * `resolveManifest` is documented never to throw and the fetch layer is
   * written so it cannot — but this is the activation path, where a throw would
   * surface as an unhandled rejection with the panel stuck on its welcome text.
   */
  it("survives a resolver that throws anyway, without taking the window with it", async () => {
    const manifests = holder({
      cache: {
        load: () => {
          throw new Error("globalState is unavailable");
        },
        save: async () => {},
      },
    });

    await expect(manifests.refresh()).resolves.toBe(false);

    expect(logged.some((line) => line.startsWith("error"))).toBe(true);
    expect(manifests.current().status.source).toBe("bundled");
  });
});

describe("what it passes through to the resolver", () => {
  /**
   * The previous version of this test asserted that a signal existed and then
   * hardcoded the number it claimed to have observed, so deleting the
   * forwarding line outright left it green. This one measures the deadline the
   * signal actually carries: a `fetch` that never settles is aborted, and the
   * clock the abort happens on is the one this test controls.
   */
  it("forwards the fetch timeout, at the value it was given", async () => {
    const aborted: number[] = [];
    const manifests = holder({
      timeoutMs: 40,
      fetch: ((_input: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const started = Date.now();
          init.signal?.addEventListener("abort", () => {
            aborted.push(Date.now() - started);
            reject(new DOMException("aborted", "AbortError"));
          });
        })) as unknown as typeof globalThis.fetch,
    });

    await manifests.refresh();

    // One abort, and it happened on the injected deadline rather than on
    // `fetch.ts`'s 5 s default — which is the difference a hardcoded
    // expectation could not see.
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toBeLessThan(2000);
    expect(logged).toContain("warn Manifest (fetched): timeout");
  });

  /**
   * The mutation the test above is built to catch, stated directly: with no
   * `timeoutMs` forwarded the request would run against `fetch.ts`'s default,
   * so a holder that drops the option is a holder whose 5 s budget is not
   * configurable at all. Asserting the *absence* of an abort within the window
   * is what makes the pair asymmetric enough to fail.
   */
  it("does not abort early when no timeout is configured", async () => {
    let signal: AbortSignal | undefined;
    const manifests = holder({
      fetch: ((_input: string, init: { signal?: AbortSignal }) => {
        signal = init.signal;
        return Promise.resolve(
          new Response(JSON.stringify(manifest()), {
            headers: { "content-type": "application/json" },
          }),
        );
      }) as unknown as typeof globalThis.fetch,
    });

    await manifests.refresh();

    expect(signal?.aborted).toBe(false);
  });

  /**
   * With no clock and no `fetch` injected, the real ones are used. The URL is
   * unusable on purpose, so `fetchManifest` refuses it before opening a socket:
   * this asserts the defaults are wired without making a network request.
   */
  it("defaults its clock and its fetch, without reaching the network", async () => {
    const manifests = createManifestHolder({
      url: () => "not-a-url",
      extensionVersion: "0.1.0",
      cache: createManifestCache(new MemoryManifestMemento()),
      log: log as never,
    });

    await manifests.refresh();

    expect(logged).toContain("warn Manifest (fetched): bad-url");
    expect(manifests.current().status.source).toBe("bundled");
  });

  it("describes a non-Error throw rather than stringifying it", async () => {
    const manifests = holder({
      cache: {
        load: () => {
          throw "just a string";
        },
        save: async () => {},
      },
    });

    await manifests.refresh();

    expect(logged).toContain(
      "error Could not resolve the recommended settings: an unexpected failure",
    );
  });
});

describe("the manifest URL setting", () => {
  it("is read per refresh, so changing it takes effect without a reload", async () => {
    let url = "https://first.example.com/defaults.json";
    const seen: string[] = [];
    const manifests = holder({
      url: () => url,
      fetch: ((input: string) => {
        seen.push(input);
        return Promise.resolve(
          new Response(JSON.stringify(manifest({ revision: "remote-1" })), {
            headers: { "content-type": "application/json" },
          }),
        );
      }) as unknown as typeof globalThis.fetch,
    });

    await manifests.refresh();
    url = "https://second.example.com/defaults.json";
    await manifests.refresh({ force: true });

    expect(seen).toEqual([
      "https://first.example.com/defaults.json",
      "https://second.example.com/defaults.json",
    ]);
  });
});
