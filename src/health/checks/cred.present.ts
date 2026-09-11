/**
 * Is there a Bedrock API key, and is it where it belongs (FR-4.1)?
 *
 * The keychain is canonical, so this check is about the keychain — but the
 * file-only state is not a failure. Claude Code's own `/setup-bedrock` writes a
 * token straight into the settings file, which makes "in the file, not in the
 * keychain" the common first-run state for anyone who tried the CLI wizard
 * first (plan Q-S). Telling them to enter a key they already have would be
 * wrong; offering to adopt the one they have is the whole point of the warning.
 */

import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { command, NO_FIX } from "./shared.js";

const SET_TOKEN = command("sensibleDefaults.setToken", "Set your Bedrock API key");
const ADOPT_TOKEN = command("sensibleDefaults.adoptToken", "Use the key from my settings file");

export const credPresentCheck = {
  id: "cred.present",
  group: "Credential",
  run(ctx: CheckContext): CheckResult {
    const { presence, keychainError } = ctx.credential;

    if (keychainError !== undefined) {
      // Plan Q-X: report it and stop. A "store it in a file instead" fallback
      // would quietly downgrade the security property the user was promised,
      // and that is a decision for a person, not for an error handler.
      return result("error", LABELS["cred.present"].keychainUnreachable, NO_FIX, keychainError);
    }
    if (presence.source === "keychain" || presence.source === "both") {
      return result("pass", LABELS["cred.present"].pass, NO_FIX);
    }
    if (presence.source === "settings-file") {
      return result("warning", LABELS["cred.present"].inFileOnly, ADOPT_TOKEN);
    }
    return result("error", LABELS["cred.present"].missing, SET_TOKEN);
  },
} satisfies Check;

function result(
  level: CheckResult["level"],
  label: string,
  fix: CheckResult["fix"],
  detail?: string,
): CheckResult {
  return {
    id: "cred.present",
    group: "Credential",
    level,
    label,
    fix,
    ...(detail === undefined ? {} : { detail }),
  };
}
