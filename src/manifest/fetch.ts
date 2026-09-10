/**
 * The remote half of the update channel (FR-3.2).
 *
 * One rule governs this file: **it never throws and never rejects.** Every
 * caller is on the activation path, where an unhandled rejection is a user
 * staring at a broken panel for a reason they cannot act on. A manifest that
 * cannot be fetched, cannot be parsed, or does not validate is not an error
 * condition — it is the ordinary case of "use what we already had".
 *
 * The guards below (size, content type, redirect origin) exist because this
 * endpoint reaches every installation at once with no Marketplace scan in
 * between. They are cheap, and each one closes a way for a compromised or
 * misconfigured host to spend a user's memory or move the channel elsewhere.
 *
 * Nothing here imports `vscode`; `fetch` is injected so every branch is
 * testable without a network.
 */

import type { SchemaProblem } from "./schema.js";
import { validateManifest } from "./schema.js";
import type { Manifest } from "./types.js";

/**
 * Why a fetch produced nothing usable. A reason code and nothing else: response
 * bodies echo request context, and the URL can carry a query string, so neither
 * may travel into a log or a diagnostics report (hard rule 4).
 */
export type FetchFailureReason =
  | "bad-url"
  | "insecure-url"
  | "timeout"
  | "dns"
  | "tls"
  | "network"
  | "http-status"
  | "too-many-redirects"
  | "cross-origin-redirect"
  | "unexpected-content-type"
  | "too-large"
  | "unreadable-body"
  | "invalid-json"
  | "invalid-manifest";

export type FetchOutcome =
  | { kind: "ok"; manifest: Manifest; revision: string }
  | { kind: "not-modified" }
  | {
      kind: "failed";
      reason: FetchFailureReason;
      /** Present only for `http-status`; a status code names no user and no host. */
      status?: number | undefined;
      /** Present only for `invalid-manifest`. Paths and rules, never values. */
      problems?: SchemaProblem[] | undefined;
    };

