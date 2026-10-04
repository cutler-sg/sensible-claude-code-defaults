import { createHash } from "node:crypto";
import type { Manifest } from "../manifest/types.js";
import { invokeModel, preflightModel } from "./probe.js";
import type {
  AvailabilitySnapshot,
  ModelContext,
  ModelDefinition,
  ModelEvidence,
  ModelFamily,
  ModelRow,
  ModelServiceOptions,
  ModelTarget,
  ProbeOutcome,
} from "./types.js";

const DAY = 86_400_000;
const FAMILIES: ModelFamily[] = ["opus", "sonnet", "haiku"];
const KEYS = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
} as const;
interface Candidate {
  model: ModelDefinition;
  target: ModelTarget;
  configured: boolean;
  metadataKey: string;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function modelContextKey(context: ModelContext): string {
  return digest([
    "models-v1",
    context.credentialGeneration,
    context.configLocation,
    context.region,
  ]);
}
function metadataKey(model: ModelDefinition, target: ModelTarget): string {
  return digest([
    1,
    model.id,
    model.probeFormat ?? "anthropic-messages",
    target.id,
    target.scope,
    [...target.sourceRegions].sort(),
  ]);
}

export class ModelAvailabilityService {
  private context: ModelContext | undefined;
  private identity: string | undefined;
  private evidence = new Map<string, ModelEvidence>();
  private controller: AbortController | undefined;
  private inFlight: Promise<void> | undefined;
  private checkingIds = new Set<string>();
  private generation = 0;
  private disposed = false;
  private issue: AvailabilitySnapshot["issue"];
  private readonly now: () => number;
  constructor(private readonly options: ModelServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async setContext(context: ModelContext | undefined): Promise<void> {
    if (this.disposed) return;
    const identity = context
      ? digest([
          modelContextKey(context),
          context.configured,
          context.manifest.models,
          context.manifest.defaults.env,
          context.allowedScopes,
        ])
      : undefined;
    if (identity === this.identity) {
      // Notices, plugin defaults and revision can change without changing any
      // model evidence. Recommendations must still carry the current manifest.
      this.context = context;
      return;
    }
    this.generation++;
    const generation = this.generation;
    this.controller?.abort();
    this.controller = undefined;
    this.inFlight = undefined;
    this.checkingIds.clear();
    this.context = context;
    this.identity = identity;
    this.evidence.clear();
    this.issue = undefined;
    this.changed();
    if (!context) return;
    try {
      const evidence = await this.options.store.load(modelContextKey(context));
      if (generation !== this.generation || this.disposed) return;
      this.mergeEvidence(evidence);
    } catch {
      if (generation === this.generation) this.issue = "cache-unavailable";
    }
    this.changed();
  }

  snapshot(): AvailabilitySnapshot {
    const context = this.context;
    if (!context) return { rows: [], checking: false, credential: "unknown" };
    const now = this.now();
    const invalidAt = this.credentialFailureAt();
    const rows: ModelRow[] = this.candidates().map((candidate) => {
      const { model, target, configured } = candidate;
      const supportedRegion = target.sourceRegions.includes(context.region);
      const allowed = context.allowedScopes.includes(target.scope);
      const evidence = this.validEvidence(candidate);
      const status = !allowed
        ? "out-of-scope"
        : !supportedRegion
          ? "unsupported"
          : this.checkingIds.has(target.id)
            ? "checking"
            : (evidence?.status ??
              (model.probeFormat && model.probeFormat !== "anthropic-messages"
                ? "unsupported"
                : "not-checked"));
      return {
        modelId: target.id,
        catalogueId: model.id === "custom" ? target.id : model.id,
        label: model.label,
        family: model.family,
        region: context.region,
        scope: target.scope,
        configured,
        allowed,
        status,
        stale: evidence
          ? now >= this.freshUntil(evidence, configured) ||
            (evidence.status === "available" && evidence.checkedAt <= invalidAt)
          : false,
        ...(evidence
          ? {
              checkedAt: evidence.checkedAt,
              nextCheckAt: this.freshUntil(evidence, configured),
              ...(evidence.lastSuccessAt !== undefined
                ? { lastSuccessAt: evidence.lastSuccessAt }
                : {}),
              ...(evidence.preflight ? { preflight: evidence.preflight } : {}),
            }
          : {}),
        ...(!supportedRegion
          ? { reason: "no-documented-source-route" }
          : !allowed
            ? { reason: "processing-scope-excluded" }
            : evidence?.reason
              ? { reason: evidence.reason }
              : {}),
      };
    });
    const current = rows.filter((row) => row.allowed && row.checkedAt !== undefined);
    const lastCheckedAt = current.length
      ? Math.max(...current.map((row) => row.checkedAt ?? 0))
      : undefined;
    const successAt = Math.max(
      -1,
      ...current
        .filter((row) => row.status === "available" && !row.stale)
        .map((row) => row.checkedAt ?? -1),
    );
    return {
      rows,
      checking: this.inFlight !== undefined,
      region: context.region,
      credential:
        successAt > invalidAt
          ? "valid"
          : invalidAt >= 0 && now < invalidAt + DAY
            ? "invalid"
            : "unknown",
      ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }),
      ...(this.issue ? { issue: this.issue } : {}),
    };
  }

