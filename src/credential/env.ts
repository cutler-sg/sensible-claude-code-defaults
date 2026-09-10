/**
 * Terminal injection (FR-4.3).
 *
 * `environmentVariableCollection` reaches integrated terminals only — the
 * Claude Code panel inherits the extension host's environment instead, which is
 * what `writeThrough.ts` is for. Both paths exist; neither replaces the other.
 */

import { BEDROCK_ENV_VAR, type EnvCollectionLike, TOKEN_ENV_VAR } from "./types.js";

/**
 * §10.4 assertion #4 as a runtime invariant, not a convention.
 *
 * A persistent collection is cached to disk by VS Code so it can be applied
 * before the extension activates — which puts the token back in plaintext on
 * disk, the exact thing keychain storage exists to avoid. If we cannot turn
 * that off we must not put the token in the collection at all, so construction
 * fails loudly rather than the caller getting a silently unsafe object.
 */
export class TerminalTokenEnv {
  readonly #collection: EnvCollectionLike;

  constructor(collection: EnvCollectionLike) {
    collection.persistent = false;
    if (collection.persistent !== false) {
      throw new Error(
        "The terminal environment collection stayed persistent, which would cache the API key to disk. Refusing to use it.",
      );
    }
    this.#collection = collection;
  }

  apply(token: string): void {
    this.#collection.replace(TOKEN_ENV_VAR, token);
    this.#collection.replace(BEDROCK_ENV_VAR, "1");
  }

  /**
   * Deletes both variables, `CLAUDE_CODE_USE_BEDROCK` included: without a token
   * it points Claude Code at Bedrock with nothing to authenticate with, which
   * fails more confusingly than not being pointed there at all. The settings
   * file keeps its own copy — clearing the terminal collection is not a config
   * change (see `syncTokenToSettings`).
   */
  clear(): void {
    this.#collection.delete(TOKEN_ENV_VAR);
    this.#collection.delete(BEDROCK_ENV_VAR);
  }
}
