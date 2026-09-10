/**
 * The fallback chain (FR-3.2): fetched → cached → bundled, first that validates.
 *
 * This function is the one the rest of the extension asks for defaults, and it
 * always answers. There is no failure path: the bundled copy ships in the same
 * VSIX as this code, so the worst case is defaults that are merely old. A fetch
 * that failed is not reported as an error anywhere — it shows up only as the
 * `source` being something other than "fetched", which the caller renders as
 * the info-level "using saved defaults from <date>" note.
 *
 * Nothing here imports `vscode`; the clock, the cache and `fetch` are injected.
 */

import { BUNDLED_MANIFEST } from "./bundled.js";
import type { ManifestCache } from "./cache.js";
import { fetchManifest } from "./fetch.js";
import { validateManifest } from "./schema.js";
import type { Manifest } from "./types.js";
import { compareVersions } from "./version.js";

export type ManifestSource = "fetched" | "cached" | "bundled";

/** For the log only. A reason code or a schema path — never a value, never a URL. */
export interface ResolutionProblem {
  source: ManifestSource;
  problem: string;
}

export interface Resolution {
  manifest: Manifest;
  source: ManifestSource;
  /** ISO 8601, when the resolved manifest was fetched. Absent for the bundled copy. */
  fetchedAt?: string | undefined;
  /**
   * FR-3.5: a candidate demanded a newer extension than this one and was
   * skipped. The caller raises the warn-level "update the extension" check and
   * names this version.
   */
  needsExtensionVersion?: string | undefined;
  problems: ResolutionProblem[];
  /**
   * ISO 8601 of the fetch attempt this call made, or absent if the throttle
   * skipped it. The caller stores it as the next call's `lastAttemptAt`.
   */
  attemptedAt?: string | undefined;
}

export interface ResolveDeps {
  url: string;
  /** The running extension's version, for the FR-3.5 gate. */
  extensionVersion: string;
  cache: ManifestCache;
  /** ISO 8601 of the last fetch attempt in this window; absent means never. */
  lastAttemptAt?: string | undefined;
  /** FR-3.3: the manual "Check for updates" command bypasses the throttle. */
  force?: boolean | undefined;
  now?: (() => Date) | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  timeoutMs?: number | undefined;
  /** Injected in tests. Defaults to the copy shipped in the VSIX. */
  bundled?: Manifest | undefined;
}

/** FR-3.3. One fetch per hour per window; a manual refresh is exempt. */
export const THROTTLE_MS = 3_600_000;

export async function resolveManifest(deps: ResolveDeps): Promise<Resolution> {
  const now = deps.now ?? (() => new Date());
  const problems: ResolutionProblem[] = [];
  const gate = new Gate(deps.extensionVersion);

  const attemptedAt = shouldFetch(deps, now()) ? now().toISOString() : undefined;

  if (attemptedAt !== undefined) {
    const fetched = await tryFetch(deps, problems);
    if (fetched !== undefined && gate.admits(fetched, "fetched", problems)) {
      // Cached only once it is a manifest we will actually use. Storing one the
      // FR-3.5 gate rejected would overwrite a usable cached copy with an
      // unusable one, trading working old defaults for the bundled floor.
      await deps.cache.save({ manifest: fetched, fetchedAt: attemptedAt, url: deps.url });
      return {
        manifest: fetched,
        source: "fetched",
        fetchedAt: attemptedAt,
        problems,
        attemptedAt,
        ...gate.note(),
      };
    }
  }

  const cached = deps.cache.load(deps.url);
  if (cached !== undefined && gate.admits(cached.manifest, "cached", problems)) {
    return withAttempt(
      {
        manifest: cached.manifest,
        source: "cached",
        fetchedAt: cached.fetchedAt,
        problems,
        ...gate.note(),
      },
      attemptedAt,
    );
  }

  return withAttempt(
    { manifest: bundled(deps, problems), source: "bundled", problems, ...gate.note() },
    attemptedAt,
  );
}

function withAttempt(resolution: Resolution, attemptedAt: string | undefined): Resolution {
  return attemptedAt === undefined ? resolution : { ...resolution, attemptedAt };
}

