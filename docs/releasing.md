# Marketplace release runbook

The publisher is `cutler-sg`. Releases publish through Entra workload identity
federation in the `marketplace-publish` environment.
Pushing a `v*` tag starts `.github/workflows/release.yml`; merging a version
bump alone does not publish anything.

## Channel: the minor version decides it

This follows VS Code's convention. An **even** minor (`0.2.x`, `1.0.x`) publishes
a stable release. An **odd** minor (`0.3.x`, `1.1.x`) publishes to the
pre-release channel. The Release workflow reads the channel from the tag and
fails if the tag and `package.json` disagree.

- A published version can never change channel. To promote a pre-release, publish
  a higher even-minor version.
- VS Code installs the highest version available, so a pre-release numbered above
  the latest stable reaches only users who opted in. The next stable release
  must be numbered above it.
- Stable users auto-update to anything published on an even minor. Complete the
  manual checks you depend on before tagging one.

## Prepare and validate

1. Pull main with `git pull --ff-only`, then create a release branch.
2. Update `package.json` and `CHANGELOG.md` for the intended version. Pick the
   minor for the channel you want (see above).
   Keep `@types/vscode ~1.98.0` while supporting VS Code 1.98.
3. Run `bun install --frozen-lockfile`, `bun audit`, `bun run lint`,
   `bun run typecheck`, `bun run test`, and `bun run package`.
4. Run the extension-host suite on stable VS Code and the API floor:
   `bun run test:integration` and
   `bun run test:integration --code-version 1.98.2`. Linux needs a display:
   use `DISPLAY=:99` on the shared development desktop or `xvfb-run -a` in CI.
   The test config creates isolated user-data and Claude directories and uses
   `.vscode-test/extensions`, never the developer's extension directory.
5. Inspect the VSIX: correct publisher/version, bundled defaults and activity
   icon present, no source maps or `node_modules`, and no `extensionKind` override.
6. Open a PR and wait for all platform jobs, dependency audit, packaging, and
   CodeQL. Review any security findings before merging. Record evidence in the
   branch plan and PR, including manual verification that remains outstanding.

## Publish the merged commit

After release publication is requested, pull main and verify the merged commit
has green CI. Check that `package.json`, the changelog, and the proposed tag agree.
Create an annotated tag for that commit and push only that tag:

```sh
git tag -a v<VERSION> -m "Release v<VERSION>"
git push origin v<VERSION>
```

Watch the Release workflow to completion. Confirm the Marketplace publish step
actually ran, and that the *Resolve release channel* notice names the channel
you intended. A green workflow with skipped publishing is not a release. Fetch
the workflow's `vsix` artifact and attach it to a GitHub release with the
release notes; mark it as a pre-release only for odd-minor versions. Verify the published Marketplace version using the registry API;
search indexing and client auto-updates may lag the direct listing.

Open VSX publishing is conditional on `OVSX_PAT`; namespace/token setup is still
pending. A skipped Open VSX step is expected until that setup is completed.

## Validation boundaries and recovery

Automated platform tests do not replace physical Keychain/DPAPI prompts,
WSL2/Remote-SSH host placement, or corporate-network checks. Record those in
`manual-verification.md` and `corporate-device-retest.md`; do not infer a pass
from CI.

For a regression, prepare a corrective patch through the same PR and validation
flow. Publish a higher version; deleting a git tag does not roll back installed
Marketplace extensions. A known-good VSIX from GitHub Releases is available for
manual recovery while the patch is prepared.
