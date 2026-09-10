/**
 * Manifest validation (FR-3.4).
 *
 * This is the security boundary of the update channel. A manifest reaching a
 * user has passed no Marketplace scan and no review; the only thing between a
 * bad revision and every installation at once is this file. So it is written
 * as a whitelist — every field is checked for the exact shape the extension
 * will use, and anything unrecognised is dropped rather than carried forward.
 *
 * Hand-written on purpose. A schema library here would be a dependency on the
 * update channel's own integrity, and the rules below are more specific than a
 * generic validator would express anyway (`warnAfterDays < failAfterDays`, an
 * `https:` console URL, marketplace sources restricted to two known shapes).
 */

import type { JsonObject, JsonValue } from "../config/types.js";
import type { CredentialPolicy, Manifest, ManifestNotice } from "./types.js";

/** A rejection names the path and what was wrong, never the value. */
export interface SchemaProblem {
  path: string;
  problem: string;
}

export type ValidationResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; problems: SchemaProblem[] };

/** Longer than any legitimate notice; a manifest is advice, not a document. */
const MAX_NOTICE_LENGTH = 200;
/** Two is enough to say something; more is a channel for nagging every user. */
export const MAX_NOTICES = 2;
/** `owner/name`, the only shape `extraKnownMarketplaces` github sources take. */
const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/**
 * Bedrock model identifiers, in every form PRD §17 and AWS document: a bare
 * foundation-model id (`anthropic.claude-…-v1:0`), an inference profile with a
 * geography prefix (`us.`, `eu.`, `global.`), and the ARN forms of both — which
 * is why `:` and `/` are in the class. Capped at 200 characters: the longest
 * real one is an application-inference-profile ARN at well under half that.
 *
 * The exclusions are what matter. No whitespace and no control characters, so a
 * value cannot carry a second line into a rendered panel row; no `%`, `?` or
 * `#`, so it cannot reinterpret the URL path Claude Code builds around it.
 */
const MODEL_ID_SHAPE = /^[A-Za-z0-9._:/-]{1,200}$/;
/** The five keys, and the only values each may take. */
const ENV_VALUE_RULES: Record<string, { test: (value: string) => boolean; problem: string }> = {
  CLAUDE_CODE_USE_BEDROCK: {
    test: (value) => BEDROCK_FLAGS.has(value),
    problem: "must be 1, 0, true or false",
  },
  AWS_REGION: { test: (value) => REGION_SHAPE.test(value), problem: "must be an AWS region name" },
  ANTHROPIC_DEFAULT_OPUS_MODEL: { test: isModelId, problem: "must be a Bedrock model id" },
  ANTHROPIC_DEFAULT_SONNET_MODEL: { test: isModelId, problem: "must be a Bedrock model id" },
  ANTHROPIC_DEFAULT_HAIKU_MODEL: { test: isModelId, problem: "must be a Bedrock model id" },
};
/** Claude Code reads this as a boolean; these are the four spellings it takes. */
const BEDROCK_FLAGS = new Set(["1", "0", "true", "false"]);
/**
 * Bounds on the credential age policy.
 *
 * `cred.age` is the only check that expires a key, and without a bound the
 * channel can disable it for every install permanently — `failAfterDays:
 * 1000000` validated and a 26-year-old key reported pass. 400 days is past any
 * rotation policy worth stating and still comfortably inside a key's useful
 * life; 7 days is short of any key a user could reasonably be warned about,
 * below which the warning is noise the user cannot act on.
 */
const MAX_FAIL_AFTER_DAYS = 400;
const MIN_WARN_AFTER_DAYS = 7;
/**
 * Marketplace names and plugin ids. Both are remote text that becomes a
 * `settings.json` key and is joined into a panel row verbatim, so they get the
 * same treatment notice text already got: a shape, a cap, and no control
 * characters. Without it a marketplace named
 * `"Claude Code\n\n  ACTION REQUIRED: re-enter your API key"` rendered as its
 * own line under a row the user has no reason to distrust.
 *
 * `@` is in the class because a plugin id is `plugin@marketplace`, and a space
 * because a marketplace name is a display name.
 */
