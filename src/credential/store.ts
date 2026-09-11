/**
 * The keychain-backed token store (FR-4.1, FR-4.6).
 *
 * One secret, one JSON document `{token, setAt}`, so the token's age travels
 * with the value and a Linux libsecret unlock prompts once rather than twice.
 * `SecretStorage` is injected structurally, so nothing here imports `vscode`.
 *
 * FR-4.9: this is also where the redaction registry is fed. The store is the
 * only door a token value comes through, so registering here is what makes
 * "the token never appears in a log line" a property of the system rather than
 * a rule every call site has to remember — a value is registered before the
 * caller that asked for it can do anything with it, `set` included.
 */

import type { CredentialPolicy } from "../manifest/types.js";
import { register } from "../util/redact.js";
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
    if (parsed.kind === "corrupt") {
      // Never deleted (F7). This runs before the user has clicked anything —
      // activation pushes a stored key into the terminal collection — so a
      // delete here destroys a credential with no consent and no copy
      // anywhere. The shape rules that decide "this could not be a key" are
      // deliberately permissive because AWS does not document the format, and
      // a rule too unsure to reject a value at the input box is far too unsure
      // to erase one. So the secret stays and the condition is reported.
      throw new CorruptTokenSecretError();
    }
    if (parsed.kind === "absent") {
      return undefined;
    }

    if (parsed.kind === "legacy") {
      // A bare string is what an earlier shape would have stored. Re-store it in
      // the current shape so the age clock starts now rather than never.
      const migrated: StoredToken = { token: parsed.token, setAt: this.#stamp() };
      register(migrated.token);
      await this.#secrets.store(TOKEN_SECRET_KEY, JSON.stringify(migrated));
      return migrated;
    }

    register(parsed.value.token);
    return parsed.value;
  }

  /**
   * The value being replaced is registered too (FR-4.9). A rotation that only
   * registered the new key would leave the old one loggable for the rest of the
   * window — and the old one is precisely the value a user is most likely to
   * find in a stale log line, a settings file we are quoting back, or a
   * diagnostics report pasted into a public issue.
   *
   * The read is best-effort: a keychain that will not open, or a previous value
   * we cannot parse, must not stop a rotation. What we lose in that case is the
   * ability to scrub a value we never saw, which is the same position we are in
   * on a machine where the key was pasted in by hand.
   */
  async set(value: StoredToken): Promise<void> {
    register(value.token);
    await this.#registerPrevious();
    await this.#secrets.store(TOKEN_SECRET_KEY, JSON.stringify(value));
  }

  async #registerPrevious(): Promise<void> {
    let raw: string | undefined;
    try {
      raw = await this.#secrets.get(TOKEN_SECRET_KEY);
    } catch {
      return;
    }
    if (raw === undefined) return;
    const parsed = parse(raw);
    if (parsed.kind === "stored") register(parsed.value.token);
    if (parsed.kind === "legacy") register(parsed.token);
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

/**
 * In-memory `TokenStore` for tests in modules that only need a token to exist.
 *
 * It registers exactly as the real store does, previous value included. A test
 * double that skipped registration would let a leak test pass because the
 * registry happened to be empty, which is the one way these tests can be wrong.
 */
export class MemoryTokenStore implements TokenStore {
  #value: StoredToken | undefined;

  constructor(initial?: StoredToken) {
    this.#value = initial;
    register(initial?.token);
  }

  get(): Promise<StoredToken | undefined> {
    register(this.#value?.token);
    return Promise.resolve(this.#value === undefined ? undefined : { ...this.#value });
  }

  set(value: StoredToken): Promise<void> {
    register(value.token);
    register(this.#value?.token);
    this.#value = { ...value };
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#value = undefined;
    return Promise.resolve();
  }
}

/**
 * A secret that is present and unreadable.
 *
 * Distinguishable so the host can tell it apart from a keychain that will not
 * open, and empty of detail on purpose: the value it is about is a credential,
 * so not one character of it — not a length, not a prefix — appears in the
 * message (hard rule 4).
 */
export class CorruptTokenSecretError extends Error {
  override readonly name = "CorruptTokenSecretError";

  constructor() {
    super(
      "The saved Bedrock API key can't be read. It has been left alone — set a key again to replace it.",
    );
  }
}

type Parsed =
  | { kind: "stored"; value: StoredToken }
  | { kind: "legacy"; token: string }
  /** Nothing recoverable is in there: report "no key set" and leave it be. */
  | { kind: "absent" }
  /** Something is in there that we cannot use and must not destroy. */
  | { kind: "corrupt" };

const ABSENT: Parsed = { kind: "absent" };
const CORRUPT: Parsed = { kind: "corrupt" };

/**
 * A bare string is ambiguous: it is both "what an earlier shape would have
 * stored" and "a secret that failed to parse". Shape decides how it is
 * reported — never whether it survives. A value we would have accepted from the
 * user migrates; a value the shape rules reject is `corrupt`, because those
 * rules are permissive by design and cannot tell a real long-term key from an
 * IAM secret access key with enough confidence to erase one. `too-short` is a
 * warning, so it migrates too (see shape.ts). An empty string is the one case
 * with nothing to lose, so it reads as plain absence.
 */
function asLegacy(token: string): Parsed {
  const verdict = validateTokenShape(token);
  if (verdict === undefined || verdict.severity !== "error") {
    return { kind: "legacy", token: token.trim() };
  }
  return verdict.problem === "empty" ? ABSENT : CORRUPT;
}

function parse(raw: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return asLegacy(raw);
  }

  if (typeof data === "string") {
    return asLegacy(data);
  }
  // A JSON document that is not our envelope cannot be carrying a bare key, so
  // there is no credential to preserve and nothing to report beyond absence.
  if (!isRecord(data)) {
    return ABSENT;
  }
  const { token, setAt } = data;
  if (typeof token !== "string" || token === "") {
    return ABSENT;
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
