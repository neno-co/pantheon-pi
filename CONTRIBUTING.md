# Contributing

Thanks for improving In-App Subagents for Pi.

## Local setup

```bash
bun install
bun run hooks:install
bun run validate
```

## Development rules

- Keep the public package focused on the in-app subagent product surface.
- Do not commit local `.env*` files, generated reports, private notes, or task databases.
- Keep `package.json#files`, `package.json#pi.skills`, and the filesystem in sync.
- Keep each agent's prompt/launcher/manifest identity in sync.
- Run `bun run validate` before opening a PR.
- For packaged prompt, routing, manifest, or governance changes, include design rationale and update tests/evals when appropriate.

## Release sanity check

```bash
bun run validate
npm pack --dry-run
```

Inspect the dry-run tarball contents and confirm only public package assets are included.
