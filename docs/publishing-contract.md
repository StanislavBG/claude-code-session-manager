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

## npm write-path 2FA gate (discovered 2026-08-21/22)

`npm publish` can 403 (`Two-factor authentication or granular access token with bypass 2fa
enabled is required to publish packages`) even when `npm whoami` succeeds — a separate gate
from login. A legacy "classic" publish token (the kind `npm token create` makes) cannot
satisfy it; only an account with 2FA enabled (interactive OTP at publish time) or a
**granular access token with "bypass 2FA for write actions"** (npmjs.com web UI only — the
CLI cannot create one) can. npm is deprecating the bypass-2FA token path itself
(https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/):
it loses publish capability entirely around Jan 2027. The durable fix, once the `release.yml`
workflow above exists, is **npm Trusted Publishing (OIDC)** — no token/2FA at all, since npm
verifies the GitHub Actions run's own short-lived identity. Until that workflow is built, this
repo has no fully unattended publish path; `/builder`'s local-worktree publish needs either a
live human OTP or a (temporary, pre-2027) bypass-2FA token per release.