const NAME_SHAPE = /^[A-Za-z0-9._@ -]{1,64}$/;
const NAME_PROBLEM = "name must be 1-64 characters of letters, digits, . _ @ - or space";
/**
 * How many entries each collection may hold.
 *
 * Unbounded, the manifest could ship tens of thousands of individually valid
 * entries; `merge` would build a settings document over a megabyte and the
 * writer would atomically write it. That is a denial of service against Claude
 * Code's own config parse which *survives removal of the manifest*, because the
 * damage is in the user's file rather than in the channel.
 *
 * The numbers are an order of magnitude above the bundled copy — three deny
 * rules, four regions, no marketplaces — and far below anything a user would
 * want in their settings.json.
 */
const MAX_DENY_RULES = 64;
const MAX_MARKETPLACES = 32;
const MAX_PLUGINS = 64;
const MAX_REGIONS = 32;
/**
 * `selectNotices` renders two; this is what may be *carried*. It is higher on
 * purpose: validation has no clock, so capping at two here would let a pair of
 * long-expired notices take both slots and suppress a live one (Q-AA).
 */
const MAX_NOTICE_ENTRIES = 16;
/**
 * A dot segment is two legal characters either side of a slash, so the shape
 * above cannot tell `../evil` from `a.b/c` — and a consumer joining it against
 * `https://github.com/` gets `https://github.com/evil`, a different repository
 * than the manifest named. Checked separately rather than by tightening the
 * shape, because a dot is genuinely legal inside an owner or a repo name.
 */
