/**
 * Credential contracts (PRD FR-4). Nothing under `src/credential/` imports
 * `vscode`: the keychain, the terminal collection and the clock are all
 * injected, so every rule here is testable without an extension host.
 *
 * Hard rule 4 applies to every type in this file: a `token` value may be
 * carried, never rendered. Anything that reaches a user or a log goes through
 * `REDACTED`.
 */

/** What we store, so the token's age travels with it (FR-4.6). */
export interface StoredToken {
  token: string;
  /** ISO 8601. When the user gave us this value, not when the key was minted. */
  setAt: string;
}

export interface TokenStore {
  get(): Promise<StoredToken | undefined>;
  set(value: StoredToken): Promise<void>;
  clear(): Promise<void>;
}

/**
 * VS Code's SecretStorage, structurally. Keeps `src/credential/` free of the
 * `vscode` import while still being the real thing at runtime.
 */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export type Thenable<T> = PromiseLike<T>;

/** FR-4.3. `persistent` must be false or VS Code caches the value to disk. */
export interface EnvCollectionLike {
  persistent: boolean;
  replace(variable: string, value: string): void;
  delete(variable: string): void;
}

/**
 * Why a candidate token was refused. Shape-based and deliberately permissive:
 * AWS does not document the key format, so the only safe rules reject things
 * that are certainly *not* a Bedrock key.
 */
export type ShapeProblem =
  | "empty"
  | "whitespace-inside"
  | "looks-like-access-key-id"
  | "looks-like-secret-access-key"
  | "too-short";

/** Severity decides whether the input box blocks or merely warns (FR-4.2). */
export interface ShapeVerdict {
  problem: ShapeProblem;
  /** `warning` lets the user proceed anyway — we must never reject a real key. */
  severity: "error" | "warning";
}

/** Outcome of the user-initiated Bedrock test call (FR-4.7). */
export type ConnectionResult =
  | { kind: "ok"; model: string }
  | { kind: "ok-without-haiku"; model: string }
  | { kind: "bad-credential"; status: number }
  | { kind: "model-not-enabled"; model: string }
  | { kind: "wrong-region"; region: string }
  | { kind: "network"; reason: "timeout" | "dns" | "tls" | "proxy" | "unknown" }
  | { kind: "unknown"; status: number };

export interface TestConnectionInput {
  token: string;
  region: string;
  /** Model ids to try, in order. First success wins. */
  models: readonly string[];
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Where a token was found when the keychain and the settings file disagree. */
export type TokenSource = "keychain" | "settings-file" | "both" | "none";

export interface TokenPresence {
  source: TokenSource;
  /** True when both hold a value and the values differ (FR-4.4 drift). */
  mismatch: boolean;
  setAt?: string;
}

export const TOKEN_SECRET_KEY = "sensibleDefaults.bedrockToken";
export const TOKEN_ENV_VAR = "AWS_BEARER_TOKEN_BEDROCK";
export const BEDROCK_ENV_VAR = "CLAUDE_CODE_USE_BEDROCK";
