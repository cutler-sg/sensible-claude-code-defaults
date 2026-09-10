/**
 * Manifest notices as panel rows (FR-3 `notices`, plan Q-AA).
 *
 * A notice is the one piece of remote *text* the extension shows a user, so
 * everything about this file is about containment:
 *
 * - It is display only. A notice never becomes a command id, never a URL the
 *   extension opens, and never a fix — `NO_FIX` is not a default here, it is
 *   the rule. Whoever can publish a manifest could otherwise aim every user's
 *   panel button at a command of their choosing.
 * - It is always info level, whatever the notice claims to be. FR-5.4 badges
 *   errors, so honouring a remote `level` would hand the update channel a red
 *   dot on every installation — a bigger lever than this project needs (Q-AA).
 *   The declared level is still shown, as words, in the tooltip.
 * - There are at most two, unexpired, from `selectNotices`. Validation has
 *   already stripped control characters and capped the length.
 * - Its id is derived from its text (F16), not from its position. VS Code keys
 *   a tree row's expansion and selection state on `TreeItem.id`, so a
 *   positional id lets a node's identity outlive its content: `notice.0` is one
 *   message before an expiry and a different one after, and the panel carries
 *   the first message's state onto the second message's text.
 *
 * They sit in Configuration, beside `config.stale`: both rows answer "what are
 * the recommendations telling me today?", which is the only thing a reader
 * would go to either of them for.
 */

import { selectNotices } from "../manifest/schema.js";
import type { Manifest } from "../manifest/types.js";
import { LABELS } from "./labels.js";
import type { CheckResult, NoticeId } from "./types.js";

export function noticeResults(manifest: Manifest, now: Date): CheckResult[] {
  const seen = new Set<NoticeId>();
  const rows: CheckResult[] = [];
  for (const notice of selectNotices(manifest.notices, now)) {
    const id = noticeId(notice.message);
    // Two rows cannot share an id — VS Code renders one node per id, so the
    // second would either vanish or fight the first for its state. Two
    // identical messages are one message anyway.
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      group: "Configuration",
      level: "info",
      label: notice.message,
      detail: `${LABELS.notice.from} (${notice.level}).`,
      fix: { kind: "none" },
    });
  }
  return rows;
}

/**
 * A notice's tree identity: a digest of its text (F16).
 *
 * FNV-1a, 32-bit, rather than a real hash — the id is only ever compared for
 * equality against the handful of other rows in the same panel, so this is a
 * dictionary key, not a security boundary, and a dependency on the update
 * channel's rendering path is not worth the collision margin. Kept numeric so
 * `NoticeId` stays the `notice.${number}` the check-id union is built from.
 */
export function noticeId(message: string): NoticeId {
  let hash = 0x811c9dc5;
  for (let index = 0; index < message.length; index += 1) {
    hash ^= message.charCodeAt(index);
    // The FNV prime, by shifts: `hash * 16777619` overflows a double's exact
    // integer range and would round, which is not a hash function any more.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return `notice.${hash}`;
}
