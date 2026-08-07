---
title: Docs pass — retire Browser tab + Web Remote from CLAUDE.md and ops docs
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: electron-refactor-into-node-js-server-browser-fo-4c8f644f
sourceTabId: 8a7cbc80-2fb6-46f2-a86d-cbb7a7b9906e
dependsOn: [delete-browser-tab, delete-web-remote]
---
# Goal

The Browser tab and Web Remote are described in several places in CLAUDE.md and the operations docs as live, load-bearing surfaces. With both deleted, those descriptions are actively misleading to every future session. This PRD brings the always-loaded instruction files back in line with the tree, and removes the now-stale `browser` OWNERS exception. Documentation only — no code changes.

# Acceptance criteria

- [ ] `CLAUDE.md`'s "Web-remote v2 mobile cockpit" section is removed entirely, along with the `webRemote.cjs` bullet in the Main-process architecture list and the `components/tabs/WebRemote.tsx` bullet in the Renderer list
- [ ] `CLAUDE.md`'s `browserView.cjs`/`browserCapture.cjs`/`browserAgentServer.cjs` references are removed, including the mention of a future MCP server wrapping the browser-agent HTTP API
- [ ] The single-writer-law section no longer lists `browser → browser` as an OWNERS namespace, and the sentence calling `browser/` "the one exception that IS in OWNERS" is deleted — not reworded, since the exception no longer exists
- [ ] Any CLAUDE.md text describing the mobile cockpit as the reason Web Remote exists, or the Bilko-repo relay integration, is removed or reduced to a one-line historical note pointing at git history
- [ ] `session-manager-operations/` namespace READMEs are checked; if a `browser` README or ownership claim exists anywhere under that root, it is removed and the folder's status stated explicitly
- [ ] The Distribution section still accurately describes the Electron/npx launch path — Electron is being KEPT, so nothing there changes
- [ ] A grep of `CLAUDE.md` for `webRemote`, `WebRemote`, `web-remote`, `browserView`, `browserCapture`, `browserAgent` returns only intentional historical notes, if any
- [ ] `npm run health` passes and no code file is modified by this PRD (verify with `git diff --name-only` — only `.md` files should appear)

# Implementation notes

Depends on BOTH deletion PRDs — run only after `delete-browser-tab` and `delete-web-remote` have landed, so the docs describe the tree as it actually is.

Established facts:
- CLAUDE.md's single-writer-law section currently names five owners: `prompt-sessions → epics`, `scheduler → scheduler`, `project-brief → project-home`, `browser → browser`, `bilko-host → bilko-host`. Only `browser` goes; the other four stay.
- That same section contains a long parenthetical explaining that `browser/` "is the one exception that IS in OWNERS ... don't move it out without checking `opsOwnership.cjs` first." That whole aside is now dead and should be deleted rather than edited.
- The `no-general-namespace` bullet enumerates non-OWNERS folders (`architecture/`, `design-mocks/`, `HUMAN_LEARN/`, `reviews/`, `logs/`, `project-pages/`, `feedback/`, `bilko-host/`). CLAUDE.md itself states any new top-level folder "must land in this enumeration or in OWNERS" — if `browser/` remains on disk as a plain artifact folder after `rehome-savebinary-off-browser-ns` removed its write grant, add it to THAT enumeration; if it is gone, say nothing.
- `session-manager-operations/architecture/ops-maintenance-protocol.md` documents exactly this drift class (declared-vs-actual ownership). Consider running its Pattern A check as verification, but do not act on unrelated findings in this PRD — report them instead.
- The repo's marketing page in `~/Projects/Bilko/` may describe Web Remote as a feature. That is a DIFFERENT repo and out of scope; note it in the completion report so the human can decide.

Keep CLAUDE.md's dense, cross-referencing house style. Do not rewrite unrelated sections, do not "tidy" prose, and do not shorten sections that are still accurate.

# Out of scope

- Any change to a `.ts`, `.tsx`, `.cjs`, or `.json` file
- Editing ~/Projects/Bilko/ or the bilko.run marketing page
- Rewriting or condensing CLAUDE.md sections unrelated to Browser tab / Web Remote
- Acting on unrelated ops-drift findings — report them instead
- Anything about removing Electron — Electron is explicitly being kept

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
