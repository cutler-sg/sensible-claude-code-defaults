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
  return selectNotices(manifest.notices, now).map((notice, index) => ({
    id: `notice.${index}` satisfies NoticeId as NoticeId,
    group: "Configuration",
    level: "info",
    label: notice.message,
    detail: `${LABELS.notice.from} (${notice.level}).`,
    fix: { kind: "none" },
  }));
}