const DOT_SEGMENTS = new Set([".", ".."]);
const VERSION_SHAPE = /^\d+(\.\d+){0,2}(-[A-Za-z0-9.-]+)?$/;
/** AWS region labels: `us-east-1`, `ap-southeast-2`, `us-gov-west-1`. */
const REGION_SHAPE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
/** `2026-10-01`, optionally with a time and zone. */
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
/**
 * Control characters, which a notice must not use to forge panel lines or to
 * hide text from the reader. Stripping them is the whole point of the rule
 * the linter is objecting to.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the intent.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

export function validateManifest(input: unknown): ValidationResult {
  const problems: SchemaProblem[] = [];
  const fail = (path: string, problem: string): undefined => {
    problems.push({ path, problem });
    return undefined;
  };

  if (!isPlainObject(input)) {
    return { ok: false, problems: [{ path: "", problem: "not a JSON object" }] };
  }

  // A future schema version may mean anything at all, so an extension that
  // does not know it must not guess — the cache or the bundle is safer.
  if (input.schemaVersion !== 1) {
    return { ok: false, problems: [{ path: "schemaVersion", problem: "must be 1" }] };
  }

  const revision = requireString(input.revision, "revision", fail);
  const minExtensionVersion = requireVersion(
    input.minExtensionVersion,
    "minExtensionVersion",
    fail,
  );
  const minimumClaudeCodeVersion = requireVersion(
    input.minimumClaudeCodeVersion,
    "minimumClaudeCodeVersion",
    fail,
  );
  const defaults = validateDefaults(input.defaults, fail);
  const regions = validateRegions(input.regions, fail);
  const credential = validateCredential(input.credential, fail);
  const notices = validateNotices(input.notices, fail);

  if (
    problems.length > 0 ||
    revision === undefined ||
    minExtensionVersion === undefined ||
    minimumClaudeCodeVersion === undefined ||
    defaults === undefined ||
    regions === undefined ||
    credential === undefined ||
    notices === undefined
  ) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      revision,
      minExtensionVersion,
      minimumClaudeCodeVersion,
      defaults,
      regions,
      credential,
      notices,
    },
  };
}

type Fail = (path: string, problem: string) => undefined;

function validateDefaults(value: unknown, fail: Fail): Manifest["defaults"] | undefined {
  if (!isPlainObject(value)) return fail("defaults", "must be an object");

  const env: Record<string, string> = {};
  if (!isPlainObject(value.env)) {
    fail("defaults.env", "must be an object");
  } else {
    for (const [key, entry] of Object.entries(value.env)) {
      // Skip before type-checking, not after. An unknown key is not ours to
      // judge: a newer manifest adding a non-string field under `env` would
      // otherwise reject the whole document for every older install and pin
      // them silently to their cache — the exact forward-compatibility failure
      // dropping unknown keys exists to avoid.
      const rule = Object.hasOwn(ENV_VALUE_RULES, key) ? ENV_VALUE_RULES[key] : undefined;
      if (rule === undefined) continue;
      // Claude Code reads these as environment variables, so a JSON boolean or
      // number would be written as a value it cannot use. Reject rather than
      // coerce: a manifest saying `true` meant something we cannot infer.
      if (typeof entry !== "string") fail(`defaults.env.${key}`, "must be a string");
      // Whitelisting the key says only *which* variable the channel may set.
      // Every one of these values is used structurally by Claude Code — the
      // region becomes a hostname label in `bedrock-runtime.<region>.amazonaws.com`,
      // the model ids become URL path segments — so a value that merely is a
      // string is a host the manifest chose to send the user's Bedrock bearer
      // token to. Same rigour as `regions[]`, which was already checked here
      // and was the asymmetry this closes.
      else if (!rule.test(entry)) fail(`defaults.env.${key}`, rule.problem);
      else env[key] = entry;
    }
  }

  const deny = validateDeny(value.permissions, fail) ?? [];

  const extraKnownMarketplaces = validateMarketplaces(value.extraKnownMarketplaces, fail);
  const enabledPlugins = validatePlugins(value.enabledPlugins, fail);

  if (extraKnownMarketplaces === undefined || enabledPlugins === undefined) return undefined;
  return { env, permissions: { deny }, extraKnownMarketplaces, enabledPlugins };
}

function validateDeny(permissions: unknown, fail: Fail): string[] | undefined {
  const path = "defaults.permissions.deny";
  if (!isPlainObject(permissions) || !Array.isArray(permissions.deny)) {
    return fail(path, "must be an array");
  }
  if (tooMany(permissions.deny, MAX_DENY_RULES, path, fail)) return undefined;

  const deny: string[] = [];
  for (const [index, rule] of permissions.deny.entries()) {
    if (typeof rule !== "string") fail(`${path}[${index}]`, "must be a string");
    else deny.push(rule);
  }
  return deny;
}

/**
 * Only the two source shapes Claude Code documents. A manifest that could name
 * an arbitrary source would let the update channel point every user's Claude
 * Code at somebody else's plugin code — the widest blast radius in the project.
 */
function validateMarketplaces(value: unknown, fail: Fail): JsonObject | undefined {
  if (!isPlainObject(value)) return fail("defaults.extraKnownMarketplaces", "must be an object");
  if (tooMany(Object.keys(value), MAX_MARKETPLACES, "defaults.extraKnownMarketplaces", fail)) {
    return undefined;
  }

  const out: JsonObject = {};
  for (const [name, entry] of Object.entries(value)) {
    // Checked before the path is built, and reported against the map rather
    // than the entry: a bad name is the offending value, and
    // `defaults.extraKnownMarketplaces.<name>` would carry the forged text
    // into the log this rejection exists to keep it out of.
    if (!NAME_SHAPE.test(name)) {
      fail("defaults.extraKnownMarketplaces", NAME_PROBLEM);
      continue;
    }
    const path = `defaults.extraKnownMarketplaces.${name}`;
    if (!isPlainObject(entry) || !isPlainObject(entry.source)) {
      fail(path, "must have a source object");
      continue;
    }
    const source = entry.source;
    if (source.source === "github") {
      if (typeof source.repo !== "string" || !isSafeRepo(source.repo)) {
        fail(`${path}.source.repo`, "must be owner/name");
        continue;
      }
      out[name] = { source: { source: "github", repo: source.repo } };
    } else if (source.source === "url") {
      if (typeof source.url !== "string" || !isHttpsUrl(source.url)) {
        fail(`${path}.source.url`, "must be an https URL");
        continue;
      }
      out[name] = { source: { source: "url", url: source.url } };
    } else {
      fail(`${path}.source.source`, "must be github or url");
    }
  }
  return out;
}

