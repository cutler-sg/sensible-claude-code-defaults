import { describe, expect, it } from "vitest";
import { BUNDLED_MANIFEST } from "../../../src/manifest/bundled.js";
import type { FetchOutcome } from "../../../src/manifest/fetch.js";
import { fetchManifest } from "../../../src/manifest/fetch.js";

const URL_ = "https://raw.githubusercontent.com/cutler-sg/x/main/manifest/defaults.json";

/** The bundled manifest is the known-good document every case starts from. */
function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...BUNDLED_MANIFEST, ...overrides });
}

interface ResponseInitLike {
  status?: number;
  headers?: Record<string, string>;
  url?: string;
}

function jsonResponse(body: string, init: ResponseInitLike = {}): Response {
  const response = new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (init.url !== undefined) {
    Object.defineProperty(response, "url", { value: init.url });
  }
  return response;
}

/** A fetch playing one scripted step per call, recording the URLs it was given. */
function scripted(steps: readonly (Response | Error | (() => Response))[]): {
  fetch: typeof globalThis.fetch;
  urls: string[];
  inits: (RequestInit | undefined)[];
} {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  let index = 0;
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    inits.push(init);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step instanceof Error) return Promise.reject(step);
    if (typeof step === "function") return Promise.resolve(step());
    return Promise.resolve(step as Response);
  }) as typeof globalThis.fetch;
  return { fetch, urls, inits };
}

function errorWithCause(name: string, code: string): Error {
  const outer = new TypeError("fetch failed");
  const inner = new Error("underlying");
  inner.name = name;
  Object.assign(inner, { code });
  Object.assign(outer, { cause: inner });
  return outer;
}

async function run(
  steps: readonly (Response | Error | (() => Response))[],
  options: { url?: string; maxBytes?: number; timeoutMs?: number } = {},
): Promise<FetchOutcome> {
  const { fetch } = scripted(steps);
  return await fetchManifest({ url: options.url ?? URL_, fetch, ...options });
}

