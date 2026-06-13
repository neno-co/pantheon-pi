# Agent Guidelines

This repository is the public hackathon/demo package for In-App Subagents for Pi: a specialist agent fleet, acpx routing, live Subagent UI, and optional telemetry for Pi users.

## Work here only when it supports the package

Keep changes aligned with the shippable public package:

- `src/` runtime code;
- `agents/` prompts, launchers, and manifest;
- `skills/` for Pantheon/acpx/telemetry operations;
- tests, evals, and scripts that validate the public package contract.

Do not add generated reports, private planning notes, local task databases, credentials, screenshots, local `.env*` files, or unrelated skill bundles.

## Keep the package contract in sync

When adding, removing, or renaming agents, skills, packaged files, or launchers, check the relevant contract surfaces together:

- `package.json#files`
- `package.json#pi.skills`
- `agents/prompts/<agent>.md`
- `agents/bin/<agent>`
- `agents/manifests/acpx-baseline.json`

## Code and tests

- Prefer small, typed changes with tests for durable behavior.
- Use the repo tooling instead of embedding style rules in prose; run `bun run lint` when style may be affected.
- Use live evals only when the required local credentials and agent tools are intentionally configured.

## Validation

Use the narrowest relevant test while iterating. Before landing durable code or package changes, run:

```bash
bun run validate
npm pack --dry-run
```

For prompt, routing, manifest, or governance changes, include rationale and update tests/evals when behavior changes.
