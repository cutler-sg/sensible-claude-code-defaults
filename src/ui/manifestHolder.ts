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
 *
 * Two things make the throttle actually hold (F6). The attempt is stamped
 * *before* the resolver is called, not after it returns, so a `globalState`
 * that throws cannot leave the window fetching on every health run — and every
 * `settings.json` write by Claude Code is a health run. And a refresh already
 * in flight is joined rather than duplicated: a fetch window is 5 s wide, which
 * is plenty for activation and a watcher event to overlap inside.
 */

import type { ManifestStatus } from "../health/types.js";
import { BUNDLED_MANIFEST } from "../manifest/bundled.js";
import type { ManifestCache } from "../manifest/cache.js";
import type { Resolution } from "../manifest/resolve.js";
import { resolveManifest, THROTTLE_MS } from "../manifest/resolve.js";
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
  // The refresh in flight, if any. Every overlapping caller awaits this one
  // rather than starting a second fetch, and each gets the same answer — a
  // `false` for the joiners would leave the host declining to repaint a panel
  // that has in fact just changed.
  let inFlight: Promise<boolean> | undefined;

  const resolve = async (options: { force?: boolean } | undefined): Promise<boolean> => {
    const now = deps.now ?? (() => new Date());
    // Stamped before the call, not after it returns. `resolveManifest` decides
    // whether the throttle admits this attempt, and it is given the same clock,
    // so recording the intent up front costs nothing when it declines and is
    // the whole fix when it throws on the way back (F6).
    const previousAttemptAt = lastAttemptAt;
    if (shouldAttempt(previousAttemptAt, now(), options?.force === true)) {
      lastAttemptAt = now().toISOString();
    }

    let resolution: Resolution;
    try {
      resolution = await resolveManifest({
        url: deps.url(),
        extensionVersion: deps.extensionVersion,
        cache: deps.cache,
        ...(previousAttemptAt === undefined ? {} : { lastAttemptAt: previousAttemptAt }),
        ...(options?.force === true ? { force: true } : {}),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      });
    } catch (error) {
      // `resolveManifest` is documented never to throw, and the fetch layer is
      // written so it cannot. This is the belt to that braces: a throw here
      // would come out of `void refresh()` as an unhandled rejection with the
      // panel stuck on its welcome text. The attempt is already stamped, so a
      // `globalState` that throws every time still costs one fetch an hour.
      deps.log.error(`Could not resolve the recommended settings: ${messageOf(error)}`);
      return false;
    }

    report(deps.log, resolution);

    // Held first, reported second (F8). The status comparison answers "is
    // there anything to repaint?" — it is not a decision about what is in
    // force. A same-`revision` republish is invisible to `sameStatus` but has
    // already reached the cache, so dropping it here left the window and the
    // cache disagreeing about the defaults until the window reloaded.
    const next = toResolved(resolution);
    const repaint = !sameStatus(held.status, next.status);
    held = next;
    return repaint;
  };

  return {
    current: () => held,
    refresh(options): Promise<boolean> {
      // Joined, not queued: the answer an overlapping caller wants is the
      // answer to the question already being asked.
      if (inFlight !== undefined) return inFlight;
      const running = resolve(options).finally(() => {
        inFlight = undefined;
      });
      inFlight = running;
      return running;
    },
  };
}

/**
 * FR-3.3's window, restated here so the attempt can be stamped before the
 * resolver runs. `resolveManifest` applies the same rule against the same clock
 * and remains the authority on whether a request is made; this only decides
 * whether to remember having tried.
 */
function shouldAttempt(lastAttemptAt: string | undefined, now: Date, force: boolean): boolean {
  if (force) return true;
  const last = lastAttemptAt === undefined ? Number.NaN : Date.parse(lastAttemptAt);
  return Number.isNaN(last) || now.getTime() - last >= THROTTLE_MS;
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
 * Whether anything the panel would render has changed. A repaint decision only
 * (F8): the newer resolution is held either way.
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
