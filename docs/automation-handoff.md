# Duplicate investigation dispatches

Investigated 2026-10-22. The active dispatcher is the external `cotdp/hadron`
repository, running as `hadron.service` from `/home/mcutler/workspaces/hadron`.
This extension's workflows run checks only; they do not dispatch repair agents.
No active routing fix is claimed by this document.

## Confirmed causes

In Hadron's `src/engine/repository-work.ts`:

- Work is keyed by `workflow-run:<run id>` near line 217, so daily failures on
  the same graph become distinct investigations. Runs `39565962529` and
  `39744213097` both audited main commit `858f54b`.
- `prompt()` near line 345 prohibits dependency changes in its
  reliability/compatibility brief, although this signal requires a dependency
  patch.
- `reconcile()` and `repairOrPark()` near lines 464–493 retry every blocked
  result twice with generic alternative hypotheses. Those retries cannot
  overcome a scope/authority restriction.
- Queue deduplication considers active Hadron tasks, without associating the
  existing repair PR #54 with subsequent daily audit failures.

The current `src/engine/verification/types.ts` profile schema has no
project-scoped workflow exclusion, prompt override, or independent investigation
switch. `maintenance: false` would disable useful dependency maintenance;
Hadron's pause control is global. T3 has no scheduled tasks for this project.
Keep the daily dependency audit enabled.

## Required external change

1. Park structured scope/authority blockers immediately. Reserve bounded retries
   for actionable investigation failures.
2. Correlate unresolved incidents across workflow runs and retain all evidence
   and repair history. Include failure/advisory identity: commit SHA alone
   cannot distinguish newly disclosed vulnerabilities in an unchanged graph.
3. Associate a verified covering repair PR with the incident, suppressing
   redundant investigations while it remains open. A matching title alone is
   insufficient evidence of coverage.
4. Route dependency-audit findings through the existing dependency-maintenance
   scope and verification controls; do not broadly loosen compatibility tasks.
5. Test terminal blockers, repeated runs, existing repair PRs, new advisories,
   and a new failure after a recovered incident.

This requires a Hadron code change, its own review, and service rollout. It
cannot be safely implemented by changing this extension's audit workflow or
by disabling security checks. Merging #54 removes the current vulnerable graph
from main but does not repair the general dispatcher defect.
