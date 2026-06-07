# Web Remote Launch Point — bilko.run Change

**Target file**: `/home/bilko/Projects/Bilko/src/data/standalone-projects.json`

## Change required

Update the `session-manager` entry so its `host` points to the new dedicated web
app instead of the npmjs.com package page.

### Before

```json
{
  "slug": "session-manager",
  "name": "Session Manager",
  "tagline": "Local cockpit for Claude Code CLI sessions",
  "category": "Dev Tool · CLI",
  "status": "live",
  "year": 2026,
  "host": {
    "kind": "external-url",
    "url": "https://www.npmjs.com/package/claude-code-session-manager",
    "sourceRepo": "github.com/StanislavBG/session-manager"
  },
  "tags": ["Electron", "CLI", "Free"]
}
```

### After

```json
{
  "slug": "session-manager",
  "name": "Session Manager",
  "tagline": "Local cockpit for Claude Code CLI sessions",
  "category": "Dev Tool · CLI",
  "status": "live",
  "year": 2026,
  "host": {
    "kind": "external-url",
    "url": "https://session-manager.bilko.run",
    "sourceRepo": "github.com/StanislavBG/session-manager"
  },
  "tags": ["Electron", "CLI", "Free"]
}
```

## What this does

The `HubRow` card's "Visit" / "Launch" link already reads `host.url` and renders
it as an `<a href>`. No component changes are needed — the change routes the card
link from npmjs.com to the new dedicated mobile-first web remote at
`https://session-manager.bilko.run`.

## Source

ARCHITECTURE.md §7.4:
> Update `standalone-projects.json` (session-manager entry):
> `"kind": "external-url", "url": "https://session-manager.bilko.run"`

## Status

**Applied**: The Bilko repo at `/home/bilko/Projects/Bilko` is present on this
machine. The edit was made directly to
`/home/bilko/Projects/Bilko/src/data/standalone-projects.json` as part of PRD 09
execution.
