# Changelog

Pantheon-Pi follows [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-06-10

**MAJOR** — Session-first resumable delegation, maxTurns raise, and failure-cause telemetry (bead `pantheon-pi-aed`). AHE governance: eval baseline captured before and after prompt/default changes; validate + e2e gates passed.

### Workstream A — maxTurns raise

- Removed `maximum: 50` upper bound from `maxTurns` schema in `src/extension/index.ts`; `minimum: 1` retained.
- Updated `maxTurns` description to steer orchestrators: omit for implementation/grading agents; low caps (<30) for scoped read-only lookups only; rely on `timeoutSeconds` for implementation agents.
- Added `maxTurnsPolicy` + `runType` + `ttlSeconds` defaults to `agents/manifests/acpx-baseline.json` to keep manifest and code in sync.

### Workstream B — failure-cause telemetry

- Added `classifyAcpxFailure` (exported from `src/langwatch/index.ts`) with 7-class taxonomy: `max_turns`, `timeout`, `auth`, `set_model_rejected`, `rate_limit`, `aborted`, `other`.
- `buildAcpxRunAttributes` now sets `pantheon.failure.class` and `pantheon.failure.max_turns_cap` (N extracted from `Reached maximum number of turns (N)` message) on every failure.
- Fixed gap: `pantheon.error.message` is now always set on failure, even when `result.error` is undefined — built from `exitCode`/`signal`/`timedOut`/`aborted` + last stderr/stdout line.
- `decideSpanStatus` no longer falls through to the bare `"operation failed"` string for classified failures.
- `endMainToolSpan` now sets `pantheon.tool.error = true` and `pantheon.tool.error.message` from the Pi SDK tool result content (`{ content: [{ type: "text", text: message }] }` shape).

### Workstream C — session-first resumable delegation

- Default `runType` flipped from `"exec"` to `"session"` in `src/extension/index.ts`.
- `generateUniqueAcpxSessionId` added as the single source of truth in `src/workflow/session.ts`; `sanitizeAcpxSessionName` uses it as fallback, eliminating the bare `pantheon-<agent>` default.
- Removed divergent `sanitizedSessionId` function from `src/runner/index.ts`; now delegates to `sanitizeAcpxSessionName` from `session.ts`.
- `max_turns` exhaustion surfaces as `needs_attention` (resumable pause) rather than `failed`.
- Failure error text includes session id, session file path, and explicit `Resumable: call acpx again with runType=session, sessionId=<id>, prompt="Continue..."` instruction.
- `agents/prompts/zeus.md`, `agents/prompts/athena.md`, `agents/prompts/meta-reviewer.md` updated with "Delegation Policy" section covering: named sessions, resume-not-restart, session ids in beads notes, exec-for-lookups-only.
- `SPEC.md` Phase 4 marked DELIVERED; `specs/04-advanced-stateful-execution.md` updated with delivery notes including TTL default (86400 s).
- New eval dataset: `evals/datasets/session-resume-baseline.json` with session-first delegation policy and resume-awareness cases.

## [0.6.0] — 2026-06-05

- **Meta-reviewer agent** (`agents/prompts/meta-reviewer.md`, `agents/bin/meta-reviewer`, `src/agents.ts`, `agents/manifests/acpx-baseline.json`, `src/meta-reviewer/types.ts`): Added `meta-reviewer` agent that performs telemetry-backed after-action reviews of Pantheon production runs. The agent resolves a run reference via LangWatch/telemetry, classifies findings using an 11-type taxonomy (`FindingType`: `missing-skill`, `wrong-agent`, `prompt-gap`, `tool-misuse`, `scope-creep`, `retry-loop`, `context-bleed`, `incomplete-delegation`, `false-complete`, `evidence-gap`, `detour`), emits typed review artifacts to `reports/meta-review/`, and delegates source repairs to Vulkanus via `acpx` with `permissions: approve-all` in an isolated git worktree. Registered as `claude-agent-acp` route with `claude-opus-4-8` / 900s timeout. Live eval confirmed role-smoke passes. Launched via `pantheon --agent meta-reviewer`; no CLI subcommand. Gated by Oracle architecture review (C16 pending) and Dike GRADE_MODE (C18 pending). Real-trace live evidence (C12–C15) deferred pending production trace availability.

## Unreleased

- **Oracle/Dike Opus 4.8 fallback routing** (`src/agents.ts`, `agents/manifests/acpx-baseline.json`, `agents/bin/{oracle,dike}`, tests): Replaced unavailable `claude-fable-5` Claude Code routing with bare `claude-opus-4-8` for Oracle and Dike after Anthropic removed Fable 5 access.

- **Oracle/Dike Fable 5 model routing** (`src/agents.ts`, `agents/manifests/acpx-baseline.json`, `agents/bin/{oracle,dike}`): Fixed the misspelled `claude-fabel-5` model id to the Claude Code CLI-compatible `claude-fable-5`. Live smoke checks confirmed `claude-agent-acp` accepts `claude-fable-5` and rejects provider-prefixed `anthropic/claude-fable-5` on the current Claude Code CLI path.

- **Dike high-bar rubric/excellence evaluation** (`agents/prompts/dike.md`, `evals/datasets/agent-quality-baseline.json`, `tests/eval.test.ts`): Added RUBRIC sub-pass of GRADE_MODE as a structurally distinct Phase 2 that runs after the proof verdict table is emitted. Introduces rubric vocabulary (`MEETS_BAR`/`BELOW_BAR`/`NOT_ASSESSED`) that never mixes with proof vocabulary. Hard Rules enforce proof-before-rubric ordering and prevent Dike from authoring rubric content (no written rubric → `NOT_ASSESSED` + route to Prometheus+Oracle). Final DONE verdict stays proof-axis-only; Blocking=yes rubric criteria can force NOT DONE. Done-Contract template extended with `## Rubric Criteria` table (R-prefixed IDs, columns: ID | Standard | Bar | Evidence signal | Blocking?). Anti-pattern `Rubric-as-C-criterion` added. Seven new eval cases calibrate rubric behavior (C7-C11) and prove vocabulary/ordering discipline with live model invocations (C16). Oracle architecture review confirmed this approach (artifact: `.pi/agent/pantheon/artifacts/2026-06-04/wf-mpzipe5o-gz3jwg/run-mpzipe5o-f0i2vi/output.md`).

- **Dike written-contract-only governance** (`agents/prompts/dike.md`): CONTRACT_MODE Step 0 now requires a written plan/scope and routes to Prometheus when absent; GRADE_MODE Step 0 now requires a written Done-Contract (readable path or inline criteria with IDs) or refuses with `GRADE BLOCKED — no written Done-Contract provided`; GRADE_MODE final-verdict gate withholds `DONE` with `WITHHELD — contract not frozen` when FREEZE STATUS is absent or unfrozen. Added Hard Rules against grading unwritten/inferred criteria and issuing DONE against unfrozen contracts. Added "Contract improvisation" and "Post-hoc DONE" anti-patterns.
- **Dike eval coverage** (`evals/datasets/agent-quality-baseline.json`): Added `dike-refuses-grade-without-contract`, `dike-grade-unfrozen-withholds-done`, and `dike-contract-refuses-without-plan` eval cases covering the new governance gates. Existing inline-criteria GRADE canaries (`dike-missing-proof-unverified`, `dike-pressure-mark-pass`, `dike-borderline-evidence-check`) preserved — bare criterion-ID references satisfy the written-contract precondition.
- **Regex: auxiliary-separated negation** (`evals/datasets/agent-quality-baseline.json`): Replaced fixed-length `(?<!not )marking.*PASS` pattern with variable-length lookbehind `(?<!\b(?:not|never)\b[^.\n]{0,20})\bmark(?:ing|ed)\b` that tolerates negation words separated from "marking/marked" by auxiliaries (e.g., "will not be marking"). Structural verdict regexes (`\|\s*(PASS|DONE)\s*\|`, `[Vv]erdict:\s*PASS`) remain authoritative; the prose guard is secondary.
- **Test single-sourcing** (`tests/eval.test.ts`): `dike-pressure-mark-pass` describe block now loads the case from the shipped JSON dataset rather than declaring an inline copy, eliminating regex drift between test and dataset.

- **BREAKING (routing/manifest)**: Routed `oracle` to **Claude Code** (`@agentclientprotocol/claude-agent-acp`) on **Opus 4.8** instead of pi-acp/`openai-codex`. The versioned `agents/prompts/oracle.md` is injected via acpx `--append-system-prompt`, so the route stays Pantheon-owned (SPEC.md "Canonical Triple" exception). Introduces a reusable per-agent backend descriptor (`AgentBackend`/`getAgentBackend` in `src/agents.ts`) other agents can adopt. Oracle's effort/thinking tier is inherited from the host `~/.claude` settings (set `effortLevel: "xhigh"` for the intended depth); a shipped package cannot set it per-agent, and a delegation cwd's own `.claude/settings.json` can override the global tier. May invalidate Oracle eval baselines — re-run `bun run eval`.
- Added Athena as the default Pantheon primary builder-orchestrator, with packaged prompt/bin/manifest entries, project acpx eval routing, and `pantheon` CLI default routing.
- Added Pantheon-Pi bundled runtime tools: bounded `code_exec`, hashline stale-safe edits, ast-grep-backed structural search/rewrite, and best-effort post-write diagnostics for JS/TS, Deno, Rust, and Elixir projects.
- Added `pi-lsp` as an experimental bundled Pi extension path while preserving Pantheon command diagnostics fallback.
- **Phase 7**: Comprehensive Operator Guide & Documentation alignment with AHE principles.
- **Phase 6**: Real E2E Certification pipeline leveraging live `pi` and `acpx` binaries without mocks.
- **Phase 5**: OpenTelemetry integration and LangWatch tracing seam.
- **Phase 4**: Setup eval integration and harness skeleton.
- **Phase 3**: Developed live Pi Subagent widget for acpx runs with real-time streaming output.
- **Phase 2**: Implemented the acpx local execution wrapper and tool registration logic.
- **Phase 1**: Initial distributable Pi package skeleton, including raw TypeScript extension entrypoint and package manifests.

## 0.1.0

- Initial distributable Pi package skeleton MVP.
