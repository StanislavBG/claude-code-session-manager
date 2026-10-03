# Security Policy

## Supported versions

Only the latest published minor of `claude-code-session-manager` on npm gets security fixes.
Upgrade to the latest release before reporting an issue.

## Reporting a vulnerability

Report privately via GitHub Security Advisories:

https://github.com/StanislavBG/claude-code-session-manager/security/advisories/new

Do not open a public issue for a suspected vulnerability.

## What to expect

We aim to acknowledge a new report within 7 days. Once triaged, we'll work with you on a
fix and a coordinated disclosure timeline.

## Scope

In scope:

- The `claude-code-session-manager` desktop app and its npm package.
- The bilko.run relay used for web remote — report it through the same advisory link above.

## Security-relevant surfaces

This app is local-first: it runs on your machine and talks to the `claude` CLI already
installed there. The main surfaces worth knowing about:

- **Local admin API** — a loopback-only (`127.0.0.1`) HTTP server, bound to an OS-assigned
  ephemeral port, protected by a bearer token regenerated every app boot.
  See [`src/main/lib/localAdminHttp.cjs`](src/main/lib/localAdminHttp.cjs).
- **Terminal sessions** — interactive shells spawned via `node-pty`.
  See [`src/main/pty.cjs`](src/main/pty.cjs).
- **Scheduler `claude -p` jobs** — headless `claude` CLI processes the scheduler spawns to
  execute queued PRDs.
  See [`src/main/lib/runClaudeP.cjs`](src/main/lib/runClaudeP.cjs).
