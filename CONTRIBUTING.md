# Contributing

Thanks for looking. A few things worth knowing before you open a pull request.

## Ground rules

`CLAUDE.md` at the repo root lists the hard rules. The ones that matter most:

1. Never write inside a workspace folder. User profile only.
2. Every write to `settings.json` is temp-file-then-rename, mode 0600.
3. Never overwrite a managed key whose value differs from the last snapshot.
4. The Bedrock key never appears in a log, an error, or a diagnostics report.

A change that violates any of these will not be merged, however good the rest
of it is.

## Setup

```sh
bun install
bun audit
bun run lint && bun run typecheck && bun run test
xvfb-run -a bun run test:integration   # Linux; bare on macOS and Windows
```

## Tests

The `diff` and `serialize-javascript` overrides keep the Mocha 11 dependency
inside `@vscode/test-cli` off vulnerable releases. They also satisfy our direct
Mocha 12 dependency. Remove them when the test CLI accepts patched versions;
verify both stable VS Code and the 1.98.2 API floor when changing this runner.

The `@vscode/vsce` override makes Open VSX use the same VSCE 4 packager as the
Marketplace CLI. Open VSX's older VSCE 3 dependency brings in vulnerable
`braces` and `fast-uri` packages. Its `createVSIX` API remains compatible with
VSCE 4; verify that API without publishing when changing this override. Keep
both brace-expansion release lines patched in the lockfile: minimatch 9 requires
2.x, while minimatch 10 requires 5.x.

Write the test with the code, not after. For anything security-relevant,
mutate your own implementation and confirm the test fails. Several tests in
this repo's history sat at full coverage and could not fail for the reason
they existed; the review notes in `plans/` record each one.

## Pull requests

- Conventional commit messages (`feat:`, `fix:`, `test:`, `docs:`, `chore:`),
  with a body that explains the decision rather than restating the diff.
- One concern per PR.
- CI runs on Linux, macOS, and Windows, plus a Linux leg with no keyring. All
  four must be green.

## Reporting a security problem

See `SECURITY.md`. Please do not open a public issue for anything involving
the credential.
