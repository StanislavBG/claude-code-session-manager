# Skills Research Loop — 7-Pass Summary

**Window:** 2026-04-05 00:01 → 06:08 PDT (6 hours, 7 passes)
**Sources mined:** 3 meta-lists, 17 official external plugins, 4 trending MCP leaderboards, HN/X/Bluesky posts, vendor skill directory (officialskills.sh), user's local Edge history + bash_history.
**Total candidates surfaced:** 54 new (after 7-way dedupe: 52).

---

## Top 20 Recommendations (ranked)

| # | id | kind | score | install |
|---|---|---|---|---|
| 1 | **skill-simplify** | skill | 0.99 | SHIPPED in claude-code v2.1.92 (built-in) |
| 2 | **skill-batch** | skill | 0.98 | SHIPPED in claude-code v2.1.92 (built-in) |
| 3 | **mcp-mindsdb** | mcp | 0.94 | data unification — 39k⭐ |
| 4 | **plugin-terraform** | plugin | 0.93 | `/plugin install terraform@claude-plugins-official` |
| 5 | **plugin-firebase** | plugin | 0.92 | `/plugin install firebase@claude-plugins-official` |
| 6 | **everything-claude-code** | plugin | 0.91 | `/plugin marketplace add affaan-m/everything-claude-code` — 139k⭐ |
| 7 | **plugin-asana** | plugin | 0.91 | `/plugin install asana@claude-plugins-official` |
| 8 | **plugin-discord** | plugin | 0.90 | `/plugin install discord@claude-plugins-official` |
| 9 | **plugin-greptile** | plugin | 0.89 | `/plugin install greptile@claude-plugins-official` |
| 10 | **composiohq-composio** | skill | 0.88 | officialskills.sh — 1000+ app connectors |
| 11 | **trailofbits-skills** | skill | 0.88 | `git clone github.com/trailofbits/skills` |
| 12 | **terraform-mcp-hashicorp** | mcp | 0.87 | first-party HashiCorp MCP |
| 13 | **cloudflare-agents-sdk** | skill | 0.86 | officialskills.sh |
| 14 | **mcp-datadog** | mcp | 0.85 | observability — fills Sentry-only gap |
| 15 | **plugin-serena** | plugin | 0.85 | `/plugin install serena@claude-plugins-official` |
| 16 | **ios-simulator-skill** | skill | 0.85 | conorluddy/ios-simulator-skill |
| 17 | **terraform-opentofu-skill** | skill | 0.85 | pairs with #4/#12 |
| 18 | **mcp-vectara** | mcp | 0.85 | RAG/vector search |
| 19 | **superclaude-framework** | plugin | 0.84 | commands+personas framework |
| 20 | **mcp-metamcp** | mcp | 0.83 | MCP-manager GUI — *directly relevant to session-manager itself* |

Full rollup with tiers 3–4 + niche: `research/candidates/2026-04-05-FINAL-merged.json`.

---

## Critical code-changes needed in session-manager (derived from research)

claude-code **v2.1.92** shipped during this research window. Required adaptations:

1. **Skills tab** — recognize `/simplify` + `/batch` as *built-in* skills (not filesystem-backed under `.claude/commands/`).
2. **Settings editor** — add boolean toggle `disableSkillShellExecution`.
3. **Permissions/effort editor** — migrate to low/medium/high scheme (replacing old numeric levels).
4. **MCP editor** — optionally surface `_meta["anthropic/maxResultSizeChars"]` (up to 500K).

---

## Stability changes made during the 6-hour loop

| pass | file | change |
|---|---|---|
| 1 | `src/renderer/main.tsx` | Added global `unhandledrejection` + `error` listeners; early check for missing `window.api` preload bridge |
| 2 | `src/renderer/components/tabs/History.tsx` | try/finally + mid-loop cancel — no longer stuck on "scanning transcripts…" when IPC errors |
| 3 | `src/renderer/components/tabs/Projects.tsx` | Same try/finally + cancel check pattern |
| 4 | `src/renderer/state/live.ts` | `.catch()` on `transcripts.subscribe` + `transcripts.buffer` promises |
| 5 | `src/renderer/state/sessions.ts` | `addTab` guards against duplicate `providedId` (React key + PTY spawn collisions) |
| 6 | `src/renderer/components/tabs/Subagents.tsx` | try/catch around agent dir scan, fall back to empty list |
| 7 | *(see pass 7 fix below)* |  |

All passes: `tsc --noEmit` clean.

---

## Local vector DB (Plan 2) — path forward

**Unblocked in pass 4** via `node:sqlite` (Node 22 experimental builtin) — **zero new deps required**. Works end-to-end from Electron main process.

- Browser history scan: demonstrated via `/home/bilko/.config/microsoft-edge/Default/History`
- Shell history scan: 118/419 Claude-related tokens found in `~/.bash_history`
- Not yet wired into UI: proposed `src/main/vector.cjs` module with `vector:scan` / `vector:query` IPC channels + Settings opt-in toggle.

For this user's Edge profile specifically, personalization signal for skill selection is **uninformative** (40 urls, all infra topics). Fusion formula's web-reweight fallback handles this cleanly. Bash-history showed a power-user profile (61 `--dangerously-skip-permissions` launches) — used as a +0.03 tilt for multi-agent/CLI candidates.

---

## New crawl sources discovered

- `officialskills.sh` — vendor-namespaced skill directory (anthropics/*, stripe/*, cloudflare/*, netlify/*, composiohq/*)
- `claudemarketplaces.com` — 2,300 skills / 770 MCPs / 95 marketplaces
- `tolkonepiu/best-of-mcp-servers` — weekly-ranked, 450 servers, 920K combined ⭐ **← recommended primary**
- `mcpmarket.com/leaderboards` — top-100 daily
- `skillsindex.dev` — 4,133 MCPs indexed
