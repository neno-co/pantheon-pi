# Agent Guidelines

This repository is the public hackathon/demo package for In-App Subagents for Pi.

## Scope

Keep the repo focused on the shippable product:

- `src/` runtime code;
- `agents/` prompts, launchers, and manifest;
- `skills/` that directly support Pantheon/acpx/telemetry operations;
- tests, evals, and scripts that validate the public package contract.

Do not add generated reports, private planning notes, local task databases, credentials, screenshots, or unrelated skill bundles.

## Validation

Use the narrowest relevant test while iterating. Before landing durable code or package changes, run:

```bash
bun run validate
npm pack --dry-run
```

For prompt, routing, manifest, or governance changes, include rationale and update tests/evals where appropriate.
