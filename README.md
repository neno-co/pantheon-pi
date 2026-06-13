# In-App Subagents for Pi

**Pantheon turns your Pi session into an observable multi-agent harness: one primary agent that delegates to a fleet of 26 specialists by name, routes "done" to independent reviewers, and records every run so you can search, verify, and improve the loop.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-000000.svg)](https://bun.sh)
[![Built on Pi](https://img.shields.io/badge/built%20on-Pi-5b21b6.svg)](https://github.com/earendil-works)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6.svg)](https://www.typescriptlang.org/)

Most coding agents are a single tool loop: one model, one context, calling tools until it stops — and the same agent that did the work declares it done. Pantheon composes more. A primary agent plans and builds, delegates bounded work to a fleet of specialists by name over `acpx`, routes verification to **independent** reviewers, traces every run, and **resumes instead of restarting** when a run stalls.

It's an installable Pi **package**, not a replacement and not a wrapper. `pantheon` launches your existing Pi binary with a Pantheon agent as the default primary, registers the delegation tool and a live Subagent UI, bundles a persistent `/goal` loop, and adds optional telemetry. Plain `pi` stays vanilla.

## 30-second start

Requirements: [Bun](https://bun.sh), an existing [Pi](https://github.com/earendil-works) install, and `acpx` on your `PATH`.

```bash
git clone https://github.com/neno-co/pantheon-pi && cd pantheon-pi
bun install        # fetch dependencies
pi install .       # register the extension, skills, and fleet in Pi
bun link           # put the `pantheon` launcher on your PATH
pantheon           # launch Pi with Athena as the default primary
```

That launches Pi with Athena as the default primary. Inside the session, just ask for a specialist — the primary delegates for you:

```text
Ask oracle for architecture tradeoffs before I change this API.
Have codebase-analyzer explain the routing flow.
Run argus review on my current diff.
```

Or hand it a whole objective and let it run:

```text
/goal "Add rate limiting to the upload endpoint, with tests, and pass an argus review."
```

## Watch the fleet work, live

A passive **Subagent widget** renders every delegated run inline in your terminal — active / queued / done / failed, final answers, artifacts, and resumable session info. Press `ctrl+0` (or run `/acpx-monitor`) to open the full Agent Explorer overlay.

<!-- DEMO: drop a real terminal recording here -->
<!-- ![Pantheon Subagent widget — delegated runs streaming live in the Pi terminal](docs/subagent-widget.gif) -->
*(Replace the placeholder above with a terminal GIF of the Subagent widget in action.)*

```text
┌─ Subagents ───────────────────────────────────────────────┐
│ ● oracle      done    api-redesign-oracle-review           │
│   └ "Prefer a token-bucket per workspace; see tradeoffs…"  │
│ ◐ vulkanus    active  upload-limit-vulkanus-impl           │
│   └ editing src/api/upload.ts … 3 tools, 41s               │
│ ⚠ argus       paused  upload-limit-argus-review  (resume)  │
│   └ turn limit reached — resume: acpx argus session …      │
│ ○ dike        queued  upload-limit-dike-grade              │
└────────────────────────────────────────────────────────────┘
```

## The fleet — 26 specialists

One primary agent, many focused experts. The package ships **26 specialist agents** — each a versioned prompt plus a packaged launcher under `agents/`, wired into `acpx` routing — and the primary delegates to them by name.

| Group | Agents | Role |
| --- | --- | --- |
| **Orchestration / build** | `athena` (default primary), `zeus`, `vulkanus`, `frontend-engineer` | Build, implement, and coordinate work |
| **Planning / architecture** | `prometheus`, `oracle` | Plan the work; advise on architecture tradeoffs |
| **Independent evaluation** | `dike` (Done-Contract grading), `argus` (adversarial review), `meta-reviewer` (telemetry-backed after-action) | Grade "done" — independently of who built it |
| **Hunters** | `hunter-security`, `hunter-silent-failure`, `hunter-type-design`, `hunter-test-coverage`, `hunter-comments`, `hunter-code-review`, `hunter-simplifier` | Targeted code-quality and risk sweeps |
| **Research / codebase** | `mnemosyne`, `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `explore`, `thoughts-locator`, `thoughts-analyzer`, `librarian` | Find, read, and explain code and notes |
| **Docs / language** | `document-writer`, `translator` | Write documentation; translate |

## The right model for each role

Pantheon is multi-provider on purpose. Judgment-heavy work runs on stronger, costlier models; fast lookups run on cheap, fast ones. You route each task to the model that fits it, not one model for everything.

| Role | Model |
| --- | --- |
| Architecture & evaluation — `oracle`, `dike`, `argus`, `meta-reviewer` | Claude Opus 4.8 |
| Primary builder — `athena`, `zeus` | OpenAI Codex / gpt-5.5 |
| Frontend & hunters | Gemini 3.1 Pro |
| Analysis & exploration | Claude Sonnet 4.6 |
| Docs — `document-writer` | Claude Sonnet 4.5 |
| Cheap, fast lookups — `codebase-locator`, `codebase-pattern-finder`, `thoughts-locator` | Gemini 3 Flash |

Full routing — including a few planning and memory roles that run on other Claude Opus tiers — lives in `agents/manifests/acpx-baseline.json`.

## Delegation transport: acpx

The extension registers an **`acpx`** tool that the primary agent calls to delegate to any fleet agent over the ACP protocol. Under the hood that's:

```text
acpx <agent> session "<prompt>"   # named, resumable run (default)
acpx <agent> exec "<prompt>"      # one-shot, stateless lookup
```

- **Session-first and resumable.** Default `runType=session`, named sessions, 24h TTL — resume, don't restart. A run that hits its turn limit surfaces as a resumable "needs attention" pause with explicit resume instructions, not a hard failure. (This redesign is the payoff in [the 34% story](#the-payoff-the-34-story) below.)
- **Slash commands.** `/acpx` shows the acpx path and usage; `/acpx-monitor` (also `ctrl+0`) opens the Agent Explorer overlay.
- **Bundled runtime tools** added to the Pi session: `code_exec` (bounded shell confined to the workspace), `hashline` (hash-safe edits that refuse to apply on stale content), `structural_search` (ast-grep structural search/rewrite), LSP tools via `pi-lsp`, and best-effort post-write diagnostics for JS/TS, Deno, Rust, and Elixir.

## Persistent goals, graded by someone else

Pantheon bundles the open-source **[pi-goal](https://www.npmjs.com/package/pi-goal) extension (by michaelliv, MIT)**, so `/goal "<objective>"` ships in the box. It's a persistent, budget-aware, resumable objective loop: it keeps the primary agent working across turns until the objective is complete, paused, or a token budget is reached, and it survives reloads (it force-pauses on reload and never silently resumes).

On its own, pi-goal runs a **single-agent** loop with a self-completion-audit. The Pantheon difference is a **composition** — the **Separate-Evaluator-Implementer (SEI)** loop:

> The agent driving the goal (`athena`) routes verification to **independent** evaluators via `acpx`. A mandatory `argus` adversarial review must pass before long-term work lands, and `dike` grades the result against a frozen Done-Contract — **PASS / FAIL / UNVERIFIED**, demanding executed proof and refusing to grade unwritten criteria.

So "done" is graded by a different agent on a different model than the one that wrote the code — not self-declared.

## Trace-native observability

Every session and delegated run emits **OpenTelemetry** spans, with optional **LangWatch** export. The trace tree connects the main session to its delegated runs:

```text
pantheon.pi.main
└─ pantheon.pi.turn
   └─ pantheon.pi.tool.*
      └─ pantheon.acpx.run        (one per delegated agent run)
```

Every failed delegated run is classified into a **7-class failure taxonomy** on a `pantheon.failure.class` attribute: `max_turns`, `timeout`, `auth`, `set_model_rejected`, `rate_limit`, `aborted`, `other`. This taxonomy is what made the causes diagnosable below.

### Local telemetry index — a queryable experience substrate

A zero-daemon SQLite database at `~/.pantheon/telemetry.db` ingests traces and session files and supports both **full-text search (FTS5)** and **semantic / vector similarity search**. Query your agents' history from the CLI:

```bash
pantheon telemetry slow                       # slowest / failed runs first
pantheon telemetry similar "rate limit retry" # find past runs by meaning
```

Full command set: `pantheon telemetry <runs|slow|trace|session-file|search|similar|stats|ingest|purge|vacuum>`.

## The payoff: the 34% story

Observability isn't decoration — it changed the design. Measured on our **own delegated-run telemetry corpus**, roughly **34% of delegated wall-clock was being lost to failed or timed-out runs.** The local telemetry index surfaced it; the 7-class failure taxonomy in the traces exposed the causes (turn limits, timeouts, session/model issues); the fix was the **session-first, resume-not-restart** redesign now built into `acpx` — a run that hits its turn limit pauses as a resumable "needs attention" handoff instead of dying.

Observe → diagnose → fix. The harness that records the loop is the same one that let us improve it. (This is a measurement of our own runs, not a universal benchmark.)

## How it fits — vs a single tool loop

Pantheon keeps your plain Pi session and wraps three things around it: a fleet you can route to, independent evaluators that grade the result, and a trace + telemetry record of every run. The point isn't more agents — it's the right specialist per task, an outside check on "done," and a loop you can actually inspect and improve.

## Commands

```bash
pantheon                 # launch Pi with Athena as the default primary agent
pantheon --agent oracle  # launch with a specific packaged agent prompt
pantheon init            # verify packaged assets; does not mutate global Pi config
pantheon telemetry ...   # query the local telemetry index (see above)

bun run build            # package/resource sanity check
bun run check:install    # install-layout smoke check
bun run test             # bun test suite (26 test files)
bun run validate         # build + install check + biome lint + bun test
bun run eval             # live acpx evals, when credentials/tools are configured
```

## Configuration

Zero-config for local use when Pi and `acpx` are already installed. Optional environment variables:

- `PANTHEON_ACPX_BIN` — custom `acpx` binary path.
- `PANTHEON_REQUIRE_ACPX=true` — fail install checks when `acpx` is unavailable.
- `LANGWATCH_API_KEY` — enable hosted LangWatch trace export.
- `LANGWATCH_ENDPOINT` — custom LangWatch endpoint.
- `PANTHEON_PI_BIN` — override the Pi binary that `pantheon` (and `bun run test:e2e`) launches; defaults to `pi` on your `PATH`.

For local LangWatch development, copy `.env.langwatch.local.example` to `.env.langwatch.local` (gitignored).

## Package boundary

Pantheon is a Pi **package/extension** — it does not replace Pi. It keeps a strict, in-sync package contract: `package.json` (`files` / `pi.extensions` / `pi.skills`), the agent prompts and launchers under `agents/`, and the acpx manifest. Tests assert this contract so installs fail fast when prompts, launchers, or manifest entries drift.

Internal project-management data, generated reports, private research notes, and unrelated skills are not part of the public package.

## Development

```bash
bun install
bun run hooks:install
bun run validate
npm pack --dry-run
```

Quality bars are real: `bun run validate` runs build + install-check + Biome lint + `bun test` across 26 test files, and `bun run eval` runs live acpx evals against the `agent-quality-baseline`, `argus-guardrails`, and `session-resume-baseline` datasets. Before landing long-term functionality, run the validation gate and a mandatory adversarial Argus review.

## Credits & license

Pantheon is built **on [Pi](https://github.com/earendil-works)** — a minimal-core, terminal-first, multi-provider coding agent by **@earendil-works / @mariozechner**. The bundled `/goal` loop is the **[pi-goal](https://www.npmjs.com/package/pi-goal)** extension by **michaelliv** (MIT). Pantheon adds the specialist fleet, acpx routing, the live Subagent UI, and the observability layer on top.

MIT — see [LICENSE](./LICENSE).
