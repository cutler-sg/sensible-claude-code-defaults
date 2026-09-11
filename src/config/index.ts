/**
 * Public surface of the config engine.
 *
 * The extension host imports from here and nowhere deeper, so the `vscode`-free
 * invariant has exactly one boundary to hold.
 */

export type {
  ApplySession,
  CommitMeta,
  CommitResult,
  ReadyPlan,
} from "./apply.js";
export {
  commit,
  createSession,
  plan,
  repairPermissions,
  resetKeyPlan,
  restore,
} from "./apply.js";
export {
  deletePath,
  getPath,
  isElementOwned,
  isJsonObject,
  REDACTED,
  redactChanges,
  redactDrift,
  SECRET_KEYS,
  setPath,
} from "./managedKeys.js";
export { merge } from "./merge.js";
export {
  assertOutsideWorkspace,
  backupsDir,
  resolveClaudeDir,
  settingsPath,
  snapshotPath,
  stateDir,
} from "./paths.js";
export { readSettings, serialize } from "./reader.js";
export type { SnapshotMemento, SnapshotStoreOptions } from "./snapshot.js";
export {
  createMementoSnapshotStore,
  FileSnapshotStore,
  MEMENTO_SNAPSHOT_KEY,
  MemorySnapshotStore,
} from "./snapshot.js";
export type {
  BackupInfo,
  Change,
  ChangeKind,
  ConfigEnv,
  Desired,
  Drift,
  ElementOwnedKey,
  FileStyle,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ManagedKey,
  MergeResult,
  PlanResult,
  ReadResult,
  Settings,
  Snapshot,
  SnapshotStore,
} from "./types.js";
export {
  ConfigError,
  DEFAULT_STYLE,
  ELEMENT_OWNED_KEYS,
  EMPTY_SNAPSHOT,
  MANAGED_KEYS,
} from "./types.js";
export type { AclOutcome, CommandRunner, WindowsAclDeps } from "./windowsAcl.js";
export {
  AUTHENTICATED_USERS,
  BROAD_PRINCIPALS,
  BUILTIN_USERS,
  EVERYONE,
  ensureWindowsAcl,
  parseDacl,
} from "./windowsAcl.js";
export type { ModeRepair, WriteOptions } from "./writer.js";
export {
  backupSettings,
  ensurePrivate,
  listBackups,
  pruneBackups,
  restoreBackup,
  writeRawAtomic,
  writeSettingsAtomic,
} from "./writer.js";
