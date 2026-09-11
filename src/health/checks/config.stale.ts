/**
 * FR-3.2, FR-3.5 and FR-5.6's `config.stale`, as one check with four branches.
 *
 * They are one row rather than three because to the reader they are one
 * question — "am I being held to the current recommendations?" — and three rows
 * that are all about the manifest, only one of which is ever interesting, is
 * three rows nobody reads. The branches are ordered by what the user can act
 * on:
 *
 *   1. FR-3.5, the extension is too old for the manifest that was offered.
 *      Warn: nothing else here can be fixed until the update lands, and this is
 *      the only branch with a cause outside the panel.
 *   2. The applied snapshot is behind the manifest in force. Info, with
 *      `applyDefaults` — the one branch with a button that changes something.
 *   3. The manifest in force is not the fetched one (FR-3.2). Info, naming the
 *      date when we know it. Never a warning and never an error: a failed fetch
 *      is not the user's doing and they cannot make the network work from here
 *      (Q-AB — a stale manifest never escalates above info).
 *   4. Everything current.
 *
 * A snapshot with no `manifestRevision` is not stale: nothing has been applied,
 * so `config.exists` is already telling that story with a louder voice.
 */

import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult, Level, Remediation } from "../types.js";
import { APPLY_DEFAULTS, NO_FIX } from "./shared.js";

const UPDATE_EXTENSION: Remediation = {
  kind: "command",
  command: "extension.open",
  title: "Open this extension's page",
  args: ["cutler-sg.sensible-claude-code-defaults"],
};

export const configStaleCheck = {
  id: "config.stale",
  group: "Configuration",
  run(ctx: CheckContext): CheckResult {
    const status = ctx.manifestStatus;

    if (status.needsExtensionVersion !== undefined) {
      return result("warning", LABELS["config.stale"].needsUpdate, UPDATE_EXTENSION, {
        detail: `Newer recommendations need version ${status.needsExtensionVersion} of this extension.`,
      });
    }

    const applied = ctx.snapshot.manifestRevision;
    if (applied !== undefined && applied !== status.revision) {
      return result("info", LABELS["config.stale"].behind, APPLY_DEFAULTS);
    }

    if (status.source !== "fetched") {
      const label =
        status.source === "cached"
          ? LABELS["config.stale"].offline
          : LABELS["config.stale"].bundled;
      return result("info", label, NO_FIX, { detail: savedOn(status.fetchedAt) });
    }

    return result("pass", LABELS["config.stale"].pass, NO_FIX);
  },
} satisfies Check;

/**
 * FR-3.2's "<date>". A date, not a time: the hour we last reached the network
 * is noise, and a cached manifest's age is only ever read as "recent enough or
 * not". An unparseable stamp names no date rather than printing `Invalid Date`.
 */
function savedOn(fetchedAt: string | undefined): string | undefined {
  if (fetchedAt === undefined) return undefined;
  const at = new Date(fetchedAt);
  if (Number.isNaN(at.getTime())) return undefined;
  return `Last updated ${at.toISOString().slice(0, 10)}.`;
}

function result(
  level: Level,
  label: string,
  fix: Remediation,
  extra: { detail?: string | undefined } = {},
): CheckResult {
  return {
    id: "config.stale",
    group: "Configuration",
    level,
    label,
    fix,
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
  };
}
