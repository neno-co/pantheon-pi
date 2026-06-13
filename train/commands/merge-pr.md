# Merge PR

Perform final pre-merge checks and merge the PR into the target feature train branch.

## Input

A single PR URL, for example:

`/merge-pr <https://github.com/neno-co/monorepo-core/pull/1234>`

## Process

1. Confirm CI is green. Note: the train branch is typically unprotected, so an empty `reviewDecision` is expected and is NOT a blocker — the human approval gate already happened before this stage.
2. Confirm PR base branch is the train branch (not main).
3. Merge using the agreed strategy (default: squash).
4. Verify merge completed successfully and branch tip moved.
5. If the PR is already merged, treat that as success.
6. Report status `success` once merged.

## Reporting the outcome

Do NOT run any `train` CLI commands (no `train handoff`/`train block`). The orchestrator records the outcome solely from the structured result you return at the end of the session:

- `success` — PR merged into the train branch (or already merged); put the merge commit/summary in `reason`.
- `blocked` — genuine approval/status ambiguity you cannot resolve; put the single clear question in `reason`.
- `failed` — the merge could not be completed; put the cause in `reason`.
