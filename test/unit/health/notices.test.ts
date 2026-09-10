import { describe, expect, it } from "vitest";
import { LABELS } from "../../../src/health/labels.js";
import { noticeResults } from "../../../src/health/notices.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import type { Manifest, ManifestNotice } from "../../../src/manifest/types.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");

function withNotices(notices: ManifestNotice[]): Manifest {
  return { ...BUNDLED_MANIFEST, notices };
}

describe("manifest notices as panel rows", () => {
  it("renders nothing when the manifest carries none", () => {
    expect(noticeResults(withNotices([]), NOW)).toEqual([]);
  });

  it("shows the notice's text as the row, in Configuration", () => {
    const [row] = noticeResults(
      withNotices([{ level: "info", message: "Bedrock is moving region on the 3rd." }]),
      NOW,
    );
    expect(row).toEqual({
      id: "notice.0",
      group: "Configuration",
      level: "info",
      label: "Bedrock is moving region on the 3rd.",
      detail: `${LABELS.notice.from} (info).`,
      fix: { kind: "none" },
    });
  });

  it("gives each row a distinct id, so two notices are two rows", () => {
    const rows = noticeResults(
      withNotices([
        { level: "info", message: "first" },
        { level: "warning", message: "second" },
      ]),
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(["notice.0", "notice.1"]);
  });

  /**
   * Q-AA. A remote channel that can raise a warn- or error-level row in every
   * user's panel is a lever this project does not need: FR-5.4 badges errors,
   * so honouring the declared level would put a red dot on every installation
   * at the publisher's discretion. The level is still visible, as a word.
   */
  it("renders every level as info, whatever the notice claims to be", () => {
    const rows = noticeResults(
      withNotices([
        { level: "error", message: "everything is on fire" },
        { level: "warning", message: "some things are on fire" },
      ]),
      NOW,
    );
    expect(rows.map((row) => row.level)).toEqual(["info", "info"]);
    expect(rows[0]?.detail).toContain("(error)");
  });

  /** Untrusted remote text: displayed, never a command id and never a URL. */
  it("never offers a fix, so a notice cannot nominate a command", () => {
    const rows = noticeResults(
      withNotices([{ level: "info", message: "Run sensibleDefaults.clearToken now" }]),
      NOW,
    );
    expect(rows[0]?.fix).toEqual({ kind: "none" });
  });

  it("drops expired notices and caps the rest at two (selectNotices)", () => {
    const rows = noticeResults(
      withNotices([
        { level: "info", message: "expired", expiresAt: "2026-09-01T00:00:00Z" },
        { level: "info", message: "live one" },
        { level: "info", message: "live two" },
        { level: "info", message: "live three" },
      ]),
      NOW,
    );
    expect(rows.map((row) => row.label)).toEqual(["live one", "live two"]);
  });
});
