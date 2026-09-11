import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../../src/config/types.js";
import { configStaleCheck } from "../../../src/health/checks/config.stale.js";
import { LABELS } from "../../../src/health/labels.js";
import type { CheckContext, ManifestStatus } from "../../../src/health/types.js";
import { makeCtx } from "./fixture.js";

const CURRENT = "2026-09-11T00:00:00Z";
const OLDER = "2026-08-01T00:00:00Z";

function applied(revision: string | undefined): Snapshot {
  return {
    schemaVersion: 1,
    values: {},
    ...(revision === undefined ? {} : { manifestRevision: revision }),
  };
}

function ctx(status: Partial<ManifestStatus>, snapshotRevision?: string): CheckContext {
  return makeCtx({
    manifestStatus: { revision: CURRENT, source: "fetched", ...status },
    snapshot: applied(snapshotRevision),
  });
}

describe("config.stale — the applied revision", () => {
  it("passes when a fetched manifest matches what was applied", () => {
    const result = configStaleCheck.run(ctx({}, CURRENT));
    expect(result.level).toBe("pass");
    expect(result.label).toBe(LABELS["config.stale"].pass);
    expect(result.fix).toEqual({ kind: "none" });
  });

  it("offers an apply, at info level, when the applied revision is behind", () => {
    const result = configStaleCheck.run(ctx({}, OLDER));
    expect(result.level).toBe("info");
    expect(result.label).toBe(LABELS["config.stale"].behind);
    expect(result.fix).toMatchObject({ command: "sensibleDefaults.applyDefaults" });
  });

  /**
   * Q-AB: staleness never escalates above info, however old. The user did not
   * cause it and an error-level row would badge (FR-5.4) over advice they were
   * already being given.
   */
  it("stays at info for a manifest revision from years ago", () => {
    expect(configStaleCheck.run(ctx({}, "2019-01-01T00:00:00Z")).level).toBe("info");
  });

  it("says nothing about staleness when nothing has ever been applied", () => {
    // `config.exists` is already telling that story, louder.
    const result = configStaleCheck.run(ctx({}, undefined));
    expect(result.level).toBe("pass");
  });
});

describe("config.stale — FR-3.2's honest note about where the defaults came from", () => {
  it("names the date a cached manifest was last updated", () => {
    const result = configStaleCheck.run(
      ctx({ source: "cached", fetchedAt: "2026-09-01T09:30:00.000Z" }, CURRENT),
    );
    expect(result.level).toBe("info");
    expect(result.label).toBe(LABELS["config.stale"].offline);
    expect(result.detail).toBe("Last updated 2026-09-01.");
    // FR-3.2: never an error, and nothing for the user to press — they cannot
    // make the network work from a panel row.
    expect(result.fix).toEqual({ kind: "none" });
  });

  it("says the defaults came with the extension when nothing else validated", () => {
    const result = configStaleCheck.run(ctx({ source: "bundled" }, CURRENT));
    expect(result.level).toBe("info");
    expect(result.label).toBe(LABELS["config.stale"].bundled);
    expect(result.detail).toBeUndefined();
  });

  it("names no date rather than printing an unparseable one", () => {
    const result = configStaleCheck.run(ctx({ source: "cached", fetchedAt: "whenever" }, CURRENT));
    expect(result.detail).toBeUndefined();
  });

  it("prefers the actionable branch: behind wins over using saved defaults", () => {
    // Both are true — an old cache the user has not applied — and only one of
    // them has a button.
    const result = configStaleCheck.run(
      ctx({ source: "cached", fetchedAt: "2026-09-01T00:00:00Z" }, OLDER),
    );
    expect(result.label).toBe(LABELS["config.stale"].behind);
  });
});

describe("config.stale — FR-3.5's minExtensionVersion gate", () => {
  it("warns and points at the extension page when an update is required", () => {
    const result = configStaleCheck.run(
      ctx({ source: "cached", needsExtensionVersion: "0.4.0" }, CURRENT),
    );
    expect(result.level).toBe("warning");
    expect(result.label).toBe(LABELS["config.stale"].needsUpdate);
    expect(result.detail).toContain("0.4.0");
    expect(result.fix).toMatchObject({
      command: "extension.open",
      args: ["cutler-sg.sensible-claude-code-defaults"],
    });
  });

  it("wins over every other branch, including a stale applied revision", () => {
    // Nothing else here can be fixed until the update lands: applying the
    // defaults we have would write the very revision the gate rejected.
    const result = configStaleCheck.run(ctx({ needsExtensionVersion: "0.4.0" }, OLDER));
    expect(result.level).toBe("warning");
    expect(result.label).toBe(LABELS["config.stale"].needsUpdate);
  });
});