function validatePlugins(
  value: unknown,
  fail: Fail,
): Record<string, boolean | string[]> | undefined {
  if (!isPlainObject(value)) return fail("defaults.enabledPlugins", "must be an object");
  if (tooMany(Object.keys(value), MAX_PLUGINS, "defaults.enabledPlugins", fail)) return undefined;

  const out: Record<string, boolean | string[]> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!NAME_SHAPE.test(name)) {
      fail("defaults.enabledPlugins", NAME_PROBLEM);
      continue;
    }
    if (typeof entry === "boolean") {
      out[name] = entry;
    } else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      // Copied, not aliased: every other field is rebuilt, and a validated
      // manifest that changes when its input is mutated is not validated.
      out[name] = [...(entry as string[])];
    } else {
      fail(`defaults.enabledPlugins.${name}`, "must be a boolean or an array of strings");
    }
  }
  return out;
}

function validateRegions(value: unknown, fail: Fail): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return fail("regions", "must be a non-empty array");
  }
  if (tooMany(value, MAX_REGIONS, "regions", fail)) return undefined;
  const out: string[] = [];
  for (const [index, region] of value.entries()) {
    if (typeof region !== "string" || !REGION_SHAPE.test(region)) {
      fail(`regions[${index}]`, "must be an AWS region name");
    } else {
      out.push(region);
    }
  }
  return out.length === value.length ? out : undefined;
}

function validateCredential(value: unknown, fail: Fail): CredentialPolicy | undefined {
  if (!isPlainObject(value)) return fail("credential", "must be an object");

  const warnAfterDays = requireDays(value.warnAfterDays, "credential.warnAfterDays", fail, {
    min: MIN_WARN_AFTER_DAYS,
  });
  const failAfterDays = requireDays(value.failAfterDays, "credential.failAfterDays", fail, {
    max: MAX_FAIL_AFTER_DAYS,
  });
  const consoleUrl = value.consoleUrl;

  if (typeof consoleUrl !== "string" || !isHttpsUrl(consoleUrl)) {
    fail("credential.consoleUrl", "must be an https URL");
  }
  // A warn threshold at or past the fail threshold would skip the warning
  // entirely and jump the user straight to an error about key age.
  if (
    warnAfterDays !== undefined &&
    failAfterDays !== undefined &&
    warnAfterDays >= failAfterDays
  ) {
    fail("credential.warnAfterDays", "must be less than failAfterDays");
  }

  if (warnAfterDays === undefined || failAfterDays === undefined) return undefined;
  if (typeof consoleUrl !== "string" || !isHttpsUrl(consoleUrl)) return undefined;
  return { warnAfterDays, failAfterDays, consoleUrl };
}

/**
 * Notices are remote text shown to every user, so they are stripped of control
 * characters and truncated. They are displayed and nothing else: never a
 * command id, never a URL the extension opens.
 *
 * Validation deliberately keeps expired notices and does not apply the cap. It
 * has no clock, and applying a cap here would let two long-expired notices take
 * both slots and silently suppress a live one. Expiry and the cap are one
 * decision and both belong to the caller, which has the clock: see
 * `selectNotices`.
 */
function validateNotices(value: unknown, fail: Fail): ManifestNotice[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail("notices", "must be an array");
  if (tooMany(value, MAX_NOTICE_ENTRIES, "notices", fail)) return undefined;

  const out: ManifestNotice[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `notices[${index}]`;
    if (!isPlainObject(entry)) {
      fail(path, "must be an object");
      continue;
    }
    const { level, message, expiresAt } = entry;
    if (level !== "info" && level !== "warning" && level !== "error") {
      fail(`${path}.level`, "must be info, warning or error");
      continue;
    }
    // Sanitise before the emptiness check, not after: `trim` leaves control
    // characters in place, so a message of nothing but them would otherwise
    // pass here and render as a blank row in the panel.
    const text = typeof message === "string" ? sanitizeNotice(message) : undefined;
    if (text === undefined || text === "") {
      fail(`${path}.message`, "must be a non-empty string");
      continue;
    }
    if (expiresAt !== undefined && (typeof expiresAt !== "string" || !isIsoDate(expiresAt))) {
      fail(`${path}.expiresAt`, "must be an ISO 8601 date");
      continue;
    }
    out.push({
      level,
      message: text,
      ...(typeof expiresAt === "string" ? { expiresAt } : {}),
    });
  }
  return out;
}

