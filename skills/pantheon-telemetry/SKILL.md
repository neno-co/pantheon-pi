---
name: pantheon-telemetry
description: Read-only forensic index over local Pantheon session files, file-backed LangWatch exports, and the live LangWatch read API. Use when looking up prior Pantheon agent runs, reconstructing traces, resolving local JSONL session files, or searching local telemetry evidence.
---

# Pantheon Telemetry

Read-only forensic index over local Pantheon session files, file-backed LangWatch exports, and the live LangWatch read API.

## When to use

Use this skill to list prior runs for any Pantheon agent, reconstruct a trace, resolve local JSONL session files, inspect slow/error runs, or search the local evidence corpus. LangWatch ingest pulls traces from the live read API (`GET ${LANGWATCH_ENDPOINT:-https://app.langwatch.ai}/api/traces/search`) when `LANGWATCH_API_KEY` is set, and additively reads local span export files from `PANTHEON_LANGWATCH_TRACE_FILES`. Both sources upsert into the same `runs`/`spans` tables.

## Install/init contract

Normal install:

```bash
pi install /path/to/pantheon-pi
pi install git:<repo-url>
pantheon init # optional packaged asset check
```

Telemetry needs no init step: `~/.pantheon/telemetry.db` is created lazily on first `pantheon telemetry ingest` or auto-ingesting read command. `pantheon init` only checks packaged assets; it does not manage `~/.pi/agent/APPEND_SYSTEM.md`.

## Commands cheat-sheet

All commands support `--json` for agent-safe output.

| Command | Purpose |
| --- | --- |
| `pantheon telemetry ingest [--since <duration>] [--source langwatch|local]` | Incrementally ingest telemetry. `langwatch` pulls the live read API when `LANGWATCH_API_KEY` is set, and also reads file-backed exports from `PANTHEON_LANGWATCH_TRACE_FILES`. |
| `pantheon telemetry runs [--agent <name>] [--role <role>] [--status <status>] [--since <dur>] [--limit N]` | List filtered runs. |
| `pantheon telemetry slow [--agent <name>] [--role <role>] [--since <dur>] [--top N]` | Slowest runs. |
| `pantheon telemetry trace <trace_id>` | Reconstruct a trace. |
| `pantheon telemetry session-file <trace_id|--correlation-id <id>|--session-id-hash <h>>` | Resolve local JSONL paths via canonical links. |
| `pantheon telemetry search "<query>" [--agent <name>] [--role <role>]` | FTS search over already-indexed content; query-time env does not gate reads. |
| `pantheon telemetry similar <run_id|trace_id|document_id> [--top N]` | Semantic search when available. |
| `pantheon telemetry stats` | DB counts/path/cursors/quarantine count. |
| `pantheon telemetry purge <trace_id>` | Delete indexed rows for a trace. |
| `pantheon telemetry vacuum` | Optimize/vacuum local DB. |

Aliases: `pantheon telemetry vulkanus latest --json`, `pantheon telemetry oracle latest --json`, `pantheon telemetry argus latest --json`, `pantheon telemetry hunters slow --json`.

## JSON output schema

- `runs`: `{ "runs": [{ run_id, trace_id, agent_name, agent_role, status, duration_ms, started_at, output_preview }] }`
- `slow`: `{ "runs": [{ run_id, trace_id, agent_name, agent_role, duration_ms, status, started_at }] }`
- `trace`: `{ trace_id, runs, spans, session_files }`
- `session-file`: `{ "session_files": ["/absolute/path.jsonl"] }`
- `search`: `{ content_storage_enabled, message?, results: [{ document_id, run_id, trace_id, agent_name, kind, snippet }] }`
- `similar`: `{ available, message?, anchor, results }`
- `stats`: `{ db_path, exists, counts, quarantine, cursors }`

## §7.2 Fast Path (authoritative live eval)

This is the **only** allowed protocol when answering a §7.2 fresh-subagent seed
question. It exists because the live evaluation has a hard budget: **≤ 30 s
wall-clock and ≤ 3 CLI invocations per seed.** Anything else fails the budget.

**Rules — non-negotiable:**

1. Use **only** `pantheon telemetry …` subcommands for reads. Always append
   `--json --no-ingest`. `--no-ingest` skips auto-ingest; the index is assumed
   already populated by the harness before evaluation.
2. **Do not** run `pantheon telemetry stats`, `pantheon telemetry --help`,
   `pantheon telemetry ingest`, `bun run src/cli.ts`, file reads, `cat`, `ls`,
   `grep`, `ripgrep`, `rg`, or any other source-inspection or shell exploration.
   The DB is the source of truth — query it directly.
3. **Maximum 3 telemetry commands**, then answer. Plan the three queries up
   front; do not iterate speculatively.
