import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { safeModelId } from "./catalogueSchema.js";
import type { ModelEvidence, ModelStatus, ModelStore } from "./types.js";

const STATUSES = new Set<ModelStatus>([
  "available",
  "subscription-required",
  "access-denied",
  "unsupported",
  "invalid-credential",
  "throttled",
  "network-error",
  "unknown",
]);
const REASONS = new Set([
  "invalid-target",
  "unsupported-partition",
  "cancelled",
  "timeout",
  "unexpected-response",
  "region-unavailable",
  "agreement-pending",
  "agreement-required",
  "model-authorization-denied",
  "availability-unconfirmed",
  "credential-rejected",
  "rate-limited",
  "service-unavailable",
  "proxy-authentication",
  "subscription-required",
  "invocation-denied",
  "metadata-permission-denied",
  "route-unavailable",
  "request-rejected",
  "tls",
  "dns",
  "transport",
  "attempt-incomplete",
  "unsupported-probe-format",
  "uncatalogued-target",
]);

/** Machine-local files; no globalState/Settings Sync and no bearer material. */
export class FileModelStore implements ModelStore {
  constructor(private readonly directory: string) {}
  async load(contextKey: string): Promise<ModelEvidence[]> {
    try {
      const file = await open(this.path(contextKey, "json"), "r");
      try {
        if ((await file.stat()).size > 524_288) return [];
        const parsed: unknown = JSON.parse(await file.readFile("utf8"));
        if (
          !record(parsed) ||
          parsed.version !== 1 ||
          !Array.isArray(parsed.evidence) ||
          parsed.evidence.length > 512
        )
          return [];
        return parsed.evidence.flatMap((entry) => {
          const valid = evidence(entry);
          return valid ? [valid] : [];
        });
      } finally {
        await file.close();
      }
    } catch {
      return [];
    }
  }
  async save(contextKey: string, entries: ModelEvidence[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(contextKey, "json");
    const temp = `${target}.${randomUUID()}.tmp`;
    const valid = entries.slice(0, 512).flatMap((entry) => {
      const clean = evidence(entry);
      return clean ? [clean] : [];
    });
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, evidence: valid }));
      await handle.close();
      await rename(temp, target);
    } finally {
      await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
    }
  }
  async acquire(
    contextKey: string,
    now: number,
    ttl: number,
  ): Promise<(() => Promise<void>) | undefined> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(contextKey, "lease");
    const owner = randomUUID();
    const marker = join(path, owner);
    const claim = async (): Promise<boolean> => {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (hasCode(error, "EEXIST")) return false;
        throw error;
      }
      const original = await stat(path);
      const handle = await open(marker, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ owner, expiresAt: now + ttl }));
      } finally {
        await handle.close();
      }
      const current = await stat(path);
      const occupants = await readdir(path);
      if (
        current.ino !== original.ino ||
        current.dev !== original.dev ||
        occupants.length !== 1 ||
        occupants[0] !== owner
      ) {
        await unlink(marker).catch(() => {});
        return false;
      }
      return true;
    };
    if (!(await claim())) {
      const occupants = await readdir(path).catch(() => undefined);
      if (!occupants || occupants.length > 1) return undefined;
      if (occupants.length === 0) {
        // mkdir can survive a crash before the owner marker is written.
        const info = await stat(path).catch(() => undefined);
        if (!info || info.mtimeMs + ttl > now) return undefined;
        try {
          await rmdir(path);
        } catch {
          return undefined;
        }
      } else {
        const priorOwner = occupants[0];
        if (!priorOwner || !/^[a-f0-9-]{36}$/.test(priorOwner)) return undefined;
        const priorPath = join(path, priorOwner);
        const prior = await readLease(priorPath);
        const info = await stat(priorPath).catch(() => undefined);
        if (prior ? prior.expiresAt > now : !info || info.mtimeMs + ttl > now) return undefined;
        // Only the winner removing this exact old owner's marker may remove its
        // empty directory. A stale reclaimer cannot unlink a successor's marker.
        try {
          await unlink(priorPath);
        } catch {
          return undefined;
        }
        try {
          await rmdir(path);
        } catch {
          return undefined;
        }
      }
      if (!(await claim())) return undefined;
    }
    return async () => {
      try {
        await unlink(marker);
      } catch {
        return;
      }
      await rmdir(path).catch(() => {});
    };
  }
  private path(contextKey: string, suffix: string): string {
    if (!/^[a-f0-9]{64}$/.test(contextKey)) throw new Error("Invalid model evidence context key");
    return join(this.directory, `${contextKey}.${suffix}`);
  }
}

async function readLease(path: string): Promise<{ owner: string; expiresAt: number } | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return record(value) && typeof value.owner === "string" && typeof value.expiresAt === "number"
      ? { owner: value.owner, expiresAt: value.expiresAt }
      : undefined;
  } catch {
    return undefined;
  }
}
function evidence(value: unknown): ModelEvidence | undefined {
  if (
    !record(value) ||
    !safeModelId(value.modelId) ||
    typeof value.metadataKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.metadataKey) ||
    !STATUSES.has(value.status as ModelStatus) ||
    !timestamp(value.checkedAt) ||
    !timestamp(value.lastAttemptAt) ||
    !timestamp(value.nextCheckAt) ||
    value.nextCheckAt < value.checkedAt ||
    value.nextCheckAt > value.checkedAt + 7 * 86_400_000 ||
    value.lastAttemptAt > value.checkedAt ||
    typeof value.failures !== "number" ||
    !Number.isInteger(value.failures) ||
    value.failures < 0 ||
    value.failures > 10_000
  )
    return undefined;
  const clean: ModelEvidence = {
    modelId: value.modelId,
    metadataKey: value.metadataKey,
    status: value.status as ModelStatus,
    checkedAt: value.checkedAt,
    lastAttemptAt: value.lastAttemptAt,
    nextCheckAt: value.nextCheckAt,
    failures: value.failures,
  };
  if (timestamp(value.lastSuccessAt) && value.lastSuccessAt <= value.checkedAt)
    clean.lastSuccessAt = value.lastSuccessAt;
  if (timestamp(value.lastCredentialFailureAt) && value.lastCredentialFailureAt <= value.checkedAt)
    clean.lastCredentialFailureAt = value.lastCredentialFailureAt;
  if (typeof value.reason === "string" && REASONS.has(value.reason)) clean.reason = value.reason;
  if (
    record(value.preflight) &&
    STATUSES.has(value.preflight.status as ModelStatus) &&
    timestamp(value.preflight.checkedAt)
  ) {
    clean.preflight = {
      status: value.preflight.status as ModelStatus,
      checkedAt: value.preflight.checkedAt,
    };
    if (typeof value.preflight.reason === "string" && REASONS.has(value.preflight.reason))
      clean.preflight.reason = value.preflight.reason;
  }
  return clean;
}
function timestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasCode(error: unknown, code: string): boolean {
  return record(error) && error.code === code;
}
