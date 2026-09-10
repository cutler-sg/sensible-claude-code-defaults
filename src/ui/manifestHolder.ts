/**
 * The manifest in force, per window (FR-3.2, FR-3.3).
 *
 * `resolveManifest` deliberately owns no state: it is given `lastAttemptAt` and
 * hands back the `attemptedAt` of the attempt it made. Somebody has to be the
 * "per window" in "at most one fetch per hour per window", and this is it. The
 * write-back below is the whole throttle — drop it and every health run fetches
 * again, which on a busy `~/.claude` is a request per file change.
 *
 * It also holds the answer between runs, so the panel can render from the
 * previous resolution while a fetch is in flight (§13: activation adds < 100 ms
 * and the panel renders from cache immediately). Nothing here imports `vscode`;
 * the URL arrives as a function so a changed setting is picked up on the next
 * refresh rather than at wiring time.
 */

import type { ManifestStatus } from "../health/types.js";
import { BUNDLED_MANIFEST } from "../manifest/bundled.js";
import type { ManifestCache } from "../manifest/cache.js";
import type { Resolution } from "../manifest/resolve.js";
import { resolveManifest } from "../manifest/resolve.js";
import type { Manifest } from "../manifest/types.js";
import type { Logger } from "../util/log.js";

/** The defaults in force, plus where they came from. */
export interface ResolvedManifest {
  manifest: Manifest;
  status: ManifestStatus;
}

/**
 * The URL when the setting is absent. VS Code returns the contributed default
 * for a registered setting, so this is only reached in a host that has not
 * loaded our `package.json` — but `contributes.test.ts` holds the two equal so
 * they cannot drift into pointing at different channels.
 */
export const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/cutler-sg/sensible-claude-code-defaults/main/manifest/defaults.json";

export interface ManifestHolderDeps {
  /** Read per refresh: the manifest URL is a user setting and can change. */
  url: () => string;
  /** This extension's version, for the FR-3.5 gate. */
  extensionVersion: string;
  cache: ManifestCache;
  log: Logger;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface ManifestHolder {
  /** The last resolution, or the bundled floor before the first refresh. */
  current(): ResolvedManifest;
  /**
   * Re-resolve, honouring the hourly throttle unless `force`. Never rejects —
   * every caller is on a path where a rejection would blank the panel.
   *
   * Resolves to `true` when the held manifest changed, which is the host's cue
   * to repaint. `false` covers both "nothing new" and "we could not reach the
   * network", because those are the same thing to a panel already showing the
   * right rows.
   */
  refresh(options?: { force?: boolean }): Promise<boolean>;
}

export function createManifestHolder(deps: ManifestHolderDeps): ManifestHolder {
  let held: ResolvedManifest = {
    manifest: BUNDLED_MANIFEST,
    status: { revision: BUNDLED_MANIFEST.revision, source: "bundled" },
  };
  let lastAttemptAt: string | undefined;

  return {
    current: () => held,
    async refresh(options): Promise<boolean> {
      let resolution: Resolution;
      try {
        resolution = await resolveManifest({
          url: deps.url(),
          extensionVersion: deps.extensionVersion,
          cache: deps.cache,
          ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
          ...(options?.force === true ? { force: true } : {}),
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        });
      } catch (error) {
        // `resolveManifest` is documented never to throw, and the fetch layer
        // is written so it cannot. This is the belt to that braces: a throw
        // here would come out of `void refresh()` as an unhandled rejection
        // with the panel stuck on its welcome text.
        deps.log.error(`Could not resolve the recommended settings: ${messageOf(error)}`);
        return false;
      }

      // The write-back the throttle is made of. It happens on every resolution,
      // including the ones that fell through to the cache or the bundle: an
      // attempt that failed is still an attempt, and only recording the
      // successes would retry a dead network on every health run.
      if (resolution.attemptedAt !== undefined) lastAttemptAt = resolution.attemptedAt;

      report(deps.log, resolution);

      const next = toResolved(resolution);
      if (sameStatus(held.status, next.status)) return false;
      held = next;
      return true;
    },
  };
}

function toResolved(resolution: Resolution): ResolvedManifest {
  return {
    manifest: resolution.manifest,
    status: {
      revision: resolution.manifest.revision,
      source: resolution.source,
      ...(resolution.fetchedAt === undefined ? {} : { fetchedAt: resolution.fetchedAt }),
      ...(resolution.needsExtensionVersion === undefined
        ? {}
        : { needsExtensionVersion: resolution.needsExtensionVersion }),
    },
  };
}

/**
 * Whether anything the panel would render has changed.
 *
 * `fetchedAt` is compared by day, not by instant, because the day is all that
 * is ever rendered (`config.stale`'s "Last updated <date>"). Comparing the
 * instant would make every hourly re-fetch of an unchanged manifest report a
 * change, and the host answers a change with a full health run — file reads, a
 * permission repair, a `claude --version` probe — for a panel that would come
 * back identical.
 */
function sameStatus(a: ManifestStatus, b: ManifestStatus): boolean {
  return (
    a.revision === b.revision &&
    a.source === b.source &&
    day(a.fetchedAt) === day(b.fetchedAt) &&
    a.needsExtensionVersion === b.needsExtensionVersion
  );
}

function day(fetchedAt: string | undefined): string | undefined {
  return fetchedAt?.slice(0, 10);
}

/**
 * FR-3.2 and FR-7.2: every resolution says where it came from, and every
 * problem is logged rather than shown. `problems` is already free of values and
 * URLs by construction — reason codes and schema paths only — so it can go to
 * the channel whole.
 */
function report(log: Logger, resolution: Resolution): void {
  log.info(
    `Recommended settings: ${resolution.source} (revision ${resolution.manifest.revision})` +
      (resolution.needsExtensionVersion === undefined
        ? ""
        : `; a newer manifest needs extension ${resolution.needsExtensionVersion}`),
  );
  for (const problem of resolution.problems) {
    // Warn, not error: falling back is the designed behaviour, not a fault.
    log.warn(`Manifest (${problem.source}): ${problem.problem}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "an unexpected failure";
}
