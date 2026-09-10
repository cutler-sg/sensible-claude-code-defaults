/**
 * FR-4.8: is the Bedrock API key sitting in a project file?
 *
 * The check that earns its keep with this audience. What it says is shaped by
 * three rules.
 *
 * **The path, never the value.** A hit is reported by file name only. The whole
 * point is that the value is somewhere it should not be; naming it in a tooltip
 * would put it somewhere else.
 *
 * **The fix opens; it never edits.** Hard rule 1 forbids writing inside a
 * workspace folder, and plan Q-AD settles it: editing a user's repository file
 * to strip a secret is the exact class of action that rule exists to prevent.
 * So the button opens the file and the user removes the line.
 *
 * **A file git tracks needs different advice.** Deleting the line does not
 * take the value out of history, and a user who removes it and believes they
 * are safe is worse off than one who was never told. When we know the file is
 * tracked, the check says rotation is the remedy.
 *
 * A `partial` scan is an info row, never a pass: the scan not finishing is not
 * evidence of anything.
 */

import type { LeakHit, ScanOutcome } from "../../credential/leakScan.js";
import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult, Level } from "../types.js";
import { command, NO_FIX } from "./shared.js";

const ROTATE = command("sensibleDefaults.rotateToken", "Replace your Bedrock API key");

/**
 * Opens the file at the offending line, and nothing else. `vscode.open` takes a
 * `Uri` plus options, both of which the tree passes through as command
 * arguments — so the fix carries a path and a line, which is all a `LeakHit`
 * holds anyway.
 */
function openAt(hit: LeakHit): CheckResult["fix"] {
  return command("sensibleDefaults.openLeakedFile", "Open the file", [hit.file, hit.line]);
}

export const credLeakCheck = {
  id: "cred.leak",
  group: "Credential",
  run(ctx: CheckContext): CheckResult {
    const scan = ctx.credential.leakScan;
    if (scan === undefined) {
      return result("info", LABELS["cred.leak"].notChecked, NO_FIX);
    }
    switch (scan.kind) {
      case "skipped":
        return skipped(scan.reason);
      case "clean":
        return result("pass", LABELS["cred.leak"].pass, NO_FIX);
      case "hits":
        return found(scan.hits, "error");
      case "partial":
        // Hits found before the budget ran out are still real, and still the
        // more important thing to say. Only an empty partial reduces to "we
        // did not finish".
        return scan.hits.length > 0
          ? found(scan.hits, "error")
          : result("info", LABELS["cred.leak"].partial, NO_FIX, PARTIAL_DETAIL);
      default:
        // A `ScanOutcome` variant this check has not been taught about. It
        // must not read as a pass: not knowing is exactly the state the
        // `partial` row exists to say out loud.
        return result("info", LABELS["cred.leak"].notChecked, NO_FIX);
    }
  },
} satisfies Check;

const PARTIAL_DETAIL =
  "Some files were not checked, so this is not a clean result. Run the check again to try the rest.";

function skipped(reason: Extract<ScanOutcome, { kind: "skipped" }>["reason"]): CheckResult {
  switch (reason) {
    case "no-token":
      return result("skipped", LABELS["cred.leak"].skipped, NO_FIX);
    case "no-folders":
      return result("skipped", LABELS["cred.leak"].noFolders, NO_FIX);
    case "untrusted":
      // §13. Not a failure and not a pass: we were not allowed to look, and
      // saying so is what stops an untrusted folder reading as a clean one.
      return result("info", LABELS["cred.leak"].untrusted, NO_FIX);
  }
}

/**
 * The rows for one or more hits.
 *
 * The first hit gets the "open the file" button; the rest are listed in the
 * detail by path. A `Remediation` is one command, and offering to open only the
 * first is honest — the detail names every file, so nothing is hidden, and a
 * user who fixes one comes back to a check that now points at the next.
 *
 * `tracked` on *any* hit escalates the wording for all of them: the advice
 * "replacing the key is the only way to be safe" is true for the whole
 * situation once one copy has reached history.
 */
function found(hits: readonly LeakHit[], level: Level): CheckResult {
  const tracked = hits.some((hit) => hit.tracked === true);
  const label = tracked ? LABELS["cred.leak"].foundTracked : LABELS["cred.leak"].found;
  const first = hits[0];
  // `hits` is non-empty at every call site, but the type does not say so and
  // `noUncheckedIndexedAccess` is on — a missing first hit reduces to the fix
  // that is right regardless.
  const fix = first === undefined ? ROTATE : openAt(first);
  return result(level, label, fix, detail(hits, tracked));
}

/**
 * The paths, and what to do about them. Paths only — the value is what is being
 * protected, and a tooltip is as public as a label.
 */
function detail(hits: readonly LeakHit[], tracked: boolean): string {
  const files = hits.map((hit) => hit.file).join("\n");
  const advice = tracked
    ? "This file is saved in version control, so the key is almost certainly in its history too. Removing it now does not take it out of past versions — replace the key in the Amazon console instead. Nothing here has been changed for you."
    : "Remove the key from the file yourself, then replace it in the Amazon console to be sure. Nothing here has been changed for you.";
  return `${files}\n\n${advice}`;
}

function result(
  level: Level,
  label: string,
  fix: CheckResult["fix"],
  detail?: string,
): CheckResult {
  return {
    id: "cred.leak",
    group: "Credential",
    level,
    label,
    fix,
    ...(detail === undefined ? {} : { detail }),
  };
}
