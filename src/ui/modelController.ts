import { createHash } from "node:crypto";
import { getPath, readSettings } from "../config/index.js";
import type { ConnectionResult, TokenStore } from "../credential/types.js";
import type { Manifest } from "../manifest/types.js";
import { ModelAvailabilityService } from "../models/service.js";
import type { ModelFamily, ModelServiceOptions, ProcessingScope } from "../models/types.js";
import { connectionFromModels, type ModelsPanel } from "./modelPresentation.js";

export const PROCESSING_SCOPES: readonly ProcessingScope[] = [
  "global",
  "us",
  "eu",
  "apac",
  "au",
  "jp",
  "regional",
  "unknown",
];
export const MODEL_ENV = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
} as const satisfies Record<ModelFamily, string>;

export interface ModelControllerDeps extends ModelServiceOptions {
  settingsFile: string;
  tokenStore: TokenStore;
  manifest: () => Manifest;
  automatic: () => boolean;
  scopes: () => readonly string[];
}

/** Coordinates effective settings with the engine; never exports credentials. */
export class ModelController {
  readonly service: ModelAvailabilityService;
  private sequence = 0;
  private problem: string | undefined;
  private configured: Partial<Record<ModelFamily, string>> = {};
  private region: string | undefined;

  constructor(private readonly deps: ModelControllerDeps) {
    this.service = new ModelAvailabilityService(deps);
  }

  async sync(): Promise<void> {
    const sequence = ++this.sequence;
    try {
      const [stored, read] = await Promise.all([
        this.deps.tokenStore.get(),
        readSettings(this.deps.settingsFile),
      ]);
      if (sequence !== this.sequence) return;
      this.configured = {};
      this.region = undefined;
      if (read.kind === "ok") {
        for (const family of Object.keys(MODEL_ENV) as ModelFamily[]) {
          const id = getPath(read.data, `env.${MODEL_ENV[family]}`);
          if (typeof id === "string" && id.length) this.configured[family] = id;
        }
        const region = getPath(read.data, "env.AWS_REGION");
        if (typeof region === "string" && /^[a-z]{2}(-[a-z]+)+-\d+$/.test(region))
          this.region = region;
      }
      if (!stored || read.kind !== "ok") {
        this.problem =
          read.kind === "malformed" ? "Fix your settings JSON before checking models." : undefined;
        await this.service.setContext(undefined);
        return;
      }
      const mirrored = getPath(read.data, "env.AWS_BEARER_TOKEN_BEDROCK");
      if (mirrored !== stored.token) {
        this.problem = "Reconcile the saved key with your settings file before checking models.";
        await this.service.setContext(undefined);
        return;
      }
      const region = this.region;
      if (!region) {
        this.problem = "Choose a valid source region before checking models.";
        await this.service.setContext(undefined);
        return;
      }
      const manifest = this.deps.manifest();
      const selectedScopes = this.deps
        .scopes()
        .filter((scope): scope is ProcessingScope =>
          PROCESSING_SCOPES.includes(scope as ProcessingScope),
        );
      const allowedScopes = selectedScopes.length
        ? selectedScopes
        : [
            ...new Set(
              Object.values(this.configured).map(
                (id) =>
                  manifest.models
                    ?.flatMap((model) => model.targets)
                    .find((target) => target.id === id)?.scope ?? "unknown",
              ),
            ),
          ];
      const generation = createHash("sha256")
        .update(JSON.stringify([stored.token, stored.setAt]))
        .digest("hex");
      if (sequence !== this.sequence) return;
      this.problem = undefined;
      await this.service.setContext({
        token: stored.token,
        credentialGeneration: generation,
        configLocation: this.deps.settingsFile,
        region,
        configured: this.configured,
        manifest,
        allowedScopes,
      });
    } catch {
      if (sequence !== this.sequence) return;
      this.problem =
        "Model checks could not read local configuration or storage. Check diagnostics and retry.";
      await this.service.setContext(undefined);
    }
  }

  async refresh(force = false): Promise<void> {
    await this.sync();
    if (!force && !this.deps.automatic()) return;
    try {
      await this.service.refresh({ force, automatic: !force });
    } catch {
      this.problem = "Model checks could not finish. Check your connection and retry.";
      this.deps.onChange?.();
    }
  }

  async test(): Promise<ConnectionResult> {
    await this.refresh(true);
    return connectionFromModels(this.service.snapshot());
  }

  manifest(): Manifest {
    const resolved = this.service.recommendedManifest();
    if (resolved) return resolved;
    const manifest = this.deps.manifest();
    const env = { ...manifest.defaults.env };
    for (const family of Object.keys(MODEL_ENV) as ModelFamily[]) {
      const id = this.configured[family];
      if (id) env[MODEL_ENV[family]] = id;
    }
    if (this.region) env.AWS_REGION = this.region;
    return { ...manifest, defaults: { ...manifest.defaults, env } };
  }

  panel(): ModelsPanel {
    const manifest = this.manifest();
    const snapshot = this.service.snapshot();
    const problem =
      this.problem ??
      (snapshot.issue === "cache-unavailable"
        ? "Model-check storage is unavailable. Results may not survive a restart; check file access and retry."
        : snapshot.issue === "another-window-checking"
          ? "Another VS Code window is checking these models. Recheck shortly to load its results."
          : undefined);
    return {
      snapshot,
      automatic: this.deps.automatic(),
      upgrades: (Object.keys(MODEL_ENV) as ModelFamily[]).some(
        (family) =>
          this.configured[family] !== undefined &&
          manifest.defaults.env[MODEL_ENV[family]] !== this.configured[family],
      ),
      ...(problem ? { problem } : {}),
    };
  }

  invalidate(): void {
    ++this.sequence;
    void this.service.setContext(undefined);
  }

  dispose(): void {
    ++this.sequence;
    this.service.dispose();
  }
}
