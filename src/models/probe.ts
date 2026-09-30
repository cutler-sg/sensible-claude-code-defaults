import { safeModelId } from "./catalogueSchema.js";
import type { ProbeOutcome } from "./types.js";

export interface ProbeInput {
  token: string;
  region: string;
  modelId: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Both endpoints are fixed AWS hosts; redirects must never carry a bearer elsewhere. */
export async function preflightModel(input: ProbeInput): Promise<ProbeOutcome> {
  return request(input, false);
}
export async function invokeModel(input: ProbeInput): Promise<ProbeOutcome> {
  return request(input, true);
}

async function request(input: ProbeInput, runtime: boolean): Promise<ProbeOutcome> {
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(input.region) || !safeModelId(input.modelId))
    return { status: "unsupported", reason: "invalid-target" };
  // Bearer inference keys are not supported on the China partition endpoints.
  if (input.region.startsWith("cn-"))
    return { status: "unsupported", reason: "unsupported-partition" };
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, input.timeoutMs ?? 10_000);
  let rejectAborted: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(new DOMException("Aborted", "AbortError"));
    controller.signal.addEventListener("abort", rejectAborted, { once: true });
  });
  try {
    if (controller.signal.aborted) return { status: "network-error", reason: "cancelled" };
    const operation = async (): Promise<ProbeOutcome> => {
      const suffix = input.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
      const host = `${runtime ? "bedrock-runtime" : "bedrock"}.${input.region}.${suffix}`;
      const path = runtime
        ? `/model/${encodeURIComponent(input.modelId)}/invoke`
        : `/foundation-model-availability/${encodeURIComponent(input.modelId)}`;
      const response = await (input.fetch ?? globalThis.fetch)(`https://${host}${path}`, {
        method: runtime ? "POST" : "GET",
        headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
        ...(runtime
          ? {
              body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 1,
                messages: [{ role: "user", content: "." }],
              }),
            }
          : {}),
        redirect: "error",
        signal: controller.signal,
      });
      const body = await boundedBody(response);
      if (response.ok)
        return runtime ? classifyRuntimeSuccess(body) : classifyAvailability(body, input.modelId);
      return classifyFailure(response.status, body, runtime);
    };
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    return {
      status: "network-error",
      reason: controller.signal.aborted ? "timeout" : networkReason(error),
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    if (rejectAborted) controller.signal.removeEventListener("abort", rejectAborted);
  }
}

async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > 65_536) {
        void reader.cancel().catch(() => {});
        return "";
      }
      chunks.push(result.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
function jsonObject(body: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
function classifyRuntimeSuccess(body: string): ProbeOutcome {
  const value = jsonObject(body);
  return value &&
    Array.isArray(value.content) &&
    (typeof value.stop_reason === "string" || typeof value.usage === "object")
    ? { status: "available" }
    : { status: "unknown", reason: "unexpected-response" };
}
function classifyAvailability(body: string, modelId: string): ProbeOutcome {
  const value = jsonObject(body);
  if (!value || (value.modelId !== undefined && value.modelId !== modelId))
    return { status: "unknown", reason: "unexpected-response" };
  const agreement = value.agreementAvailability;
  const agreementStatus =
    typeof agreement === "object" && agreement !== null && "status" in agreement
      ? agreement.status
      : undefined;
  if (value.regionAvailability === "NOT_AVAILABLE")
    return { status: "unsupported", reason: "region-unavailable" };
  if (
    value.entitlementAvailability === "NOT_AVAILABLE" ||
    agreementStatus === "NOT_AVAILABLE" ||
    agreementStatus === "PENDING"
  )
    return {
      status: "subscription-required",
      reason: agreementStatus === "PENDING" ? "agreement-pending" : "agreement-required",
    };
  if (value.authorizationStatus === "NOT_AUTHORIZED")
    return { status: "access-denied", reason: "model-authorization-denied" };
  if (
    value.regionAvailability === "AVAILABLE" &&
    value.entitlementAvailability === "AVAILABLE" &&
    agreementStatus === "AVAILABLE" &&
    value.authorizationStatus === "AUTHORIZED"
  )
    return { status: "available" };
  return { status: "unknown", reason: "availability-unconfirmed" };
}
function classifyFailure(status: number, body: string, runtime: boolean): ProbeOutcome {
  const value = jsonObject(body);
  const marker =
    typeof value?.__type === "string"
      ? value.__type.toLowerCase()
      : typeof value?.code === "string"
        ? value.code.toLowerCase()
        : "";
  const message = typeof value?.message === "string" ? value.message.toLowerCase() : "";
  if (
    /unrecognizedclient|invalidsignature|expiredtoken|invalidbearertoken|invalidtoken/.test(
      marker,
    ) ||
    ((status === 401 || status === 403) &&
      /security token.{0,30}(invalid|expired)|invalid.{0,15}bearer token|token.{0,20}expired/.test(
        message,
      ))
  )
    return { status: "invalid-credential", reason: "credential-rejected" };
  if (status === 429 || marker.includes("throttling"))
    return { status: "throttled", reason: "rate-limited" };
  if (status >= 500) return { status: "network-error", reason: "service-unavailable" };
  if (status === 407) return { status: "network-error", reason: "proxy-authentication" };
  if (
    (status === 400 || status === 403) &&
    /marketplace.{0,80}(subscription|subscribe)|subscription.{0,40}(required|not|missing)|agreement.{0,30}(required|not accepted)/.test(
      message,
    )
  )
    return { status: "subscription-required", reason: "subscription-required" };
  if (status === 401 || status === 403)
    return {
      status: runtime ? "access-denied" : "unknown",
      reason: runtime ? "invocation-denied" : "metadata-permission-denied",
    };
  if (status === 404 || marker.includes("resourcenotfound"))
    return { status: "unsupported", reason: "route-unavailable" };
  if (
    status === 400 &&
    /not supported in|on-demand throughput.*isn.t supported|provided model identifier is invalid/.test(
      message,
    )
  )
    return { status: "unsupported", reason: "route-unavailable" };
  return { status: "unknown", reason: status === 400 ? "request-rejected" : "unexpected-response" };
}
function networkReason(error: unknown): string {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as Record<string, unknown>;
    const code = typeof value.code === "string" ? value.code : "";
    if (code.includes("CERT") || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL"))
      return "tls";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
    current = value.cause;
  }
  return "transport";
}
