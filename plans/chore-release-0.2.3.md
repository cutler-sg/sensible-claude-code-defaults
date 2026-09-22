# Release 0.2.3

Branch: `chore/release-0.2.3`
Authorization: Michael requested merging the completed sprint and tagging a new
release on 2026-09-22. Pushing the version tag invokes the existing Marketplace
and Open VSX pre-release workflow.

Acceptance criteria:

- PRs #35, #36 and #37 are merged after current-base CI passes.
- Package version and changelog identify patch release 0.2.3.
- Dependencies, VS Code 1.98 support, model defaults and namespaces stay intact.
- Typecheck, lint, tests, packaging and VS Code 1.98.2 integration pass.
- The release PR passes CI, is registered in T3, and merges before tagging.
- Annotated tag `v0.2.3` identifies the merged release commit; the GitHub
  pre-release and publishing workflow outcomes are verified and reported.

Tasks:

- [x] Verify GitHub identity, repository state, PR checks and release workflow.
- [x] Merge #35, retarget/update #36, then update/merge #37 with green CI.
- [x] Verify combined code: 1,984 tests passed, 2 skipped; lint and typecheck
  passed; VS Code 1.98.2 extension host passed 7 tests with 1 platform skip.
- [x] Bump the patch version and document the reliability fixes.
- [ ] Validate the versioned package and release PR CI.
- [ ] Merge release metadata, push annotated tag, create GitHub pre-release,
  and verify publishing outcomes.

Platform limits: WSL2/Remote-SSH host placement and physical Keychain/DPAPI
interaction remain manual checks. The automated platform matrix is green.
