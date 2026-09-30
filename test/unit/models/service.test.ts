import { describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import { ModelAvailabilityService, modelContextKey } from "../../../src/models/service.js";
import type {
  ModelContext,
  ModelDefinition,
  ModelEvidence,
  ModelStore,
} from "../../../src/models/types.js";

const DAY = 86_400_000;
function model(family: "opus" | "sonnet" | "haiku", version = 1): ModelDefinition {
  const id = `anthropic.claude-${family}-${version}`;
  return {
    id,
    family,
    label: `${family} ${version}`,
    rank: version,
    targets: [
      { id: `global.${id}`, scope: "global", sourceRegions: ["us-east-1", "ap-southeast-1"] },
    ],
  };
}
function context(models = [model("opus"), model("sonnet"), model("haiku")]): ModelContext {
  return {
    token: "test-secret",
    credentialGeneration: "generation-1",
    configLocation: "/test/config",
    region: "us-east-1",
    allowedScopes: ["global", "unknown"],
    configured: {
      opus: "global.anthropic.claude-opus-1",
      sonnet: "global.anthropic.claude-sonnet-1",
      haiku: "global.anthropic.claude-haiku-1",
    },
    manifest: { ...BUNDLED_MANIFEST, models },
  };
}
class Store implements ModelStore {
  data = new Map<string, ModelEvidence[]>();
  leases = new Set<string>();
  async load(key: string) {
    return structuredClone(this.data.get(key) ?? []);
  }
  async save(key: string, entries: ModelEvidence[]) {
    this.data.set(key, structuredClone(entries));
  }
  async acquire(key: string) {
    if (this.leases.has(key)) return;
    this.leases.add(key);
    return async () => {
      this.leases.delete(key);
    };
  }
}
const positive = {
  authorizationStatus: "AUTHORIZED",
  entitlementAvailability: "AVAILABLE",
  regionAvailability: "AVAILABLE",
  agreementAvailability: { status: "AVAILABLE" },
};
function goodFetch(): typeof fetch {
  return vi.fn(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("foundation-model-availability")
            ? positive
            : { content: [], stop_reason: "max_tokens" },
        ),
      ),
  );
}
function runtimeCalls(call: typeof fetch) {
  return vi.mocked(call).mock.calls.filter(([url]) => String(url).includes("/invoke"));
}

