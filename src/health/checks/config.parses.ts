import { LABELS } from "../labels.js";
import type { Check, CheckContext, CheckResult } from "../types.js";
import { command, NO_FIX } from "./shared.js";

const CANNOT_READ = "The file could not be read as JSON.";

/**
 * Hard rule 4, belt to the reader's braces.
 *
 * V8's `SyntaxError.message` quotes ~20 characters of the document around the
 * fault, and the likeliest way for a user to break *this* file is pasting a
 * Bedrock bearer token in unquoted — which puts the token inside that quoted
 * window. `reader.ts` already refuses to pass V8's message through, but the
 * detail rendered here is one hop from a tooltip, so it is rebuilt from
 * scratch rather than trusted: a coordinate is repeated if the message offers
 * one, and nothing else survives.
 */
function safeDetail(error: string): string {
  const position = /\bcharacter (\d+)\b/.exec(error)?.[1];
  return position === undefined
    ? CANNOT_READ
    : `${CANNOT_READ} The problem is at character ${position}.`;
}

/**
 * FR-2.5. The primary remediation is opening the file; the tree offers
 * "restore previous configuration" alongside it. Neither writes anything: a
 * file we cannot parse is a file we must not overwrite.
 */
export const configParsesCheck = {
  id: "config.parses",
  group: "Configuration",
  run(ctx: CheckContext): CheckResult {
    if (ctx.read.kind === "absent") {
      return {
        id: "config.parses",
        group: "Configuration",
        level: "skipped",
        label: LABELS["config.parses"].skipped,
        fix: NO_FIX,
      };
    }
    if (ctx.read.kind === "malformed") {
      return {
        id: "config.parses",
        group: "Configuration",
        level: "error",
        label: LABELS["config.parses"].malformed,
        detail: safeDetail(ctx.read.error),
        fix: command("sensibleDefaults.openSettings", "Open the settings file"),
      };
    }
    return {
      id: "config.parses",
      group: "Configuration",
      level: "pass",
      label: LABELS["config.parses"].pass,
      fix: NO_FIX,
    };
  },
} satisfies Check;
