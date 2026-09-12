/**
 * The "Test connection" call (FR-4.7, plan Q-U).
 *
 * This is the only place the extension sends the token anywhere, so it is
 * deliberately one function with one host pattern and no configuration of its
 * own. It is user-initiated only: `cred.valid` never triggers it (plan Q-T).
 *
 * Hard rule 4 governs the whole file. Response bodies are read *only* to
 * classify — AWS error bodies echo request context, and a proxy's 407 page can
 * contain anything — so nothing derived from a body or from the token ever
 * reaches the returned value. Every `ConnectionResult` variant carries only a
 * status code, a region, or a model id we ourselves supplied.
 */

import type { ConnectionResult, TestConnectionInput } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/** AWS regions are lower-case alphanumerics and hyphens; anything else is not one. */
const REGION_SHAPE = /^[a-z0-9-]+$/;

/** Error markers that mean "the key itself was refused". */
const CREDENTIAL_MARKERS = [
  "unrecognizedclientexception",
  "invalidsignatureexception",
  "security token",
] as const;

/**
 * Phrases that make a denial about the *policy on the key* rather than about a
 * model the account never enabled. IAM denials quote the ARN of the resource
 * they refused, and a Bedrock model ARN ends in the model id — so "the body
 * mentions a model" is true of every one of them and cannot be the test.
 */
const POLICY_DENIAL_MARKERS = ["not authorized to perform", "explicit deny", "no identity-based"];

/**
 * Phrases AWS uses when the *model* is the thing unavailable. A denial that
 * carries one of these is about model access even though it is also worded as
 * an authorization failure, so it outranks the policy markers above.
 */
const MODEL_STATE_MARKERS = ["access to the model", "model access", "not been granted"];

/** Error markers that mean "the key is fine, this model is not available to it". */
const MODEL_MARKERS = ["accessdeniedexception", "validationexception"] as const;

const WRONG_REGION_MARKER = "not supported in";

/**
 * Fields only a real Bedrock answer carries. A 200 that has none of them did
 * not come from Bedrock — an intercepting proxy or captive portal answering
 * with its own sign-in page is the case this exists for, and treating that as
 * proof the key works would make the extension's only proof-of-function lie.
 */
const BEDROCK_RESPONSE_FIELDS = ["content", "stop_reason", "usage"] as const;

export async function testConnection(input: TestConnectionInput): Promise<ConnectionResult> {
  if (!REGION_SHAPE.test(input.region)) {
    // The region is interpolated into a hostname, so it is validated before it
    // is used rather than escaped afterwards. A malformed region is also the
    // most likely cause of the DNS failure it would otherwise produce.
    return { kind: "wrong-region", region: input.region };
  }

  const region = input.region;
  const call = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // One budget for the whole call, not one per model. The user is watching a
  // progress notification, and Q-U's Sonnet retry must not be able to double
  // how long they wait for an answer.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await race(call, region, input.models, input.token, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function race(
  call: typeof globalThis.fetch,
  region: string,
  models: readonly string[],
  token: string,
  signal: AbortSignal,
): Promise<ConnectionResult> {
  let deniedModel: string | undefined;
  for (const model of models) {
    if (signal.aborted) {
      // The budget went on the previous model. Starting another attempt would
      // put the token on the wire again for a request already out of time.
      return { kind: "network", reason: "timeout" };
    }
    const outcome = await attempt(call, region, model, token, signal);

    if (outcome.kind === "ok") {
      // Q-U: Haiku is tried first and is the model Claude Code uses for
      // background work. If it was refused and a later model answered, the
      // setup works but is degraded, and the user needs to know which it is.
      return deniedModel === undefined ? outcome : { kind: "ok-without-haiku", model };
    }
    if (outcome.kind !== "model-not-enabled") {
      return outcome;
    }
    // Report the first model refused, not the last: that is the one the
    // account is missing and the one the console page must enable.
    deniedModel ??= model;
  }

  if (deniedModel !== undefined) {
    return { kind: "model-not-enabled", model: deniedModel };
  }
  // An empty model list is a caller bug, not a user-visible AWS state. Status 0
  // is the "we never made a request" marker the unknown branch already uses.
  return { kind: "unknown", status: 0 };
}

