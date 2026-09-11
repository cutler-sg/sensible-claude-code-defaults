import { describe, expect, it } from "vitest";
import type { JsonObject, ReadResult, Settings } from "../../../src/config/types.js";
import { pluginsEnabledCheck } from "../../../src/health/checks/plugins.enabled.js";
import { pluginsMarketplaceCheck } from "../../../src/health/checks/plugins.marketplace.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import type { Manifest } from "../../../src/manifest/types.js";
import { makeCtx, okRead, okSettings } from "./fixture.js";

const ABSENT: ReadResult = { kind: "absent" };
const MALFORMED: ReadResult = { kind: "malformed", raw: "{", error: "bad" };

function withRecommendations(
  extraKnownMarketplaces: JsonObject,
  enabledPlugins: Record<string, boolean | string[]>,
): Manifest {
  return {
    ...BUNDLED_MANIFEST,
    defaults: { ...BUNDLED_MANIFEST.defaults, extraKnownMarketplaces, enabledPlugins },
  };
}

const MARKETPLACE: JsonObject = {
  "example-marketplace": { source: { source: "github", repo: "example/plugins" } },
};
const PLUGINS: Record<string, boolean | string[]> = { "helper@example-marketplace": true };

function ctxWith(settings: Settings, manifest: Manifest) {
  return makeCtx({ read: okRead(settings), manifest });
}

describe("plugins.marketplace", () => {
  it.each([ABSENT, MALFORMED])("skips when there is nothing to read (%s)", (read) => {
    expect(pluginsMarketplaceCheck.run(makeCtx({ read })).level).toBe("skipped");
  });

  it("passes with an honest label when nothing is recommended", () => {
    const result = pluginsMarketplaceCheck.run(makeCtx());
    expect(result).toMatchObject({
      level: "pass",
      label: "No plugin marketplace is recommended yet",
    });
  });

  it("reports a missing recommendation as information", () => {
    const result = pluginsMarketplaceCheck.run(
      ctxWith(okSettings(), withRecommendations(MARKETPLACE, {})),
    );
    expect(result.level).toBe("info");
    expect(result.detail).toContain("example-marketplace");
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.applyDefaults" });
  });

  it("passes once the recommendation is present", () => {
    const settings = okSettings();
    settings.extraKnownMarketplaces = MARKETPLACE;
    expect(
      pluginsMarketplaceCheck.run(ctxWith(settings, withRecommendations(MARKETPLACE, {}))).level,
    ).toBe("pass");
  });

  it("treats a non-object value as nothing set up", () => {
    const settings = okSettings();
    settings.extraKnownMarketplaces = "oops";
    expect(
      pluginsMarketplaceCheck.run(ctxWith(settings, withRecommendations(MARKETPLACE, {}))).level,
    ).toBe("info");
  });
});

describe("plugins.enabled", () => {
  it.each([ABSENT, MALFORMED])("skips when there is nothing to read (%s)", (read) => {
    expect(pluginsEnabledCheck.run(makeCtx({ read })).level).toBe("skipped");
  });

  it("passes with an honest label when nothing is recommended", () => {
    expect(pluginsEnabledCheck.run(makeCtx())).toMatchObject({
      level: "pass",
      label: "No plugins are recommended yet",
    });
  });

  it("reports a plugin that is not turned on", () => {
    const result = pluginsEnabledCheck.run(ctxWith(okSettings(), withRecommendations({}, PLUGINS)));
    expect(result.level).toBe("info");
    expect(result.detail).toContain("helper@example-marketplace");
  });

  it("passes on presence, not equality — a narrowed scope list is drift, not absence", () => {
    const settings = okSettings();
    settings.enabledPlugins = { "helper@example-marketplace": ["Read"] };
    expect(pluginsEnabledCheck.run(ctxWith(settings, withRecommendations({}, PLUGINS))).level).toBe(
      "pass",
    );
  });

  it("treats a non-object value as nothing turned on", () => {
    const settings = okSettings();
    settings.enabledPlugins = 42;
    expect(pluginsEnabledCheck.run(ctxWith(settings, withRecommendations({}, PLUGINS))).level).toBe(
      "info",
    );
  });
});
