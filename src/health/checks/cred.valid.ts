/**
 * Does the key actually work (FR-4.7)?
 *
 * This check never calls AWS. The test call is user-initiated and lives in
 * `testConnection`; here we only report its last result (plan Q-T). A health
 * check that phoned AWS on every file change would bill the user for our
 * refresh loop and put the token on the wire on a schedule nobody chose.
 */

import type { ConnectionResult } from "../../credential/types.js";
import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult, Level } from "../types.js";
import { command } from "./shared.js";

const TEST = command("sensibleDefaults.testConnection", "Test the connection");

export const credValidCheck = {
  id: "cred.valid",
  group: "Credential",
  run(ctx: CheckContext): CheckResult {
    const { lastTest } = ctx.credential;
    if (lastTest === undefined || isStale(ctx)) {
      // `skipped`, not `warning`: an untested key is not evidence of a broken
      // one, and this is the state every correctly-configured user starts in.
      return { ...base("skipped", LABELS["cred.valid"].untested), fix: TEST };
    }
    const { level, label } = describe(lastTest.result);
    // The status goes on the tooltip, not the label. The label is the sentence
    // the user reads; a bare HTTP code there is noise to them (and a test pins
    // that it never appears). The tooltip is where someone helping them looks,
    // and on the unknown branch the status is the only lead there is.
    const detail =
      lastTest.result.kind === "unknown" ? `HTTP ${lastTest.result.status}` : undefined;
    return { ...base(level, label), ...(detail === undefined ? {} : { detail }), fix: TEST };
  },
} satisfies Check;

/**
 * A result speaks only for the key it tested. When the host stamps its results
 * with the tested key's `setAt` and that stamp no longer matches the stored
 * key, the result is about a key the user has replaced — reporting it would
 * vouch for, or accuse, the wrong credential (F5).
 *
 * An unstamped result is trusted: `tokenSetAt` is optional so that a host that
 * does not record it yet keeps working, rather than every result blanking out.
 */
function isStale(ctx: CheckContext): boolean {
  const tokenSetAt = ctx.credential.lastTest?.tokenSetAt;
  return tokenSetAt !== undefined && tokenSetAt !== ctx.credential.stored?.setAt;
}

/**
 * One plain-language sentence per outcome. `ok-without-haiku` is the only
 * partial success: the credential is good and Claude Code will work, but the
 * small model it uses for background tasks is not enabled, so answers arrive
 * from a larger, slower model than the user is paying for (plan Q-U).
 */
function describe(result: ConnectionResult): { level: Level; label: string } {
  switch (result.kind) {
    case "ok":
      return { level: "pass", label: LABELS["cred.valid"].pass };
    case "ok-without-haiku":
      return { level: "warning", label: LABELS["cred.valid"].withoutHaiku };
    case "bad-credential":
      return { level: "error", label: LABELS["cred.valid"].badCredential };
    case "insufficient-permissions":
      return { level: "error", label: LABELS["cred.valid"].insufficientPermissions };
    case "model-not-enabled":
      return { level: "error", label: LABELS["cred.valid"].modelNotEnabled };
    case "wrong-region":
      return { level: "error", label: LABELS["cred.valid"].wrongRegion };
    case "network":
      return { level: "error", label: LABELS["cred.valid"].network };
    case "unknown":
      return { level: "error", label: LABELS["cred.valid"].unknown };
    default:
      // A `ConnectionResult` variant this check has not been taught about.
      // `info`, so an unreadable row never badges, and never an exception: a
      // check that throws gives the user an error they cannot act on (F12).
      return { level: "info", label: LABELS["cred.valid"].unrecognised };
  }
}

function base(level: Level, label: string): Omit<CheckResult, "fix"> {
  return { id: "cred.valid", group: "Credential", level, label };
}
