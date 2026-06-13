# Review PR

Review a pull request thoroughly and independently.

## Input

A single PR URL, for example:

`/review-pr <https://github.com/neno-co/monorepo-core/pull/1234>`

## Process

1. Read the PR description, changed files, and comments.
2. Verify behavior, regressions, and missing tests.
3. Prioritize findings by severity (critical, major, minor).
4. If blocked by missing context that prevents a complete review, surface exactly one clear question (report status `blocked`).
5. Otherwise post your review and report status `success`.

## Output format

- Findings first (ordered by severity, with file references).
- Open questions/assumptions.
- Brief summary.

## Reporting the outcome

Do NOT run any `train` CLI commands (no `train handoff`/`train block`). The orchestrator records the outcome solely from the structured result you return at the end of the session:

- `success` — review complete and findings posted.
- `blocked` — you need a developer decision; put the single clear question in `reason`.
- `failed` — the review could not be completed; put the cause in `reason`.
