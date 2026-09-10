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
  /** The stamped results, so a test can assert which key a result speaks for. */
  recordedAt: { tokenSetAt?: string; result: ConnectionResult }[];
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
    recordedAt: [],
    requests: [],
    respond: () => bedrockOk(),
    recordTest: (result, tokenSetAt) => {
      deps.recorded.push(result);
      deps.recordedAt.push({ result, ...(tokenSetAt === undefined ? {} : { tokenSetAt }) });
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

/**
 * The shortest run of a secret worth reporting (F11).
 *
 * Four, not six. Six was the brief, but the disclosure that slipped past the
 * old whole-value assertions was `` `…${token.slice(-4)}` `` — a four-character
 * run, which no six-character rule can see. Four is also what the token
 * alphabet allows: these are base64-ish, so a four-character window is ~24 bits
 * and does not collide with anything the panel prints on its own (asserted
 * below by running it over a real report). Three would start matching ordinary
 * English inside a base64 key.
 */
export const MIN_LEAK_RUN = 4;

/** Every contiguous `MIN_LEAK_RUN`-character window of `secret`. */
function runsOf(secret: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + MIN_LEAK_RUN <= secret.length; i += 1) {
    out.push(secret.slice(i, i + MIN_LEAK_RUN));
  }
  return out;
}

/**
 * Hard rule 4 as an assertion: no fragment of any `secret` appears in any of
 * `strings`.
 *
 * The failure names the offset of the run that escaped and never the run
 * itself — a test that printed the token on failure would put it in CI logs,
 * which is the thing being prevented.
 */
export function expectNoTokenLeak(strings: readonly string[], secrets: readonly string[]): void {
  for (const secret of secrets) {
    const runs = runsOf(secret);
    for (const text of strings) {
      const index = runs.findIndex((run) => text.includes(run));
      if (index >= 0) {
        throw new Error(
          `A ${MIN_LEAK_RUN}-character run of a token, at offset ${index}, reached a rendered string.`,
        );
      }
    }
  }
}
