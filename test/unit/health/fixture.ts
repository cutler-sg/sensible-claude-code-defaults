import type { ReadResult, Settings } from "../../../src/config/types.js";
import { DEFAULT_STYLE, EMPTY_SNAPSHOT } from "../../../src/config/types.js";
import type { CheckContext } from "../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";

export const CLAUDE_DIR = "/home/tester/.claude";
export const SETTINGS_FILE = `${CLAUDE_DIR}/settings.json`;

/** A settings document that satisfies every M2 check. */
export function okSettings(): Settings {
  return {
    env: { ...BUNDLED_MANIFEST.defaults.env },
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
    permissions: { kind: "ok", before: 0o600 },
    ...overrides,
  };
}