  recommendedManifest(): Manifest | undefined {
    const context = this.context;
    if (!context) return undefined;
    const env: Record<string, string> = {
      ...context.manifest.defaults.env,
      AWS_REGION: context.region,
    };
    const rows = this.snapshot().rows;
    const candidates = this.candidates();
    for (const family of FAMILIES) {
      const pinned = context.configured[family];
      if (pinned) env[KEYS[family]] = pinned;
      const current = candidates.find((candidate) => candidate.target.id === pinned);
      // An opaque custom pin has no defensible catalogue rank or upgrade path.
      if (current?.model.id === "custom") continue;
      const currentRank = current?.model.rank ?? -1;
      const verified = candidates
        .filter(
          (candidate) =>
            candidate.model.family === family &&
            candidate.model.lifecycle !== "deprecated" &&
            (candidate.model.rank ?? 0) >= currentRank &&
            rows.some(
              (row) =>
                row.modelId === candidate.target.id &&
                row.allowed &&
                row.status === "available" &&
                !row.stale,
            ),
        )
        .sort(
          (a, b) =>
            (b.model.rank ?? 0) - (a.model.rank ?? 0) ||
            Number(b.configured) - Number(a.configured),
        );
      const best = verified[0];
      if (best) env[KEYS[family]] = best.target.id;
    }
    return { ...context.manifest, defaults: { ...context.manifest.defaults, env } };
  }

  refresh(options: { force?: boolean; automatic?: boolean } = {}): Promise<void> {
    if (this.disposed || !this.context) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const context = this.context;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const promise = this.run(context, generation, controller, options.force === true).finally(
      () => {
        if (generation !== this.generation) return;
        this.inFlight = undefined;
        this.controller = undefined;
        this.checkingIds.clear();
        this.changed();
      },
    );
    this.inFlight = promise;
    this.changed();
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.controller?.abort();
    this.context = undefined;
    this.evidence.clear();
    this.checkingIds.clear();
    this.inFlight = undefined;
  }

