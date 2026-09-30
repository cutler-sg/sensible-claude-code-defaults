import { describe, expect, it } from "vitest";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import { validateManifest } from "../../../src/manifest/schema.js";

const first = BUNDLED_MANIFEST.models?.[0];
if (!first) throw new Error("Missing bundled catalogue");
describe("model catalogue validation", () => {
  it("accepts old manifests without catalogue metadata", () => {
    const { models: _, ...old } = BUNDLED_MANIFEST;
    expect(validateManifest(old).ok).toBe(true);
  });
  it("accepts future model IDs and unknown formats without allowing remote code", () => {
    expect(
      validateManifest({
        ...BUNDLED_MANIFEST,
        models: [
          {
            ...first,
            id: "anthropic.claude-sonnet-99",
            probeFormat: "future-probe-v2",
            requestBody: { injected: true },
            targets: [
              {
                id: "global.anthropic.claude-sonnet-99",
                sourceRegions: ["us-east-1"],
                scope: "global",
              },
            ],
          },
        ],
      }).ok,
    ).toBe(true);
  });
  it.each([
    { targets: [{ ...first.targets[0], id: "../escape" }] },
    { targets: [{ ...first.targets[0], id: "global.anthropic.unrelated-model" }] },
    { targets: [{ ...first.targets[0], scope: "eu" }] },
    { targets: [{ ...first.targets[0], sourceRegions: ["us-east-1.attacker.invalid"] }] },
    { targets: [{ ...first.targets[0], scope: "anywhere" }] },
    { targets: Array.from({ length: 9 }, () => first.targets[0]) },
    { label: "Model\nforged" },
    { source: "https://attacker.invalid/" },
    { rank: 1.5 },
    { id: "custom/not-anthropic" },
    { lifecycle: "invented" },
    { probeFormat: "../../arbitrary" },
  ])("refuses malicious or ambiguous metadata %j", (overrides) => {
    expect(validateManifest({ ...BUNDLED_MANIFEST, models: [{ ...first, ...overrides }] }).ok).toBe(
      false,
    );
  });
  it("refuses duplicates and oversized catalogues", () => {
    expect(validateManifest({ ...BUNDLED_MANIFEST, models: [first, first] }).ok).toBe(false);
    expect(
      validateManifest({ ...BUNDLED_MANIFEST, models: Array.from({ length: 65 }, () => first) }).ok,
    ).toBe(false);
  });
});
