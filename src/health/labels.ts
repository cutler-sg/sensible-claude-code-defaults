/**
 * Every user-facing string the health checks can produce (FR-5.3).
 *
 * The audience does not know what an environment variable is, so no label here
 * names one, mentions a file format, or quotes a path. Paths and raw parser
 * output belong in `detail`, which the tree renders as a tooltip for the person
 * who goes looking. `test/unit/health/labels.test.ts` enforces the first half
 * of that mechanically.
 */

import type { ManagedKey } from "../config/types.js";
import type { ConnectionResult } from "../credential/types.js";

export const LABELS = {
  /** Used by the runner when a check body throws (never by a check itself). */
  crashed: "This check couldn't finish",

  "install.extension": {
    pass: "Claude Code is installed",
    missing: "Claude Code is not installed",
  },
  "install.version": {
    pass: "Your Claude Code is new enough for these settings",
    outdated: "Your Claude Code is older than these settings expect",
    skipped: "Nothing to check until Claude Code is installed",
  },
  "install.cli": {
    pass: "You can also start Claude Code from a terminal",
    missing: "Claude Code isn't available from a terminal — that's normal",
  },
  "config.exists": {
    pass: "Your Claude Code settings are in place",
    absent: "Claude Code hasn't been set up yet",
  },
  "config.parses": {
    pass: "Your settings can be read",
    malformed: "Your settings are damaged and Claude Code can't read them",
    skipped: "Nothing to check until Claude Code has been set up",
  },
  /**
   * The Windows arm (M6 Part B) says the same things as the POSIX one, because
   * to the reader they are the same things: who else can open this file.
   *
   * `unverifiable` is the label Q-AG exists to make possible. Before M6 an
   * unreadable ACL was reported as "nothing to check here" — indistinguishable
   * from a pass, on the file holding the key. It is now its own story, and it
   * is a warning: not knowing is not the same as being fine.
   */
  "config.perms": {
    pass: "Your settings are private to you",
    aclPass: "Windows settings permissions checked",
    skipped: "Nothing to check until Claude Code has been set up",
    unsupported: "This computer doesn't offer a way to check who can read your settings",
    unverifiable: "We couldn't tell who else can read your settings on this computer",
    loose: "Other people using this computer can read your settings",
    failed: "Other people using this computer may be able to read your settings",
  },
  "config.bedrock": {
    pass: "Claude Code is set to use Amazon Bedrock",
    off: "Claude Code isn't set to use Amazon Bedrock",
    skipped: "Nothing to check until Claude Code has been set up",
  },
  "config.region": {
    pass: "Your Amazon region is set",
    unset: "No Amazon region has been chosen",
    unknown: "The chosen Amazon region isn't one Claude Code can use",
    skipped: "Nothing to check until Claude Code has been set up",
  },
  "config.models": {
    pass: "The recommended Claude models are selected",
    mismatch: "The recommended Claude models aren't selected",
    skipped: "Nothing to check until Claude Code has been set up",
  },
  "config.drift": {
    pass: "Nothing has been changed since the recommended setup",
    drifted: "Some settings have been changed since the recommended setup",
    skipped: "Nothing to check until Claude Code has been set up",
  },
  /**
   * One check, four stories, because to the reader they are one story: "are the
   * recommendations I am being held to the current ones?". The FR-3.5 gate wins
   * over staleness — the update is the thing that unblocks everything else —
   * and "using saved defaults" is never an error (FR-3.2), because the user did
   * not cause it and cannot fix it.
   */
  "config.stale": {
    pass: "Your settings match the latest recommendations",
    behind: "There are newer recommended settings to apply",
    offline: "Using the recommendations saved on this computer",
    bundled: "Using the recommendations that came with this extension",
    needsUpdate: "An update to this extension is available with newer recommendations",
  },
  notice: {
    /**
     * Prefixes the row itself, not the tooltip (F4). A notice renders with the
     * same codicon, font, indent and group as our own advice, so without this
     * the only thing separating remote text from the extension's own voice is
     * a tooltip — invisible until hover, and absent entirely for a screen
     * reader, whose label is built from this string.
     *
     * It goes first because a tree row truncates at the end: the provenance is
     * the part the reader always sees, and the remote text is the part that
     * gets cut off.
     */
    prefix: "Message from the people who look after these settings",
    /**
     * The tooltip's second line. The declared level is shown as a word rather
     * than honoured as a level (Q-AA), so the reader can see that a publisher
     * called something urgent without the publisher getting a red dot in every
     * installation.
     */
    sentAs: "They marked it as",
  },
  "cred.present": {
    pass: "Your Bedrock API key is saved in this computer's keychain",
    inFileOnly: "Your Bedrock API key isn't in this computer's keychain yet",
    missing: "No Bedrock API key has been set",
    keychainUnreachable: "This computer's keychain can't be opened, so your key can't be checked",
  },
  "cred.mirrored": {
    pass: "Claude Code can see your Bedrock API key",
    missing: "Claude Code can't see your Bedrock API key",
    differs: "Claude Code is using a different Bedrock API key from the one you saved",
    skipped: "Nothing to check until a Bedrock API key is saved",
  },
  "cred.valid": {
    untested: "Your Bedrock API key hasn't been tried yet — test it to be sure it works",
    pass: "Your Bedrock API key works",
    withoutHaiku: "Your key works, but the small, fast Claude model isn't turned on for you",
    badCredential: "Amazon wouldn't accept your Bedrock API key — it may have expired",
    insufficientPermissions:
      "Your Bedrock API key is valid, but it isn't allowed to use Claude — whoever issued it needs to widen its permissions",
    modelNotEnabled: "Amazon accepted your key, but the Claude models aren't turned on for you",
    wrongRegion: "The Claude models aren't available in the Amazon region you chose",
    network: "Couldn't reach Amazon to try your Bedrock API key",
    tls: "A certificate problem blocked the secure connection to Amazon",
    proxy: "Your network proxy requires sign-in before Amazon can be reached",
    unknown: "Amazon gave an answer we didn't understand when we tried your key",
    unrecognised: "We couldn't tell how the last test of your Bedrock API key went — try it again",
  },
  "cred.age": {
    unknown: "We don't know how long ago your Bedrock API key was saved",
    skipped: "Nothing to check until a Bedrock API key is saved",
  },
  "cred.leak": {
    pass: "Your Bedrock API key isn't sitting in any of your project files",
    /** The scan is the point of the check, so not running it is information. */
    notChecked: "Your project files haven't been checked for a copy of your key",
    untrusted: "Open folder not checked for a copy of your key — you haven't trusted it yet",
    noFolders: "No project folder is open, so there's nothing to check for a copy of your key",
    skipped: "Nothing to check until a Bedrock API key is saved",
    /**
     * FR-4.8's whole reason for existing. The user is told the file, never the
     * value, and told plainly that deleting it is not enough when git has seen
     * it — a user who removes the line and believes they are safe is worse off
     * than one who was never told.
     */
    found: "Your Bedrock API key is written inside one of your project files",
    foundTracked:
      "Your Bedrock API key is inside a project file that's saved in version control — replacing the key is the only way to be safe",
    /**
     * F7. The same finding, from a scan that did not get through everything.
     *
     * Without the hedge, an incomplete list of the places the key is reads as
     * the list: the user removes it from the one file named, runs the check
     * again, times out again before the remaining copies, and is told the same
     * confident thing twice. "There may be more" is the whole difference
     * between a user who keeps looking and one who stops.
     */
    foundPartial:
      "Your Bedrock API key is written inside one of your project files — and we didn't finish checking the rest",
    foundTrackedPartial:
      "Your Bedrock API key is inside a project file that's saved in version control — replacing the key is the only way to be safe, and we didn't finish checking the rest",
    /**
     * Never a pass. "We looked at some of your files and found nothing" and
     * "your key is not in your project" are different claims.
     */
    partial: "We ran out of time checking your project files for a copy of your key",
  },
  "plugins.marketplace": {
    none: "No plugin marketplace is recommended yet",
    pass: "The recommended plugin marketplaces are set up",
    missing: "A recommended plugin marketplace hasn't been set up",
    skipped: "Nothing to check until Claude Code has been set up",
  },
  "plugins.enabled": {
    none: "No plugins are recommended yet",
    pass: "The recommended plugins are turned on",
    missing: "Some recommended plugins aren't turned on",
    skipped: "Nothing to check until Claude Code has been set up",
  },
} as const;

