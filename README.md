# Pantheon

**A native loop stack for software-engineering agents: specialist delegation, independent evaluation, trace-native observability, and evidence-gated harness improvement based on Pi-agent.**

## The seven pillars

Pantheon is opinionated about what makes agent loops trustworthy:

1. **Long-running agents** — resumable work over real tasks, not one-shot prompts.
2. **Independent evaluators** — Dike/Argus grade evidence instead of letting builders self-certify.
3. **Trace-native observability** — every main turn, tool call, and delegation becomes inspectable telemetry.
4. **Semantic experience memory** — prior runs are searchable by text and meaning.
5. **Projects Wiki as company brain** — durable decisions, research, and handoffs live outside chat.
6. **Beads as shared work graph** — task/dependency state survives across sessions and agents.
7. **Evidence-gated AHE** — trace evidence drives harness changes only after eval/review.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-000000.svg)](https://bun.sh)
[![Built on Pi](https://img.shields.io/badge/built%20on-Pi-5b21b6.svg)](https://github.com/earendil-works)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6.svg)](https://www.typescriptlang.org/)

![Pantheon running in Pi with live subagents](docs/pantheon-demo.gif)

> Demo GIF placeholder: record Pantheon working in Pi and save it as `docs/pantheon-demo.gif`.

Most coding agents are a single tool loop: one model, one context, calling tools until it stops and **the same agent that did the work declares it done.** Pantheon composes more. It stacks the Loopcraft ladder for software engineering: a primary builder, specialist agents, long-running sessions, independent evaluators, eval gates, telemetry, and a meta-improvement loop that turns trace evidence into safer, human-approved harness changes.

It's an installable Pi **package** not a replacement, not a wrapper. `pantheon` launches your existing Pi binary with a Pantheon agent as the default primary, registers the delegation tool and a live Subagent UI, bundles a persistent `/goal` loop, and adds telemetry. Plain `pi` stays vanilla.

One line to install, then ask for a specialist by name or hand it a whole `/goal`. Every delegated run is graded by a *different* agent and recorded as an OpenTelemetry trace you can query later.

## Installation

Requirements: [Bun](https://bun.sh), [Pi](https://github.com/earendil-works), `acpx`, Git, and authenticated local provider CLIs on your `PATH`.

Pantheon is intentionally opinionated and multi-provider. Before using the full fleet, authenticate the providers it routes to:

```bash
claude auth login  # Claude Code / Anthropic auth
```
Then use `/login` to login for openai-codex and gemini providers.

If any provider is missing or unauthenticated, only the agents backed by the remaining providers will work reliably.

```bash
curl -fsSL https://pantheon.viche.ai/install.sh | bash
pantheon
```

The installer clones Pantheon-Pi into `~/.pantheon/pantheon-pi`, installs dependencies, registers the Pi package, links the `pantheon` launcher, and runs `pantheon init`.

`pantheon init` is check-only by design: run it any time to verify packaged prompts, launchers, manifests, skills, and install prerequisites.

<details>
<summary>Manual / contributor install</summary>

```bash
git clone https://github.com/neno-co/pantheon-pi && cd pantheon-pi
bun install        # fetch dependencies
pi install .       # register the extension, skills, and fleet in Pi
bun link           # put the `pantheon` launcher on your PATH
pantheon init      # verify packaged assets and install prerequisites
pantheon           # launch Pi with Athena as the default primary
```

Installer overrides:

```bash
PANTHEON_REPO_URL=https://github.com/neno-co/pantheon-pi.git \
PANTHEON_INSTALL_DIR=~/.pantheon/pantheon-pi \
PANTHEON_INSTALL_BRANCH=main \
  curl -fsSL https://pantheon.viche.ai/install.sh | bash
```

</details>

Inside the session, just ask for a specialist — the primary delegates for you:

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

Observability isn't decoration — it changed the design. Measured on our **own delegated-run telemetry corpus/window**, roughly **34% of delegated wall-clock was being lost to failed or timed-out runs.** The local telemetry index surfaced it; the 7-class failure taxonomy in the traces exposed the causes (turn limits, timeouts, session/model issues); the fix was the **session-first, resume-not-restart** redesign now built into `acpx` — a run that hits its turn limit pauses as a resumable "needs attention" handoff instead of dying.

Observe → diagnose → fix. The harness that records the loop is the same one that let us improve it. (This is a measurement of our own analyzed corpus/window, not a universal benchmark or a post-fix speedup claim.)

## Agentic Harness Engineering, not prompt tweaking

Pantheon treats the harness itself as the product: prompts, tools, routing, manifests, skills, evals, sessions, permissions, validation gates, review policy, and telemetry. This follows two recent research threads:

- **[Agentic Harness Engineering](https://arxiv.org/abs/2604.25850)** frames prompts, tools, middleware, memory, skills, and sub-agent configs as auditable adaptation surfaces. Its reported Terminal-Bench 2 result moves pass@1 from **69.7% → 77.0%** through evidence-backed harness edits — this is the AHE paper's benchmark result, not Pantheon's. The transferable lesson for Pantheon is decision observability: every harness change should cite evidence, predicted fixes, and regression risks.
- **[Meta-Harness](https://arxiv.org/abs/2603.28052)** shows an outer loop where a coding-agent proposer inspects prior harness candidates, traces, scores, and artifacts before proposing the next harness candidate. Its lesson for Pantheon is full-history, selective access: traces should become a queryable experience store, not screenshots thrown away after a demo.

Pantheon's AHE loop is deliberately evidence-gated and human-approved:

```text
trace evidence
  → failure pattern
  → hypothesis
  → isolated harness change
  → eval / holdout / review
  → promote or reject
```

That is why this repo carries versioned prompts/manifests, telemetry indexing, fixture and live eval paths, proof-matrix tests, and mandatory review policy for durable functionality. Pantheon does not just use agents; it improves the system that runs them.

## How it fits — vs a single tool loop

Pantheon keeps your plain Pi session and wraps four things around it: a fleet you can route to, independent evaluators that grade the result, a trace + telemetry record of every run, and an AHE loop for improving the harness. The point isn't more agents — it's the right specialist per task, an outside check on "done," and a loop you can actually inspect, evaluate, and improve.

## Commands

```bash
pantheon                 # launch Pi with Athena as the default primary agent
pantheon --agent oracle  # launch with a specific packaged agent prompt
pantheon init            # verify packaged assets and install prerequisites
pantheon telemetry ...   # query the local telemetry index (see above)

bun run build            # package/resource sanity check
bun run check:install    # install-layout smoke check
bun run test             # bun test suite
bun run validate         # build + install check + biome lint + bun test
bun run eval             # live acpx evals, when credentials/tools are configured
npm pack --dry-run       # verify publishable package contents
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

Pantheon is a Pi **package/extension** — it does not replace Pi. It keeps a strict, in-sync package contract: `package.json` (`files` / `pi.extensions` / `pi.skills`), the agent prompts and launchers under `agents/`, the acpx manifest, the installer, and the docs/demo assets. Tests assert this contract so installs fail fast when prompts, launchers, or manifest entries drift.

Internal project-management data, generated reports, private research notes, and unrelated skills are not part of the public package.

## Development

```bash
bun install
bun run hooks:install
bun run validate
npm pack --dry-run
```

Quality bars are real: `bun run validate` runs build + install-check + Biome lint + `bun test`, and `bun run eval` runs live acpx evals against the `agent-quality-baseline`, `argus-guardrails`, and `session-resume-baseline` datasets. Before landing long-term functionality, run the validation gate and a mandatory adversarial Argus review.

## Credits & license

Pantheon is built **on [Pi](https://github.com/earendil-works)** — a minimal-core, terminal-first, multi-provider coding agent by **@earendil-works / @mariozechner**. The bundled `/goal` loop is the **[pi-goal](https://www.npmjs.com/package/pi-goal)** extension by **michaelliv** (MIT). Pantheon adds the specialist fleet, acpx routing, the live Subagent UI, independent evaluation, and the observability/AHE layer on top.

MIT — see [LICENSE](./LICENSE).
