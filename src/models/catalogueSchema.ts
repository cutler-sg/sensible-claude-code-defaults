import type { ModelDefinition, ModelFamily, ModelTarget, ProcessingScope } from "./types.js";

const SCOPES = new Set<ProcessingScope>(["global", "us", "eu", "apac", "au", "jp", "regional"]);
const FAMILIES = new Set<ModelFamily>(["opus", "sonnet", "haiku"]);
const ID = /^[A-Za-z0-9._:/-]{1,200}$/;
const FOUNDATION_ID = /^anthropic\.[A-Za-z0-9._:-]{1,180}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LABEL = /^[\p{L}\p{N} .()+_-]{1,80}$/u;

export function safeModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ID.test(value) &&
    !value.split("/").some((p) => p === "." || p === "..")
  );
}

export function validateCatalogue(
  value: unknown,
  fail: (path: string, problem: string) => undefined,
): ModelDefinition[] | undefined {
  if (!Array.isArray(value) || value.length > 64)
    return fail("models", "must be an array of at most 64 models");
  const out: ModelDefinition[] = [];
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const [index, model] of value.entries()) {
    const path = `models[${index}]`;
    if (
      !record(model) ||
      typeof model.id !== "string" ||
      !FOUNDATION_ID.test(model.id) ||
      ids.has(model.id)
    ) {
      fail(path, "must have a unique Anthropic foundation-model id");
      continue;
    }
    ids.add(model.id);
    if (
      typeof model.label !== "string" ||
      !LABEL.test(model.label) ||
      !FAMILIES.has(model.family as ModelFamily)
    ) {
      fail(path, "must have a display label and supported family");
      continue;
    }
    if (!Array.isArray(model.targets) || model.targets.length === 0 || model.targets.length > 8) {
      fail(`${path}.targets`, "must have 1-8 explicit invocation targets");
      continue;
    }
    const routes: ModelTarget[] = [];
    for (const [i, target] of model.targets.entries()) {
      const p = `${path}.targets[${i}]`;
      if (
        !record(target) ||
        !safeModelId(target.id) ||
        targets.has(target.id) ||
        !SCOPES.has(target.scope as ProcessingScope)
      ) {
        fail(p, "must have a unique safe invocation id and known processing scope");
        continue;
      }
      if (
        !Array.isArray(target.sourceRegions) ||
        target.sourceRegions.length === 0 ||
        target.sourceRegions.length > 40 ||
        target.sourceRegions.some((region) => typeof region !== "string" || !REGION.test(region)) ||
        new Set(target.sourceRegions).size !== target.sourceRegions.length
      ) {
        fail(`${p}.sourceRegions`, "must have 1-40 unique AWS source regions");
        continue;
      }
      const expected = target.scope === "regional" ? model.id : `${target.scope}.${model.id}`;
      if (target.id !== expected) {
        fail(`${p}.id`, "must identify this foundation model in the declared processing scope");
        continue;
      }
      targets.add(target.id);
      routes.push({
        id: target.id,
        scope: target.scope as ProcessingScope,
        sourceRegions: [...target.sourceRegions] as string[],
      });
    }
    const entry: ModelDefinition = {
      id: model.id,
      label: model.label,
      family: model.family as ModelFamily,
      targets: routes,
    };
    if (model.rank !== undefined) {
      if (
        typeof model.rank !== "number" ||
        !Number.isInteger(model.rank) ||
        model.rank < 0 ||
        model.rank > 100_000
      )
        fail(`${path}.rank`, "must be an integer from 0 to 100000");
      else entry.rank = model.rank;
    }
    if (model.lifecycle !== undefined) {
      if (model.lifecycle !== "active" && model.lifecycle !== "deprecated")
        fail(`${path}.lifecycle`, "must be active or deprecated");
      else entry.lifecycle = model.lifecycle;
    }
    if (model.probeFormat !== undefined) {
      if (typeof model.probeFormat !== "string" || !/^[a-z0-9-]{1,64}$/.test(model.probeFormat))
        fail(`${path}.probeFormat`, "must be a bounded format identifier");
      else entry.probeFormat = model.probeFormat;
    }
    for (const field of ["releasedAt", "verifiedAt"] as const) {
      const date = model[field];
      if (date === undefined) continue;
      if (typeof date !== "string" || !DATE.test(date) || !Number.isFinite(Date.parse(date)))
        fail(`${path}.${field}`, "must be an ISO date");
      else entry[field] = date;
    }
    if (model.source !== undefined) {
      if (
        typeof model.source !== "string" ||
        model.source.length > 300 ||
        !/^https:\/\/docs\.aws\.amazon\.com\/bedrock\/[A-Za-z0-9/._#-]+$/.test(model.source)
      )
        fail(`${path}.source`, "must be an AWS Bedrock documentation URL");
      else entry.source = model.source;
    }
    out.push(entry);
  }
  return out;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
