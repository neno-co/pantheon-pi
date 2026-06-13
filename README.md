# In-App Subagents for Pi

**Pantheon turns Pi into an observable multi-agent engineering harness:** Athena builds, specialists run through `acpx`, Dike/Argus verify independently, and every run becomes searchable trace evidence.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-000000.svg)](https://bun.sh)
[![Built on Pi](https://img.shields.io/badge/built%20on-Pi-5b21b6.svg)](https://github.com/earendil-works)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6.svg)](https://www.typescriptlang.org/)

![Pantheon running in Pi with live subagents](docs/pantheon-demo.gif)

> Demo GIF placeholder: record Pantheon working in Pi and save it as `docs/pantheon-demo.gif`.

## Install

Requirements: [Bun](https://bun.sh), [Pi](https://github.com/earendil-works), `acpx`, and Git on your `PATH`.

```bash
curl -fsSL https://pantheon.viche.ai/install.sh | bash
pantheon
```

The installer clones Pantheon-Pi into `~/.pantheon/pantheon-pi`, installs dependencies, registers the Pi package, links the `pantheon` launcher, and runs `pantheon init`.

`pantheon init` is intentionally check-only: run it any time to verify packaged prompts, launchers, manifests, skills, and install prerequisites.

<details>
<summary>Manual / contributor install</summary>

```bash
git clone https://github.com/neno-co/pantheon-pi && cd pantheon-pi
bun install
pi install .
bun link
pantheon init
pantheon
```

Installer overrides:

```bash
PANTHEON_REPO_URL=https://github.com/neno-co/pantheon-pi.git \
PANTHEON_INSTALL_DIR=~/.pantheon/pantheon-pi \
PANTHEON_INSTALL_BRANCH=main \
  curl -fsSL https://pantheon.viche.ai/install.sh | bash
```

</details>

## What Pantheon adds to Pi

Plain `pi` stays vanilla. `pantheon` launches the same Pi binary with a packaged primary agent prompt and a Pi extension stack:

- **Athena primary** — a builder-orchestrator that implements directly and delegates intentionally.
- **26 packaged specialists** — architecture, planning, implementation, research, docs, translation, adversarial review, and targeted hunter roles under `agents/`.
- **Live Subagent UI** — delegated `acpx` runs stream inside Pi; `/acpx-monitor` or `ctrl+0` opens the Agent Explorer.
- **Session-first delegation** — named, resumable runs with explicit pause/resume behavior instead of restart-from-scratch handoffs.
- **Independent evaluation** — `/goal` composes with Dike and Argus so implementers do not grade their own work.
- **Trace-native observability** — OpenTelemetry spans connect main Pi turns, tools, and delegated agents; LangWatch export is optional.
- **Queryable experience memory** — `pantheon telemetry` indexes local traces/session files into SQLite with FTS and semantic similarity search.

## Agents do not grade themselves

Pantheon bundles the open-source [`pi-goal`](https://www.npmjs.com/package/pi-goal) extension and wraps it with a Separate Evaluator-Implementer workflow:

```text
/goal → Done-Contract → implementer: Athena/Vulkanus → evidence
                         evaluator: Dike/Argus → PASS / FAIL / UNVERIFIED
                         ↺ fix/retry until verified
```

Long-term work is not “done” because the builder says so. Dike grades written criteria and proof; Argus performs adversarial review before landing durable functionality.

## Proof, not vibes

Pantheon is engineered as an Agentic Harness Engineering (AHE) loop: observe the harness, diagnose failures, change one thing, then validate with evals/review.

- **Representative trace proof:** a selected LangWatch run shows `pantheon.pi.main`, `236.1s`, `52` spans, and nested Pi turn/tool/acpx spans for a meta-agent review.
- **Measured bottleneck:** in the analyzed local delegated-run corpus/window, ~**34% of delegated wall-clock** was spent in failed or timed-out runs. This is scoped evidence, not a universal benchmark.
- **Design response:** session-first, named, resumable delegation replaces restart-heavy failure recovery.
- **Regression gates:** `bun run validate` checks package/build/install contract, Biome, and the Bun test suite. `bun run eval` runs live acpx evals when credentials/tools are configured.
- **Proof matrix:** telemetry tests cover fleet runs, parallel correlation, failure similarity, FTS/semantic search, hunter SLA surfacing, and fixture-backed UX paths. Fixture proof is marked as fixture proof; live UX proof uses the gated live runner.

The point is not “more agents.” The point is a loop you can inspect, verify, resume, and improve.

## Commands

```bash
pantheon                 # launch Pi with Athena as the default primary
pantheon --agent oracle  # launch Pi with a specific packaged agent prompt
pantheon init            # check packaged assets and install prerequisites
pantheon telemetry ...   # query local telemetry traces/session files

bun run validate         # build + install check + lint + tests
bun run eval             # live acpx evals, when configured
npm pack --dry-run       # verify package contents before publishing
```

Useful telemetry examples:

```bash
pantheon telemetry slow
pantheon telemetry search "timeout"
pantheon telemetry similar "rate limit retry"
pantheon telemetry trace <trace_id> --json --no-ingest
```

## Configuration

Optional environment variables:

- `PANTHEON_ACPX_BIN` — custom `acpx` binary path.
- `PANTHEON_REQUIRE_ACPX=true` — fail install checks when `acpx` is unavailable.
- `PANTHEON_PI_BIN` — override the Pi binary launched by `pantheon`.
- `LANGWATCH_API_KEY` / `LANGWATCH_ENDPOINT` — enable hosted LangWatch export.

For local LangWatch development, copy `.env.langwatch.local.example` to `.env.langwatch.local`.

<details>
<summary>Fleet and package details</summary>

### Fleet

- Primary / build: `athena`, `zeus`, `vulkanus`, `frontend-engineer`
- Planning / architecture: `prometheus`, `oracle`
- Evaluation: `dike`, `argus`, `meta-reviewer`
- Hunters: `hunter-security`, `hunter-silent-failure`, `hunter-type-design`, `hunter-test-coverage`, `hunter-comments`, `hunter-code-review`, `hunter-simplifier`
- Research / codebase: `mnemosyne`, `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `explore`, `thoughts-locator`, `thoughts-analyzer`, `librarian`
- Docs / language: `document-writer`, `translator`

Full routing lives in `agents/manifests/acpx-baseline.json`.

### Package boundary

Pantheon is a Pi package/extension, not a Pi replacement. The public package includes runtime code under `src/`, packaged prompts/launchers/manifests under `agents/`, Pantheon skills, tests/evals/scripts, and docs. Internal project-management data, generated reports, private research notes, credentials, and local task databases are outside the package boundary.

</details>

## Credits & license

Pantheon is built on [Pi](https://github.com/earendil-works), a terminal-first multi-provider coding agent by @earendil-works / @mariozechner. The bundled `/goal` loop is [`pi-goal`](https://www.npmjs.com/package/pi-goal) by michaelliv (MIT). Pantheon adds the specialist fleet, `acpx` routing, live Subagent UI, independent evaluation workflow, and observability layer.

MIT — see [LICENSE](./LICENSE).
