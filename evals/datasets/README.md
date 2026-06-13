# Eval datasets

Datasets are JSON files consumed by `bun run eval`.

Each file contains:

- `name`: dataset name
- `description`: optional context
- `cases`: eval cases

Each case contains:

- `id`: stable case identifier
- `targetAgent`: agent name to evaluate
- `inputPrompt`: prompt sent to the live agent through acpx
- `expectedOutputCharacteristics`: local assertions
  - `requiredSubstrings`
  - `forbiddenSubstrings`
  - `requiredRegex`
  - `caseSensitive`
  - `minScore`

`bun run eval` is live-only by default: it invokes real Pantheon agents through acpx and fails the case if invocation fails. Dataset mocks/fixtures must not be used as validation or release evidence.

For deterministic local harness tests only, use explicit fixture mode (`bun run eval:fixtures` or `PANTHEON_EVAL_MODE=fixtures`) with cases that contain `fixtureOutput`. By default, fixture mode reads `evals/fixtures`; override with `PANTHEON_EVAL_DATASET_DIR` only for local harness checks. Fixture mode is non-authoritative and must not be cited as an eval pass for release validation.

Set `PANTHEON_EVAL_RESULTS=path/to/results.json` to write structured results for future LangWatch/AHE reporting.

For bounded targeted evidence, set `PANTHEON_EVAL_DATASET_FILE` to one dataset JSON file. For example, run the live Argus guardrail eval without the full agent smoke suite:

```bash
PANTHEON_EVAL_DATASET_FILE=evals/datasets/argus-guardrails.json \
PANTHEON_EVAL_RESULTS=reports/evals/argus-guardrails.json \
bun run eval
```

Full hunter-swarm evidence is intentionally exercised through the sandbox workflow so Argus can create `.argus` artifacts and run source mutation guards without touching the active worktree:

```bash
PANTHEON_ARGUS_SANDBOX_RESULTS=reports/evals/argus-sandbox-live.json \
bun run evals/scripts/run-argus-sandbox-eval.ts
```
