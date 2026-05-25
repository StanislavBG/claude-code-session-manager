---
id: documentation/refresh-claude-md
title: Refresh CLAUDE.md against current repo state
category: Documentation
sendMode: auto-fire
description: Updates commands, paths, conventions, architecture notes; splits files past ~300 lines.
---
Invoke the `refresh-claude-md` skill. Diff the current `CLAUDE.md` against the actual state of the repo: read `package.json` scripts, look for new top-level directories, check `git log --since="30 days ago"` for architectural shifts, scan for new tooling configs (eslint, vitest, playwright, etc.). Update commands, file paths, conventions, and architecture notes that have drifted. Split the file if it has grown past ~300 lines. Do not add filler; remove anything stale.