  private async run(
    context: ModelContext,
    generation: number,
    controller: AbortController,
    force: boolean,
  ): Promise<void> {
    const key = modelContextKey(context);
    const batchTimeout = this.options.batchTimeoutMs ?? 30_000;
    let release: (() => Promise<void>) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = () =>
      !this.disposed && this.generation === generation && !controller.signal.aborted;
    timer = setTimeout(() => controller.abort(), batchTimeout);
    try {
      release = await this.options.store.acquire(key, this.now(), batchTimeout + 5_000);
      if (!active()) return;
      if (!release) {
        this.issue = "another-window-checking";
        return;
      }
      this.issue = undefined;
      // A sibling window may have refreshed between activation and lease acquisition.
      const saved = await this.options.store.load(key);
      if (!active()) return;
      this.mergeEvidence(saved);
      if (!force && this.snapshot().credential === "invalid") return;
      const work = this.candidates()
        .filter(
          (candidate) =>
            context.allowedScopes.includes(candidate.target.scope) &&
            candidate.target.sourceRegions.includes(context.region) &&
            (force || this.due(candidate)),
        )
        .sort(
          (a, b) =>
            Number(b.configured) - Number(a.configured) ||
            (force
              ? (this.validEvidence(a)?.lastAttemptAt ?? -1) -
                (this.validEvidence(b)?.lastAttemptAt ?? -1)
              : 0) ||
            (b.model.rank ?? 0) - (a.model.rank ?? 0),
        )
        .slice(0, 12);
      let index = 0;
      let invalidCredential = false;
      let writes: Promise<boolean> = Promise.resolve(true);
      const persist = () => {
        const evidence = [...this.evidence.values()];
        writes = writes
          .then(async () => {
            await this.options.store.save(key, evidence);
            return true;
          })
          .catch(() => {
            if (generation === this.generation) this.issue = "cache-unavailable";
            return false;
          });
        return writes;
      };
      const worker = async () => {
        while (active() && !invalidCredential) {
          const candidate = work[index++];
          if (!candidate) return;
          const previous = this.validEvidence(candidate);
          const now = this.now();
          const lastCredentialFailureAt = this.credentialFailureAt();
          // A crash during dispatch still backs off instead of causing an activation loop.
          this.evidence.set(candidate.target.id, {
            modelId: candidate.target.id,
            metadataKey: candidate.metadataKey,
            status: "unknown",
            reason: "attempt-incomplete",
            checkedAt: now,
            lastAttemptAt: now,
            nextCheckAt: now + 900_000,
            failures: previous?.failures ?? 0,
            ...(lastCredentialFailureAt >= 0 ? { lastCredentialFailureAt } : {}),
            ...(previous?.lastSuccessAt !== undefined
              ? { lastSuccessAt: previous.lastSuccessAt }
              : {}),
          });
          this.checkingIds.add(candidate.target.id);
          if (!(await persist()) || !active()) return;
          this.changed();
          const input = {
            token: context.token,
            region: context.region,
            signal: controller.signal,
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
            ...(this.options.requestTimeoutMs ? { timeoutMs: this.options.requestTimeoutMs } : {}),
          };
          let outcome: ProbeOutcome;
          let preflight: ModelEvidence["preflight"];
          if (candidate.model.probeFormat && candidate.model.probeFormat !== "anthropic-messages")
            outcome = { status: "unsupported", reason: "unsupported-probe-format" };
          else {
            const metadata = candidate.model.id.startsWith("anthropic.")
              ? await preflightModel({ ...input, modelId: candidate.model.id })
              : { status: "unknown" as const, reason: "uncatalogued-target" };
            preflight = { ...metadata, checkedAt: this.now() };
            if (generation !== this.generation || this.disposed || invalidCredential) return;
            if (controller.signal.aborted) outcome = { status: "network-error", reason: "timeout" };
            else if (metadata.status === "invalid-credential") outcome = metadata;
            else if (candidate.configured || metadata.status === "available")
              outcome = await invokeModel({ ...input, modelId: candidate.target.id });
            else outcome = metadata;
          }
          if (generation !== this.generation || this.disposed) return;
          // Batch timeouts are recorded; credential/configuration cancellations are discarded.
          const checkedAt = this.now();
          const transient =
            outcome.status === "network-error" ||
            outcome.status === "throttled" ||
            outcome.status === "unknown";
          const failures = transient ? (previous?.failures ?? 0) + 1 : 0;
          const delay = transient
            ? Math.min(DAY, 900_000 * 2 ** Math.min(failures - 1, 7))
            : outcome.status === "available" && !candidate.configured
              ? 7 * DAY
              : DAY;
          this.evidence.set(candidate.target.id, {
            modelId: candidate.target.id,
            metadataKey: candidate.metadataKey,
            ...outcome,
            checkedAt,
            lastAttemptAt: now,
            nextCheckAt: checkedAt + delay,
            failures,
            ...(outcome.status === "invalid-credential"
              ? { lastCredentialFailureAt: checkedAt }
              : lastCredentialFailureAt >= 0
                ? { lastCredentialFailureAt }
                : {}),
            ...(outcome.status === "available"
              ? { lastSuccessAt: checkedAt }
              : previous?.lastSuccessAt !== undefined
                ? { lastSuccessAt: previous.lastSuccessAt }
                : {}),
            ...(preflight ? { preflight } : {}),
          });
          if (outcome.status === "invalid-credential") invalidCredential = true;
          this.checkingIds.delete(candidate.target.id);
          await persist();
          this.changed();
        }
      };
      await Promise.all([worker(), worker()]);
    } catch {
      if (generation === this.generation) this.issue = "cache-unavailable";
    } finally {
      if (timer) clearTimeout(timer);
      await release?.().catch(() => {});
    }
  }

