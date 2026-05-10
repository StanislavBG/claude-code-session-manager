# Plan 1 — Web Skill Discovery Pipeline

**Goal:** Surface new + popular Claude Code skills from public web sources and merge them into `src/renderer/data/catalog.ts`.

## Sources (ranked by signal/noise)

1. **GitHub code+topic search**
   - Topics: `claude-code`, `claude-skill`, `claude-plugin`, `claude-agent`, `mcp-server`, `anthropic-mcp`.
   - Code search: path contains `.claude/skills/` with `SKILL.md`; filename `commands/*.md` under `.claude/`.
   - Rank by: stars-delta (30d), commit recency, fork count, README quality heuristic (length + code fences + install section).
2. **Anthropic official registry** — `anthropics/claude-plugins-official` (plugin bundles) + `anthropics/claude-agent-sdk-*` repos for patterns.
3. **Awesome lists** — `awesome-claude`, `awesome-mcp-servers`, `awesome-claude-code`. Parse README tables.
4. **npm + pypi** — packages tagged `mcp-server-*`, `@anthropic-ai/*`, `claude-skill-*`. Pull weekly download counts.
5. **HackerNews / Lobsters / r/ClaudeAI** — search last 30d for "claude code skill", rank by points.
6. **X / Mastodon / Bluesky** — monitor accounts: @anthropic, @claudeai, known DevRel. (Out of scope for automated pass; manual review.)

## Pipeline stages

1. **Fetch** — `WebSearch` for each query bucket, `WebFetch` top 5 per bucket (README, package.json, SKILL.md).
2. **Extract** — pull `id`, `name`, `description`, `source`, `official` flag, install command/config.
3. **Dedupe** — normalize `id` (lowercase, strip `@scope/`), hash on `source` URL.
4. **Score** — composite: `0.4*stars_norm + 0.2*recency + 0.2*download_norm + 0.1*official + 0.1*readme_quality`.
5. **Diff against `catalog.ts`** — produce add/update/remove set.
6. **Emit** — write `research/findings/web-YYYY-MM-DD-HHMM.json` with top 20 candidates + scoring breakdown.
7. **Gate** — never auto-write to `catalog.ts`; present diff for human approval.

## Queries to run this pass

- `claude-code skill github 2026`
- `anthropic mcp server new`
- `claude-code plugin awesome list`
- `claude skill marketplace popular`

## Success criteria

- ≥10 unique new candidates per pass
- Each candidate has verified install instructions
- No duplicates of existing `catalog.ts` entries
