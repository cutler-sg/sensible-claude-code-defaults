import type { Manifest } from "../manifest/types.js";

export type ModelFamily = "opus" | "sonnet" | "haiku";
export type ProcessingScope =
  | "global"
  | "us"
  | "eu"
  | "apac"
  | "au"
  | "jp"
  | "regional"
  | "unknown";
export interface ModelTarget {
  id: string;
  sourceRegions: string[];
  scope: ProcessingScope;
}
export interface ModelDefinition {
  id: string;
  label: string;
  family: ModelFamily;
  targets: ModelTarget[];
  rank?: number;
  lifecycle?: "active" | "deprecated";
  probeFormat?: string;
  releasedAt?: string;
  verifiedAt?: string;
  source?: string;
}
export type ModelStatus =
  | "available"
  | "subscription-required"
  | "access-denied"
  | "unsupported"
  | "invalid-credential"
  | "throttled"
  | "network-error"
  | "unknown"
  | "not-checked"
  | "checking"
  | "out-of-scope";
export interface ModelEvidence {
  modelId: string;
  metadataKey: string;
  status: ModelStatus;
  checkedAt: number;
  lastAttemptAt: number;
  nextCheckAt: number;
  lastSuccessAt?: number;
  /** Credential-wide rejection barrier, retained through inconclusive retries. */
  lastCredentialFailureAt?: number;
  failures: number;
  reason?: string;
  preflight?: { status: ModelStatus; checkedAt: number; reason?: string };
}
export interface ModelRow {
  modelId: string;
  catalogueId?: string;
  label: string;
  family: ModelFamily;
  region: string;
  scope: ProcessingScope;
  configured: boolean;
  allowed: boolean;
  status: ModelStatus;
  stale: boolean;
  checkedAt?: number;
  nextCheckAt?: number;
  lastSuccessAt?: number;
  reason?: string;
  preflight?: ModelEvidence["preflight"];
}
export interface AvailabilitySnapshot {
  rows: ModelRow[];
  checking: boolean;
  credential: "unknown" | "valid" | "invalid";
  region?: string;
  lastCheckedAt?: number;
  issue?: "cache-unavailable" | "another-window-checking";
}
export interface ModelContext {
  token: string;
  credentialGeneration: string;
  configLocation: string;
  region: string;
  configured: Partial<Record<ModelFamily, string>>;
  manifest: Manifest;
  allowedScopes: readonly ProcessingScope[];
}
export interface ModelStore {
  load(contextKey: string): Promise<ModelEvidence[]>;
  save(contextKey: string, evidence: ModelEvidence[]): Promise<void>;
  acquire(contextKey: string, now: number, ttl: number): Promise<(() => Promise<void>) | undefined>;
}
export interface ModelServiceOptions {
  store: ModelStore;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  onChange?: () => void;
  requestTimeoutMs?: number;
  batchTimeoutMs?: number;
}
export interface ProbeOutcome {
  status: ModelStatus;
  reason?: string;
}
