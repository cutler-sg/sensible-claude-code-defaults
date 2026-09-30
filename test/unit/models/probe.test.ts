import { describe, expect, it, vi } from "vitest";
import { invokeModel, preflightModel } from "../../../src/models/probe.js";

const input = {
  token: "test-only-secret-do-not-leak",
  region: "us-east-1",
  modelId: "global.anthropic.claude-sonnet-5-5",
};
const available = {
  authorizationStatus: "AUTHORIZED",
  entitlementAvailability: "AVAILABLE",
  regionAvailability: "AVAILABLE",
  agreementAvailability: { status: "AVAILABLE" },
};
function fetchResponse(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("model probes", () => {
  it("uses the exact target, minimal fixed body, fixed AWS host and no redirects", async () => {
    const call = fetchResponse({ content: [], stop_reason: "max_tokens" });
    expect(await invokeModel({ ...input, fetch: call })).toEqual({ status: "available" });
    const [url, init] = vi.mocked(call).mock.calls[0] ?? [];
    expect(url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-sonnet-5-5/invoke",
    );
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    });
  });
  it("requires all availability fields positive", async () => {
    expect(await preflightModel({ ...input, fetch: fetchResponse(available) })).toEqual({
      status: "available",
    });
    expect(
      await preflightModel({
        ...input,
        fetch: fetchResponse({ ...available, authorizationStatus: undefined }),
      }),
    ).toMatchObject({ status: "unknown" });
  });
  it.each([
    [{ ...available, entitlementAvailability: "NOT_AVAILABLE" }, "subscription-required"],
    [{ ...available, agreementAvailability: { status: "PENDING" } }, "subscription-required"],
    [{ ...available, authorizationStatus: "NOT_AUTHORIZED" }, "access-denied"],
    [{ ...available, regionAvailability: "NOT_AVAILABLE" }, "unsupported"],
    [{ ...available, modelId: "another-model" }, "unknown"],
  ])("classifies explicit preflight state %j", async (body, status) => {
    expect(await preflightModel({ ...input, fetch: fetchResponse(body) })).toMatchObject({
      status,
    });
  });
  it.each([
    [403, {}, "access-denied"],
    [401, {}, "access-denied"],
    [
      403,
      {
        __type: "AccessDeniedException",
        message:
          "Not authorized to perform bedrock:InvokeModel on global.anthropic.claude-sonnet-5-5",
      },
      "access-denied",
    ],
    [403, { __type: "ExpiredTokenException" }, "invalid-credential"],
    [
      403,
      { message: "The security token included in the request is invalid" },
      "invalid-credential",
    ],
    [403, { message: "AWS Marketplace subscription is required" }, "subscription-required"],
    [404, {}, "unsupported"],
    [400, { __type: "ValidationException", message: "max_tokens must be positive" }, "unknown"],
    [400, { message: "The provided model identifier is invalid" }, "unsupported"],
    [429, {}, "throttled"],
    [500, {}, "network-error"],
    [503, {}, "network-error"],
    [407, {}, "network-error"],
  ])(
    "classifies %d response without confusing policy, tokens or subscriptions",
    async (code, body, status) => {
      const outcome = await invokeModel({
        ...input,
        fetch: fetchResponse({ ...body, token: input.token }, code),
      });
      expect(outcome.status).toBe(status);
      expect(JSON.stringify(outcome)).not.toContain(input.token);
      expect(JSON.stringify(outcome)).not.toContain("max_tokens");
    },
  );
  it("does not equate metadata permission denial with invocation access", async () => {
    expect(await preflightModel({ ...input, fetch: fetchResponse({}, 403) })).toEqual({
      status: "unknown",
      reason: "metadata-permission-denied",
    });
  });
  it.each([{}, { content: "fake" }, { usage: "not-json-model" }, "<html>login</html>"])(
    "rejects proxy success %j",
    async (body) => {
      expect(await invokeModel({ ...input, fetch: fetchResponse(body) })).toMatchObject({
        status: "unknown",
      });
    },
  );
  it("bounds responses", async () => {
    expect(
      await invokeModel({
        ...input,
        fetch: fetchResponse({ content: ["x".repeat(70_000)], stop_reason: "end_turn" }),
      }),
    ).toMatchObject({ status: "unknown" });
  });
  it("times out even a transport ignoring AbortSignal", async () => {
    expect(
      await invokeModel({
        ...input,
        timeoutMs: 5,
        fetch: vi.fn(() => new Promise<Response>(() => {})),
      }),
    ).toEqual({ status: "network-error", reason: "timeout" });
  });
  it("makes no request for an already cancelled signal or unsafe target", async () => {
    const call = vi.fn();
    await invokeModel({ ...input, fetch: call, signal: AbortSignal.abort() });
    await invokeModel({ ...input, fetch: call, region: "us-east-1.evil.invalid" });
    await invokeModel({ ...input, fetch: call, modelId: "../escape" });
    expect(call).not.toHaveBeenCalled();
  });
  it("sanitizes thrown errors", async () => {
    const call = vi.fn(async () => {
      throw new Error(input.token, { cause: { code: "CERT_HAS_EXPIRED" } });
    });
    expect(await invokeModel({ ...input, fetch: call })).toEqual({
      status: "network-error",
      reason: "tls",
    });
  });
});
