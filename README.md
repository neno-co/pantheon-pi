# In-App Subagents for Pi

A small, installable Pi package that brings a specialist subagent fleet into your coding session. Ask for help, route work to focused agents through `acpx`, and watch delegated runs live in the Pi terminal.

## Why it exists

Modern coding agents work best when they can split work across roles: builder, reviewer, researcher, planner, frontend specialist, security hunter, and more. This package makes that pattern available inside Pi without replacing Pi itself.

- **In-app delegation** — launch subagents from the same Pi session instead of switching tools.
- **Specialist fleet** — bundled prompts and launchers for Athena, Oracle, Argus, Vulkanus, Prometheus, Mnemosyne, hunters, codebase tools, and docs/translation agents.
- **Live Subagent widget** — track active delegated work, final answers, failures, artifacts, and resumable session metadata.
- **Observable by default** — optional LangWatch/OpenTelemetry traces and a local telemetry index for debugging agent runs.
- **Clean package boundary** — plain `pi` stays vanilla; Pantheon mode starts explicitly with the `pantheon` command.

## 30-second start

Requirements: [Bun](https://bun.sh), Pi, and `acpx` on your PATH.

```bash
bun install
bun run validate
pi install /path/to/pantheon-pi
pantheon
```

Inside the Pi session, ask for a specialist:

```text
Consult codebase-analyzer to explain the routing flow.
Ask oracle for architecture tradeoffs before changing this API.
Run argus review on my current diff.
```

The package exposes an `acpx` tool to Pi. Delegated agents run through `acpx`, and the extension renders a live in-app Subagent view while they work.

## What is included

### Agent fleet

The routable fleet is declared in `agents/manifests/acpx-baseline.json` and backed by versioned files:

- `agents/prompts/<agent>.md` — system prompt for each specialist.
- `agents/bin/<agent>` — packaged launcher for each Pi-backed specialist.
- `src/agents.ts` — shared allow-list used by CLI, extension, and tests.

### Pi extension

`src/extension/index.ts` registers the in-app tools and Subagent UI. The package also adds focused coding helpers:

- `code_exec` — bounded shell execution under the current workspace.
- `hashline` — stale-safe line edits by expected content hash.
- `structural_search` — ast-grep structural search and rewrite.
- LSP tools when the optional `pi-lsp` extension is installed.

### Telemetry and diagnostics

- `src/langwatch/` emits optional LangWatch/OpenTelemetry traces.
- `src/telemetry/` indexes local session evidence for trace lookup and debugging.
- `skills/pantheon-telemetry`, `skills/pantheon-cli`, and `skills/mlops/observability/langwatch-acpx` document the shipped operational workflows.

## Commands

```bash
pantheon                 # launch Pi with Athena as the default primary agent
pantheon --agent oracle  # launch a specific packaged agent prompt
pantheon init            # verify packaged assets; does not mutate global Pi config

bun run build            # package/resource sanity check
bun run check:install    # install-layout smoke check
bun run test             # unit tests
bun run validate         # build + install check + lint + tests
bun run eval             # live acpx evals, when credentials/tools are configured
```

## Configuration

The package is zero-config for local use when Pi and `acpx` are already installed. Optional environment variables:

- `PANTHEON_ACPX_BIN` — custom `acpx` binary path.
- `PANTHEON_REQUIRE_ACPX=true` — fail install checks when `acpx` is unavailable.
- `LANGWATCH_API_KEY` — enable hosted LangWatch trace export.
- `LANGWATCH_ENDPOINT` — custom LangWatch endpoint.
- `PI_E2E_BINARY` — Pi binary used by `bun run test:e2e`.

For local LangWatch development, copy `.env.langwatch.local.example` to `.env.langwatch.local`. The local file is gitignored.

## Package boundary

This public repository intentionally keeps only the product surface needed for the hackathon/demo:

- core runtime in `src/`;
- packaged agent prompts, launchers, and manifest in `agents/`;
- tests/evals/scripts that validate the package contract;
- a minimal set of operational skills directly related to Pantheon, telemetry, and acpx.

Internal project-management data, generated reports, private research notes, and unrelated skills are not part of the public package.

## Development

```bash
bun install
bun run hooks:install
bun run validate
npm pack --dry-run
```

Before changing prompts, routing, manifests, or governance rules, consult Oracle and update the corresponding tests/evals. Before landing long-term functionality, run the relevant validation gate and an adversarial Argus review.

## License

MIT — see [LICENSE](./LICENSE).
