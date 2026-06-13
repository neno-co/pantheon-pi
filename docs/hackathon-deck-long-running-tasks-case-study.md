# Long-running tasks at Neno — a case study on how we solved it

> Hackathon deck (rebuilt 2026-06-13). New spine: **lead with the proof, then reverse-engineer it.** Neno already runs long-running agentic tasks in production — here are the numbers, the 8 pillars we found were required to get there, and the two things we built (Truth Conditions + Pantheon) that deliver them.
>
> Reuses material from the "Trust the Loop" consolidated deck and the "Trust Onion" deck. Every load-bearing claim is grounded in code; provenance + metric-integrity guardrails at the end.
>
> Core thesis: **The blocker on long-running agents isn't making them loop — it's making the loop trustworthy enough to let it run. That's engineerable, and we identified exactly 8 pillars that make it work.**

---

## Slide 1 — Title

**Headline:** Long-running tasks at Neno: a case study on how we solved it

**Subhead:** How a frontier org actually got to trusted, overnight-grade agentic work — and the architecture that gets anyone there.

**Speaker line:** Everyone can make an agent loop. We're going to show you how we made a loop our org actually trusts to run on real work — starting with the receipts.

---

## Slide 2 — Proof: we already run on this

> *(Was Slide 6. Promoted to the front: show the success metrics before explaining the mechanism.)*

**Purpose:** Measurable, verified impact up front. The hook is the result, not the problem.

**Headline:** This is already in production at Neno, where 100% of our code is written with AI.

**Copy:**

* **100% of PRs in our codebase agent-implemented since November 2025** — every change, human-gated through the verified loop.
* **98%+ Claude Code suggestion acceptance rate since February 2026** — the loop produces work we trust enough to ship (an output of the verified loop, not blind acceptance — every change still passes the human gate).
* We trust it so much we just extended full-monorepo agent access to non-engineers — GTM and accounting; first PR in flight.
* Telemetry found **~34% of delegated wall-clock** (analyzed corpus) lost to failed/timed-out runs → drove a session-first, resume-don't-restart redesign.

**Speaker line:** 100% agent-implemented, human-gated, for seven months — and trusted enough that people who don't write code now operate the loop. The rest of this deck is how we got here.

---

## Slide 3 — The 8 pillars of trustworthy long-running tasks

> *(Was Slide 4.5, expanded from 4 pillars to 8.)*

**Purpose:** Name the full set of requirements. These are the critical requirements we identified for tooling that makes long-running agentic tasks actually work — for us, and for any org.

**Headline:** 8 pillars make a long-running loop trustworthy.

**Visual:** 8-pillar grid; highlight Pillar 1 as the "define done" half and Pillars 2–8 as the "run + verify + improve" half.

**Copy:**

