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
/** Bedrock env values Claude Code reads. Anything else is not ours to write. */
const ALLOWED_ENV_KEYS = new Set([
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_REGION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
]);
/** `owner/name`, the only shape `extraKnownMarketplaces` github sources take. */
const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const VERSION_SHAPE = /^\d+(\.\d+){0,2}(-[A-Za-z0-9.-]+)?$/;
/** AWS region labels: `us-east-1`, `ap-southeast-2`, `us-gov-west-1`. */
const REGION_SHAPE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
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
      if (!ALLOWED_ENV_KEYS.has(key)) continue;
      // Claude Code reads these as environment variables, so a JSON boolean or
      // number would be written as a value it cannot use. Reject rather than
      // coerce: a manifest saying `true` meant something we cannot infer.
      if (typeof entry !== "string") fail(`defaults.env.${key}`, "must be a string");
      else env[key] = entry;
    }
  }

  const deny: string[] = [];
  const permissions = value.permissions;
  if (!isPlainObject(permissions) || !Array.isArray(permissions.deny)) {
    fail("defaults.permissions.deny", "must be an array");
  } else {
    for (const [index, rule] of permissions.deny.entries()) {
      if (typeof rule !== "string") fail(`defaults.permissions.deny[${index}]`, "must be a string");
      else deny.push(rule);
    }
  }

  const extraKnownMarketplaces = validateMarketplaces(value.extraKnownMarketplaces, fail);
  const enabledPlugins = validatePlugins(value.enabledPlugins, fail);

  if (extraKnownMarketplaces === undefined || enabledPlugins === undefined) return undefined;
  return { env, permissions: { deny }, extraKnownMarketplaces, enabledPlugins };
}

/**
 * Only the two source shapes Claude Code documents. A manifest that could name
 * an arbitrary source would let the update channel point every user's Claude
 * Code at somebody else's plugin code — the widest blast radius in the project.
 */
function validateMarketplaces(value: unknown, fail: Fail): JsonObject | undefined {
  if (!isPlainObject(value)) return fail("defaults.extraKnownMarketplaces", "must be an object");

  const out: JsonObject = {};
  for (const [name, entry] of Object.entries(value)) {
    const path = `defaults.extraKnownMarketplaces.${name}`;
    if (!isPlainObject(entry) || !isPlainObject(entry.source)) {
      fail(path, "must have a source object");
      continue;
    }
    const source = entry.source;
    if (source.source === "github") {
      if (typeof source.repo !== "string" || !REPO_SHAPE.test(source.repo)) {
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

  const out: Record<string, boolean | string[]> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") {
      out[name] = entry;
    } else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      // The published settings schema allows a scope list as well as a boolean.
      out[name] = entry as string[];
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

  const warnAfterDays = requirePositiveInt(value.warnAfterDays, "credential.warnAfterDays", fail);
  const failAfterDays = requirePositiveInt(value.failAfterDays, "credential.failAfterDays", fail);
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
    if (typeof message !== "string" || message.trim() === "") {
      fail(`${path}.message`, "must be a non-empty string");
      continue;
    }
    if (expiresAt !== undefined && (typeof expiresAt !== "string" || !isIsoDate(expiresAt))) {
      fail(`${path}.expiresAt`, "must be an ISO 8601 date");
      continue;
    }
    out.push({
      level,
      message: sanitizeNotice(message),
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

function requirePositiveInt(value: unknown, path: string, fail: Fail): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fail(path, "must be a positive whole number");
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

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
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