4. **Stop immediately** once the required fields (`trace_id`, session-file
   path, slowest run, matching trace ids, etc.) appear in JSON output. Do not
   issue confirmatory or "to be safe" follow-up queries.
5. Final answer is **two short lines**: line 1 is the direct answer
   (trace_id, JSONL absolute path, agent + duration_ms, etc.); line 2 is a
   one-line summary (status, output_preview, or match snippet). Nothing else.
6. If a query returns an empty result, do not retry with the same shape —
   either broaden once with a different filter, or report "not found in
   indexed window" and stop. Do not exceed the 3-command budget chasing it.

**Generic recipes (substitute the seed-specific values; do not hardcode trace ids):**

```bash
# Recent agent failure (any agent / role / status)
pantheon telemetry runs --agent <agent> --status error --limit 1 --json --no-ingest
pantheon telemetry runs --role <role> --status error --limit 1 --json --no-ingest

# Timeout + local JSONL session file (status values are "error" / "ok" / "unknown";
# "timeout" surfaces in output_preview rather than as a status string):
pantheon telemetry runs --agent <agent> --status error --limit 5 --json --no-ingest
# pick the most recent row whose output_preview mentions timeout, then:
pantheon telemetry session-file <trace_id> --json --no-ingest

# Slow run by role/agent in a recent window
pantheon telemetry slow --role <role> --since 24h --top 1 --json --no-ingest
pantheon telemetry slow --agent <agent> --since 24h --top 1 --json --no-ingest

# Phrase / topic lookup (e.g. oracle on a concept)
pantheon telemetry search "<phrase>" --agent <agent> --json --no-ingest
# If the existing index has no stored content, use `runs` filtered by agent/role
# and rely on output_preview rather than running another search variant.
```

The §7.2 budget is met when each seed answer is produced from ≤ 3 of the
commands above and the wall-clock for that seed is ≤ 30 s.

## General recipes

```bash
pantheon telemetry runs --agent vulkanus --status error --limit 5 --json --no-ingest
pantheon telemetry session-file <trace_id> --json --no-ingest
pantheon telemetry session-file --correlation-id <correlation_id> --json --no-ingest
pantheon telemetry trace <trace_id> --json --no-ingest
pantheon telemetry slow --role hunter --since 24h --top 10 --json --no-ingest
pantheon telemetry search "canonical telemetry header" --agent oracle --json --no-ingest
PANTHEON_LANGWATCH_TRACE_FILES=/path/to/langwatch-export.json pantheon telemetry ingest --source langwatch --json
LANGWATCH_API_KEY=*** pantheon telemetry ingest --source langwatch --since 24h --json
```

## Failure modes

- Ingest lock held: query current DB and retry ingest later.
- No stored content in the existing index: `search` returns `content_storage_enabled: false` and empty results.
- Unknown id: empty arrays, no path guessing.
- Missing canonical triple: file is quarantined and not linked.
- Semantic unavailable: `similar` returns `available: false`.

## Privacy

Do not ask users to paste secrets into telemetry. Default storage keeps hashes, lengths, and short redacted previews only. Full redacted text and embeddings require `PANTHEON_TELEMETRY_STORE_CONTENT=true` during ingest; once stored, `search --no-ingest` can read the existing local index without that env var. Treat the local DB as sensitive.

## Proof evidence

Two distinct layers cover the telemetry proof matrix. **Do not conflate them.**

- **Fixture-backed contract proof** (`tests/telemetry/proof-matrix.test.ts`). Runs in `bun test`. Builds a deterministic seed corpus via `tests/telemetry/fixtures/seed-corpus.ts`, exercises each documented §7.1 use case, asserts JSON contracts and threshold-as-regression-sentinel timings, and writes `reports/telemetry-proof-matrix.json` with `fixture: true, authoritative_live_proof: false`. This is not live UX proof.
- **Gated live proof** (`scripts/telemetry-live-eval.ts`). OFF by default. Authoritative for §7.2's fresh-subagent UX bar: a fresh subagent with only this skill answers each seed question in ≤ 3 CLI invocations and ≤ 30 s wall-clock against the user's real `~/.pantheon/telemetry.db`.

Run the live evaluation:

```bash
# Ensure the DB is populated first (auto-ingest also runs on each read command).
pantheon telemetry ingest --since 30d
PANTHEON_TELEMETRY_LIVE_E2E=true bun run scripts/telemetry-live-eval.ts
# Report: reports/telemetry-live-eval.json — authoritative_live_proof: true when ran=true.
```

Exit codes: 0 = ran and met budgets, 1 = ran but at least one seed question failed, 2 = gated off (default), 3 = gate on but prerequisites missing.
