/**
 * Shared contracts for the config engine (`src/config/**`).
 *
 * Invariant: nothing under `src/config/` imports `vscode`. Everything that
 * needs the editor (Memento, workspace folders, homedir) is injected.
 */

/** Dotted key into settings.json, e.g. `env.AWS_REGION`, `permissions.deny`. */
export const MANAGED_KEYS = [
  "env.CLAUDE_CODE_USE_BEDROCK",
  "env.AWS_REGION",
  "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
  "env.ANTHROPIC_DEFAULT_SONNET_MODEL",
  "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "env.AWS_BEARER_TOKEN_BEDROCK",
  "permissions.deny",
  "extraKnownMarketplaces",
  "enabledPlugins",
] as const;

export type ManagedKey = (typeof MANAGED_KEYS)[number];

/** Keys whose value is a set of elements owned individually (plan Q-E). */
export const ELEMENT_OWNED_KEYS = [
  "permissions.deny",
  "extraKnownMarketplaces",
  "enabledPlugins",
] as const satisfies readonly ManagedKey[];

export type ElementOwnedKey = (typeof ELEMENT_OWNED_KEYS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/** A settings.json document. Unknown keys are preserved verbatim. */
export type Settings = JsonObject;

/** Formatting detected on read so a write does not reformat the user's file. */
export interface FileStyle {
  /** Indent string, e.g. two spaces or a tab. Default two spaces. */
  indent: string;
  /** Whether the file ended with a newline. Default true. */
  trailingNewline: boolean;
  /**
   * Line ending the file uses. Optional so existing style literals stay valid;
   * everything that omits it is treated as `"\n"`.
   */
  eol?: "\n" | "\r\n";
}

export const DEFAULT_STYLE: FileStyle = { indent: "  ", trailingNewline: true, eol: "\n" };

export type ReadResult =
  | { kind: "absent" }
  | { kind: "ok"; data: Settings; style: FileStyle; raw: string }
  | { kind: "malformed"; raw: string; error: string };

/**
 * Last-applied snapshot: exactly what the extension last wrote, per managed
 * key. Absence of a key means "never written by us". For element-owned keys
 * the value is the subset of elements we wrote, not the whole list/map.
 */
export interface Snapshot {
  schemaVersion: 1;
  /** Opaque manifest revision that produced this snapshot, if any. */
  manifestRevision?: string;
  appliedAt?: string;
  values: Partial<Record<ManagedKey, JsonValue>>;
}

export const EMPTY_SNAPSHOT: Snapshot = { schemaVersion: 1, values: {} };

export interface SnapshotStore {
  load(): Promise<Snapshot>;
  save(snapshot: Snapshot): Promise<void>;
}

/**
 * What the extension wants each managed key to be. `undefined` means
 * "remove if we own it" (plan Q-G). Keys not present are left alone entirely.
 */
export type Desired = Partial<Record<ManagedKey, JsonValue | undefined>>;

export type ChangeKind = "add" | "update" | "remove";

export interface Change {
  key: ManagedKey;
  kind: ChangeKind;
  before: JsonValue | undefined;
  after: JsonValue | undefined;
}

/** A managed key whose current value differs from what we last wrote. */
export interface Drift {
  key: ManagedKey;
  current: JsonValue | undefined;
  lastApplied: JsonValue | undefined;
  recommended: JsonValue | undefined;
}

export interface MergeResult {
  next: Settings;
  changes: Change[];
  drift: Drift[];
  /** Snapshot values to persist if `next` is written. */
  snapshotValues: Snapshot["values"];
}

export type PlanResult =
  | { kind: "blocked"; reason: "malformed"; error: string; raw: string }
  | {
      kind: "ready";
      read: ReadResult;
      merge: MergeResult;
      style: FileStyle;
      /** True when `changes` is empty; commit becomes a no-op. */
      noop: boolean;
    };

export interface BackupInfo {
  path: string;
  createdAt: Date;
}

/** Everything the engine needs from its host. Pure data, no `vscode`. */
export interface ConfigEnv {
  /** Resolved `~/.claude` (or `$CLAUDE_CONFIG_DIR`). */
  claudeDir: string;
  /** Absolute workspace folder paths; writes inside any of them are refused. */
  workspaceFolders: readonly string[];
  snapshotStore: SnapshotStore;
  /** Injected for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  now?: () => Date;
}

export class ConfigError extends Error {
  constructor(
    public readonly code:
      | "WRITE_INSIDE_WORKSPACE"
      | "MALFORMED_SETTINGS"
      | "BACKUP_NOT_FOUND"
      | "ATOMIC_WRITE_FAILED",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ConfigError";
  }
}
