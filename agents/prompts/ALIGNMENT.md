# Pantheon-Pi prompt baseline provenance matrix

Olympus source inspected: `https://github.com/neno-co/olympus` commit `f939230eb557c673de27c3de1845c784699bfad7`.

This document is a historical baseline provenance artifact. It records the one-time Olympus prompt sources used to bootstrap Pantheon-Pi packaged prompts. It is non-gating: CI, install checks, tests, and evals must not require ongoing equivalence with Olympus or reject independent Pantheon prompt evolution.

Pantheon-Pi prompts are canonical after import. The prompt files in `agents/prompts/`, their `agents/bin/` launchers, and `agents/manifests/acpx-baseline.json` define the supported runtime surface. Future changes should be evaluated against Pantheon-owned behavior, AHE prompt governance, package integrity, and manifest-authoritative routing rather than Olympus alignment.

| Local agent prompt | Historical Olympus source | Provenance note |
|---|---|---|
| `argus.md` | `.opencode/agents/argus.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `athena.md` | No Olympus counterpart | Pantheon-Pi native primary builder-orchestrator prompt; combines direct implementation with bounded delegation. |
| `codebase-analyzer.md` | `.opencode/agents/codebase-analyzer.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `codebase-locator.md` | `.opencode/agents/codebase-locator.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `codebase-pattern-finder.md` | `.opencode/agents/codebase-pattern-finder.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `dike.md` | No Olympus counterpart | Pantheon-Pi native evaluator/completeness judge; owns Done-Contract freeze and proof-backed completion grading. |
| `document-writer.md` | `.opencode/agents/document-writer.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `explore.md` | `.opencode/agents/explore.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `frontend-engineer.md` | `.opencode/agents/frontend-engineer.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `hunter-code-review.md` | `.opencode/agents/hunter-code-review.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `hunter-comments.md` | `.opencode/agents/hunter-comments.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `hunter-security.md` | `.opencode/agents/hunter-security.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `hunter-silent-failure.md` | `.opencode/agents/hunter-silent-failure.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `hunter-simplifier.md` | `.opencode/agents/hunter-simplifier.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `hunter-test-coverage.md` | `.opencode/agents/hunter-test-coverage.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `hunter-type-design.md` | `.opencode/agents/hunter-type-design.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `librarian.md` | `.opencode/agents/librarian.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `meta-reviewer.md` | No Olympus counterpart | Pantheon-Pi native telemetry-backed meta-review and harness improvement agent; no Olympus origin. |
| `mnemosyne.md` | `.opencode/agents/mnemosyne.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `oracle.md` | `.opencode/agents/oracle.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `prometheus.md` | `.opencode/agents/prometheus.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `thoughts-analyzer.md` | `.opencode/agents/thoughts-analyzer.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `thoughts-locator.md` | `.opencode/agents/thoughts-locator.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `translator.md` | `.opencode/agents/translator.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `vulkanus.md` | `.opencode/agents/vulkanus.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `zeus.md` | `.opencode/agents/zeus.md` | Imported baseline; Pi/acpx overlay and packaged runtime adaptations are Pantheon-owned. |
| `aether.md` | No Olympus counterpart | Local-only experimental prompt; not manifest-routable and not exposed by extension acpx allowlist. |

Olympus prompts not packaged locally: `benchmark-hunter.md`, `build.md`, `plan.md`. They are historical references only and are not manifest-routable Pantheon-Pi packaged agents in `agents/manifests/acpx-baseline.json`.
