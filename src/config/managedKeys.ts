/**
 * Dotted-key access over a `settings.json` document (FR-2.1).
 *
 * Every helper here is pure: inputs are never mutated, and the returned
 * document shares structure with its input wherever nothing changed. Key
 * insertion order is preserved for untouched keys, because the writer
 * serialises this object straight back to the user's file.
 */

import {
  ConfigError,
  ELEMENT_OWNED_KEYS,
  type ElementOwnedKey,
  type JsonObject,
  type JsonValue,
  type ManagedKey,
  type Settings,
} from "./types.js";

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isElementOwned(key: ManagedKey): key is ElementOwnedKey {
  return ELEMENT_OWNED_KEYS.some((owned) => owned === key);
}

/**
 * Managed keys are one or two segments deep (`enabledPlugins`, `env.AWS_REGION`),
 * so a single split is enough — no leaf name in the set contains a dot.
 */
function parseKey(key: ManagedKey): { parent: string | undefined; leaf: string } {
  const dot = key.indexOf(".");
  return dot === -1
    ? { parent: undefined, leaf: key }
    : { parent: key.slice(0, dot), leaf: key.slice(dot + 1) };
}

/**
 * The container a nested managed key lives in, or `undefined` when it is absent.
 * A present-but-non-object container (`"env": "prod"`) is a malformed file: we
 * refuse rather than clobbering whatever the user has there.
 */
function parentObject(settings: Settings, parent: string): JsonObject | undefined {
  const node = own(settings, parent);
  if (node === undefined) return undefined;
  if (!isJsonObject(node)) {
    throw new ConfigError(
      "MALFORMED_SETTINGS",
      `"${parent}" must be a JSON object in settings.json, found ${describe(node)}.`,
    );
  }
  return node;
}

function describe(value: JsonValue): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/**
 * Own properties only. A key segment is data from the user's file, and
 * `Object.prototype` answers to `toString`, `constructor` and `__proto__` —
 * reading through the chain would report a function as the value there.
 */
function own(node: JsonObject, name: string): JsonValue | undefined {
  return Object.hasOwn(node, name) ? node[name] : undefined;
}

function omit(node: JsonObject, leaf: string): JsonObject {
  return Object.fromEntries(Object.entries(node).filter(([name]) => name !== leaf));
}

export function getPath(settings: Settings, key: ManagedKey): JsonValue | undefined {
  const { parent, leaf } = parseKey(key);
  if (parent === undefined) return own(settings, leaf);
  const node = parentObject(settings, parent);
  return node === undefined ? undefined : own(node, leaf);
}

/**
 * Returns a new document with `key` set; creates the parent container if absent.
 *
 * The computed keys below *define* properties rather than assigning them, so a
 * leaf named `__proto__` becomes an own key instead of reassigning a prototype
 * and disappearing from the serialised file.
 */
export function setPath(settings: Settings, key: ManagedKey, value: JsonValue): Settings {
  const { parent, leaf } = parseKey(key);
  if (parent === undefined) return { ...settings, [leaf]: value };
  const node = parentObject(settings, parent) ?? {};
  return { ...settings, [parent]: { ...node, [leaf]: value } };
}

/**
 * Returns a new document without `key`. The parent container is never removed:
 * deleting the last entry we own leaves `"env": {}` rather than reshaping a part
 * of the file we do not own.
 */
export function deletePath(settings: Settings, key: ManagedKey): Settings {
  const { parent, leaf } = parseKey(key);
  if (parent === undefined) {
    return Object.hasOwn(settings, leaf) ? omit(settings, leaf) : settings;
  }
  const node = parentObject(settings, parent);
  if (node === undefined || !Object.hasOwn(node, leaf)) return settings;
  return { ...settings, [parent]: omit(node, leaf) };
}
