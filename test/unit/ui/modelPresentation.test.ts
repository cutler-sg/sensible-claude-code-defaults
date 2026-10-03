import { describe, expect, it } from "vitest";
import { countLevels } from "../../../src/health/types.js";
import type { AvailabilitySnapshot, ModelRow } from "../../../src/models/types.js";
import {
  administratorRequest,
  connectionFromModels,
  modelDiagnostics,
  modelHealth,
} from "../../../src/ui/modelPresentation.js";
import { render } from "../../../src/ui/panel/html.js";

const row = (over: Partial<ModelRow> = {}): ModelRow => ({
  modelId: "global.anthropic.claude-sonnet-5",
  label: "Sonnet 5",
  family: "sonnet",
  region: "us-east-1",
  scope: "global",
  configured: true,
  allowed: true,
  status: "available",
  stale: false,
  checkedAt: Date.parse("2026-09-30T00:00:00Z"),
  ...over,
});
const snapshot = (
  rows: ModelRow[],
  over: Partial<AvailabilitySnapshot> = {},
): AvailabilitySnapshot => ({
  rows,
  checking: false,
  credential: "valid",
  region: "us-east-1",
  ...over,
});

describe("availability presentation", () => {
  it("a working Haiku cannot hide a blocked configured Sonnet or Opus", () => {
    const result = snapshot([
      row({ family: "haiku" }),
      row({ family: "sonnet", status: "subscription-required" }),
      row({ family: "opus", status: "access-denied" }),
    ]);
    expect(modelHealth(result)).toMatchObject({
      level: "error",
      label: "Sonnet, Opus need attention",
    });
    expect(connectionFromModels(result)).toEqual({ kind: "models-unavailable", working: 1 });
  });
  it("an unselected blocked release does not degrade a working configuration", () => {
    expect(
      modelHealth(snapshot([row(), row({ configured: false, status: "subscription-required" })]))
        .level,
    ).toBe("pass");
  });
  it("stale success never reports a currently verified setup", () => {
    const result = snapshot([row({ stale: true })]);
    expect(modelHealth(result).level).toBe("info");
    expect(connectionFromModels(result).kind).toBe("models-unavailable");
  });
  it("processing policy overrides stale historical success", () => {
    expect(modelHealth(snapshot([row({ status: "out-of-scope", stale: true })])).level).toBe(
      "error",
    );
  });
  it("network failure remains inconclusive even with historic success", () => {
    expect(modelHealth(snapshot([row({ status: "network-error", lastSuccessAt: 1 })])).level).toBe(
      "warning",
    );
  });
  it("a credential rejection overrides previously working targets", () => {
    const result = snapshot([row()], { credential: "invalid" });
    expect(modelHealth(result).level).toBe("error");
    expect(connectionFromModels(result).kind).toBe("bad-credential");
  });
  it("a missing context is unknown rather than successful", () => {
    expect(modelHealth(snapshot([], { credential: "unknown" })).level).toBe("skipped");
    expect(connectionFromModels(snapshot([])).kind).toBe("models-unavailable");
  });
  it("copies a targeted administrator request with IDs, scope, reason, and date", () => {
    const text = administratorRequest(
      snapshot([row({ status: "subscription-required", reason: "entitlement-unavailable" })]),
    );
    expect(text).toContain("global.anthropic.claude-sonnet-5");
    expect(text).toContain("entitlement-unavailable");
    expect(text).toContain("2026-09-30T00:00:00.000Z");
    expect(text).not.toContain("Authorization");
  });
  it("diagnostics distinguishes stale evidence and configured targets", () => {
    expect(modelDiagnostics(snapshot([row({ stale: true })]))).toContain(
      "(configured) | global | Invocation verified · stale",
    );
  });
  it("renders a keyboard-scrollable geography matrix and escapes remote labels", () => {
    const html = render(
      {
        kind: "healthy",
        keySetAt: undefined,
        lastTestedAt: undefined,
        interruption: undefined,
        counts: countLevels([]),
        detailsOpen: false,
        models: {
          snapshot: snapshot([
            row({
              catalogueId: "first",
              label: "<script>alert(1)</script>",
              stale: true,
              preflight: { status: "available", checkedAt: 1 },
            }),
            row({
              catalogueId: "second",
              label: "<script>alert(1)</script>",
              modelId: "different-id",
            }),
          ]),
          automatic: false,
          upgrades: true,
        },
      },
      { nonce: "test", cspSource: "vscode-webview://test" },
    );
    expect(html).toContain('aria-label="Model availability by processing geography"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Stale · recheck due");
    expect(html).toContain("Enable automatic checks");
    expect(html.match(/<th scope="row">/g)).toHaveLength(2);
    expect(html).toContain("Available (metadata only)");
    expect(html).toContain("Review available upgrade");
    expect(html).not.toContain("Everything is working");
    expect(html).toContain('class="status info"');
    expect(html).not.toContain('class="status ok"');
  });
});
