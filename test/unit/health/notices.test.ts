import { describe, expect, it } from "vitest";
import { LABELS } from "../../../src/health/labels.js";
import { noticeId, noticeResults } from "../../../src/health/notices.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import type { Manifest, ManifestNotice } from "../../../src/manifest/types.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");

function withNotices(notices: ManifestNotice[]): Manifest {
  return { ...BUNDLED_MANIFEST, notices };
}

/** The remote half of a row's label, with the F4 provenance prefix taken off. */
function messageOf(row: { label: string }): string {
  return row.label.replace(`${LABELS.notice.prefix}: `, "");
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
      id: noticeId("Bedrock is moving region on the 3rd."),
      group: "Configuration",
      level: "info",
      label: `${LABELS.notice.prefix}: Bedrock is moving region on the 3rd.`,
      detail: `${LABELS.notice.sentAs} info.`,
      fix: { kind: "none" },
    });
  });

  /**
   * F4. A notice row renders with the same codicon, font, indent and group as
   * `config.drift` — so remote text reading "Your Bedrock API key has expired.
   * Run 'Set Bedrock API Key'…" used to arrive as a first-class piece of the
   * extension's own advice. Having no button does not help when the text can
   * name a real button.
   *
   * The only provenance marker was in `detail`, i.e. the tooltip, which is
   * invisible until hover and reaches a screen-reader user not at all, because
   * `accessibilityInformation.label` is built from the label. So the marker has
   * to be in the label: visible in the row, and in the accessibility string by
   * construction.
   */
  it("marks a notice as somebody else's words, in the row itself (F4)", () => {
    const [row] = noticeResults(
      withNotices([
        {
          level: "error",
          message: "Your Bedrock API key has expired. Run 'Set Bedrock API Key'.",
        },
      ]),
      NOW,
    );

    expect(row?.label.startsWith(`${LABELS.notice.prefix}:`)).toBe(true);
    expect(row?.label).toContain("Your Bedrock API key has expired.");
  });

  /**
   * The prefix is what survives a narrow panel: a tree row truncates at the
   * end, so provenance placed first is the part the reader always sees, and
   * the impersonation is the part that gets cut off.
   */
  it("puts the provenance before the remote text, never after", () => {
    const [row] = noticeResults(withNotices([{ level: "info", message: "anything" }]), NOW);
    expect(row?.label.indexOf(LABELS.notice.prefix)).toBe(0);
  });

  it("gives each row a distinct id, so two notices are two rows", () => {
    const rows = noticeResults(
      withNotices([
        { level: "info", message: "first" },
        { level: "warning", message: "second" },
      ]),
      NOW,
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  /**
   * F16. The ids used to be positional, so a row's identity outlived its
   * content: `notice.0` was one message before an expiry and a different one
   * after. VS Code keys expansion and selection state on `TreeItem.id`, so the
   * panel would carry the first notice's state onto the second notice's text —
   * the mirror image of the bug M2's review found in the check rows.
   */
  it("keeps a notice's id with its text, not with its position (F16)", () => {
    const first = noticeResults(
      withNotices([
        { level: "info", message: "expiring soon", expiresAt: "2026-09-12T00:00:00Z" },
        { level: "info", message: "the long-lived one" },
      ]),
      NOW,
    );
    // A day later the first notice has expired and the second has slid into
    // position 0. Its id must have come with it.
    const later = noticeResults(
      withNotices([
        { level: "info", message: "expiring soon", expiresAt: "2026-09-12T00:00:00Z" },
        { level: "info", message: "the long-lived one" },
      ]),
      new Date("2026-09-13T12:00:00.000Z"),
    );

    expect(later.map(messageOf)).toEqual(["the long-lived one"]);
    expect(later[0]?.id).toBe(first[1]?.id);
    expect(later[0]?.id).not.toBe(first[0]?.id);
  });

  it("gives different text different ids, so a replaced notice is a new row", () => {
    expect(noticeId("one thing")).not.toBe(noticeId("another thing"));
  });

  /**
   * `runner.ts` reserves `notice.-1` for the row that says notice synthesis
   * itself failed (F5). No message may be able to claim it, or the publisher of
   * a manifest could aim a crafted notice at that row's identity.
   */
  it("never mints the id the runner reserves for its own failure row", () => {
    for (const message of ["", "-1", "notice.-1", "x".repeat(200), "\u{1f600}"]) {
      expect(noticeId(message)).not.toBe("notice.-1");
      expect(noticeId(message)).toMatch(/^notice\.\d+$/);
    }
  });

  /**
   * Two identical messages cannot be two rows: they would share an id, and VS
   * Code renders one tree node per id — the second would vanish or, worse,
   * fight the first for its state. Identical text is one message anyway.
   */
  it("collapses two identical messages into one row", () => {
    const rows = noticeResults(
      withNotices([
        { level: "info", message: "the same thing twice" },
        { level: "warning", message: "the same thing twice" },
      ]),
      NOW,
    );
    expect(rows).toHaveLength(1);
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
    expect(rows[0]?.detail).toContain("error");
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
    expect(rows.map(messageOf)).toEqual(["live one", "live two"]);
  });
});
