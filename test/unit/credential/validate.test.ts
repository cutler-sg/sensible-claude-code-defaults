import { describe, expect, it } from "vitest";
import type { ConnectionResult } from "../../../src/credential/types.js";
import { testConnection } from "../../../src/credential/validate.js";

const TOKEN = "ABSKQmVkcm9ja0FQSUtleUV4YW1wbGVWYWx1ZTAxMjM0NTY3ODk";
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const SONNET = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const REGION = "us-east-1";

/**
 * What Bedrock actually answers with. A bare `{}` is what a proxy returns, not
 * what a model returns, so it is never used as a success body here (F9).
 */
const BEDROCK_BODY = JSON.stringify({
  id: "msg_bdrk_01",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "." }],
  stop_reason: "max_tokens",
  usage: { input_tokens: 8, output_tokens: 1 },
});

/** A pure IAM policy denial. Names an action and a model ARN, not a model state. */
const IAM_DENIAL = JSON.stringify({
  message:
    "User: arn:aws:sts::123456789012:assumed-role/Developer/mc is not authorized to perform: " +
    `bedrock:InvokeModel on resource: arn:aws:bedrock:us-east-1::foundation-model/${HAIKU} ` +
    "because no identity-based policy allows the bedrock:InvokeModel action",
});

/** What Bedrock says when the account has never enabled the model. */
const MODEL_NOT_ENABLED = JSON.stringify({
  __type: "AccessDeniedException",
  message: "You don't have access to the model with the specified model ID.",
});

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/**
 * A fetch that plays a scripted step per call, recording each.
 *
 * Steps are factories rather than values because a `Response` body can only be
 * consumed once, and the last step repeats for every call past the end of the
 * script — a shared instance would make the second model's attempt see an empty
 * body and classify on the status alone.
 */
type Step = (() => Response | object) | Error | unknown;

function scriptedFetch(script: readonly Step[]): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return typeof step === "function" ? Promise.resolve(step() as Response) : Promise.reject(step);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function respond(status: number, body = ""): () => Response {
  return () => new Response(body, { status });
}

function nodeError(name: string, code: string, extra: Record<string, unknown> = {}): Error {
  // Undici wraps the transport failure in `cause`, which is what we classify on.
  const cause = Object.assign(new Error("underlying"), { code, ...extra });
  return Object.assign(new Error(name), { name: "TypeError", cause });
}

async function run(
  script: readonly unknown[],
  overrides: Partial<Parameters<typeof testConnection>[0]> = {},
): Promise<{ result: ConnectionResult; calls: Call[] }> {
  const { fetch, calls } = scriptedFetch(script as readonly Step[]);
  const result = await testConnection({
    token: TOKEN,
    region: REGION,
    models: [HAIKU, SONNET],
    fetch,
    timeoutMs: 50,
    ...overrides,
  });
  return { result, calls };
}

