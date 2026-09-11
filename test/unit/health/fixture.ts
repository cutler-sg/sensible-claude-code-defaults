import type { ReadResult, Settings } from "../../../src/config/types.js";
import { DEFAULT_STYLE, EMPTY_SNAPSHOT } from "../../../src/config/types.js";
import type { CheckContext, CredentialContext, ManifestStatus } from "../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";

export const NOW = new Date("2026-09-10T12:00:00.000Z");

/** Days before `NOW`, as the ISO stamp `StoredTokenMeta` carries. */
export function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

/**
 * The credential slice, defaulting to "a key is in the keychain and mirrored" —
 * the healthy state, matching `okSettings()`, which carries a token in `env`.
 */
export function okCredential(overrides: Partial<CredentialContext> = {}): CredentialContext {
  return {
    presence: { source: "both", mismatch: false, setAt: daysAgo(1) },
    stored: { setAt: daysAgo(1) },
    policy: BUNDLED_MANIFEST.credential,
    now: NOW,
    ...overrides,
  };
}

/**
 * The healthy manifest state: fetched a moment ago, matching what was applied.
 * `config.stale`'s pass branch, so a fixture-based test of any other check does
 * not pick up an unrelated info row.
 */
export const FETCHED_STATUS: ManifestStatus = {
  revision: BUNDLED_MANIFEST.revision,
  source: "fetched",
  fetchedAt: NOW.toISOString(),
};

export const CLAUDE_DIR = "/home/tester/.claude";
export const SETTINGS_FILE = `${CLAUDE_DIR}/settings.json`;

/**
 * The token the healthy fixture has in both places. A recognisable literal so a
 * leak test can search every rendered string for it.
 */
export const FIXTURE_TOKEN = "ABSKZml4dHVyZUJlZHJvY2tBUElLZXlWYWx1ZQ";

/** A settings document that satisfies every M2 check. */
export function okSettings(): Settings {
  return {
    env: { ...BUNDLED_MANIFEST.defaults.env, AWS_BEARER_TOKEN_BEDROCK: FIXTURE_TOKEN },
    permissions: { deny: [...BUNDLED_MANIFEST.defaults.permissions.deny] },
  };
}

export function okRead(settings: Settings = okSettings()): ReadResult {
  const raw = `${JSON.stringify(settings, null, 2)}\n`;
  return {
    kind: "ok",
    data: settings,
    style: { indent: "  ", trailingNewline: true, eol: "\n" },
    raw,
  };
}

/** A healthy context: everything installed, settings as recommended, no drift. */
export function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    claudeDir: CLAUDE_DIR,
    settingsFile: SETTINGS_FILE,
    platform: "linux",
    read: okRead(),
    snapshot: EMPTY_SNAPSHOT,
    manifest: BUNDLED_MANIFEST,
    manifestStatus: FETCHED_STATUS,
    plan: {
      kind: "ready",
      read: okRead(),
      merge: { next: okSettings(), changes: [], drift: [], snapshotValues: {} },
      style: DEFAULT_STYLE,
      noop: true,
    },
    drift: [],
    detection: {
      extension: { installed: true, version: BUNDLED_MANIFEST.minimumClaudeCodeVersion },
      cli: { found: true, version: "2.1.267" },
    },
    credential: okCredential(),
    permissions: { kind: "ok", before: 0o600 },
    ...overrides,
  };
}
