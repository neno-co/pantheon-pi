# In-App Subagents Architecture

This package makes a fleet of specialist agents available from inside a Pi session.

## Goals

1. Keep normal `pi` behavior untouched.
2. Provide an explicit `pantheon` entrypoint for in-app subagents.
3. Route delegated work through `acpx` with packaged, versioned prompts.
4. Show delegated runs in a live Subagent UI.
5. Preserve enough telemetry to debug failures and resume sessions.

## Core flow

```text
user in Pi
  -> Pantheon extension tool call (`acpx`)
  -> src/runner starts acpx with selected agent route
  -> packaged prompt/bin/manifest define the specialist identity
  -> workflow registry tracks live output, status, artifacts, session metadata
  -> Pi extension renders the Subagent widget
  -> optional LangWatch/local telemetry records the trace
```

## Package surfaces

- `src/cli.ts` — `pantheon` command that starts Pi with an appended packaged agent prompt.
- `src/extension/` — Pi extension, Subagent UI wiring, and local coding tools.
- `src/runner/` — bounded `acpx` invocation, permissions, model/session handling, and final-answer extraction.
- `src/workflow/` — run registry, rendering, artifacts, and session helpers.
- `src/langwatch/` and `src/telemetry/` — optional observability.
- `agents/` — versioned prompts, launchers, and manifest entries.
- `skills/` — minimal operational skills for Pantheon CLI, telemetry, and acpx trace validation.

## Agent identity contract

Every public specialist route should have a consistent triple:

1. `agents/prompts/<agent>.md`
2. `agents/bin/<agent>` for Pi-backed agents, or a manifest route for adapter-backed agents
3. `agents/manifests/acpx-baseline.json` entry

Tests assert this contract so package installs fail fast when prompts, launchers, or manifest entries drift.

## Validation

Use the narrowest useful command while iterating, then run:

```bash
bun run validate
npm pack --dry-run
```

Prompt/routing/manifest changes should also run the relevant evals when credentials and live agents are available.