function sanitizeNotice(message: string): string {
  const stripped = message.replaceAll(CONTROL_CHARACTERS, " ").replaceAll(/\s+/g, " ").trim();
  return stripped.length > MAX_NOTICE_LENGTH
    ? `${stripped.slice(0, MAX_NOTICE_LENGTH - 1)}…`
    : stripped;
}

/**
 * Refuse the collection rather than truncate it. Which entries would survive a
 * truncation is an accident of key or array order, and the result is a set of
 * defaults nobody authored — the same reason every other rule here fails the
 * field instead of repairing it.
 */
function tooMany(entries: readonly unknown[], max: number, path: string, fail: Fail): boolean {
  if (entries.length <= max) return false;
  fail(path, `must have at most ${max} entries`);
  return true;
}

function requireString(value: unknown, path: string, fail: Fail): string | undefined {
  if (typeof value !== "string" || value === "") return fail(path, "must be a non-empty string");
  return value;
}

function requireVersion(value: unknown, path: string, fail: Fail): string | undefined {
  if (typeof value !== "string" || !VERSION_SHAPE.test(value)) {
    return fail(path, "must be a dotted version");
  }
  return value;
}

/**
 * A whole number of days inside the band the extension will honour. Out of
 * range fails the field rather than being clamped into it: silently rewriting
 * a threshold would leave every install running a policy the manifest never
 * stated, which is exactly the kind of quiet divergence the channel must not
 * be able to produce.
 */
function requireDays(
  value: unknown,
  path: string,
  fail: Fail,
  bounds: { min?: number; max?: number },
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fail(path, "must be a positive whole number");
  }
  if (bounds.min !== undefined && value < bounds.min) {
    return fail(path, `must be at least ${bounds.min}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    return fail(path, `must be at most ${bounds.max}`);
  }
  return value;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * ISO 8601 as far as we need it: a date, optionally with a time. `Date.parse`
 * alone accepts `March 5, 2026`, which the rejection message promises we do
 * not — and a manifest that says one thing and enforces another is how a rule
 * quietly stops holding.
 */
function isIsoDate(value: string): boolean {
  return ISO_DATE_SHAPE.test(value) && !Number.isNaN(Date.parse(value));
}

function isSafeRepo(repo: string): boolean {
  return REPO_SHAPE.test(repo) && !hasDotSegment(repo);
}

/**
 * Model ids reach a URL path, so the same dot-segment rule the marketplace repo
 * gets applies: `foundation-model/../../evil` is a shape-legal ARN naming a
 * path the manifest did not write.
 */
function isModelId(value: string): boolean {
  return MODEL_ID_SHAPE.test(value) && !hasDotSegment(value);
}

function hasDotSegment(value: string): boolean {
  return value.split("/").some((part) => DOT_SEGMENTS.has(part));
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The notices to actually show, given a clock (FR-3 `notices`).
 *
 * Expiry and the cap are applied together and in that order, so a stale notice
 * can never crowd out a live one — the reason validation does neither.
 */
export function selectNotices(notices: readonly ManifestNotice[], now: Date): ManifestNotice[] {
  return notices.filter((notice) => !hasExpired(notice, now)).slice(0, MAX_NOTICES);
}

function hasExpired(notice: ManifestNotice, now: Date): boolean {
  if (notice.expiresAt === undefined) return false;
  const expiry = Date.parse(notice.expiresAt);
  // An unparseable date cannot have passed: validation already refused one, and
  // treating a date we cannot read as expired would silently drop live advice.
  return !Number.isNaN(expiry) && expiry <= now.getTime();
}
