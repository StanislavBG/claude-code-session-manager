---
title: Plugins: full-page Skill Home replaces bottom-drawer skill browser
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

The Plugins tab currently has 3 nav levels: Plugins (List) → Plugin Home (src/renderer/components/tabs/Plugins.tsx, component `PluginHomePage`) → Skills list (within Plugin Home's section content). Clicking a skill row opens `PluginSkillBrowser` (src/renderer/components/tabs/plugins/PluginSkillBrowser.tsx) as a fixed `h-80` drawer docked at the bottom of the page, showing an inline list+detail. Replace that drawer with a full 4th nav level: Plugins (List) → Plugin Home → Skills (list) → Skill Home (full page), so selecting a skill takes over the whole content area the same way selecting a plugin row already does today (PluginHomePage replaces the KVTable in place — mirror that same pattern one level deeper).

# Acceptance criteria

- [ ] A new `SkillHomePage` component (co-located in src/renderer/components/tabs/plugins/, e.g. PluginSkillBrowser.tsx or a new file) renders a full-height page: header row with a `← <plugin name>` back button (mirrors PluginHomePage's `← Plugins` back link at Plugins.tsx:407) + the skill's name, thin meta strip row (mirrors Plugins.tsx:430-460) showing the skill's description if present, and a full-height content body rendering the skill's markdown body via the existing `MarkdownEditor` (read-only), reusing the same file path/value/onChange={()=>{}} pattern already used in PluginSkillBrowser.tsx:91.
- [ ] In Plugins.tsx's `PluginHomePage`, clicking a skill row in the Skills section (`SectionContent`'s `onOpenSkill` callback, Plugins.tsx:495/540) now sets a selected-skill state that swaps PluginHomePage's own body (header+meta+section-index+content, Plugins.tsx:404-499) for the new SkillHomePage full page — not the old bottom-drawer `PluginSkillBrowser` render at Plugins.tsx:501-508, which is removed from this call site.
- [ ] The SkillHomePage back button returns to PluginHomePage's Skills section list (the section index + skills list state, i.e. `active==='skills'`), not all the way back to the Plugins list.
- [ ] The existing `SkillReferenceGraph` view (currently a list/graph toggle inside PluginSkillBrowser, PluginSkillBrowser.tsx:21-58) is preserved and reachable: add it as a toggle within the new SkillHomePage (list body vs graph body), keeping the existing `detectSkillEdges` call and props (skills, edges, selectedId, onSelect) — selecting a different skill in the graph should navigate within SkillHomePage without leaving the full-page view.
- [ ] PluginSkillBrowser.tsx's old drawer-only rendering (the outer `h-80 border-t` wrapper div) is deleted — the file becomes (or is replaced by) the full-page SkillHomePage component; do not leave two parallel unused implementations.
- [ ] src/renderer/components/tabs/__tests__/PluginHomePage.test.ts is updated: the existing 'Agents' section-click test still passes unmodified in behavior, and a new test (in this file or a new PluginSkillBrowser/SkillHomePage test file) clicks a skill row inside Plugin Home's Skills section, asserts the table/section-index Plugin Home body is replaced by the full-page Skill Home view (header shows the skill name + a back button whose text references the plugin), asserts the skill's markdown body text renders, then clicks the back button and asserts Plugin Home's Skills section list is shown again (not the outer Plugins table).
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npx vitest run src/renderer/components/tabs/__tests__/PluginHomePage.test.ts` (and any new/renamed skill-browser test file) passes.

# Implementation notes

Read plugins/session-manager-dev/skills/develop/standards.md (absolute path: /home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md) before starting — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD.

Key files:
- src/renderer/components/tabs/Plugins.tsx — `PluginHomePage` (lines ~291-511) is the pattern to mirror: header row (line 406-427), meta strip (429-460), and full-height body swap driven by a `selected`/`active` state in the parent (see how `Plugins()` itself swaps KVTable for PluginHomePage at line 211-212 based on `selectedRow`). `browsingSkill` state (line 305) currently drives the old drawer at 501-508 — replace this with a full-page swap of PluginHomePage's own render.
- src/renderer/components/tabs/plugins/PluginSkillBrowser.tsx — has the MarkdownEditor rendering (line 91), the list/graph toggle (lines 21, 50-58), and `detectSkillEdges` usage (line 20) to reuse/adapt into the new full-page component. Keep the `ListDetail` sidebar-of-skills-in-plugin pattern if useful, or replace with PluginHomePage-style layout — your call, but keep list/detail navigation between skills working within the full page (i.e. you can still switch to a different skill without leaving Skill Home, similar to how the current drawer's sidebar works).
- src/renderer/components/tabs/plugins/SkillReferenceGraph.tsx — the graph view component, unchanged in behavior, just re-hosted.
- src/renderer/lib/pluginSkills.ts — `PluginSkillEntry` type, `detectSkillEdges`.
- src/renderer/components/ui/MarkdownEditor.tsx, EmptyState.tsx, ListDetail.tsx — existing primitives to reuse, do not reimplement.
- src/renderer/components/tabs/__tests__/PluginHomePage.test.ts — existing test harness/mocks (`installWindowApiMock`, `flush()`) to extend for the new skill-click flow; it already mocks a `my-skill` skill with SKILL.md body 'Body text.' and description 'Does the skill thing. More detail here.' — reuse these fixtures for the new assertions rather than inventing new ones.

Follow the existing visual conventions already established in PluginHomePage (font-mono/font-serif classes, `text-fg-faint`/`text-fg-dim`/`text-accent` color tokens, `border-line` dividers) so Skill Home looks like a sibling of Plugin Home, not a different design system.

# Out of scope

- Do not touch the standalone Skills.tsx tab (src/renderer/components/tabs/Skills.tsx) — different, already-correct list+detail surface, unrelated to this change.
- No changes to how plugins are discovered/listed, manifest parsing, or the Installed/Library toggle.
- No new persistence of which skill was last viewed across app restarts — in-memory nav state only, matching how `selected`/`browsingSkill` work today.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
