# Address PR Feedback

Address review findings on an existing PR without expanding scope.

## Input

A single PR URL, for example:

`/address-pr <https://github.com/neno-co/monorepo-core/pull/1234>`

## Process

1. Read all unresolved review comments and requested changes.
2. Implement minimal changes to satisfy feedback.
3. Run targeted tests first, then run the project validation command relevant to your changes.
4. Push updates to the same PR branch.
5. If blocked by a product/technical decision you cannot resolve, surface exactly one clear question (report status `blocked`).
6. When the feedback is addressed and pushed, report status `success`.

## Reporting the outcome

Do NOT run any `train` CLI commands (no `train handoff`/`train block`). The orchestrator records the outcome solely from the structured result you return at the end of the session:

- `success` — feedback addressed, changes pushed to the PR branch.
- `blocked` — you need a developer decision; put the single clear question in `reason`.
- `failed` — the work could not be completed; put the cause in `reason`.