1. **Truth Conditions Framework** — feature-complete descriptions of the system after the work has completed.
2. **Long-running agents** — resumable work over real tasks, not one-shot prompts.
3. **Independent evaluators** — Dike/Argus grade evidence instead of letting builders self-certify.
4. **Trace-native observability** — every main turn, tool call, and delegation becomes inspectable telemetry. *(Shout out LangWatch.)*
5. **Semantic experience memory** — prior runs are searchable by text and meaning.
6. **Projects Wiki as company brain** — durable decisions, research, and handoffs live outside chat.
7. **Beads as shared work graph** — task/dependency state survives across sessions and agents.
8. **Evidence-gated AHE** — trace evidence drives harness changes only after eval/review. ([arxiv.org/abs/2604.25850](https://arxiv.org/abs/2604.25850))

**Speaker line:** These 8 are the requirements we kept rediscovering the hard way. Pillar 1 is about pinning *what done means*. Pillars 2 through 8 are about running the work, proving it, remembering it, and improving the harness itself. Everything else in this deck maps to these.

---

## Slide 4 — Our submissions: Truth Conditions + Pantheon

> *(Was Slide 5 — "In practice: one command." Re-framed as the overview of what we built and how the two pieces fit.)*

**Purpose:** Prove it's real and applicable, not theoretical — and show the whole bridge is a single prompt.

**Headline:** Two submissions, one command.

**Visual:** Terminal showing the command.

**Copy:**

* **Truth Conditions** (Pillar 1) — the `/define-project` skill that pins "done" before you start.
* **Pantheon** (Pillars 2–8) — the ACPX-driven multi-agent harness that runs the work and grades it.
* `/define-project` → project + truth conditions live in Linear.
* The dev then runs a single durable objective:

  > `/goal implement the functionality outlined in [Linear project link] until Dike approves the contract is implemented and the truth conditions are met`
* `/goal` reads the project, builds, and loops with an **independent** evaluator until every truth condition passes.

**Speaker line:** No custom pipeline or tooling. The truth conditions *are* the contract the loop runs against — any team can do this today; the only requirement is that they can run Pi. We submitted two things: the framework that defines done, and the harness that runs against it.

---

## Slide 5 — Pillar 1: Truth Conditions

> *(Was Slide 3. Pin "done" before you start.)*

**Purpose:** First half of the mechanism — make "done" verifiable.

**Headline:** Pillar 1: The Truth Conditions Framework

**Visual:** A truth-condition example — `[auto]` vs `[manual]`.

**Copy:**

* Our `/define-project` skill interviews the team and produces **Truth Conditions** — the north star *and* the loop's stop condition.
* Each is classified `[auto]` (an agent runs a check and asserts the outcome) or `[manual]` (an explicit human sign-off gate).
* The project, its truth conditions, and milestones are written straight into **Linear** as the shared source of truth.

**Speaker line:** First we built a tool to help you define your contracts up front. At Neno we call it the "Truth Conditions" framework. "Done" stops being a vibe and becomes something an independent party can verify.

---

## Slide 6 — Pillars 2–8: an ACPX-enabled multi-agent implementation and evaluation system

> *(Combines the original Pantheon slide with the Trust-Onion deck's Slide 4 — the 34% telemetry proof.)*

**Purpose:** Second half of the mechanism — the trust engine, and the evidence that it improves itself.

**Headline:** Pillars 2–8: The Pantheon — an ACPX-driven network of trustworthy agents.

**Visual:** Overview graph of the Pantheon agents and their interactions (builder → reviewers → independent graders); inset before/after trace showing recovered wall-clock.

**Copy:**

* **Long-running agents (Pillar 2):** `/goal` is a persistent, budget-aware, resumable objective loop — it keeps the primary agent working across turns until done, paused, or budget reached.
* **Independent evaluators (Pillar 3):** a mandatory `argus` adversarial review must pass, and `dike` grades the result against a frozen Done-Contract — **PASS / FAIL / UNVERIFIED**, demanding executed proof. "Done" is graded by a different agent on a different model than the one that wrote the code.
* **Trace-native observability (Pillar 4):** every session and delegated run emits OpenTelemetry spans, with a 7-class failure taxonomy on every failed run.
* **Semantic memory + Projects Wiki + Beads (Pillars 5–7):** prior runs are searchable by meaning; durable decisions live in the wiki; task/dependency state survives across sessions and agents.
* **Evidence-gated AHE (Pillar 8) — the payoff:** local telemetry showed **~34% of delegated wall-clock** in the analyzed corpus was lost to failed or timed-out runs. Root causes (max-turn pauses, timeouts, session/model issues) were diagnosable *because* of the trace taxonomy. The harness response: **session-first execution** and **resume, don't restart**.

**Speaker line:** Each agent attacks the work from a different angle — writing, reviewing, grading, understanding the wider world of Neno. And Pantheon is not just observable: it uses the trace evidence to improve its own loop. The 34% finding is exactly that — observe, diagnose, fix, all on the same harness.

---

## Slide 7 — Get started: long-running loops, the Neno way

> *(Was Slide 7 — Close.)*

**Purpose:** Final claim + the on-ramp.

**Headline:** The biggest lift is building trust with agents *before* you let them run overnight.

**Copy:** Truth Conditions + Pantheon are that foundation — as long as you have:

* Enforced pre-commit hooks (tests + linting + integration + database schema verification).
* Consistent CI/CD pipelines to catch errors on deploy.
* Humans at the gates that matter.

**Get started today:**

```bash
curl -fsSL https://pantheon.viche.ai/install.sh | bash
pantheon                 # Athena as your default primary
/define-project          # pin your truth conditions into Linear
/goal "implement [Linear project] until Dike approves the truth conditions are met"
```

**Speaker line:** Don't trust the agent. Trust the loop. Pin "done," run the fleet against it, let independent evaluators grade the evidence — and the harness gets better every time you do.

---

## Recommended timing (≈2 min)

| Time | Slide | Beat |
| -- | -- | -- |
| 0:00–0:12 | 1 | Title — "we solved long-running tasks, here's the case study" |
| 0:12–0:35 | 2 | **Proof first: 100% agent-implemented + 34% finding** |
| 0:35–0:55 | 3 | The 8 pillars |
| 0:55–1:12 | 4 | Our submissions + one-command bridge |
| 1:12–1:30 | 5 | Pillar 1 — Truth Conditions |
| 1:30–1:52 | 6 | Pillars 2–8 — Pantheon + 34% telemetry proof |
| 1:52–2:00 | 7 | Get started, the Neno way |

---

## Code grounding (every mechanism claim is verifiable)

* **Different-model evaluator, enforced in code:** `src/agents.ts` — Dike & Argus on `claude-opus-4-8`; Athena on `openai-codex/gpt-5.5`; Vulkanus on `claude-sonnet-4-6`.
* **`/goal` loop pattern:** `README.md`; extension wired via the external `pi-goal` package (`package.json`). *(Don't claim Pantheon authored `/goal` — it configures the implementer/evaluator routing around it.)*
* **Frozen, proof-only grading:** `agents/prompts/dike.md` — DONE only when all criteria PASS + contract frozen + no blocking rubric BELOW_BAR; PASS/FAIL/UNVERIFIED, never prose.
* **ACPX parallel fan-out:** `agents/prompts/argus.md` (hunters in parallel), `src/extension/index.ts`.
* **34% finding:** `README.md` ("The payoff: the 34% story") — analyzed local delegated-run corpus; scoped evidence, not a universal benchmark. Source bead `pantheon-pi-aed` (`CHANGELOG.md`).
* **Session-first / resume-not-restart:** `CHANGELOG.md` v1.0.0.

## Metric-integrity guardrails

* **The bridge is a prompt-level handoff, not an automated pipeline.** Honest framing: "truth conditions *are* the contract the `/goal` loop runs against." Do NOT claim Pantheon auto-ingests Linear projects or QA cases — that integration is not built.
* **Terminology by altitude.** The skill says "Truth Conditions"; the engine says "Done-Contract / acceptance criteria / rubric." Map them — don't claim the engine uses the words "truth conditions."
* **`/goal` is the external `pi-goal` package**, bundled in. Pantheon did not author the loop primitive.
* **The 98% acceptance rate is an output of the verified loop, not blind acceptance** — always pair it with the human gate.
* **Neno is frontier/destination, not a reformed left-behind company.** Frame applicability as "here's the architecture that gets you there."
* **The non-engineer rollout is a frontier signal, not a proven practice** (decided recently, one PR in flight).
* **Scope the 34% if pressed:** "delegated wall-clock lost to failed/timed-out runs in our analyzed window" — not a universal benchmark.
* **Live telemetry proof is limited:** `reports/telemetry-proof-matrix.json` is fixture-based (`authoritative_live_proof: false`). Don't claim live production trace proof beyond the one LangWatch screenshot in `artifacts/hackathon-proof/`.
```

## Provenance of trust-gap stats (Slide 1 of the old deck, now retired)

The original opening stats (84% use AI / 33% trust / 46% distrust / 66% "almost right" / 3% full trust) came from the Stack Overflow Developer Survey framing. They are dropped in this case-study cut because we now lead with Neno's own numbers. Re-add them only if you want a "why this is hard for everyone" beat between Slides 2 and 3.
