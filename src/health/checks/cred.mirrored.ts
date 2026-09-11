/**
 * Can Claude Code actually see the key (FR-4.4)?
 *
 * The keychain is where the token is safe; the settings file is where Claude
 * Code reads it. The panel spawns its binary from the extension host and
 * inherits VS Code's environment, which `environmentVariableCollection` never
 * touches — so a key that exists only in the keychain is a key Claude Code
 * cannot use, and that is an error rather than a nicety.
 *
 * A file holding a *different* key is a warning, not an error: something works,
 * and which of the two the user wants is a question only they can answer
 * (`resolveTokenConflict` asks it). Overwriting would be hard rule 3's exact
 * failure — destroying a value we did not write.
 */

import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { command, NO_FIX } from "./shared.js";

const REAPPLY = command("sensibleDefaults.reapplyToken", "Copy the key into my settings file");
const RESOLVE = command("sensibleDefaults.resolveTokenConflict", "Choose which key to use");

export const credMirroredCheck = {
  id: "cred.mirrored",
  group: "Credential",
  run(ctx: CheckContext): CheckResult {
    const { presence } = ctx.credential;

    // Without a keychain token there is nothing to mirror. `cred.present` owns
    // both of those states — the missing key and the file-only one — and saying
    // it twice makes the panel read as two problems rather than one.
    if (presence.source === "none" || presence.source === "settings-file") {
      return result("skipped", LABELS["cred.mirrored"].skipped, NO_FIX);
    }
    if (presence.source === "keychain") {
      return result("error", LABELS["cred.mirrored"].missing, REAPPLY);
    }
    return presence.mismatch
      ? result("warning", LABELS["cred.mirrored"].differs, RESOLVE)
      : result("pass", LABELS["cred.mirrored"].pass, NO_FIX);
  },
} satisfies Check;

function result(level: CheckResult["level"], label: string, fix: CheckResult["fix"]): CheckResult {
  return { id: "cred.mirrored", group: "Credential", level, label, fix };
}