const KEY_DISPLAY_NAMES: Record<ManagedKey, string> = {
  "env.CLAUDE_CODE_USE_BEDROCK": "Amazon Bedrock connection",
  "env.AWS_REGION": "Amazon region",
  "env.ANTHROPIC_DEFAULT_OPUS_MODEL": "Opus model",
  "env.ANTHROPIC_DEFAULT_SONNET_MODEL": "Sonnet model",
  "env.ANTHROPIC_DEFAULT_HAIKU_MODEL": "Haiku model",
  "env.AWS_BEARER_TOKEN_BEDROCK": "Amazon Bedrock API key",
  "permissions.deny": "blocked commands list",
  extraKnownMarketplaces: "plugin marketplace list",
  enabledPlugins: "enabled plugins list",
};

export function networkGuidance(reason: Extract<ConnectionResult, { kind: "network" }>["reason"]): {
  sentence: string;
  hint: string;
} {
  if (reason === "tls") {
    return {
      sentence: LABELS["cred.valid"].tls,
      hint: "Your company may inspect encrypted connections. Ask IT to check its trusted certificates and your Claude Code version. We haven't changed certificate trust or disabled certificate checks.",
    };
  }
  if (reason === "proxy") {
    return {
      sentence: LABELS["cred.valid"].proxy,
      hint: "Sign in to your company network or ask IT to configure proxy access, then try again.",
    };
  }
  return {
    sentence: LABELS["cred.valid"].network,
    hint: "Check your internet connection, then try again.",
  };
}

