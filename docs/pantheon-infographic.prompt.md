Create a professional infographic following these specifications:

## Image Specifications

- **Type**: Infographic
- **Layout**: structural-breakdown
- **Style**: technical-schematic
- **Aspect Ratio**: 16:9
- **Language**: English

## Core Principles

- Follow the layout structure precisely for information architecture
- Apply style aesthetics consistently throughout
- If content involves sensitive or copyrighted figures, create stylistically similar alternatives
- Keep information concise, highlight keywords and core concepts
- Use ample whitespace for visual clarity
- Maintain clear visual hierarchy

## Text Requirements

- All text must match the specified style treatment
- Main titles should be prominent and readable
- Key concepts should be visually emphasized
- Labels should be clear and appropriately sized
- Use the specified language for all text content
- Preserve all command text exactly where specified
- This is for a GitHub README hero, so all text must remain legible when scaled down

## Layout Guidelines

# structural-breakdown

Internal structure visualization with labeled parts or layers.

## Structure

- Central subject (object, system, body)
- Parts or layers clearly shown
- Labels with callout lines
- Exploded or cutaway view
- Optional zoomed detail sections

## Variants

Use a polished exploded-system variant: two large orchestration modules side-by-side, a central usage strip, and a lower feedback-loop module.

## Visual Elements

- Main subject clearly rendered
- Callout lines with dots/arrows
- Label boxes at endpoints
- Numbered parts optionally
- Layer boundaries or separation
- Title at top
- Part/layer labels at callouts
- Brief descriptions in boxes
- Legend for numbered systems

## Style Guidelines

# technical-schematic

Technical diagrams with engineering precision and clean geometry.

## Color Palette

