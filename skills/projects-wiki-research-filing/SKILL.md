---
name: projects-wiki-research-filing
description: File durable project research into the shared projects wiki at ~/Projects/projects-wiki. Use when the user asks to save research, write something down for later, capture architecture notes, preserve debugging findings, create a hub note, or move implementation context into the LLM wiki / projects wiki / Obsidian vault.
user-invocable: true
---

# Projects Wiki Research Filing

Use this skill whenever research, architecture notes, implementation context, or durable debugging findings should be saved for future sessions instead of being left only in chat.

This is the user-specific workflow for the shared project knowledge vault:

- Primary vault path: `~/Projects/projects-wiki`
- Obsidian fallback/symlink: `~/Documents/Obsidian Vault`
- Project research should be filed there by default

## When to use

Activate this skill when:
- the user says to write something down, save research, or keep it for later
- you finish non-trivial research on `neno`, `viche`, `hermes-agent`, or related work
- you collect architecture findings, design notes, implementation context, operational setup steps, or debugging results
- you need to create a reusable starting point for future implementation work

## Orientation

Always do this before creating or updating notes:

1. Read `~/Projects/projects-wiki/SCHEMA.md`
2. Read `~/Projects/projects-wiki/index.md`
3. Read `~/Projects/projects-wiki/log.md`
4. Search the vault for existing notes on the same topic to avoid duplicates

## Vault structure

Use these folders intentionally:

- `raw/articles/` — immutable source markdown copied from repos, docs, tickets, or plans
- `raw/transcripts/` — session captures, meeting summaries, or human handoff transcripts
- `raw/assets/` — diagrams, HTML artifacts, screenshots, and other non-note source material
- `entities/` — stable pages for projects, systems, repositories, and tools
- `concepts/` — reusable workflows, runbooks, implementation hubs, and "start here" notes
- `queries/` — dated research deliverables and synthesized answers

## Default filing rules

### 1. Capture raw sources first

If source material is likely to matter later, copy it into `raw/` before summarizing it elsewhere.

Examples:
- repo README for a subsystem → `raw/articles/...`
- task plan, spec, or issue text → `raw/articles/...`
- meeting summary or chat handoff → `raw/transcripts/...`
- diagrams or HTML artifacts → `raw/assets/...`

Do not treat `raw/` as a place for living summaries. Raw files should stay immutable once captured.

### 2. Choose the right durable note type

- use `entities/` for stable project pages like `neno`, `viche`, and `hermes-agent`
- use `concepts/` for working notes, runbooks, and future resume points
- use `queries/` for dated research notes answering a specific question or investigation

### 3. Maintain navigation

Every new durable note must be made discoverable.

Update:
- `index.md`
- `log.md`

Also add wikilinks from related pages when appropriate so future sessions can find the note through backlinks.

## Neno / Exact-specific conventions

For Neno / Exact work, the main starting points are:

- `~/Projects/projects-wiki/concepts/neno-exact-online-development-hub.md`
- `~/Projects/projects-wiki/concepts/neno-exact-matchsets-reconciliation-hub.md`

Before implementation or issue investigation, read the relevant hub note first.

Important companion note:

- `~/Projects/projects-wiki/concepts/neno-exact-online-local-setup.md`

This contains the critical Exact local-auth rule:
- run `deno task db:pull:sandbox`
- then `truncate workspace_exact_connections;`
- before a fresh Exact OAuth flow
- otherwise token refresh can conflict with other developers

## NEO-974 / MatchSets filing pattern

When researching or handing off NEO-974-style issue work, capture all three source layers when available:

1. Issue source — ticket body and comments → `raw/articles/...`
2. Branch source — branch-local plan or task note → `raw/articles/...`
3. Human handoff source — meeting transcript, chat summary, or voice handoff → `raw/transcripts/...`

Then create:
- a dated `queries/...` note that explains what the branch already contains, what is solved, and what the current blocker is
- a `concepts/...-hub.md` note that becomes the future resume point

For branch-based handoffs, explicitly record:
- the exact worktree path
- whether the branch is research-only or already contains implementation/code/tests
- the current blocker to investigate first

Do not assume the issue tracker reflects the latest state. Branch-local plans, comments, and handoff material may be more current than the ticket body.

## Recommended workflow

1. Orient on `SCHEMA.md`, `index.md`, and `log.md`
2. Search for an existing note on the topic
3. Read the repo files or source material that ground the note
4. Copy durable source material into `raw/` when useful
5. Create or update the appropriate note in `entities/`, `concepts/`, or `queries/`
6. Add cross-links to related notes
7. Update `index.md`
8. Append an entry to `log.md`
9. Re-read the changed files to verify discoverability and correctness

## Pitfalls

- don't leave important research only in chat
- don't create duplicate notes when an existing page should be updated
- don't forget to update `index.md` and `log.md`
- don't put mutable summaries in `raw/`
- don't save a note without enough context for a future session to resume the work

## Success criteria

The work is done when:
- the research exists in the vault
- the note is linked from the index
- the action is recorded in the log
- related pages link to it when appropriate
- a future session has a clear "start here" page if the topic is likely to continue