describe("model availability scheduling", () => {
  it("never resurrects older successful alternatives after a credential rejection expires or its row is excluded", async () => {
    let now = DAY;
    const store = new Store();
    const call = goodFetch();
    const options = { store, fetch: call, now: () => now };
    let service = new ModelAvailabilityService(options);
    const input = context([model("opus"), model("sonnet"), model("haiku"), model("sonnet", 2)]);
    await service.setContext(input);
    await service.refresh();
    expect(service.recommendedManifest()?.defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      "global.anthropic.claude-sonnet-2",
    );
    now += DAY;
    vi.mocked(call).mockImplementation(
      async () =>
        new Response(JSON.stringify({ __type: "ExpiredTokenException" }), { status: 403 }),
    );
    await service.refresh();
    expect(service.snapshot().credential).toBe("invalid");
    expect(service.recommendedManifest()?.defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      input.configured.sonnet,
    );
    const before = vi.mocked(call).mock.calls.length;
    await service.refresh();
    expect(vi.mocked(call).mock.calls.length).toBe(before);
    await service.setContext({ ...input, allowedScopes: [] });
    expect(service.snapshot().credential).toBe("invalid");
    await service.setContext(input);
    now += DAY;
    expect(service.snapshot().credential).toBe("unknown");
    expect(service.snapshot().rows.find((row) => row.modelId.endsWith("sonnet-2"))?.stale).toBe(
      true,
    );
    expect(service.recommendedManifest()?.defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      input.configured.sonnet,
    );
    vi.mocked(call).mockImplementation(async () => {
      throw new Error("Offline");
    });
    await service.refresh({ force: true });
    service.dispose();
    service = new ModelAvailabilityService(options);
    await service.setContext(input);
    expect(service.snapshot().credential).toBe("unknown");
    now++;
    vi.mocked(call).mockImplementation(goodFetch());
    await service.refresh({ force: true });
    expect(service.snapshot().credential).toBe("valid");
    expect(service.recommendedManifest()?.defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      "global.anthropic.claude-sonnet-2",
    );
  });

  it("keeps the source region used to verify an upgrade in its apply manifest", async () => {
    const service = new ModelAvailabilityService({ store: new Store(), fetch: goodFetch() });
    const input = context([model("opus"), model("sonnet"), model("haiku"), model("sonnet", 2)]);
    input.region = "ap-southeast-1";
    await service.setContext(input);
    await service.refresh();
    expect(service.recommendedManifest()?.defaults.env.AWS_REGION).toBe("ap-southeast-1");
    expect(service.recommendedManifest()?.defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      "global.anthropic.claude-sonnet-2",
    );
  });

  it("repeated manual batches reach candidates beyond the first twelve", async () => {
    let now = DAY;
    const call = goodFetch();
    const service = new ModelAvailabilityService({
      store: new Store(),
      fetch: call,
      now: () => now,
    });
    const models = Array.from({ length: 24 }, (_, i) => model("sonnet", i + 1));
    await service.setContext(context(models));
    for (let batch = 0; batch < 3; batch++) {
      await service.refresh({ force: true });
      now++;
    }
    expect(service.snapshot().rows.every((row) => row.status === "available")).toBe(true);
    expect(runtimeCalls(call)).toHaveLength(36);
  });

  it("carries non-model manifest updates without discarding verified model evidence", async () => {
    const service = new ModelAvailabilityService({ store: new Store(), fetch: goodFetch() });
    const input = context();
    await service.setContext(input);
    await service.refresh();
    const manifest = {
      ...input.manifest,
      revision: "updated-notice",
      notices: [{ level: "info" as const, message: "New notice" }],
    };
    await service.setContext({ ...input, manifest });
    expect(service.recommendedManifest()?.revision).toBe("updated-notice");
    expect(service.recommendedManifest()?.notices).toEqual(manifest.notices);
    expect(service.snapshot().credential).toBe("valid");
  });

  it("preserves opaque configured custom pins even when catalogue candidates work", async () => {
    const service = new ModelAvailabilityService({ store: new Store(), fetch: goodFetch() });
    const input = context();
    input.configured.sonnet =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/custom";
    await service.setContext(input);
    await service.refresh();
    expect(service.recommendedManifest()?.defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      input.configured.sonnet,
    );
  });

  it("enforces two concurrent HTTP requests across preflight and runtime", async () => {
    let active = 0;
    let peak = 0;
    const call: typeof fetch = vi.fn(async (url) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return new Response(
        JSON.stringify(
          String(url).includes("foundation-model-availability")
            ? positive
            : { content: [], stop_reason: "end_turn" },
        ),
      );
    });
    const service = new ModelAvailabilityService({ store: new Store(), fetch: call });
    await service.setContext(context());
    await service.refresh();
    expect(peak).toBe(2);
  });

  it("never dispatches when attempts cannot be persisted", async () => {
    const store = new Store();
    store.save = async () => {
      throw new Error("Storage failed");
    };
    const call = goodFetch();
    const service = new ModelAvailabilityService({ store, fetch: call });
    await service.setContext(context());
    await service.refresh();
    expect(call).not.toHaveBeenCalled();
    expect(service.snapshot().issue).toBe("cache-unavailable");
  });

  it("stops credential-wide failure at the two in-flight requests and expires the evidence", async () => {
    let now = DAY;
    const call: typeof fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ __type: "ExpiredTokenException" }), { status: 403 }),
    );
    const service = new ModelAvailabilityService({
      store: new Store(),
      fetch: call,
      now: () => now,
    });
    await service.setContext(context());
    await service.refresh();
    expect(vi.mocked(call).mock.calls.length).toBeLessThanOrEqual(2);
    expect(runtimeCalls(call)).toHaveLength(0);
    expect(service.snapshot().credential).toBe("invalid");
    now += DAY;
    expect(service.snapshot().credential).toBe("unknown");
  });

  it("discards a stale lease cache load when credentials change during that await", async () => {
    const store = new Store();
    const input = context();
    const seed = new ModelAvailabilityService({ store, fetch: goodFetch() });
    await seed.setContext(input);
    await seed.refresh();
    const saved = await store.load(modelContextKey(input));
    const call = goodFetch();
    const service = new ModelAvailabilityService({ store, fetch: call });
    await service.setContext(input);
    let resolveOld: ((value: ModelEvidence[]) => void) | undefined;
    const load = store.load.bind(store);
    store.load = (key) =>
      key === modelContextKey(input)
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : load(key);
    const pending = service.refresh({ force: true });
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    await service.setContext({ ...input, credentialGeneration: "replacement" });
    resolveOld?.(saved);
    await pending;
    expect(call).not.toHaveBeenCalled();
    expect(service.snapshot().rows.every((row) => row.status === "not-checked")).toBe(true);
  });

  it("invalidates only the target whose invocation metadata changed", async () => {
    const call = goodFetch();
    const service = new ModelAvailabilityService({ store: new Store(), fetch: call });
    const input = context();
    await service.setContext(input);
    await service.refresh();
    const changed = structuredClone(input);
    const target = changed.manifest.models?.[0]?.targets[0];
    if (!target) throw new Error("Fixture missing target");
    target.sourceRegions.push("us-west-2");
    await service.setContext(changed);
    await service.refresh();
    expect(runtimeCalls(call)).toHaveLength(4);
  });

  it("probes every configured family, persists safe evidence and reuses fresh evidence after restart", async () => {
    const store = new Store();
    const call = goodFetch();
    const options = { store, fetch: call, now: () => DAY };
    const service = new ModelAvailabilityService(options);
    await service.setContext(context());
    await service.refresh();
    expect(runtimeCalls(call)).toHaveLength(3);
    expect(
      service
        .snapshot()
        .rows.filter((r) => r.configured)
        .map((r) => r.status),
    ).toEqual(["available", "available", "available"]);
    expect(service.snapshot().credential).toBe("valid");
    expect(JSON.stringify([...store.data])).not.toContain("test-secret");
    const restarted = new ModelAvailabilityService(options);
    await restarted.setContext(context());
    await restarted.refresh();
    expect(runtimeCalls(call)).toHaveLength(3);
  });
  it("refreshes configured evidence at 24h and alternatives at 7d", async () => {
    let now = DAY;
    const call = goodFetch();
    const service = new ModelAvailabilityService({
      store: new Store(),
      fetch: call,
      now: () => now,
    });
    await service.setContext(
      context([model("opus"), model("sonnet"), model("haiku"), model("sonnet", 2)]),
    );
    await service.refresh();
    expect(runtimeCalls(call)).toHaveLength(4);
    now += DAY;
    await service.refresh();
    expect(runtimeCalls(call)).toHaveLength(7);
    now += 6 * DAY;
    await service.refresh();
    expect(runtimeCalls(call)).toHaveLength(11);
  });
  it("checks a newly published target without rechecking unchanged targets", async () => {
    const call = goodFetch();
    const service = new ModelAvailabilityService({
      store: new Store(),
      fetch: call,
      now: () => DAY,
    });
    const first = context();
    await service.setContext(first);
    await service.refresh();
    await service.setContext({
      ...first,
      manifest: {
        ...first.manifest,
        revision: "new",
        models: [...(first.manifest.models ?? []), model("sonnet", 2)],
      },
    });
    await service.refresh();
    expect(runtimeCalls(call)).toHaveLength(4);
  });
  it("keeps configured pins when a newer subscription is absent; only configured targets bypass unknown metadata", async () => {
    const call: typeof fetch = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes("foundation-model-availability"))
        return target.includes("sonnet-2")
          ? new Response(JSON.stringify({ ...positive, entitlementAvailability: "NOT_AVAILABLE" }))
          : new Response("{}", { status: 403 });
      return new Response(JSON.stringify({ content: [], stop_reason: "end_turn" }));
    });
    const service = new ModelAvailabilityService({ store: new Store(), fetch: call });
    await service.setContext(
      context([model("opus"), model("sonnet"), model("haiku"), model("sonnet", 2)]),
    );
    await service.refresh({ force: true, automatic: false });
    expect(runtimeCalls(call)).toHaveLength(3);
    expect(service.snapshot().rows.find((r) => r.modelId.endsWith("sonnet-2"))?.status).toBe(
      "subscription-required",
    );
    expect(service.recommendedManifest()?.defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      "global.anthropic.claude-sonnet-1",
    );
  });
  it("recommends only freshly verified upgrades and preserves the current geography policy", async () => {
    let now = DAY;
    const service = new ModelAvailabilityService({
      store: new Store(),
      fetch: goodFetch(),
      now: () => now,
    });
    const input = context([model("opus"), model("sonnet"), model("haiku"), model("sonnet", 2)]);
    await service.setContext(input);
    await service.refresh();
    expect(service.recommendedManifest()?.defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      "global.anthropic.claude-sonnet-2",
    );
    now += 8 * DAY;
    expect(service.recommendedManifest()?.defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      "global.anthropic.claude-sonnet-1",
    );
    await service.setContext({ ...input, allowedScopes: ["eu"] });
    expect(service.snapshot().rows.every((r) => r.status === "out-of-scope")).toBe(true);
  });
  it("a successful Haiku does not hide failed Sonnet or Opus", async () => {
    const call: typeof fetch = vi.fn(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("foundation-model-availability")
              ? positive
              : String(url).includes("haiku")
                ? { content: [], stop_reason: "end_turn" }
                : {},
          ),
          {
            status:
              String(url).includes("foundation-model-availability") || String(url).includes("haiku")
                ? 200
                : 403,
          },
        ),
    );
    const service = new ModelAvailabilityService({ store: new Store(), fetch: call });
    await service.setContext(context());
    await service.refresh();
    expect(service.snapshot().credential).toBe("valid");
    expect(service.snapshot().rows.map((r) => r.status)).toEqual([
      "access-denied",
      "access-denied",
      "available",
    ]);
  });
  it("backs off transient failures and retains last successful observation", async () => {
    let now = DAY;
    const call = goodFetch();
    const service = new ModelAvailabilityService({
      store: new Store(),
      fetch: call,
      now: () => now,
    });
    await service.setContext(context());
    await service.refresh();
    vi.mocked(call).mockImplementation(async () => new Response("{}", { status: 503 }));
    now += DAY;
    await service.refresh();
    const row = service.snapshot().rows[0];
    expect(row).toMatchObject({
      status: "network-error",
      lastSuccessAt: DAY,
      nextCheckAt: now + 900_000,
    });
    const count = vi.mocked(call).mock.calls.length;
    await service.refresh();
    expect(vi.mocked(call)).toHaveBeenCalledTimes(count);
    await service.refresh({ force: true });
    expect(vi.mocked(call).mock.calls.length).toBeGreaterThan(count);
  });
  it("never sends excluded or unsupported-region requests", async () => {
    const call = goodFetch();
    const service = new ModelAvailabilityService({ store: new Store(), fetch: call });
    await service.setContext({ ...context(), allowedScopes: ["eu"] });
    await service.refresh();
    expect(call).not.toHaveBeenCalled();
    await service.setContext({ ...context(), region: "eu-central-1" });
    await service.refresh();
    expect(call).not.toHaveBeenCalled();
  });
  it("coalesces windows via the store lease and bounds requests at two concurrent and twelve runtime", async () => {
    const store = new Store();
    const call = goodFetch();
    const models = Array.from({ length: 20 }, (_, i) => model("sonnet", i + 1));
    const input = context(models);
    const a = new ModelAvailabilityService({ store, fetch: call });
    const b = new ModelAvailabilityService({ store, fetch: call });
    await Promise.all([a.setContext(input), b.setContext(input)]);
    await Promise.all([a.refresh(), a.refresh(), b.refresh()]);
    expect(runtimeCalls(call)).toHaveLength(12);
    await a.refresh();
    expect(runtimeCalls(call).length).toBe(22);
  });
  it("invalidates credential and region evidence and discards in-flight rotation results", async () => {
    const store = new Store();
    let finish: (() => void) | undefined;
    const call: typeof fetch = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return new Response(JSON.stringify(positive));
    });
    const service = new ModelAvailabilityService({ store, fetch: call });
    const first = context();
    await service.setContext(first);
    const pending = service.refresh();
    await vi.waitFor(() => expect(call).toHaveBeenCalled());
    await service.setContext({ ...first, credentialGeneration: "generation-2" });
    finish?.();
    await pending;
    expect(service.snapshot().rows.every((r) => r.status === "not-checked")).toBe(true);
    expect(service.snapshot().credential).toBe("unknown");
    expect(modelContextKey(first)).not.toBe(
      modelContextKey({ ...first, region: "ap-southeast-1" }),
    );
  });
  it("caps batch wall time even when transport ignores abort", async () => {
    const service = new ModelAvailabilityService({
      store: new Store(),
      fetch: vi.fn(() => new Promise<Response>(() => {})),
      batchTimeoutMs: 10,
      requestTimeoutMs: 10_000,
    });
    await service.setContext(context());
    await service.refresh();
    expect(service.snapshot().checking).toBe(false);
  });
  it("lists but does not invoke unknown future probe formats", async () => {
    const call = goodFetch();
    const future = model("sonnet", 2);
    future.probeFormat = "future-format";
    const service = new ModelAvailabilityService({ store: new Store(), fetch: call });
    await service.setContext(context([future]));
    await service.refresh();
    expect(service.snapshot().rows[0]).toMatchObject({ status: "unsupported" });
    expect(vi.mocked(call).mock.calls.every(([url]) => !String(url).includes("sonnet-2"))).toBe(
      true,
    );
  });
});
