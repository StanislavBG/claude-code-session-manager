# Publishing Contract

Rules that apply to every npm publish of this package.

## Required metadata (package.json)

Every published version must have:

- `name` — `claude-code-session-manager`
- `version` — semver, bumped before publish
- `license` — `MIT`
- `repository.url` — `https://github.com/StanislavBG/claude-code-session-manager.git`
- `homepage` — `https://github.com/StanislavBG/claude-code-session-manager#readme`
- `bugs.url` — `https://github.com/StanislavBG/claude-code-session-manager/issues`
- `publishConfig.provenance` — `true`

## GitHub repo requirement

Every published Bilko package MUST have a corresponding GitHub repo at
`https://github.com/StanislavBG/<repo>` (or under an org) **before the first publish**.

The `repository.url` in `package.json` points there. npm provenance (`--provenance` flag)
requires this — npm validates the source URL against the GitHub Actions runner context.
Local-only packages cannot be provenanced.

> Note: `repository` and related fields only appear on the npm registry page after the
> **next publish** following the commit that adds them. They do not backfill old versions.

## Pre-publish checklist

1. `npm run typecheck` passes.
2. `npm run build` succeeds (runs automatically via `prepublishOnly`).
3. Secret scan clean: `grep -rEn 'sk-[a-zA-Z0-9]+|pk-[a-zA-Z0-9]+|API_KEY=|TOKEN=' --include='*.{ts,tsx,js,json,md}' . | grep -v node_modules`
4. `git push origin main` — source must be on GitHub before publish if using `--provenance`.
5. `npm publish` (provenance is opt-in until GH Actions is wired; local publish skips it).

## Provenance (future)

Once a `release.yml` GitHub Actions workflow exists, publish via:

```bash
npm publish --provenance
```

This embeds a signed SLSA attestation linking the npm artifact to the exact commit + workflow run.
