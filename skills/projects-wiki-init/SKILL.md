---
name: projects-wiki-init
description: Create or repair the shared Projects Wiki / LLM Wiki scaffold at ~/Projects/projects-wiki. Use when the user asks to initialize, bootstrap, create, repair, or ensure the projects wiki / LLM wiki / company brain exists before filing durable notes.
user-invocable: true
---

# Projects Wiki Initialization

Use this skill when the shared `~/Projects/projects-wiki` vault does not exist yet, is missing its core files, or the user asks to create the Projects Wiki / LLM Wiki / company brain.

This skill complements:

- `obsidian` — read/search/edit Obsidian and projects wiki notes.
- `projects-wiki-research-filing` — file durable research into an existing wiki.

## Canonical location

Default vault path:

```text
~/Projects/projects-wiki
```

Fallback/symlink path used by some tools:

```text
~/Documents/Obsidian Vault
```

Only use another path if the user explicitly asks for it or sets `PROJECTS_WIKI_PATH`.

## Bootstrap workflow

1. Resolve the target path:

   ```bash
   WIKI_PATH="${PROJECTS_WIKI_PATH:-$HOME/Projects/projects-wiki}"
   ```

2. If the directory does not exist, create it and the standard folders:

   ```bash
   mkdir -p "$WIKI_PATH"/{entities,concepts,queries,meetings,digests,comparisons,raw/articles,raw/papers,raw/transcripts,raw/assets}
   ```

3. If `SCHEMA.md`, `index.md`, or `log.md` are missing, create them from the templates below. Do **not** overwrite existing files without user confirmation.

4. Re-read the created/updated files and report the exact path.

5. After initialization, use `projects-wiki-research-filing` for actual research capture.

## Required root files

### `SCHEMA.md`

````markdown
# Wiki Schema

## Domain

This vault is the shared project knowledge base for repositories under `~/Projects`. It stores research, architecture notes, implementation context, debugging findings, decisions, integrations, and operational knowledge that should persist beyond chat.

## Conventions

- File names: lowercase, hyphens, no spaces.
- Every wiki page starts with YAML frontmatter.
- Meta pages at the vault root (`SCHEMA.md`, `index.md`, `log.md`) are exempt from the frontmatter and lowercase-hyphen filename rules.
- Use `[[wikilinks]]` so related notes stay connected.
- Raw source material goes under `raw/` and is immutable.
- Durable research must be filed here before it is considered done.
- When a page changes, bump its `updated` date.
- Every new page must be added to `index.md`.
- Every substantive action must be appended to `log.md`.

## Naming

- `entities/<name>.md` — projects, vendors, tools, services, APIs.
- `concepts/<topic>.md` — workflows, architectural ideas, recurring themes.
- `comparisons/<a>-vs-<b>.md` — tradeoff analysis.
- `queries/<YYYY-MM-DD>-<topic>.md` — filed research answers and synthesized findings.
- `meetings/<YYYY-MM-DD>-<slug>.md` — meeting records.
- `digests/<YYYY-MM-DD>-slack.md` — daily Slack digest.
- `raw/articles/`, `raw/papers/`, `raw/transcripts/`, `raw/assets/` — immutable source captures.

## Frontmatter

```yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query | summary | meeting | digest
tags: [research]
sources: []
projects: []
---
```

## Research filing policy

When research is done:

1. Save raw source material under `raw/` if it matters later.
2. Update existing entity/concept pages when the research extends them.
3. Create a dated page in `queries/` when the result is a standalone synthesis.
4. Add the page to `index.md`.
5. Append the action to `log.md`.
````

### `index.md`

```markdown
# Wiki Index

> Persistent project knowledge base for research and implementation context.
> Last updated: YYYY-MM-DD | Total pages: 0

## Meta

- [[SCHEMA]] — vault conventions, taxonomy, and filing rules.
- [[log]] — chronological record of wiki changes.

## Meetings

## Raw Sources

## Digests

## Entities

## Concepts

## Comparisons

## Queries
```

### `log.md`

```markdown
# Wiki Log

> Chronological record of important vault actions. Format:
> `## [YYYY-MM-DD] action | subject`

## [YYYY-MM-DD] init | Projects Wiki scaffold

- Created the Projects Wiki scaffold with schema, index, log, durable-note folders, and raw-source folders.
```

## Safety rules

- Never overwrite an existing wiki file without asking the user.
- Never store credentials, secrets, private keys, or auth tokens in the wiki.
- Keep raw sources immutable once captured.
- If the wiki already exists, inspect `SCHEMA.md`, `index.md`, and `log.md` before changing anything.
- Prefer updating navigation over creating orphan notes.

## Success criteria

The wiki is initialized when:

- `SCHEMA.md`, `index.md`, and `log.md` exist;
- standard durable-note and raw-source directories exist;
- the user knows the absolute vault path;
- follow-up research filing can use `projects-wiki-research-filing`.
