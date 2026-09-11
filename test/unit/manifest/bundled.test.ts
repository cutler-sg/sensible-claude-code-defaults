import { describe, expect, it } from "vitest";
import bundledJson from "../../../manifest/defaults.json";
import packageJson from "../../../package.json";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import { validateManifest } from "../../../src/manifest/schema.js";
import { compareVersions } from "../../../src/manifest/version.js";

/**
 * FR-3.1 and the CI gate on the published manifest.
 *
 * `manifest/defaults.json` is both the bundled floor and — per plan Q-Y — the
 * document served from `main`, so a bad edit ships to every install twice
 * over: inside the next VSIX, and immediately over the update channel. This
 * test is what makes that unmergeable. It runs in CI as part of `bun run test`,
 * so no separate CI step is needed.
 *
 * It reads the JSON file rather than `BUNDLED_MANIFEST` in the first case,
 * because `bundled.ts` reaches the manifest through a cast: the cast is the
 * thing being checked.
 */
describe("manifest/defaults.json", () => {
  it("passes the schema", () => {
    const result = validateManifest(bundledJson);
    expect(result.ok ? [] : result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is exactly what the cast in bundled.ts claims it is", () => {
    const result = validateManifest(bundledJson);
    expect(result.ok && result.manifest).toEqual(BUNDLED_MANIFEST);
  });

  it("does not demand an extension version newer than the one shipping it", () => {
    // A bundle whose own floor excludes the extension it ships in would gate
    // itself out of the fallback chain on first run (FR-3.5).
    expect(
      compareVersions(BUNDLED_MANIFEST.minExtensionVersion, packageJson.version),
    ).toBeLessThanOrEqual(0);
  });
});