describe("testConnection request shape", () => {
  it("posts to the regional runtime host with the encoded model id", async () => {
    const { calls } = await run([respond(200, BEDROCK_BODY)]);
    expect(calls[0]?.url).toBe(
      `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(HAIKU)}/invoke`,
    );
    // The colon in the model id must not reach the path raw.
    expect(calls[0]?.url).toContain("%3A0");
  });

  it("sends the bearer token, the json content type, and the minimal body", async () => {
    const { calls } = await run([respond(200, BEDROCK_BODY)]);
    const init = calls[0]?.init;
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    });
  });

  it("aborts the request when it passes the timeout", async () => {
    const slow = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      })) as typeof globalThis.fetch;
    const result = await testConnection({
      token: TOKEN,
      region: REGION,
      models: [HAIKU],
      fetch: slow,
      timeoutMs: 5,
    });
    expect(result).toEqual({ kind: "network", reason: "timeout" });
  });

  it("spends one timeout budget across every model, not one each", async () => {
    // The user is watching a progress notification: two models must not be able
    // to hold it for two full timeouts.
    const started: number[] = [];
    const hang = ((_url: string, init?: RequestInit) => {
      started.push(Date.now());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    }) as typeof globalThis.fetch;

    const began = Date.now();
    const result = await testConnection({
      token: TOKEN,
      region: REGION,
      models: [HAIKU, SONNET],
      fetch: hang,
      timeoutMs: 40,
    });
    const elapsed = Date.now() - began;

    expect(result).toEqual({ kind: "network", reason: "timeout" });
    // One budget, not two. The generous ceiling keeps this from being a
    // timing-flaky test while still failing the per-attempt controller.
    expect(elapsed).toBeLessThan(80);
    expect(started).toHaveLength(1);
  });

  it("stops before the next model when the budget expired mid-attempt", async () => {
    // The first model answers, but only after the budget is gone. Trying the
    // second would put the token on the wire for a request already out of time.
    let calls = 0;
    const late = (() => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        setTimeout(
          () => resolve(new Response('{"__type":"AccessDeniedException: model"}', { status: 403 })),
          25,
        );
      });
    }) as typeof globalThis.fetch;

    const result = await testConnection({
      token: TOKEN,
      region: REGION,
      models: [HAIKU, SONNET],
      fetch: late,
      timeoutMs: 5,
    });
    expect(result).toEqual({ kind: "network", reason: "timeout" });
    expect(calls).toBe(1);
  });

  it("does not start a second model once the shared budget is spent", async () => {
    let calls = 0;
    const slowThenFast = ((_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      }
      return Promise.resolve(new Response(BEDROCK_BODY, { status: 200 }));
    }) as typeof globalThis.fetch;

    const result = await testConnection({
      token: TOKEN,
      region: REGION,
      models: [HAIKU, SONNET],
      fetch: slowThenFast,
      timeoutMs: 20,
    });
    expect(result).toEqual({ kind: "network", reason: "timeout" });
    expect(calls).toBe(1);
  });

  it("falls back to the global fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = ((url: string | URL | Request) => {
      seen.push(String(url));
      return Promise.resolve(new Response(BEDROCK_BODY, { status: 200 }));
    }) as typeof globalThis.fetch;
    try {
      await expect(
        testConnection({ token: TOKEN, region: REGION, models: [HAIKU] }),
      ).resolves.toEqual({ kind: "ok", model: HAIKU });
      expect(seen).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses the default timeout when none is given", async () => {
    // Resolves immediately; the assertion is that the default path is exercised.
    const { fetch } = scriptedFetch([respond(200, BEDROCK_BODY)]);
    await expect(
      testConnection({ token: TOKEN, region: REGION, models: [HAIKU], fetch }),
    ).resolves.toEqual({ kind: "ok", model: HAIKU });
  });
});