function shouldFetch(deps: ResolveDeps, now: Date): boolean {
  if (deps.force === true) return true;
  const last = deps.lastAttemptAt === undefined ? Number.NaN : Date.parse(deps.lastAttemptAt);
  // An unparseable or absent timestamp means we have no evidence of a recent
  // attempt, and one request is cheaper than defaults that never update.
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= THROTTLE_MS;
}

async function tryFetch(
  deps: ResolveDeps,
  problems: ResolutionProblem[],
): Promise<Manifest | undefined> {
  const outcome = await fetchManifest({
    url: deps.url,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  });
  if (outcome.kind === "ok") return outcome.manifest;
  if (outcome.kind === "not-modified") {
    // Q-Z sends no conditional request, but a proxy may still answer 304. It
    // means the cache is current, which is the next rung anyway.
    return undefined;
  }
  problems.push({ source: "fetched", problem: outcome.reason });
  for (const detail of outcome.problems ?? []) {
    problems.push({ source: "fetched", problem: `${detail.path}: ${detail.problem}` });
  }
  return undefined;
}

/**
 * The bundled floor. It is a `Manifest` by type, but it arrives through
 * `resolveJsonModule`, so it is validated like everything else — and returned
 * anyway if it somehow fails, because there is nothing below it and this
 * function must answer.
 */
function bundled(deps: ResolveDeps, problems: ResolutionProblem[]): Manifest {
  const candidate = deps.bundled ?? BUNDLED_MANIFEST;
  const result = validateManifest(candidate);
  if (result.ok) return result.manifest;
  for (const detail of result.problems) {
    problems.push({ source: "bundled", problem: `${detail.path}: ${detail.problem}` });
  }
  return candidate;
}

/**
 * FR-3.5. A manifest demanding a newer extension is skipped in favour of the
 * previous source, and the version it wants is carried out so the caller can
 * raise a warn-level check. The first such demand is the one reported: it came
 * from the freshest source, so it is the newest requirement.
 *
 * With one bound (F12). The gate is the one field a manifest can use to disable
 * the update channel permanently: `"999.999.999"` pins every install to the
 * bundled copy for good — no later manifest can lift it, because the gate is
 * evaluated before the manifest is used — while `config.stale` tells every user
 * an extension update with newer recommendations is available. It is not, and
 * never will be. So a demand no plausible release could satisfy is not a
 * compatibility signal at all, and is ignored.
 */
class Gate {
  #needs: string | undefined;

  constructor(private readonly extensionVersion: string) {}

  admits(manifest: Manifest, source: ManifestSource, problems: ResolutionProblem[]): boolean {
    if (compareVersions(manifest.minExtensionVersion, this.extensionVersion) <= 0) return true;
    if (!isReachableVersion(manifest.minExtensionVersion)) {
      // F12: admitted on its merits, and the demand is logged rather than
      // honoured. Nothing else changes — it goes on to be cached and used like
      // any other manifest.
      problems.push({
        source,
        problem: `minExtensionVersion: ignoring an implausible ${manifest.minExtensionVersion}`,
      });
      return true;
    }
    this.#needs ??= manifest.minExtensionVersion;
    problems.push({
      source,
      problem: `minExtensionVersion: needs ${manifest.minExtensionVersion}`,
    });
    return false;
  }

  note(): { needsExtensionVersion?: string } {
    return this.#needs === undefined ? {} : { needsExtensionVersion: this.#needs };
  }
}

/**
 * The highest major this extension will treat as a real future release (F12).
 *
 * A cap and not a diff from the running version: a diff would have to be
 * re-tuned every time the extension's own major moved, and getting it wrong in
 * the tight direction breaks the gate for the release it exists to announce.
 * 100 majors is far beyond anything this project will ship and far below the
 * numbers an off-switch reaches for.
 *
 * Local to this file for now: the other half of M4 is exporting a predicate
 * from `schema.ts` for the same question, and this collapses into that call
 * when it lands. The bound belongs on both sides anyway — the validator can
 * refuse to store one, and the resolver must not honour one that reached it
 * through the cache from an older release.
 */
const MAX_PLAUSIBLE_MAJOR = 100;

function isReachableVersion(version: string): boolean {
  return compareVersions(version, `${MAX_PLAUSIBLE_MAJOR}.0.0`) < 0;
}
