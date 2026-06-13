# Telemetry Fixture Seed Corpus

Programmatic, deterministic seed corpus that backs the telemetry proof matrix.
**This fixture set is not authoritative live proof.** It is shaped to exercise
the documented CLI contracts under a tiny in-process SQLite DB so contract
regressions surface immediately.

## Layout

- `seed-corpus.ts` — programmatic generator. `writeSeedCorpus()` writes JSONL
  session files into the caller-provided `pi-sessions/` and `acpx-sessions/`
  directories. `buildSeedCorpus()` additionally ingests into a temp DB with
  `PANTHEON_TELEMETRY_STORE_CONTENT=true` so FTS5 + sqlite-vec rows exist.
- `pi-sessions/`, `acpx-sessions/` — placeholder directories. Real fixture files
  are written on demand into a per-test temp directory by `buildSeedCorpus()`.

## §7.1 row → fixture mapping

| Row | Use case | Fixture entry |
|-----|----------|---------------|
| 1 | Fleet Latest Runs | `manifest.prometheusRuns` (6 prometheus runs to assert `--limit 5` exactness) |
| 2 | Parallel Correlation | `manifest.parallelTraces` (two concurrent sessions, distinct `correlation_id`) |
| 3 | Vulkanus Failure | `manifest.vulkanusFailureAnchorTrace` + `vulkanusFailureSimilarTraces` (semantic neighbours) + unrelated success |
| 4 | Oracle Arch Search | `manifest.oracleArchAnchorTrace` + `oracleArchSimilarTraces` + unrelated oracle |
| 5 | Mnemosyne Research | `manifest.mnemosyneAnchorTrace` + `mnemosyneSimilarTraces` |
| 6 | Argus / Hunter SLA | `manifest.argusTimeoutTrace` (synthetic ~600s, no `done`) + `manifest.hunterParallelTrace` (`hunter-test-coverage` @ 385s) + faster hunters |
| 7 | Fresh-Subagent UX | **Not covered by fixture matrix.** Covered by gated live runner `scripts/telemetry-live-eval.ts`. |

## Synthetic substitution for real trace ids

The fixture corpus uses synthetic traces that match the SHAPE of real operator
scenarios — an Argus run that ends without a `done` event and a
`hunter-test-coverage` row at ~385s — so the proof matrix can run hermetically
without shipping private telemetry recordings.

## Rebuilding from scratch

```bash
# Each test builds its own ephemeral DB from buildSeedCorpus(); there is no
# checked-in DB file. To regenerate JSONL examples by hand:
bun --eval "import { writeSeedCorpus } from './tests/telemetry/fixtures/seed-corpus.ts'; writeSeedCorpus('/tmp/pi', '/tmp/acpx');"
```

## Reports

- `reports/telemetry-proof-matrix.json` — per-use-case timings written by
  `tests/telemetry/proof-matrix.test.ts`. Marked `fixture: true,
  authoritative_live_proof: false`.
- `reports/telemetry-live-eval.json` — written only when
  `PANTHEON_TELEMETRY_LIVE_E2E=true scripts/telemetry-live-eval.ts` runs against
  real `acpx` + populated `~/.pantheon/telemetry.db`. Marked `fixture: false`.