describe("fetchManifest", () => {
  it("returns the validated manifest and its revision on 200", async () => {
    const outcome = await run([jsonResponse(validBody())]);
    expect(outcome).toEqual({
      kind: "ok",
      manifest: BUNDLED_MANIFEST,
      revision: BUNDLED_MANIFEST.revision,
    });
  });

  it("requests with manual redirect handling and a JSON accept header", async () => {
    const { fetch, urls, inits } = scripted([jsonResponse(validBody())]);
    await fetchManifest({ url: URL_, fetch });
    expect(urls).toEqual([URL_]);
    expect(inits[0]?.redirect).toBe("manual");
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["invalid JSON", jsonResponse("{ not json"), "invalid-json"],
    ["JSON null", jsonResponse("null"), "invalid-manifest"],
    ["a JSON array", jsonResponse("[]"), "invalid-manifest"],
  ] as const)("fails with %s", async (_name, response, reason) => {
    const outcome = await run([response]);
    expect(outcome).toMatchObject({ kind: "failed", reason });
  });

  it("reports the schema problem paths when valid JSON fails validation", async () => {
    const outcome = await run([jsonResponse(validBody({ regions: [] }))]);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBe("invalid-manifest");
    expect(outcome.problems).toEqual([{ path: "regions", problem: "must be a non-empty array" }]);
  });

  it("carries no response body or URL into a failure", async () => {
    const outcome = await run([jsonResponse("secret-body-content", { status: 500 })]);
    expect(JSON.stringify(outcome)).not.toContain("secret-body-content");
    expect(JSON.stringify(outcome)).not.toContain("githubusercontent");
  });

  it("treats 304 as not-modified rather than a failure", async () => {
    expect(await run([new Response(null, { status: 304 })])).toEqual({ kind: "not-modified" });
  });

  it.each([404, 403, 500, 503])("fails with the status on %i", async (status) => {
    expect(await run([jsonResponse("nope", { status })])).toEqual({
      kind: "failed",
      reason: "http-status",
      status,
    });
  });

  it("classifies an abort as a timeout", async () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(await run([abort])).toEqual({ kind: "failed", reason: "timeout" });
  });

  it("aborts the request once the timeout elapses", async () => {
    const fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof globalThis.fetch;
    const outcome = await fetchManifest({ url: URL_, fetch, timeoutMs: 1 });
    expect(outcome).toEqual({ kind: "failed", reason: "timeout" });
  });

  it.each([
    ["dns", errorWithCause("Error", "ENOTFOUND"), "dns"],
    ["a flaky resolver", errorWithCause("Error", "EAI_AGAIN"), "dns"],
    ["tls", errorWithCause("Error", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"), "tls"],
    ["an ssl error", errorWithCause("Error", "ERR_SSL_WRONG_VERSION_NUMBER"), "tls"],
    ["a refused connection", errorWithCause("Error", "ECONNREFUSED"), "network"],
  ] as const)("classifies %s", async (_name, error, reason) => {
    expect(await run([error])).toEqual({ kind: "failed", reason });
  });

  it("classifies a thrown non-Error as a network failure", async () => {
    const fetch = (() => Promise.reject("just a string")) as typeof globalThis.fetch;
    expect(await fetchManifest({ url: URL_, fetch })).toEqual({
      kind: "failed",
      reason: "network",
    });
  });

  it("survives a self-referential cause chain", async () => {
    const error = new Error("looping");
    Object.assign(error, { cause: error });
    expect(await run([error])).toEqual({ kind: "failed", reason: "network" });
  });

  it("follows a same-origin redirect", async () => {
    const { fetch, urls } = scripted([
      new Response(null, { status: 302, headers: { location: "/moved/defaults.json" } }),
      jsonResponse(validBody()),
    ]);
    const outcome = await fetchManifest({ url: URL_, fetch });
    expect(outcome.kind).toBe("ok");
    expect(urls[1]).toBe("https://raw.githubusercontent.com/moved/defaults.json");
  });

  it("refuses a redirect to another origin", async () => {
    const outcome = await run([
      new Response(null, { status: 301, headers: { location: "https://evil.example/x.json" } }),
    ]);
    expect(outcome).toEqual({ kind: "failed", reason: "cross-origin-redirect" });
  });

  it("refuses a redirect with no location header", async () => {
    const outcome = await run([new Response(null, { status: 302 })]);
    expect(outcome).toEqual({ kind: "failed", reason: "cross-origin-redirect" });
  });

  it("refuses a redirect to an unparseable location", async () => {
    const outcome = await run([
      new Response(null, { status: 307, headers: { location: "http://[::bad" } }),
    ]);
    expect(outcome).toEqual({ kind: "failed", reason: "cross-origin-redirect" });
  });

  it("gives up on a same-origin redirect loop", async () => {
    const outcome = await run([
      () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    ]);
    expect(outcome).toEqual({ kind: "failed", reason: "too-many-redirects" });
  });

  it("refuses a 200 whose response URL is a different origin", async () => {
    const outcome = await run([
      jsonResponse(validBody(), { url: "https://evil.example/defaults.json" }),
    ]);
    expect(outcome).toEqual({ kind: "failed", reason: "cross-origin-redirect" });
  });

  it("accepts a 200 whose response URL matches the request", async () => {
    const outcome = await run([jsonResponse(validBody(), { url: URL_ })]);
    expect(outcome.kind).toBe("ok");
  });

  it("refuses a 200 whose response URL is unparseable", async () => {
    const outcome = await run([jsonResponse(validBody(), { url: "not a url" })]);
    expect(outcome).toEqual({ kind: "failed", reason: "cross-origin-redirect" });
  });

  it.each([
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["text/plain; charset=utf-8", true],
    ["application/vnd.github.v3+json", true],
    ["text/html", false],
    ["application/octet-stream", false],
  ])("content-type %s is accepted: %s", async (contentType, accepted) => {
    const outcome = await run([
      jsonResponse(validBody(), { headers: { "content-type": contentType } }),
    ]);
    expect(outcome.kind).toBe(accepted ? "ok" : "failed");
  });

  it("accepts a response with no content-type at all", async () => {
    const response = new Response(validBody());
    response.headers.delete("content-type");
    expect((await run([response])).kind).toBe("ok");
  });

  it("refuses a body whose declared content-length is over the cap", async () => {
    const outcome = await run([
      jsonResponse(validBody(), { headers: { "content-length": "999999999" } }),
    ]);
    expect(outcome).toEqual({ kind: "failed", reason: "too-large" });
  });

  it("refuses an oversized body even when the header lies", async () => {
    const outcome = await run(
      [jsonResponse(validBody(), { headers: { "content-length": "12" } })],
      { maxBytes: 16 },
    );
    expect(outcome).toEqual({ kind: "failed", reason: "too-large" });
  });

  it("ignores an unparseable content-length and still caps while reading", async () => {
    const outcome = await run(
      [jsonResponse(validBody(), { headers: { "content-length": "banana" } })],
      { maxBytes: 16 },
    );
    expect(outcome).toEqual({ kind: "failed", reason: "too-large" });
  });

  it("reports a body that fails mid-read rather than throwing", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.error(new Error("connection reset"));
      },
    });
    const response = new Response(body, { headers: { "content-type": "application/json" } });
    expect(await run([response])).toEqual({ kind: "failed", reason: "unreadable-body" });
  });

  it("treats a 200 with no body as invalid JSON", async () => {
    const response = new Response(null, { headers: { "content-type": "application/json" } });
    expect(await run([response])).toEqual({ kind: "failed", reason: "invalid-json" });
  });

  it("reassembles a body split across chunks", async () => {
    const bytes = new TextEncoder().encode(validBody());
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const response = new Response(body, { headers: { "content-type": "application/json" } });
    expect((await run([response])).kind).toBe("ok");
  });

  it.each([
    ["not a url at all", "bad-url"],
    ["http://example.com/defaults.json", "insecure-url"],
    ["ftp://example.com/defaults.json", "insecure-url"],
  ] as const)("refuses the url %s", async (url, reason) => {
    const outcome = await fetchManifest({
      url,
      fetch: (() => Promise.reject(new Error("must not be called"))) as typeof globalThis.fetch,
    });
    expect(outcome).toEqual({ kind: "failed", reason });
  });

  it("resolves rather than rejects on every branch", async () => {
    const cases: (Response | Error | (() => Response))[][] = [
      [jsonResponse(validBody())],
      [jsonResponse("{")],
      [jsonResponse("null")],
      [new Response(null, { status: 304 })],
      [jsonResponse("x", { status: 404 })],
      [jsonResponse("x", { status: 500 })],
      [new Error("boom")],
      [errorWithCause("Error", "ENOTFOUND")],
      [errorWithCause("Error", "ERR_TLS_CERT_ALTNAME_INVALID")],
      [new Response(null, { status: 302, headers: { location: "https://evil.example/" } })],
      [jsonResponse(validBody(), { headers: { "content-type": "text/html" } })],
      [jsonResponse(validBody(), { headers: { "content-length": "999999999" } })],
    ];
    for (const steps of cases) {
      await expect(run(steps)).resolves.toBeDefined();
    }
  });
});
