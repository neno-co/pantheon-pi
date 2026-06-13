---
name: langwatch-acpx
description: Validate LangWatch observability and child-span creation for acpx sessions in Pantheon. Use this skill to inspect traces, ensure proper span tree generation (pantheon.acpx.run, pantheon.acpx.event.*), and debug metrics or noisy JSON CLI outputs.
---

# LangWatch acpx Validation Skill

This skill documents the precise workflow for validating `acpx` child-span observability in Pantheon using the `langwatch` CLI.

## Key Concepts for Validation

When validating acpx observability, note that top-level metadata alone is not enough. The proof of observability is the presence of the trace, its spans, and the `spans[].params.pantheon` metadata.

- **Proof of Observability:** The trace contains a parent `pantheon.acpx.run` span and child event spans (when transcript events exist).
- **Span Names:** Look for `pantheon.acpx.run`, `pantheon.acpx.event.client`, `pantheon.acpx.event.done`, and other `pantheon.acpx.event.*` spans.
- **Success vs. Failure:**
  - *Success traces* should have a parent `pantheon.acpx.run` span along with child event spans.
  - *Early validation failures* may only have the `pantheon.acpx.run` span (with error metadata) and no child event spans.
- **Metrics Limitation:** Tool spans might have `metrics: null`. Token or cost metrics are not necessarily proof of this specific observability feature.

## Useful Fields to Inspect

Under `spans[].params.pantheon`, you should verify:
- `agent`, `run_type`, `trace_id`, `parent_span_id`
- `session_id` (hashed), `turn_id`, `correlation_id`
- `run.success`, `run.duration_ms`
- `timeout` / `abort` flags, `exit_code`, `error.message`
- `permissions`, `timeout_seconds`
- Prompt/stdout/stderr/final_answer/transcript lengths and hashes.

*Real trace IDs for reference:*
- Success: `f7b464981fa0a0854ebb1dca650e406a`
- Failure: `63832278d5282f7d4420b7250deb887a`

## CLI Workflow & Parsing Strategy

The LangWatch CLI might emit noisy prelude lines (e.g., `◇ injected env...`) when fetching traces as JSON.
Do **not** pipe directly to parsing tools (like `jq`) because the CLI might throw `EPIPE` when the pipe closes. Instead, write the output to a temporary file and parse from the first `{`.

### Recommended Commands

1. **Fetch the trace:**
   Use `npx -y langwatch` if it's not globally installed.
   ```bash
   npx -y langwatch trace get <trace_id> -f json > /tmp/trace.json
   ```

2. **Clean and parse the output:**
   Extract everything from the first `{` to standard out, then save or pipe to `jq`.
   ```bash
   sed -n '/^{/,$p' /tmp/trace.json > /tmp/clean_trace.json
   ```

3. **Inspect the spans:**
   ```bash
   jq '.spans[] | {name: .name, pantheon: .params.pantheon}' /tmp/clean_trace.json
   ```

## Limitations and Nuances

- **Missing Child Spans:** Do not expect child spans if an early validation failure aborts the run before events are emitted.
- **Piping:** Avoid `npx -y langwatch trace get <id> -f json | jq` due to potential `EPIPE` exceptions.
