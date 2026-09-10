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
  "config.perms": {
    pass: "Your settings are private to you",
    skipped: "Nothing to check until Claude Code has been set up",
    unsupported: "Windows manages file privacy differently — nothing to check here",
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
  "config.stale": {
    skipped: "Checking for newer recommended settings arrives in a later update",
  },
  "cred.present": {
    skipped: "Not set up yet — API key management arrives in the next update",
  },
  "cred.mirrored": {
    skipped: "Not set up yet — API key management arrives in the next update",
  },
  "cred.valid": {
    skipped: "Not set up yet — connection testing arrives in the next update",
    untested: "Your Bedrock API key hasn't been tried yet — test it to be sure it works",
    pass: "Your Bedrock API key works",
    withoutHaiku: "Your key works, but the small, fast Claude model isn't turned on for you",
    badCredential: "Amazon wouldn't accept your Bedrock API key — it may have expired",
    modelNotEnabled: "Amazon accepted your key, but the Claude models aren't turned on for you",
    wrongRegion: "The Claude models aren't available in the Amazon region you chose",
    network: "Couldn't reach Amazon to try your Bedrock API key",
    unknown: "Amazon gave an answer we didn't understand when we tried your key",
  },
  "cred.age": {
    skipped: "Not set up yet — API key reminders arrive in the next update",
  },
  "cred.leak": {
    skipped: "Not set up yet — API key safety scanning arrives in the next update",
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
