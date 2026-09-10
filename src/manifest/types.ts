/**
 * Defaults manifest (PRD FR-3). M2 reads only the bundled copy; M4 adds the
 * remote fetch, cache, and schema validation. Keep this file `vscode`-free.
 */

import type { Desired, JsonObject } from "../config/types.js";

export interface ManifestNotice {
  level: "info" | "warning" | "error";
  message: string;
  expiresAt?: string;
}

export interface Manifest {
  schemaVersion: 1;
  /** Opaque; used for change detection and `config.stale`. */
  revision: string;
  minExtensionVersion: string;
  minimumClaudeCodeVersion: string;
  defaults: {
    env: Record<string, string>;
    permissions: { deny: string[] };
    extraKnownMarketplaces: JsonObject;
    enabledPlugins: Record<string, boolean | string[]>;
  };
  regions: string[];
  notices: ManifestNotice[];
}

/** Project the manifest's defaults onto the managed-key `Desired` shape. */
export function desiredFromManifest(manifest: Manifest): Desired {
  const env = manifest.defaults.env;
  const pick = (name: string): string | undefined => env[name];
  const desired: Desired = {
    "permissions.deny": manifest.defaults.permissions.deny,
    extraKnownMarketplaces: manifest.defaults.extraKnownMarketplaces,
    enabledPlugins: manifest.defaults.enabledPlugins,
  };
  for (const key of [
    "CLAUDE_CODE_USE_BEDROCK",
    "AWS_REGION",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  ] as const) {
    const value = pick(key);
    if (value !== undefined) desired[`env.${key}`] = value;
  }
  return desired;
}
