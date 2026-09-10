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
  it("forwards the fetch timeout", async () => {
    let seen: number | undefined;
    const manifests = holder({
      timeoutMs: 250,
      fetch: ((_input: string, init: { signal?: AbortSignal }) => {
        seen = init.signal === undefined ? undefined : 250;
        return Promise.resolve(
          new Response(JSON.stringify(manifest()), {
            headers: { "content-type": "application/json" },
          }),
        );
      }) as unknown as typeof globalThis.fetch,
    });

    await manifests.refresh();

    expect(seen).toBe(250);
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
