---
name: pantheon-cli
description: Use the Pantheon CLI to launch Pantheon agents, check packaged assets, and query local telemetry/traces quickly. Load when asked about `pantheon`, Pantheon CLI help, agent launches, prior Pantheon runs, trace lookup, session-file lookup, or fastest trace proof.
---

# Pantheon CLI

Use `pantheon` before generic `langwatch` or raw file searches when the task is about Pantheon agents, local telemetry, trace lookup, or session files.

## What it can do

- `pantheon --help` — show Pantheon CLI help. Use `pi --help` for raw Pi help, or `pantheon -- --help` to explicitly forward help to Pi.
- `pantheon --agent <agent> [...pi args]` — launch Pi with the selected Pantheon agent prompt appended. Normal Pi flags are forwarded, but Pantheon owns prompt override flags.
- `pantheon init` — check packaged Pantheon assets. It does not migrate prompts or manage `APPEND_SYSTEM.md`.
- `pantheon telemetry ...` — query the local SQLite telemetry index at `~/.pantheon/telemetry.db`, populated from LangWatch and local Pi/acpx session files.

## Fast telemetry rules

- Prefer `pantheon telemetry ... --json --no-ingest` for agent-safe reads when the index is already populated.
- Run ingest once when fresh LangWatch traces may not be indexed yet:

```bash
pantheon telemetry ingest --source langwatch --since 2h --json
```

- Do not grep session directories first. Ask the index for `runs`, `trace`, `search`, or `session-file`.

## Fewest-call recipes

Find a known trace:

```bash
pantheon telemetry trace <trace_id> --json --no-ingest
```

Find a smoke-test marker or phrase:

```bash
pantheon telemetry search "<marker or phrase>" --json --no-ingest
```

List recent runs for an agent:

```bash
pantheon telemetry runs --agent <agent> --limit 5 --json --no-ingest
```

Find recent failures:

```bash
pantheon telemetry runs --agent <agent> --status error --limit 5 --json --no-ingest
```

Resolve local JSONL for a trace:

```bash
pantheon telemetry session-file <trace_id> --json --no-ingest
```

Find slow runs:

```bash
pantheon telemetry slow --role hunter --since 24h --top 5 --json --no-ingest
```

## When to use generic LangWatch CLI instead

Use `langwatch trace get/search` only when you need the live LangWatch system-of-record directly, the local telemetry DB is unavailable, or you are validating raw LangWatch API/CLI behavior itself.
