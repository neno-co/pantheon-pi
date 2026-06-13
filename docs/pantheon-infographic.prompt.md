# Pantheon infographic image-generation prompt

Create a wide README hero infographic as a crisp technical schematic, aspect ratio 16:9, suitable for GitHub README embedding. Output should be a clean, high-contrast SVG/PNG-style image that remains readable around 700px wide.

## Style

Technical schematic / blueprint interface. Dark navy background, subtle grid, thin connector lines, glowing but restrained accents. Engineering audience, hackathon-demo tone. Use only a few type sizes. No photorealism, no cartoons, no generic robot mascots.

## Core message

Pantheon is a communication protocol between specialized agents: Athena handles short-running edit/validate/ship work by default; Zeus handles long-running implementation loops; independent evaluators Dike and Argus grade done; AHE uses trace evidence to improve the harness after eval/review.

Do not invent metrics. Do not claim autonomous self-improvement. AHE must read as evidence-gated and human-reviewed.

## Layout

Wide 1600×900 composition.

### Header

Title: `Pantheon — Agent Delegation Map`

Subtitle: `Run Athena by default, route long-running implementation to Zeus, and let independent evaluators grade “done.”`

Small terminal capsule on the right:

```text
$ pantheon                 default: Athena
$ pantheon --agent zeus    long-running loop
```

### Upper half: two side-by-side structural-breakdown panels

Panel A heading: `ATHENA · short-running work`
Small caption: `edit in place → validate → ship`

Central node:
- `Athena`
- `primary builder-orchestrator`

Five specialist nodes beneath it, connected by arrows:
- `Mnemosyne` — `memory / archaeology`; sublabel `locator · analyzer · librarian`
- `Prometheus` — `planning / strategy`; sublabel `Oracle counsel`
- `Vulkanus` — `TDD implementation`; sublabel `Oracle on blockers`
- `Dike` — `verifier / judge`; sublabel `truth conditions`
- `Argus` — `adversarial review`; sublabel `hunter reviewers`

Panel B heading: `ZEUS · long-running implementation`
Small caption: `delegate → resume → gate`

Central node:
- `Zeus`
- `resumable orchestrator`

Five specialist nodes beneath it, connected by arrows:
- `Mnemosyne` — `system context`; sublabel `prior decisions`
- `Prometheus` — `phase plan`; sublabel `sequence work`
- `Vulkanus` — `long task`; sublabel `implementation`
- `Dike` — `contract gate`; sublabel `approve / fail`
- `Argus` — `final review`; sublabel `hunters fan out`

Use identical specialist roster in both panels to show the contrast: same fleet, different orchestration mode.

### Middle usage strip

Heading: `Use it as an engineering loop, not a chat trick`

Show a left-to-right flow:

```text
/define-project → project + truth conditions live in Linear
```

arrow to:

```text
/goal implement the functionality outlined in [Linear project link]
until Dike approves the contract is implemented and the truth conditions are met
```

### Lower panel: AHE loop

Heading: `AHE · evidence-gated harness evolution`

Caption: `Traces inform changes to prompts, tools, manifests, skills, evals, and routing — then review gates promotion.`

Four-stage loop with arrows:

```text
trace → eval → harness update → review
```

Micro-labels:
- trace: `spans / run IDs`
- eval: `Dike / Argus`
- harness update: `session-first, telemetry`
- review: `human gate`

### Footer chips

Short pillar chips:

```text
subagents · delegation · telemetry/proofs · AHE · Projects Wiki · LLM Wiki · acpx
```

Footer line:

```text
A communication protocol between specialized agents, plus an evidence loop for improving the protocol.
```

## Constraints

- Must be README-ready and legible at reduced size.
- Do not include the old “ask a specialist” examples.
- Do not show fake dashboards, fake metrics, or performance percentages.
- Make Dike and Argus visually stand out as independent evaluators/gates, but keep all five specialists aligned.
- Prefer clean diagrammatic boxes and arrows over decorative illustration.