export interface FetchManifestOptions {
  url: string;
  /** FR-3.2. The whole request, not per hop. */
  timeoutMs?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  maxBytes?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 5_000;
/** 256 KiB. The bundled manifest is under 1 KiB; this is three orders of slack. */
const DEFAULT_MAX_BYTES = 262_144;
/** Same-origin only, so a chain this long is a loop or a misconfiguration. */
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Content types a JSON document may legitimately arrive as.
 *
 * `text/plain` is on the list because `raw.githubusercontent.com` — the host
 * plan Q-Y picks — serves every file, `.json` included, as
 * `text/plain; charset=utf-8`. A stricter rule would reject the primary
 * channel's own responses. The body is parsed and validated regardless, so the
 * header is a sanity check against an HTML error page, not a trust boundary.
 */
const JSON_CONTENT_TYPES = new Set(["application/json", "text/json", "text/plain"]);

export async function fetchManifest(options: FetchManifestOptions): Promise<FetchOutcome> {
  const call = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let target: URL;
  try {
    target = new URL(options.url);
  } catch {
    return { kind: "failed", reason: "bad-url" };
  }
  // FR-3.2 says HTTPS. Over plaintext, anyone on the path could set the env
  // block and the plugin marketplace list on every machine behind that network.
  if (target.protocol !== "https:") {
    return { kind: "failed", reason: "insecure-url" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await request(call, target, controller.signal, maxBytes);
  } catch (error) {
    return { kind: "failed", reason: classifyThrown(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function request(
  call: typeof globalThis.fetch,
  target: URL,
  signal: AbortSignal,
  maxBytes: number,
): Promise<FetchOutcome> {
  let current = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // `manual` so the redirect decision is ours: the default would follow a
    // Location to any host, which is exactly the move that would relocate the
    // update channel away from the URL the user can see in their settings.
    const response = await call(current.toString(), {
      redirect: "manual",
      signal,
      headers: { accept: "application/json" },
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const next = redirectTarget(response, current);
      if (next === undefined) return { kind: "failed", reason: "cross-origin-redirect" };
      current = next;
      continue;
    }

    // Belt and braces: a `fetch` that ignores `redirect: "manual"` still lands
    // here, and `response.url` is then the host that actually answered.
    if (!sameOrigin(response.url, current)) {
      return { kind: "failed", reason: "cross-origin-redirect" };
    }

    // Q-Z declines conditional requests, but a caching layer or a proxy can
    // still answer 304, and "nothing changed" is not a failure.
    if (response.status === 304) return { kind: "not-modified" };
    if (response.status !== 200) {
      return { kind: "failed", reason: "http-status", status: response.status };
    }

    return await readManifest(response, maxBytes);
  }

  return { kind: "failed", reason: "too-many-redirects" };
}

/** The same-origin hop to follow next, or `undefined` if there is not one. */
function redirectTarget(response: Response, current: URL): URL | undefined {
  const location = response.headers.get("location");
  if (location === null) return undefined;
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return undefined;
  }
  return next.origin === current.origin ? next : undefined;
}

/**
 * An empty `response.url` is what a hand-built `Response` has, and a fetch
 * implementation that does not populate it tells us nothing either way.
 */
function sameOrigin(responseUrl: string, current: URL): boolean {
  if (responseUrl === "") return true;
  try {
    return new URL(responseUrl).origin === current.origin;
  } catch {
    return false;
  }
}

async function readManifest(response: Response, maxBytes: number): Promise<FetchOutcome> {
  if (!isJsonish(response.headers.get("content-type"))) {
    return { kind: "failed", reason: "unexpected-content-type" };
  }

  const declared = Number(response.headers.get("content-length"));
  // Refused before a byte is read when the header is honest, and again while
  // reading when it is not — a `content-length` is a claim, not a limit.
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { kind: "failed", reason: "too-large" };
  }

  const body = await readCapped(response, maxBytes);
  if (body.kind !== "ok") return { kind: "failed", reason: body.kind };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return { kind: "failed", reason: "invalid-json" };
  }

  // FR-3.4: validation happens here, not at the point of use, so no caller can
  // hold an unvalidated manifest even briefly.
  const result = validateManifest(parsed);
  if (!result.ok) {
    return { kind: "failed", reason: "invalid-manifest", problems: result.problems };
  }
  return { kind: "ok", manifest: result.manifest, revision: result.manifest.revision };
}

function isJsonish(contentType: string | null): boolean {
  if (contentType === null) return true;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return JSON_CONTENT_TYPES.has(type) || type.endsWith("+json");
}

type Body = { kind: "ok"; text: string } | { kind: "too-large" } | { kind: "unreadable-body" };

/**
 * Read the body, counting bytes as they arrive and stopping at the cap.
 *
 * `response.text()` would buffer whatever the server chose to send before we
 * had any say in it, which on a compromised host is a memory-exhaustion lever
 * pointed at every user's editor.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Body> {
  const stream = response.body;
  if (stream === null) {
    // A null body is a legitimate shape (a 200 with no content); it simply
    // parses as nothing further down.
    return { kind: "ok", text: "" };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) return { kind: "too-large" };
      chunks.push(value);
    }
  } catch {
    return { kind: "unreadable-body" };
  } finally {
    // Releases the socket whether we finished, capped out, or failed.
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", text: new TextDecoder().decode(joined) };
}

/**
 * Transport failures, classified from the `cause` chain `fetch` wraps them in.
 * The distinction is for the log only — every one of these falls back the same
 * way — but "offline" and "your TLS interception is misconfigured" are very
 * different support conversations.
 */
function classifyThrown(error: unknown): FetchFailureReason {
  const chain = causeChain(error);
  if (chain.some((link) => link.name === "AbortError" || link.name === "TimeoutError")) {
    return "timeout";
  }
  const codes = chain.map((link) => link.code).filter((code): code is string => code !== undefined);
  if (codes.some(isTlsCode)) return "tls";
  if (codes.includes("ENOTFOUND") || codes.includes("EAI_AGAIN")) return "dns";
  return "network";
}

/**
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` is listed explicitly because it carries
 * neither "CERT" nor an `ERR_` prefix, and it is the code a corporate TLS
 * interception proxy produces — the single likeliest TLS failure on the
 * machines this extension targets.
 */
const TLS_CODES = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "EPROTO"]);

function isTlsCode(code: string): boolean {
  return (
    code.includes("CERT") ||
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    TLS_CODES.has(code)
  );
}

interface Link {
  name: string | undefined;
  code: string | undefined;
}

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
  if (typeof value !== "object" || value === null) return { name: undefined, code: undefined };
  const record = value as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    code: typeof record.code === "string" ? record.code : undefined,
  };
}
