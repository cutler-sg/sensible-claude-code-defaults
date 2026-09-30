import type { ConnectionResult } from "../credential/types.js";
import type { CheckResult } from "../health/types.js";
import type { AvailabilitySnapshot, ModelRow, ModelStatus } from "../models/types.js";

export const MODEL_STATUS_LABELS: Record<ModelStatus, string> = {
  available: "Invocation verified",
  "subscription-required": "Administrator enablement needed",
  "access-denied": "Access denied",
  unsupported: "Route or probe unsupported",
  "invalid-credential": "Credential rejected",
  throttled: "Rate limited · retry later",
  "network-error": "Connection or service failure",
  unknown: "Could not verify",
  "not-checked": "Not checked",
  checking: "Checking…",
  "out-of-scope": "Excluded by processing policy",
};

export interface ModelsPanel {
  snapshot: AvailabilitySnapshot;
  automatic: boolean;
  upgrades: boolean;
  problem?: string;
}

export function modelHealth(snapshot: AvailabilitySnapshot): CheckResult {
  const configured = snapshot.rows.filter((row) => row.configured);
  const base = {
    id: "cred.valid" as const,
    group: "Credential" as const,
    fix: {
      kind: "command" as const,
      command: "sensibleDefaults.recheckModels",
      title: "Recheck models",
    },
  };
  if (configured.length === 0)
    return { ...base, level: "skipped", label: "Configured models have not been checked" };
  if (snapshot.credential === "invalid")
    return { ...base, level: "error", label: "AWS rejected this credential" };
  const blocked = configured.filter(
    (row) =>
      (row.status === "out-of-scope" || !row.stale) &&
      ["subscription-required", "access-denied", "unsupported", "out-of-scope"].includes(
        row.status,
      ),
  );
  if (blocked.length)
    return {
      ...base,
      level: "error",
      label: `${families(blocked)} ${blocked.length === 1 ? "needs" : "need"} attention`,
      detail: blocked
        .map((row) => `${row.label}: ${MODEL_STATUS_LABELS[row.status]} (${row.modelId})`)
        .join("; "),
    };
  const failed = configured.filter((row) =>
    ["network-error", "throttled", "unknown"].includes(row.status),
  );
  if (failed.length)
    return {
      ...base,
      level: "warning",
      label: `Could not verify ${families(failed)}`,
      detail: "The last check was inconclusive. Previous success does not prove current access.",
    };
  if (configured.some((row) => row.stale || row.status !== "available"))
    return {
      ...base,
      level: "info",
      label: snapshot.checking
        ? "Checking configured models…"
        : "Configured models need a fresh check",
    };
  return {
    ...base,
    level: "pass",
    label: "Configured models worked when last checked",
    detail: `Source region: ${snapshot.region ?? "unknown"}. Results describe these exact model IDs at their recorded check times.`,
  };
}

function families(rows: ModelRow[]): string {
  return [...new Set(rows.map((row) => row.family[0]?.toUpperCase() + row.family.slice(1)))].join(
    ", ",
  );
}

export function connectionFromModels(snapshot: AvailabilitySnapshot): ConnectionResult {
  if (snapshot.credential === "invalid") return { kind: "bad-credential", status: 403 };
  const configured = snapshot.rows.filter((row) => row.configured);
  if (configured.length && configured.every((row) => row.status === "available" && !row.stale)) {
    return { kind: "ok", model: configured.map((row) => row.modelId).join(", ") };
  }
  return {
    kind: "models-unavailable",
    working: configured.filter((row) => row.status === "available" && !row.stale).length,
  };
}

export function modelDiagnostics(snapshot: AvailabilitySnapshot): string {
  const lines = [
    "### Model availability",
    "",
    `Source region: ${snapshot.region ?? "not configured"}`,
    `Credential evidence: ${snapshot.credential}`,
    "",
    "| Model / profile ID | Processing scope | Result | Checked (UTC) |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of snapshot.rows) {
    lines.push(
      `| ${cell(row.modelId)}${row.configured ? " (configured)" : ""} | ${cell(row.scope)} | ${MODEL_STATUS_LABELS[row.status]}${row.stale ? " · stale" : ""} | ${row.checkedAt === undefined ? "never" : new Date(row.checkedAt).toISOString()} |`,
    );
  }
  return lines.join("\n");
}

export function administratorRequest(snapshot: AvailabilitySnapshot): string {
  const blocked = snapshot.rows.filter((row) =>
    ["subscription-required", "access-denied", "unsupported", "invalid-credential"].includes(
      row.status,
    ),
  );
  return [
    "Please review Amazon Bedrock model access for my configured credential.",
    `Source region: ${snapshot.region ?? "unknown"}`,
    "",
    ...blocked.map(
      (row) =>
        `${row.label}\nModel/profile: ${row.modelId}\nProcessing scope: ${row.scope}\nResult: ${MODEL_STATUS_LABELS[row.status]}${row.reason ? ` (${row.reason})` : ""}\nChecked: ${row.checkedAt === undefined ? "not checked" : new Date(row.checkedAt).toISOString()}${row.stale ? " (stale)" : ""}\n`,
    ),
    "No credentials are included. An access denial alone does not establish that a Marketplace subscription is missing.",
  ].join("\n");
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/[\r\n\u2028\u2029]/gu, " ");
}
