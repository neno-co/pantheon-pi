---
name: obsidian
description: Work with the Obsidian vault and the shared projects wiki. Use when the user asks to read, search, create, update, or link notes in Obsidian; asks to "save this to the wiki"; mentions the projects wiki, LLM wiki, Obsidian notes, backlinks, note filing, or durable research capture.
user-invocable: true
---

# Obsidian Vault

This skill gives Claude a stable workflow for reading and editing notes in Ihor's shared Obsidian/project wiki setup.

## Primary vaults

Prefer these paths in this order:

1. `~/Projects/projects-wiki` — the shared project/LLM wiki and the default place for project research
2. `~/Documents/Obsidian Vault` — fallback/symlink location
3. `OBSIDIAN_VAULT_PATH` — only use a different path if the task is clearly about another vault or the environment explicitly points there

For project research, architecture notes, debugging findings, implementation context, and durable handoff material, default to `~/Projects/projects-wiki`.

## When to use this skill

Activate this skill when the user wants to:
- read or search notes in the wiki
- save findings for later
- create or update Obsidian notes
- add links, backlinks, or related-note references
- move chat knowledge into durable documentation
- inspect the current structure of the projects wiki

## Core operating rules

1. Search before creating
   - Look for existing notes on the same topic before making a new one.
   - Prefer updating an existing durable note over creating a duplicate.

2. Keep paths explicit
   - Work with full vault-relative or absolute paths.
   - Be careful with spaces in `~/Documents/Obsidian Vault`.

3. Preserve Obsidian structure
   - Use Markdown.
   - Use `[[Wiki Links]]` for related notes where appropriate.
   - Keep note names evergreen and descriptive.

4. Verify after writes
   - Re-read the file after creating or editing it.
   - If the note should be discoverable from another note, update the relevant index or hub page too.

## Typical tasks

### Read a note
- Open the note directly by path if known.
- If only a topic is known, search filenames and content first.

### Search the vault
- Search by filename when the note title is likely known.
- Search by content when the concept is known but the note name is not.
- Check related hub/index notes before creating something new.

### Create a note
When creating a new note:
- choose the correct folder for the note type
- add a clear title
- link related notes with `[[...]]`
- include enough context that a future session can resume from the note alone

### Update a note
When updating an existing note:
- preserve the note's current structure and style
- append or integrate new material cleanly
- avoid rewriting unrelated sections

## Recommended note-writing pattern

A good durable note usually contains:
- what this note is about
- the relevant current state
- key facts or decisions
- exact paths, branches, issue IDs, or commands if they matter
- links to related notes
- a clear next-start point if future work will continue from it

## Projects wiki relationship

The shared `projects-wiki` vault is the canonical place for durable project research. If the task is specifically about saving architecture, implementation notes, research, or handoff material, also apply the `projects-wiki-research-filing` skill.

## Success criteria

This skill has been applied successfully when:
- the right vault is used
- the right existing note was found or a clean new one was created
- links and related navigation were preserved or improved
- the note was re-read after editing to verify the final content
