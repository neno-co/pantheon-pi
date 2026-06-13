# CLAUDE.md

Public contributor guidance for agentic work in this repository.

## Project intent

In-App Subagents for Pi packages a specialist agent fleet, acpx routing, a live Subagent UI, and optional telemetry for Pi users. Keep changes aligned with that product story.

## Code style

- TypeScript modules use tabs, single quotes, and no semicolons; run `bun run lint`.
- Prefer small, typed changes with tests for durable behavior.
- Keep package resources explicit and installable.
- Do not commit local `.env*` files, generated reports, private research notes, or task databases.

## Validation

```bash
bun run validate
npm pack --dry-run
```

Use live evals only when the required local credentials and agent tools are intentionally configured.

## Package contract

Keep these in sync:

- `package.json#files`
- `package.json#pi.skills`
- `agents/prompts/<agent>.md`
- `agents/bin/<agent>`
- `agents/manifests/acpx-baseline.json`

Prompt, routing, manifest, and governance changes should include rationale and relevant tests/evals.
