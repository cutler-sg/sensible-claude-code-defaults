import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryTokenStore } from "../../../src/credential/store.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import type { Manifest } from "../../../src/manifest/types.js";
import { FileModelStore } from "../../../src/models/store.js";
import { ModelController } from "../../../src/ui/modelController.js";

const TOKEN = "synthetic-controller-test-credential";
const modelId = "global.anthropic.claude-sonnet-test";
let dir: string;
let controller: ModelController;
let tokenStore: MemoryTokenStore;
let automatic: boolean;
let scopes: string[];
let requests: string[];
let now: number;
let manifest: Manifest;
let outcome: "ok" | "subscription" | "network";

const settings = (region = "us-east-1", token = TOKEN) => ({
  env: {
    AWS_REGION: region,
    AWS_BEARER_TOKEN_BEDROCK: token,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
  },
});
const makeController = () =>
  new ModelController({
    settingsFile: join(dir, "settings.json"),
    tokenStore,
    store: new FileModelStore(join(dir, "evidence")),
    manifest: () => manifest,
    automatic: () => automatic,
    scopes: () => scopes,
    now: () => now,
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      if (outcome === "network") throw new Error("simulated offline");
      if (url.includes("foundation-model-availability"))
        return Response.json({
          authorizationStatus: "AUTHORIZED",
          entitlementAvailability: outcome === "subscription" ? "NOT_AVAILABLE" : "AVAILABLE",
          regionAvailability: "AVAILABLE",
          agreementAvailability: { status: "AVAILABLE" },
        });
      if (outcome === "subscription")
        return Response.json({ message: "Marketplace subscription required" }, { status: 403 });
      return Response.json({
        content: [{ type: "text", text: "." }],
        stop_reason: "max_tokens",
        usage: { output_tokens: 1 },
      });
    },
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scd-model-controller-"));
  automatic = false;
  scopes = [];
  requests = [];
  now = Date.parse("2026-09-30T00:00:00Z");
  outcome = "ok";
  tokenStore = new MemoryTokenStore({ token: TOKEN, setAt: "2026-09-29T00:00:00Z" });
  manifest = {
    ...BUNDLED_MANIFEST,
    models: [
      {
        id: "anthropic.claude-sonnet-test",
        label: "Sonnet test",
        family: "sonnet",
        rank: 1,
        targets: [{ id: modelId, scope: "global", sourceRegions: ["us-east-1", "us-west-2"] }],
      },
    ],
  };
  await writeFile(join(dir, "settings.json"), JSON.stringify(settings()));
  controller = makeController();
});
afterEach(async () => {
  controller.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe("model host coordination", () => {
  it("does not call AWS when automatic checks are off", async () => {
    await controller.refresh();
    expect(requests).toEqual([]);
    expect(controller.panel().snapshot.rows.some((r) => r.configured)).toBe(true);
  });
  it("two fresh controllers share a lease and persistent credential context", async () => {
    automatic = true;
    const second = makeController();
    try {
      await Promise.all([controller.refresh(), second.refresh()]);
      expect(requests.filter((url) => url.includes("/invoke"))).toHaveLength(1);
      await second.refresh();
      expect(requests.filter((url) => url.includes("/invoke"))).toHaveLength(1);
      expect(second.panel().snapshot.credential).toBe("valid");
    } finally {
      second.dispose();
    }
  });
  it.each(["missing", "mismatch"])(
    "preserves configured pins and source region with %s credentials",
    async (mode) => {
      if (mode === "missing") await tokenStore.clear();
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify(settings("ap-southeast-1", mode === "mismatch" ? "different" : TOKEN)),
      );
      await controller.sync();
      expect(controller.manifest().defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(modelId);
      expect(controller.manifest().defaults.env.AWS_REGION).toBe("ap-southeast-1");
      expect(controller.panel().upgrades).toBe(false);
    },
  );
  it("manual checks test exact configured targets", async () => {
    await controller.refresh(true);
    expect(requests.some((url) => url.includes(encodeURIComponent(modelId)))).toBe(true);
    expect(controller.panel().snapshot.credential).toBe("valid");
  });
  it("enabled automatic checks reuse fresh evidence across restarts", async () => {
    automatic = true;
    await controller.refresh();
    const count = requests.length;
    controller.dispose();
    controller = makeController();
    await controller.refresh();
    expect(requests).toHaveLength(count);
    now += 86_400_001;
    await controller.refresh();
    expect(requests.length).toBeGreaterThan(count);
  });
  it("key replacement with the same timestamp cannot inherit prior evidence", async () => {
    await controller.refresh(true);
    await tokenStore.set({
      token: "different-synthetic-credential",
      setAt: "2026-09-29T00:00:00Z",
    });
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify(settings("us-east-1", "different-synthetic-credential")),
    );
    await controller.sync();
    expect(controller.panel().snapshot.credential).toBe("unknown");
  });
  it("a source-region change invalidates credential and model evidence", async () => {
    await controller.refresh(true);
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings("us-west-2")));
    await controller.sync();
    expect(controller.panel().snapshot.credential).toBe("unknown");
    expect(controller.panel().snapshot.region).toBe("us-west-2");
  });
  it("a key mismatch prevents probing the wrong credential", async () => {
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings("us-east-1", "different")));
    await controller.refresh(true);
    expect(requests).toEqual([]);
    expect(controller.panel().problem).toContain("Reconcile");
  });
  it("invalid JSON produces recoverable guidance without network calls", async () => {
    await writeFile(join(dir, "settings.json"), "broken");
    await controller.refresh(true);
    expect(requests).toEqual([]);
    expect(controller.panel().problem).toContain("JSON");
  });
  it("removing a key clears visible evidence immediately", async () => {
    await controller.refresh(true);
    await tokenStore.clear();
    controller.invalidate();
    expect(controller.panel().snapshot.credential).toBe("unknown");
    await controller.refresh(true);
    expect(controller.panel().snapshot.rows).toEqual([]);
  });
  it("an explicit geography policy excludes configured global routes", async () => {
    scopes = ["eu"];
    await controller.refresh(true);
    expect(requests).toEqual([]);
    expect(controller.panel().snapshot.rows.find((r) => r.configured)?.status).toBe("out-of-scope");
  });
  it("blocked candidates cannot replace a working pin", async () => {
    manifest.models?.push({
      id: "anthropic.claude-sonnet-new",
      label: "Sonnet new",
      family: "sonnet",
      rank: 2,
      targets: [
        { id: "global.anthropic.claude-sonnet-new", scope: "global", sourceRegions: ["us-east-1"] },
      ],
    });
    outcome = "subscription";
    await controller.refresh(true);
    expect(controller.manifest().defaults.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(modelId);
    expect(controller.panel().upgrades).toBe(false);
  });
  it("inference failure preserves historic success without claiming current access", async () => {
    await controller.refresh(true);
    outcome = "network";
    await controller.refresh(true);
    const r = controller.panel().snapshot.rows.find((r) => r.configured);
    expect(r?.status).toBe("network-error");
    expect(r?.lastSuccessAt).toBe(now);
    expect(controller.panel().snapshot.credential).toBe("unknown");
  });
  it("never exports credential identities or mutates configuration while probing", async () => {
    const before = await readFile(join(dir, "settings.json"), "utf8");
    await controller.refresh(true);
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe(before);
    expect(JSON.stringify(controller.panel())).not.toContain(TOKEN);
    expect(JSON.stringify(controller.panel())).not.toContain("generation");
  });
});
