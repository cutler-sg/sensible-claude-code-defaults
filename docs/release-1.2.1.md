# Release 1.2.1

Prepared on 2026-10-22 for the stable Marketplace channel in
[PR #54](https://github.com/cutler-sg/sensible-claude-code-defaults/pull/54),
merged as `9373054` under Michael's delegation. The public presentation refresh
in [PR #55](https://github.com/cutler-sg/sensible-claude-code-defaults/pull/55),
merged as `09f12d1`, ships in the same version: it changes the README, media,
and Marketplace metadata only, so the product bundle verified below is
unchanged. Publication was scheduled for 2026-10-23 and the changelog dated
accordingly.

## Release notes

A recovered Bedrock credential now stays recovered through offline and
rate-limited model checks. The newest success or rejection determines
authentication for 24 hours within the same credential, source-region, and
configuration context. A newer rejection still wins. Historical authentication
does not establish current model access or authorize an upgrade.

Catalogue metadata updates no longer erase that historical authentication.
Model availability continues to use its existing freshness and metadata rules.
There is no evidence-store schema, public API, or VS Code support-floor change.

Two transitive development dependencies, `follow-redirects` and Vite, have been
patched to resolve the current audit findings. They are not bundled in the
extension. The previous UX review and Azure Foundry research are preserved,
with future work tracked in [the maintenance backlog](maintenance-backlog.md).

## Validation

- Frozen installation and dependency audit pass. Lint and typechecking pass.
- Unit tests: 2,094 pass, two existing skips, across 57 files. Six new regression
  cases cover recovery, transient failures, metadata changes, persistence,
  processing-policy exclusion, expiry, later rejection, and context isolation.
- Linux VS Code 1.142.0 and minimum-supported 1.98.2 extension hosts: seven pass
  and one existing Windows-only skip each, using isolated profiles.
- The actual packaged extension passed [desktop verification](verification-1.2.1/README.md):
  setup, blocked optional upgrade, preview/cancel/apply, credential recovery,
  custom-setting preservation, original backup preservation, restore, and undo.
- Stable VSCE and the packager resolved by Open VSX contain the ten expected
  files with the same entry contents. The API floor remains `^1.98.0`; no source
  maps, test harness, `node_modules`, `preview`, or `extensionKind` override is
  packaged. Open VSX resolves the same VSCE 4 package as the project.
  The final local stable archive is 106,214 bytes, SHA-256
  `ccc0ced22ca919024cd9fc706afcec2c3792c6e3edab2d8402e7d18db22d168a`.
  Archive timestamps can differ between builds; entry contents were compared.
- Independent review found and verified the catalogue-change edge case before
  completion, then found no remaining correctness blockers.
- Candidate `4032471` passed all nine hosted check entries, including the
  [platform matrix and packaging](https://github.com/cutler-sg/sensible-claude-code-defaults/actions/runs/39796996950),
  [dependency audit](https://github.com/cutler-sg/sensible-claude-code-defaults/actions/runs/39797005183),
  and [CodeQL](https://github.com/cutler-sg/sensible-claude-code-defaults/actions/runs/39797005199).
  All ten entries in the downloaded hosted VSIX match the locally validated
  package, including the desktop-tested product bundle.

The PR checks report the final pushed commit's platform matrix, dependency
audit, package, and CodeQL results. Earlier green commits do not establish that
the final release commit passed. Verify all checks before merge and again on
the merged commit before tagging.

## Remaining operational work

The repeated investigation dispatches come from the external Hadron service.
[The automation handoff](automation-handoff.md) identifies its failure modes
and acceptance criteria. Merging #54 resolves the current vulnerable graph on
main; it does not implement general incident deduplication or routing in Hadron.
Keep the daily security audit enabled.

Synthetic desktop checks do not verify live AWS entitlements, subscription
behaviour, billing, or routing. Physical Keychain/DPAPI prompts, corporate
devices, WSL/Remote-SSH placement, and screen-reader output retain the existing
[manual](manual-verification.md) and [corporate retest](corporate-device-retest.md)
limitations. Open VSX publication remains optional pending its separate
namespace/token configuration.

## Publication handoff

1. Review and merge PR #54 after all final checks pass. No other product PR is
   needed for the captured fixes; preserved research remains a future proposal.
2. Select the publication date, update the changelog's Unreleased date through
   the normal reviewed flow, and verify the exact merged release commit.
3. Follow [the release runbook](releasing.md) to create and push only the
   annotated `v1.2.1` tag. Its even minor selects stable publication. Verify the
   tag matches `package.json` before pushing; the tag triggers Marketplace
   submission.
4. Confirm the Release workflow actually published, verify version 1.2.1 and
   the stable channel in the Marketplace, then attach that workflow's exact
   VSIX to the GitHub release with the notes above.

A successful local package or green PR is preparation evidence, not a registry
submission. No tag or release was created during this preparation.
