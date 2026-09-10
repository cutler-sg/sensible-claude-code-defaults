/**
 * The single choke point for scrubbing secrets out of anything the extension
 * emits: log lines, error messages, the diagnostics report (FR-4.9, FR-7.1).
 *
 * Registry first, patterns second, and the order matters. AWS does not document
 * the Bedrock API key format, so a pattern set can only ever recognise the
 * shapes we happen to know. What we always know is the exact value we are
 * holding — so the credential store registers it here on every change, and that
 * exact-value match is what actually carries the guarantee. The patterns are a
 * second net for values we never held: a key pasted into a settings file we are
 * quoting back, an `Authorization` header in a stack trace.
 *
 * Memory-only, cleared on deactivate. A persisted list of known secrets would be
 * a worse artefact than the leak it prevents.
 */

export const REDACTED = "«redacted»";

/**
 * Below this, an exact-value match is more likely to be coincidence than a
 * disclosure — and redacting a common substring would corrupt every log line
 * that happened to contain it.
 */
const MIN_REGISTERED_LENGTH = 8;

const registry = new Set<string>();

/**
 * Patterns for secrets we never held. Deliberately narrow: a pattern that is too
 * eager turns diagnostics into a wall of `«redacted»` and the reader stops
 * trusting any of it. Each is anchored on a prefix or a key name that does not
 * occur by accident.
 */
const PATTERNS: readonly RegExp[] = [
  // AWS access key id, then its secret — the pair a confused user is most
  // likely to paste when they mean to paste a Bedrock key.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Long-term Bedrock API keys observed in the wild.
  /\bABSK[A-Za-z0-9+/=_-]{16,}/g,
  // Short-term keys minted by the token generator.
  /\bbedrock-api-key-[A-Za-z0-9+/=._-]{8,}/g,
  // Any bearer credential in a quoted header or a stack trace.
  /\b(?:Authorization|authorization)\s*:\s*Bearer\s+\S+/g,
  // The token key as it appears in a settings file we are quoting back.
  /"AWS_BEARER_TOKEN_BEDROCK"\s*:\s*"[^"]*"/g,
];

/**
 * Start scrubbing this exact value. Called by the credential store whenever the
 * stored token changes, including the value being replaced: a rotation should
 * not leave the previous key loggable for the rest of the window.
 */
export function register(secret: string | undefined): void {
  if (secret === undefined) return;
  const trimmed = secret.trim();
  if (trimmed.length < MIN_REGISTERED_LENGTH) return;
  registry.add(trimmed);
}

/** Drop every registered value. Called on deactivate. */
export function forgetAll(): void {
  registry.clear();
}

/** How many values are registered. For tests and diagnostics counts only. */
export function registeredCount(): number {
  return registry.size;
}

export function redact(message: string): string {
  let out = message;

  // Longest first: a shorter secret that is a substring of a longer one must not
  // cut it in half and leave the remainder readable.
  for (const secret of [...registry].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.replaceAll(secret, REDACTED);
  }

  for (const pattern of PATTERNS) {
    // Each pattern is a module-level literal with the `g` flag, so `lastIndex`
    // persists between calls; `replaceAll` resets it, but being explicit here
    // means adding a non-global pattern later cannot silently break the others.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }

  return out;
}

/**
 * Redact a whole JSON-shaped value, by key as well as by value.
 *
 * Key-based redaction is the half that still works when the pattern set is
 * wrong and the registry is empty — which is exactly the situation on a machine
 * where the user pasted a key by hand and the extension has never held it.
 *
 * Key *names* go through `redact` too, and for the same reason values do: a
 * settings document's keys are unconstrained user data, so a transposed
 * key/value — `{"ABSK…": "AWS_BEARER_TOKEN_BEDROCK"}`, an ordinary hand-editing
 * slip — puts the token in the one position a value-only walker cannot see.
 * Leaving keys alone also made this walker strictly weaker than `redact` over
 * the serialised text, which would have caught that. A key that *is* a secret
 * key keeps its own name: the row has to stay identifiable, or the reader
 * cannot tell which setting was removed.
 *
 * `secretKeys` may hold either dotted paths (`env.AWS_BEARER_TOKEN_BEDROCK`, as
 * `SECRET_KEYS` does) or bare leaf names; both match. Handing this the project's
 * own constant and having it silently match nothing, degrading the key rule to
 * the pattern net, is the trap a caller falls into exactly once.
 */
export function redactValue(value: unknown, secretKeys: ReadonlySet<string>): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secretKeys));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const secret = isSecret(key, secretKeys);
      const redacted = secret ? REDACTED : redactValue(entry, secretKeys);
      // Defined, not assigned: `out.__proto__ = x` sets the prototype instead of
      // adding a key, so the entry vanishes from `JSON.stringify` and the report
      // silently omits part of the file the user is pasting to get help.
      Object.defineProperty(out, secret ? key : redact(key), {
        value: redacted,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * A key is secret when the caller named it directly or named a dotted path
 * ending in it. Comparing leaf-to-leaf rather than requiring the caller to
 * flatten means `SECRET_KEYS` works handed over unchanged.
 */
function isSecret(key: string, secretKeys: ReadonlySet<string>): boolean {
  if (secretKeys.has(key)) return true;
  for (const candidate of secretKeys) {
    if (leafOf(candidate) === key) return true;
  }
  return false;
}

/** The last segment of a dotted key. */
function leafOf(key: string): string {
  const at = key.lastIndexOf(".");
  return at === -1 ? key : key.slice(at + 1);
}
