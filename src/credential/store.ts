/**
 * The keychain-backed token store (FR-4.1, FR-4.6).
 *
 * One secret, one JSON document `{token, setAt}`, so the token's age travels
 * with the value and a Linux libsecret unlock prompts once rather than twice.
 * `SecretStorage` is injected structurally, so nothing here imports `vscode`.
 */

import type { CredentialPolicy } from "../manifest/types.js";
import { validateTokenShape } from "./shape.js";
import {
  type SecretStorageLike,
  type StoredToken,
  TOKEN_SECRET_KEY,
  type TokenStore,
} from "./types.js";

const MS_PER_DAY = 86_400_000;

export interface TokenStoreOptions {
  /** Injected for tests; defaults to the wall clock. */
  now?: () => Date;
}

export class SecretTokenStore implements TokenStore {
  readonly #secrets: SecretStorageLike;
  readonly #now: () => Date;

  constructor(secrets: SecretStorageLike, options: TokenStoreOptions = {}) {
    this.#secrets = secrets;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Errors from `SecretStorage` propagate on purpose (plan Q-X): on Linux
   * without libsecret every call throws, and a store that swallowed that would
   * report "no key set" to a user who has one — sending them round the entry
   * flow again to hit the same invisible wall. The health check turns the throw
   * into "VS Code can't reach your system keychain"; we do not degrade to a
   * lesser storage location behind the user's back.
   */
  async get(): Promise<StoredToken | undefined> {
    const raw = await this.#secrets.get(TOKEN_SECRET_KEY);
    if (raw === undefined) {
      return undefined;
    }

    const parsed = parse(raw);
    if (parsed === undefined) {
      // A secret we cannot parse is a secret we can never use, and leaving it
      // makes every future read fail the same way. Clearing it puts the user
      // back on the ordinary "no key set" path, which has a fix attached.
      await this.#secrets.delete(TOKEN_SECRET_KEY);
      return undefined;
    }

    if (parsed.kind === "legacy") {
      // A bare string is what an earlier shape would have stored. Re-store it in
      // the current shape so the age clock starts now rather than never.
      const migrated: StoredToken = { token: parsed.token, setAt: this.#stamp() };
      await this.#secrets.store(TOKEN_SECRET_KEY, JSON.stringify(migrated));
      return migrated;
    }

    return parsed.value;
  }

  async set(value: StoredToken): Promise<void> {
    await this.#secrets.store(TOKEN_SECRET_KEY, JSON.stringify(value));
  }

  async clear(): Promise<void> {
    await this.#secrets.delete(TOKEN_SECRET_KEY);
  }

  /** Stamp a value the caller is about to store, from this store's clock. */
  stamp(token: string): StoredToken {
    return { token, setAt: this.#stamp() };
  }

  #stamp(): string {
    return this.#now().toISOString();
  }
}

/** In-memory `TokenStore` for tests in modules that only need a token to exist. */
export class MemoryTokenStore implements TokenStore {
  #value: StoredToken | undefined;

  constructor(initial?: StoredToken) {
    this.#value = initial;
  }

  get(): Promise<StoredToken | undefined> {
    return Promise.resolve(this.#value === undefined ? undefined : { ...this.#value });
  }

  set(value: StoredToken): Promise<void> {
    this.#value = { ...value };
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#value = undefined;
    return Promise.resolve();
  }
}

type Parsed = { kind: "stored"; value: StoredToken } | { kind: "legacy"; token: string };

/**
 * A bare string is ambiguous: it is both "what an earlier shape would have
 * stored" and "a secret that failed to parse". Shape decides which — a value
 * that could not be a key is corruption, and anything else is a token we would
 * have accepted from the user, so migrating it is strictly better than making
 * them re-enter it. `too-short` is a warning, so it migrates too (see shape.ts).
 */
function asLegacy(token: string): Parsed | undefined {
  return validateTokenShape(token)?.severity === "error"
    ? undefined
    : { kind: "legacy", token: token.trim() };
}

function parse(raw: string): Parsed | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return asLegacy(raw);
  }

  if (typeof data === "string") {
    return asLegacy(data);
  }
  if (!isRecord(data)) {
    return undefined;
  }
  const { token, setAt } = data;
  if (typeof token !== "string" || token === "") {
    return undefined;
  }
  // A missing or non-string `setAt` costs us the age check, not the token, so
  // the value is kept and the stamp is repaired on the next `set`.
  return {
    kind: "stored",
    value: { token, setAt: typeof setAt === "string" ? setAt : "" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whole days since the token was set, or `undefined` when the stamp is missing
 * or unparseable. A stamp in the future yields a negative number rather than
 * being clamped: the caller decides, and `ageLevel` treats it as fresh.
 */
export function ageInDays(stored: StoredToken, now: Date): number | undefined {
  const setAt = Date.parse(stored.setAt);
  if (Number.isNaN(setAt)) {
    return undefined;
  }
  return Math.floor((now.getTime() - setAt) / MS_PER_DAY);
}

/**
 * FR-4.6. An unreadable stamp reports `ok`: the age check is a nudge to rotate,
 * and a missing date is not evidence the key is old. `failAfterDays` wins ties
 * with `warnAfterDays` so a misconfigured manifest cannot hide a failure.
 */
export function ageLevel(
  stored: StoredToken,
  policy: CredentialPolicy,
  now: Date,
): "ok" | "warn" | "fail" {
  const days = ageInDays(stored, now);
  if (days === undefined) {
    return "ok";
  }
  if (days >= policy.failAfterDays) {
    return "fail";
  }
  return days >= policy.warnAfterDays ? "warn" : "ok";
}