describe("testConnection classification", () => {
  it("200 is ok", async () => {
    const { result } = await run([respond(200, BEDROCK_BODY)]);
    expect(result).toEqual({ kind: "ok", model: HAIKU });
  });

  it("201 is ok", async () => {
    const { result } = await run([respond(201, BEDROCK_BODY)]);
    expect(result).toEqual({ kind: "ok", model: HAIKU });
  });

  it("a captive portal's HTML sign-in page is not a working key (F9)", async () => {
    const { result } = await run([
      respond(200, "<html><body><h1>Sign in to continue</h1></body></html>"),
    ]);
    expect(result).toEqual({ kind: "unknown", status: 200 });
  });

  it("a 200 with an empty body is not a working key", async () => {
    const { result } = await run([respond(200, "")]);
    expect(result).toEqual({ kind: "unknown", status: 200 });
  });

  it("a 200 whose JSON is not Bedrock-shaped is not a working key", async () => {
    const { result } = await run([respond(200, '{"ok":true}')]);
    expect(result).toEqual({ kind: "unknown", status: 200 });
  });

  it.each([
    ["null", "null"],
    ["a number", "42"],
    ["a quoted string", '"signed in"'],
  ])("a 200 whose body is JSON %s is not a working key", async (_shape, body) => {
    const { result } = await run([respond(200, body)]);
    expect(result).toEqual({ kind: "unknown", status: 200 });
  });

  it.each([
    ["content", '{"content":[{"type":"text","text":"."}]}'],
    ["stop_reason", '{"stop_reason":"max_tokens"}'],
    ["usage", '{"usage":{"input_tokens":8,"output_tokens":1}}'],
  ])("a 200 carrying %s is a working key", async (_field, body) => {
    const { result } = await run([respond(200, body)]);
    expect(result).toEqual({ kind: "ok", model: HAIKU });
  });

  it("does not fall through to the next model when a 200 was not Bedrock-shaped", async () => {
    const { result, calls } = await run([respond(200, "<html>portal</html>")]);
    expect(result.kind).toBe("unknown");
    expect(calls).toHaveLength(1);
  });

  it("401 with UnrecognizedClientException is a bad credential", async () => {
    const { result } = await run([
      respond(401, '{"message":"The security token included in the request is invalid."}'),
    ]);
    expect(result).toEqual({ kind: "bad-credential", status: 401 });
  });

  it("403 with UnrecognizedClientException is a bad credential", async () => {
    const { result } = await run([respond(403, '{"__type":"UnrecognizedClientException"}')]);
    expect(result).toEqual({ kind: "bad-credential", status: 403 });
  });

  it("403 with InvalidSignatureException is a bad credential", async () => {
    const { result } = await run([respond(403, '{"__type":"InvalidSignatureException"}')]);
    expect(result).toEqual({ kind: "bad-credential", status: 403 });
  });

  it("a bare 403 with no recognisable body is still a bad credential", async () => {
    const { result } = await run([respond(403, "")]);
    expect(result).toEqual({ kind: "bad-credential", status: 403 });
  });

  it("403 AccessDeniedException naming the model tries the next model", async () => {
    const { result, calls } = await run([
      respond(403, '{"message":"AccessDeniedException: you do not have access to the model"}'),
      respond(200, BEDROCK_BODY),
    ]);
    expect(result).toEqual({ kind: "ok-without-haiku", model: SONNET });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain(encodeURIComponent(SONNET));
  });

  it("400 ValidationException mentioning the model tries the next model", async () => {
    const { result } = await run([
      respond(400, '{"message":"ValidationException: the provided model identifier is invalid"}'),
      respond(200, BEDROCK_BODY),
    ]);
    expect(result).toEqual({ kind: "ok-without-haiku", model: SONNET });
  });

  it("an IAM policy denial is a permissions problem, not a disabled model (F8)", async () => {
    // The denial quotes the model ARN, so "the body mentions a model" is true of
    // every one of them. The user's key is fine and every model is enabled; the
    // policy attached to the key does not allow bedrock:InvokeModel.
    const { result, calls } = await run([respond(403, IAM_DENIAL)]);
    expect(result).toEqual({ kind: "insufficient-permissions", status: 403 });
    // And it must not re-send the token for a retry that could never help.
    expect(calls).toHaveLength(1);
  });

  it("a genuine model-not-enabled body still routes the user to the console", async () => {
    const { result } = await run([
      respond(403, MODEL_NOT_ENABLED),
      respond(403, MODEL_NOT_ENABLED),
    ]);
    expect(result).toEqual({ kind: "model-not-enabled", model: HAIKU });
  });

  it("a 400 ValidationException about a malformed request is unknown, not a model verdict", async () => {
    const { result, calls } = await run([
      respond(
        400,
        '{"message":"ValidationException: 1 validation error detected: value at \'maxTokens\' failed to satisfy constraint"}',
      ),
    ]);
    expect(result).toEqual({ kind: "unknown", status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("403 quoting the model id back is model-not-enabled", async () => {
    const { result } = await run([respond(403, `no access to ${HAIKU}`)], { models: [HAIKU] });
    expect(result).toEqual({ kind: "model-not-enabled", model: HAIKU });
  });

  it("reports the first refused model when every model is refused", async () => {
    const { result, calls } = await run([
      respond(403, '{"message":"AccessDeniedException on this model"}'),
    ]);
    expect(result).toEqual({ kind: "model-not-enabled", model: HAIKU });
    expect(calls).toHaveLength(2);
  });

  it("does not downgrade to ok-without-haiku when the first model succeeded", async () => {
    const { result } = await run([respond(200, BEDROCK_BODY)]);
    expect(result).toEqual({ kind: "ok", model: HAIKU });
  });

  it("stops at the first non-model failure rather than trying the next model", async () => {
    const { result, calls } = await run([respond(401, "UnrecognizedClientException")]);
    expect(result.kind).toBe("bad-credential");
    expect(calls).toHaveLength(1);
  });

  it("404 is the wrong region", async () => {
    const { result } = await run([respond(404, "")]);
    expect(result).toEqual({ kind: "wrong-region", region: REGION });
  });

  it("a body saying the model is not supported in the region is the wrong region", async () => {
    const { result } = await run([
      respond(400, `The model ${HAIKU} is not supported in this region.`),
    ]);
    expect(result).toEqual({ kind: "wrong-region", region: REGION });
  });

  it("407 is a proxy failure", async () => {
    const { result } = await run([respond(407, "Proxy Authentication Required")]);
    expect(result).toEqual({ kind: "network", reason: "proxy" });
  });

  it("an unhandled status is unknown, carrying only the status", async () => {
    const { result } = await run([respond(503, "Service Unavailable")]);
    expect(result).toEqual({ kind: "unknown", status: 503 });
  });

  it("a body that cannot be read classifies on the status alone", async () => {
    const unreadable = () => ({
      status: 500,
      text: () => Promise.reject(new Error("stream already consumed")),
    });
    const { fetch } = scriptedFetch([unreadable]);
    await expect(
      testConnection({ token: TOKEN, region: REGION, models: [HAIKU], fetch }),
    ).resolves.toEqual({ kind: "unknown", status: 500 });
  });

  it("an empty model list is a caller bug, reported as unknown", async () => {
    const { result, calls } = await run([respond(200, BEDROCK_BODY)], { models: [] });
    expect(result).toEqual({ kind: "unknown", status: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("testConnection transport failures", () => {
  it("AbortError is a timeout", async () => {
    const { result } = await run([Object.assign(new Error("x"), { name: "AbortError" })]);
    expect(result).toEqual({ kind: "network", reason: "timeout" });
  });

  it("TimeoutError is a timeout", async () => {
    const { result } = await run([Object.assign(new Error("x"), { name: "TimeoutError" })]);
    expect(result).toEqual({ kind: "network", reason: "timeout" });
  });

  it("ENOTFOUND on our own regional host is the wrong region", async () => {
    const host = `bedrock-runtime.${REGION}.amazonaws.com`;
    const { result } = await run([nodeError("fetch failed", "ENOTFOUND", { hostname: host })]);
    expect(result).toEqual({ kind: "wrong-region", region: REGION });
  });

  it("ENOTFOUND naming another host is a DNS failure", async () => {
    const { result } = await run([
      nodeError("fetch failed", "ENOTFOUND", { hostname: "corp-proxy.internal" }),
    ]);
    expect(result).toEqual({ kind: "network", reason: "dns" });
  });

  it("ENOTFOUND with no hostname falls back to the wrong region", async () => {
    const { result } = await run([nodeError("fetch failed", "ENOTFOUND")]);
    expect(result).toEqual({ kind: "wrong-region", region: REGION });
  });

  it("EAI_AGAIN is a DNS failure, never a region verdict", async () => {
    const { result } = await run([nodeError("fetch failed", "EAI_AGAIN")]);
    expect(result).toEqual({ kind: "network", reason: "dns" });
  });

  it("a self-signed certificate is a TLS failure", async () => {
    const { result } = await run([nodeError("fetch failed", "SELF_SIGNED_CERT_IN_CHAIN")]);
    expect(result).toEqual({ kind: "network", reason: "tls" });
  });

  it("an expired certificate is a TLS failure", async () => {
    const { result } = await run([nodeError("fetch failed", "CERT_HAS_EXPIRED")]);
    expect(result).toEqual({ kind: "network", reason: "tls" });
  });

  it("an ERR_TLS code is a TLS failure", async () => {
    const { result } = await run([nodeError("fetch failed", "ERR_TLS_CERT_ALTNAME_INVALID")]);
    expect(result).toEqual({ kind: "network", reason: "tls" });
  });

  it("an ERR_SSL code is a TLS failure", async () => {
    const { result } = await run([nodeError("fetch failed", "ERR_SSL_WRONG_VERSION_NUMBER")]);
    expect(result).toEqual({ kind: "network", reason: "tls" });
  });

  it("ECONNREFUSED is an unknown network failure", async () => {
    const { result } = await run([nodeError("fetch failed", "ECONNREFUSED")]);
    expect(result).toEqual({ kind: "network", reason: "unknown" });
  });

  it("handles a thrown non-Error", async () => {
    const { result } = await run(["something went wrong"]);
    expect(result).toEqual({ kind: "network", reason: "unknown" });
  });

  it("handles a thrown null", async () => {
    const { result } = await run([null]);
    expect(result).toEqual({ kind: "network", reason: "unknown" });
  });

  it("ignores non-string name, code and hostname fields on a cause", async () => {
    const { result } = await run([{ name: 7, code: {}, hostname: [], cause: null }]);
    expect(result).toEqual({ kind: "network", reason: "unknown" });
  });

  it("survives a self-referential cause chain", async () => {
    const looping: Record<string, unknown> = { name: "Error", code: "ECONNRESET" };
    looping.cause = looping;
    const { result } = await run([looping]);
    expect(result).toEqual({ kind: "network", reason: "unknown" });
  });
});

describe("testConnection region validation", () => {
  it("refuses a region that could not be part of a hostname", async () => {
    const { result, calls } = await run([respond(200, BEDROCK_BODY)], {
      region: "us-east-1/../evil.example.com",
    });
    expect(result).toEqual({ kind: "wrong-region", region: "us-east-1/../evil.example.com" });
    expect(calls).toHaveLength(0);
  });

  it("refuses an empty region without making a request", async () => {
    const { result, calls } = await run([respond(200, BEDROCK_BODY)], { region: "" });
    expect(result).toEqual({ kind: "wrong-region", region: "" });
    expect(calls).toHaveLength(0);
  });

  it("accepts an unknown but well-shaped region", async () => {
    const { result, calls } = await run([respond(200, BEDROCK_BODY)], { region: "ap-southeast-7" });
    expect(result).toEqual({ kind: "ok", model: HAIKU });
    expect(calls[0]?.url).toContain("bedrock-runtime.ap-southeast-7.amazonaws.com");
  });
});

describe("hard rule 4: nothing leaks into a result", () => {
  /** Every string anywhere in the result, however nested. */
  function strings(value: unknown): string[] {
    return JSON.stringify(value ?? null).match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  }

  const LEAKY_BODY = `{"message":"AccessDeniedException for token ${TOKEN}, account 123456789012, request 8f2a"}`;
  const LEAKY_DENIAL = `{"message":"User arn:aws:iam::123456789012:user/mc is not authorized to perform: bedrock:InvokeModel with ${TOKEN}"}`;
  const LEAKY_PORTAL = `<html>AccessDeniedException sign in as 123456789012 with ${TOKEN}</html>`;

  const scenarios: readonly (readonly [string, readonly unknown[]])[] = [
    ["ok", [respond(200, `{"content":[{"type":"text","text":"${TOKEN}"}]}`)]],
    ["bad credential", [respond(401, LEAKY_BODY)]],
    ["model not enabled", [respond(403, LEAKY_BODY), respond(403, LEAKY_BODY)]],
    ["insufficient permissions", [respond(403, LEAKY_DENIAL)]],
    ["a 200 from an intercepting proxy", [respond(200, LEAKY_PORTAL)]],
    ["wrong region", [respond(404, LEAKY_BODY)]],
    ["proxy", [respond(407, LEAKY_BODY)]],
    ["unknown status", [respond(500, LEAKY_BODY)]],
    ["thrown error carrying the token", [new Error(`connect failed for ${TOKEN}`)]],
  ];

  for (const [name, script] of scenarios) {
    it(`${name}: the token appears in no field`, async () => {
      const { result } = await run(script);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(TOKEN);
      // Belt and braces: sweep each string individually, including keys.
      for (const value of strings(result)) {
        expect(value).not.toContain(TOKEN);
      }
    });

    it(`${name}: no response body content is echoed back`, async () => {
      const { result } = await run(script);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("123456789012");
      expect(serialized).not.toContain("AccessDeniedException");
    });
  }

  it("a thrown error carrying the token never reaches the result", async () => {
    const { result } = await run([new Error(`refused: ${TOKEN}`)]);
    expect(result).toEqual({ kind: "network", reason: "unknown" });
  });
});