  private changed(): void {
    if (!this.disposed) this.options.onChange?.();
  }
  private freshUntil(evidence: ModelEvidence, configured: boolean): number {
    return configured && evidence.status === "available"
      ? Math.min(evidence.nextCheckAt, evidence.checkedAt + DAY)
      : evidence.nextCheckAt;
  }
  private due(candidate: Candidate): boolean {
    const evidence = this.validEvidence(candidate);
    return (
      !evidence ||
      this.now() >= this.freshUntil(evidence, candidate.configured) ||
      (evidence.status === "available" && evidence.checkedAt <= this.credentialFailureAt())
    );
  }
  private credentialFailureAt(): number {
    let latest = -1;
    for (const evidence of this.evidence.values()) {
      if (evidence.checkedAt > this.now() + 60_000) continue;
      latest = Math.max(
        latest,
        evidence.lastCredentialFailureAt ?? -1,
        evidence.status === "invalid-credential" ? evidence.checkedAt : -1,
      );
    }
    return latest;
  }
  private validEvidence(candidate: Candidate): ModelEvidence | undefined {
    const evidence = this.evidence.get(candidate.target.id);
    return evidence?.metadataKey === candidate.metadataKey &&
      evidence.checkedAt <= this.now() + 60_000
      ? evidence
      : undefined;
  }
  private mergeEvidence(entries: ModelEvidence[]): void {
    for (const entry of entries) {
      const previous = this.evidence.get(entry.modelId);
      if (!previous || entry.checkedAt > previous.checkedAt)
        this.evidence.set(entry.modelId, entry);
    }
  }
  private candidates(): Candidate[] {
    const context = this.context;
    if (!context) return [];
    const candidates: Candidate[] = [];
    for (const model of context.manifest.models ?? [])
      for (const target of model.targets)
        candidates.push({
          model,
          target,
          configured: Object.values(context.configured).includes(target.id),
          metadataKey: metadataKey(model, target),
        });
    for (const family of FAMILIES) {
      const id = context.configured[family] ?? context.manifest.defaults.env[KEYS[family]];
      if (!id || candidates.some((candidate) => candidate.target.id === id)) continue;
      const target: ModelTarget = { id, scope: "unknown", sourceRegions: [context.region] };
      const model: ModelDefinition = {
        id: "custom",
        family,
        label: `${family[0]?.toUpperCase()}${family.slice(1)} (custom target)`,
        targets: [target],
      };
      candidates.push({
        model,
        target,
        configured: context.configured[family] === id,
        metadataKey: metadataKey(model, target),
      });
    }
    return candidates;
  }
}