export function keyDisplayName(key: ManagedKey): string {
  return KEY_DISPLAY_NAMES[key];
}

/**
 * The three model pins are the routine case, and blaming the user for them
 * would be wrong: Claude Code writes them itself from `/setup-bedrock` and from
 * the model prompt it shows at startup. Everything else in the managed set only
 * changes because a person changed it.
 */
const CLAUDE_CODE_WRITES: ReadonlySet<ManagedKey> = new Set<ManagedKey>([
  "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
  "env.ANTHROPIC_DEFAULT_SONNET_MODEL",
  "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
]);

export function driftLabel(key: ManagedKey): string {
  const name = keyDisplayName(key);
  return CLAUDE_CODE_WRITES.has(key)
    ? `Claude Code changed the ${name}`
    : `You changed the ${name}`;
}

/**
 * FR-4.6's label. The age is approximate and never a date: the exact instant is
 * noise to the person reading it, and a date invites "but I set it in March"
 * arguments the check cannot win.
 */
export function credAgeLabel(level: "ok" | "warn" | "fail", days: number): string {
  const age = `Your Bedrock API key is ${approximateAge(days)} old`;
  switch (level) {
    case "ok":
      return age;
    case "warn":
      return `${age} — worth replacing it soon`;
    case "fail":
      return `${age} — time to replace it`;
  }
}

const DAYS_PER_WEEK = 7;
/** Averaged, because "about 3 months" is the claim, not a calendar calculation. */
const DAYS_PER_MONTH = 30.44;

/**
 * Weeks up to two months, months after that. A key set in the future — a clock
 * that moved — reads as new rather than as a negative age.
 */
export function approximateAge(days: number): string {
  if (days < DAYS_PER_WEEK) {
    return "less than a week";
  }
  if (days < 2 * DAYS_PER_MONTH) {
    return plural(Math.round(days / DAYS_PER_WEEK), "week");
  }
  return plural(Math.round(days / DAYS_PER_MONTH), "month");
}

function plural(count: number, unit: string): string {
  return `about ${count} ${unit}${count === 1 ? "" : "s"}`;
}
