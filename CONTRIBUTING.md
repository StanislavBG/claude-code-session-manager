# Contributing

Thanks for taking a look. This project is open-core and free — the app and the Field Manual
always will be, no "pro" tier, no license checks. Contributions that help keep it that way are
welcome.

## Prerequisites

- Node.js >= 22.12.0 (see `engines` in `package.json`)
- macOS or Linux (see `os` in `package.json`) — Windows is not currently supported
- `git`

## Setup

```bash
git clone https://github.com/StanislavBG/claude-code-session-manager
cd claude-code-session-manager
npm ci
```

## Running

```bash
npm run dev    # Vite + Electron with HMR (SM_DEV=1)
```

## Before opening a PR

Run these and make sure they pass:

```bash
npm run typecheck
npm run lint
npm run test:unit
```

- `npm run typecheck` — `tsc --noEmit` against both the renderer and main process configs.
- `npm run lint` — unstable test selectors, conditional hooks, and doc-hierarchy checks.
- `npm run test:unit` — the Vitest unit suite.

If you're touching a UI surface, exercise it manually in the running app too — the unit suite
checks correctness, not that a feature actually works end to end.

## Opening an issue

File it at https://github.com/StanislavBG/claude-code-session-manager/issues with repro steps
(or the behavior you'd like to see) and your OS/Node version.

## Opening a pull request

- Keep the PR focused on one change.
- Match the existing code style — no new backwards-compat shims; rename/refactor directly
  (this is a single-author project by convention, but the same rule applies to external PRs).
- Make sure `npm run typecheck`, `npm run lint`, and `npm run test:unit` all pass before pushing.
- Describe what changed and why in the PR description.

## Reporting a security issue

Do not open a public issue for a security vulnerability — see [SECURITY.md](SECURITY.md) for
the private reporting process.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you're
expected to uphold it.
