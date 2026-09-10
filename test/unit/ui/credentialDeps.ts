/**
 * The credential half of `CommandDeps`/`FlowDeps`, faked.
 *
 * Shared by `commands.test.ts` (which only needs the field to exist) and
 * `flows.test.ts` (which drives every part of it), so the two stay in step when
 * the shape changes.
 */

import { MemoryTokenStore } from "../../../src/credential/store.js";
import type { ConnectionResult, StoredToken, TokenEnv } from "../../../src/credential/types.js";
import type { CredentialFlowDeps } from "../../../src/ui/flows.js";

/** Records what reached the integrated-terminal collection. */
export class FakeTerminalEnv implements TokenEnv {
  applied: string[] = [];
  cleared = 0;

  apply(token: string): void {
    this.applied.push(token);
  }

  clear(): void {
    this.cleared += 1;
  }
}

/**
 * A body shaped like a real `InvokeModel` answer.
 *
 * `validate.ts` refuses to read a bare `200` as proof the key works — a captive
 * portal or an intercepting proxy answers 200 with its own page — so a fake
 * that returns `{}` models a *failure*, not a success. Anything asserting on
 * the happy path has to answer with the fields Bedrock actually sends.
 */
export const BEDROCK_OK_BODY = JSON.stringify({
  content: [{ type: "text", text: "." }],
  stop_reason: "max_tokens",
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** A `200` carrying that body, ready to hand back from a fake `fetch`. */
export function bedrockOk(): Response {
  return new Response(BEDROCK_OK_BODY, { status: 200 });
}

export interface FakeCredentialDeps extends CredentialFlowDeps {
  store: MemoryTokenStore;
  terminal: FakeTerminalEnv;
  recorded: ConnectionResult[];
  /** Requests the fake `fetch` saw, so a test can assert the token left once. */
  requests: { url: string; authorization: string }[];
  /** What the next Bedrock call answers with. */
  respond: (url: string) => Response;
}

export function fakeCredentialDeps(initial?: StoredToken): FakeCredentialDeps {
  const deps: FakeCredentialDeps = {
    store: new MemoryTokenStore(initial),
    terminal: new FakeTerminalEnv(),
    recorded: [],
    requests: [],
    respond: () => bedrockOk(),
    recordTest: (result) => {
      deps.recorded.push(result);
    },
    fetch: (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      deps.requests.push({ url, authorization: headers.get("authorization") ?? "" });
      return Promise.resolve(deps.respond(url));
    },
  };
  return deps;
}