async function attempt(
  call: typeof globalThis.fetch,
  region: string,
  model: string,
  token: string,
  signal: AbortSignal,
): Promise<ConnectionResult> {
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  try {
    const response = await call(`https://${host}/model/${encodeURIComponent(model)}/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      // The cheapest call that proves both the credential and the model:
      // one token in, one token out.
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
      signal,
    });
    return classifyResponse(response, model, region, await bodyText(response));
  } catch (error) {
    return classifyThrown(error, region, host);
  }
}

/** Never returned, never logged — read for classification and dropped. */
async function bodyText(response: Response): Promise<string> {
  try {
    return (await response.text()).toLowerCase();
  } catch {
    // A truncated or already-consumed body classifies as an empty one; the
    // status code still carries most of the signal.
    return "";
  }
}

function classifyResponse(
  response: Response,
  model: string,
  region: string,
  body: string,
): ConnectionResult {
  const status = response.status;
  if (status === 200 || status === 201) {
    // A 200 is only proof the key works if the answer came from Bedrock. An
    // intercepting proxy or captive portal answers 200 with its own page, and
    // this is the extension's only proof-of-function (F9).
    return looksLikeBedrock(body) ? { kind: "ok", model } : { kind: "unknown", status };
  }
  if (status === 407) {
    return { kind: "network", reason: "proxy" };
  }
  // Checked before the credential and model branches: a 400 that says the model
  // "isn't supported in" a region is about the region, and its body also names
  // the model, so the later branches would both claim it.
  if (status === 404 || body.includes(WRONG_REGION_MARKER)) {
    return { kind: "wrong-region", region };
  }
  if ((status === 401 || status === 403) && CREDENTIAL_MARKERS.some((m) => body.includes(m))) {
    return { kind: "bad-credential", status };
  }
  // Before the model branch: an IAM denial quotes the ARN it refused, and a
  // Bedrock model ARN ends in the model id, so the model branch would claim
  // every policy denial and send the user to enable models that are already on.
  if ((status === 401 || status === 403 || status === 400) && isPolicyDenial(body)) {
    return { kind: "insufficient-permissions", status };
  }
  if ((status === 403 || status === 400) && namesModel(body, model)) {
    return { kind: "model-not-enabled", model };
  }
  // A bare 401/403 with a body we do not recognise is still a refused key: no
  // other cause produces those two statuses on an authenticated POST.
  if (status === 401 || status === 403) {
    return { kind: "bad-credential", status };
  }
  return { kind: "unknown", status };
}

/**
 * A 200 that is a JSON object carrying at least one field only Bedrock sends.
 * Deliberately field-presence rather than schema validation: the point is to
 * separate "an answer from a model" from "an answer from something else on the
 * path", and a stricter shape would fail the day Bedrock adds a field.
 */
function looksLikeBedrock(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }
  return BEDROCK_RESPONSE_FIELDS.some((field) => field in parsed);
}

/**
 * The key is real and the models are on; the policy attached to the key does
 * not allow the call. Distinct from `model-not-enabled` because the remedy is
 * different — an IAM policy, not the model-access console page — and because
 * retrying another model with the same key can never succeed (F8).
 */
function isPolicyDenial(body: string): boolean {
  return (
    POLICY_DENIAL_MARKERS.some((marker) => body.includes(marker)) &&
    !MODEL_STATE_MARKERS.some((marker) => body.includes(marker))
  );
}

/**
 * The body names the model when it quotes the id back, or when it is one of the
 * two exceptions AWS raises for an unavailable model and mentions models at all.
 *
 * The loose second half is only safe because policy denials are taken out
 * above: every Bedrock error quotes a model ARN, so on its own "mentions a
 * model" matched a plain IAM refusal too (F8).
 */
function namesModel(body: string, model: string): boolean {
  return (
    body.includes(model.toLowerCase()) ||
    (MODEL_MARKERS.some((marker) => body.includes(marker)) && body.includes("model"))
  );
}

/**
 * Transport failures. `fetch` wraps the real cause one or two levels deep, so
 * the chain is walked rather than the top-level error inspected.
 *
 * NXDOMAIN on our own regional host is reported as a wrong region rather than a
 * DNS fault: that hostname exists for every region AWS has, so the name that
 * failed to resolve is the region the user typed. A DNS failure naming some
 * other host is the user's proxy or resolver, and a transient `EAI_AGAIN` is
 * never authoritative enough to blame the region for.
 */
function classifyThrown(error: unknown, region: string, host: string): ConnectionResult {
  const chain = causeChain(error);

  if (chain.some((link) => link.name === "AbortError" || link.name === "TimeoutError")) {
    return { kind: "network", reason: "timeout" };
  }

  const codes = chain.map((link) => link.code).filter((code): code is string => code !== undefined);
  if (codes.some(isTlsCode)) {
    return { kind: "network", reason: "tls" };
  }
  if (codes.includes("ENOTFOUND")) {
    const hostname = chain.find((link) => link.hostname !== undefined)?.hostname;
    return hostname === undefined || hostname === host
      ? { kind: "wrong-region", region }
      : { kind: "network", reason: "dns" };
  }
  if (codes.includes("EAI_AGAIN")) {
    return { kind: "network", reason: "dns" };
  }
  // Includes a thrown non-Error: something failed at the transport and we have
  // no idea what, which is exactly what `unknown` means.
  return { kind: "network", reason: "unknown" };
}

function isTlsCode(code: string): boolean {
  return (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code.includes("CERT") ||
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL")
  );
}

interface Link {
  name: string | undefined;
  code: string | undefined;
  hostname: string | undefined;
}

/** Flatten `error.cause` into a list, guarding against a self-referential chain. */
function causeChain(error: unknown): Link[] {
  const links: Link[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    links.push(linkOf(current));
    current = typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  return links;
}

function linkOf(value: unknown): Link {
  if (typeof value !== "object" || value === null) {
    return { name: undefined, code: undefined, hostname: undefined };
  }
  const record = value as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    code: typeof record.code === "string" ? record.code : undefined,
    hostname: typeof record.hostname === "string" ? record.hostname : undefined,
  };
}