- Primary: Blues (#2563EB), teals, grays, white lines
- Background: Deep blue (#1E3A5F), white, or light gray with grid
- Accents: Amber highlights (#F59E0B), cyan callouts

## Variant

Use the Blueprint variant with modern product polish: dark navy canvas, faint grid, glowing edge highlights, clean vector cards, precise arrows, and readable terminal callouts.

## Visual Elements

- Geometric precision throughout
- Grid pattern or isometric angle
- Dimension lines and measurements
- Technical symbols and annotations
- Clean vector shapes
- Consistent stroke weights

## Typography

- Technical stencil or clean sans-serif
- All-caps labels for module headings
- Measurement-style annotations sparingly
- Floating labels for specialist cards

---

Generate the infographic based on the content below:

# Pantheon — Agent Delegation Map

## Overall composition

Create a polished wide 16:9 README hero. Do NOT make it look like a plain code-generated SVG. It should look like a modern technical product infographic: depth, hierarchy, glow, spacing, alignment, and visual polish.

Top title:

**Pantheon — Agent Delegation Map**

Subtitle:

**Athena is the default primary. Zeus runs long implementation loops. Dike and Argus grade “done.”**

Small terminal capsule:

```text
$ pantheon                 default: Athena
$ pantheon --agent zeus    long-running implementation
```

## Upper zone: two side-by-side modules

### Left module: ATHENA

Heading:

**ATHENA · short-running work**

Subhead:

**edit in place → validate → ship**

Central node:

- **Athena**
- primary builder-orchestrator

Specialist cards connected beneath Athena:

- **Mnemosyne** — memory
- **Prometheus** — planning
- **Vulkanus** — implementation

Then show a visually separated evaluator gate column, not just more cards:

- **Dike** — contract gate
- **Argus** — adversarial gate

Make Dike and Argus visibly independent evaluator gates using shield/stamp/gate motifs, a distinct outline, and a label: **must PASS before done**.

### Right module: ZEUS

Heading:

**ZEUS · long-running implementation**

Subhead:

**delegate → resume → gate**

Central node:

- **Zeus**
- resumable orchestrator

Specialist cards connected beneath Zeus:

- **Mnemosyne** — context
- **Prometheus** — phase plan
- **Vulkanus** — long task

Then show a visually separated evaluator gate column, not just more cards:

- **Dike** — contract gate
- **Argus** — final review gate

Make the viewer understand: same fleet, different orchestration mode; Dike and Argus are independent gates.

## Middle usage strip: the concrete engineering loop

Heading:

**Use it as an engineering loop**

Make this the clearest concrete usage example in the image. Use a large, high-contrast terminal card with generous padding and large monospaced text. Command text must be crisp and readable when the full image is scaled to 800px wide.

Left card:

```text
/define-project
```

Small label beside it:

```text
Linear project + truth conditions
```

Arrow to a wide terminal card. Render this exact command text, split into three large readable lines:

```text
/goal implement the functionality
outlined in the Linear project
until Dike approves contract + truth conditions
```

End with a strong approval stamp/card:

**DIKE APPROVES**

Tiny caption under stamp:

**contract + truth conditions met**

## Lower panel: AHE loop

Heading:

**AHE · evidence-gated harness evolution**

Caption:

**Traces inform changes to prompts, tools, manifests, skills, evals, and routing — then review gates promotion.**

Four-stage loop with arrows:

```text
trace → eval → harness update → review
```

Micro labels:

- trace: spans / run IDs
- eval: Dike / Argus
- harness update: prompts · tools · manifests · skills · evals · routing
- review: human gate

Important: do NOT call this autonomous self-improvement. Show it as evidence-gated and human-reviewed.

## Footer chips: seven pillars, shortened

Show as compact pill chips:

```text
long runs · evaluators · trace proof · memory · Projects Wiki · work graph · AHE
```

Footer line:

**A communication protocol between specialized agents, plus an evidence loop for improving the protocol.**

## Design quality requirements

- Must look like a polished image-generation infographic, not a hand-coded wireframe.
- Re-render as a high-resolution README hero; prioritize legibility over density.
- All command text and card labels must remain crisply legible when the image is scaled to 800px wide.
- Use large fonts; never render tiny body text or dense microtext.
- Keep the text readable; use fewer words per node.
- Use strong visual hierarchy: title → launch modes → Athena/Zeus comparison → usage flow → AHE loop → pillar chips.
- Use technical schematic aesthetics: dark blueprint background, subtle grid, crisp vector edges, cyan Athena lane, amber Zeus lane, green AHE loop.
- Avoid clutter; if space is tight, keep specialist names and role tags but shrink subordinate micro-callouts.
- No fake metrics. No percentages. No speedup claims.
- No old “ask oracle / ask specialist” examples.

Text labels (in English):

- Pantheon — Agent Delegation Map
- Athena is the default primary. Zeus runs long implementation loops. Dike and Argus grade “done.”
- $ pantheon
- default: Athena
- $ pantheon --agent zeus
- long-running implementation
- ATHENA · short-running work
- edit in place → validate → ship
- Athena
- primary builder-orchestrator
- ZEUS · long-running implementation
- delegate → resume → gate
- Zeus
- resumable orchestrator
- Mnemosyne
- memory / archaeology
- system context
- Prometheus
- planning / strategy
- phase plan
- Vulkanus
- TDD implementation
- long task
- Dike
- verifier / judge
- contract gate
- Argus
- adversarial review
- final review
- must PASS before done
- Use it as an engineering loop
- /define-project
- Linear project + truth conditions
- /goal implement the functionality
- outlined in the Linear project
- until Dike approves contract + truth conditions
- DIKE APPROVES
- contract + truth conditions met
- AHE · evidence-gated harness evolution
- trace
- spans / run IDs
- eval
- Dike / Argus
- harness update
- prompts · tools · manifests · skills · evals · routing
- review
- human gate
- long runs
- evaluators
- trace proof
- memory
- Projects Wiki
- work graph
- AHE
- A communication protocol between specialized agents, plus an evidence loop for improving the protocol.
