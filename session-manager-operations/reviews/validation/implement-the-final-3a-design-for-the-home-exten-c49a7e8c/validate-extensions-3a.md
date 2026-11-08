# Validation — Extensions 3a plan (PRDs 2853–2876)

Base: d8d77193de80d4b701b8688c7b1e686ce25f459e (37 commits to HEAD; plan code touches ~100 files).
Method: PRD files read from prds-archived/ (incl. fix PRDs 2867-fix, 2875-fix); every gate re-run as a superset:
full `timeout 880 npm run test:unit` (965 files / 9284 tests passed, 1 skipped), `npm run typecheck` exit 0,
`npm run lint` exit 0 (includes lint:selectors/hooks/docs; e2e budget 18/19), `npm run lint:page-stewards` clean,
`npx playwright test -c tests/web-ui/playwright.config.ts extensions-shots.spec.ts` 1 passed.
These cover every per-PRD vitest path (all gates are subsets of the full suite).

## Verdicts

| PRD | Verdict | Evidence |
| --- | --- | --- |
| ext3a-folder-tabs | VERIFIED | src/renderer/components/ui/FolderTabs.tsx + FolderTabs.test.tsx pass in full suite; lint clean |
| ext3a-savebar-clean-status | VERIFIED | SaveBar.tsx + SaveBar.test.tsx pass; "Saved — matches the file on disk" visible in skills-light.png |
| ext3a-paper-markdown-editor | VERIFIED | lib/monacoPaperTheme.ts + test pass; editor paper theme visible in screens |
| ext3a-extensions-toolbar | VERIFIED | tabs/extensions/ExtensionsToolbar.tsx + test + zLayers test pass; "+ New" menu in screens (plugins menu render) |
| ext3a-file-age-hook | VERIFIED | lib/useFileAges.ts + test pass |
| ext3a-extension-counts-hook | VERIFIED | lib/useExtensionCounts.ts + test pass; tab counts visible in screens |
| ext3a-mcp-tools-probe | VERIFIED | mcpToolsProbe.test.cjs/mcpStatus.test.cjs pass. Real-path probe: `checkConfiguredMcpServer({source:'user',name:'fetch'})` → `{ok:true,status:'connected',tools:[fetch]}`; `playwright` → connected with many tools |
| ext3a-mcp-check-ipc | VERIFIED | src/main/ipcSchemas.cjs:696-712 `mcpCheckServer` is `.strict()`, names only source/name/cwd/pluginKey (absolute cwd, key regex); src/main/index.cjs:600 reads config from disk in main, `validatePath(cwd)`; mcpCheckServerIpc.test.cjs passes |
| ext3a-mcp-check-preload | VERIFIED | src/preload/index.cjs:122 `checkServer`; apiSurface.json:355 `"remote":"deny"`; src/preload tests pass |
| ext3a-mcp-checks-store | VERIFIED | state/mcpChecks.ts + test pass |
| ext3a-plugin-contents-lib | VERIFIED | lib/pluginContents.ts + test pass |
| ext3a-skill-frontmatter-body | VERIFIED | lib/skillFrontmatter.ts, tests/unit/skillFrontmatter.spec.ts pass |
| ext3a-file-explorer-reveal | VERIFIED | lib/revealInFileExplorer.ts, FileTree.reveal + ProjectsWorkspace.reveal tests pass; "Reveal in File Explorer" link in screens |
| ext3a-extensions-frame | VERIFIED | SectionFrame.tsx:17-50 `hideTitle` drops h1; SectionFrame.test.tsx:65 asserts every other framed Home page still shows its title; Extensions.test.tsx passes |
| ext3a-skills-list | VERIFIED | Skills.tsx + Skills.scenario.test.tsx pass (fix PRD 2867-fix landed); list sections (Skills / Slash commands / From plugins) in screens |
| ext3a-skills-detail | VERIFIED | tabs/extensions/SkillDetail.tsx; scenario tests pass; detail header, description, file row, Source/Preview in screen |
| ext3a-skills-new-item | VERIFIED | scenario tests pass; "+ New" menu |
| ext3a-skills-plugin-group | VERIFIED | tabs/extensions/PluginSkillsGroup.tsx; "session-manager-dev 4 skills" rows in screen |
| ext3a-mcp-list | VERIFIED | McpServers.test.ts:307 "never probes on mount": `mcp.status` and `mcp.checkServer` not called; mcpConnectionState test passes |
| ext3a-mcp-detail | VERIFIED | tabs/extensions/McpServerDetail.tsx; McpServers.test.ts (803 lines changed) passes; mcp-light.png |
| ext3a-mcp-plugin-servers | VERIFIED | McpServers/McpServerDetail plugin-source tests pass |
| ext3a-plugins-cards | VERIFIED | plugins/PluginCard.tsx + test, Plugins.enable.test pass; `grep window.confirm\|confirm(` in Plugins.tsx → none (inline uninstall confirm per §7) |
| ext3a-web-ui-shots | VERIFIED | playwright gate passed (27s); six PNGs regenerated in test-results/extensions-3a and copied to screens/; compared with design-mocks renders (skills-light vs 01-skills-source): same folder tabs, toolbar, list sections, detail, save bar. Differences are fixture content and decided §7 deviations (Learn/eyebrow kept; no sidebar chrome in harness) |
| ext3a-docs | VERIFIED | `npm run lint` (incl. lint:docs) exit 0; lint:page-stewards clean |

Full suite at plan end: test:unit, typecheck, lint all green.

## Screens
screens/skills-light.png, skills-dark.png, mcp-light.png, mcp-dark.png, plugins-light.png, plugins-dark.png
(mocks: design-mocks/extensions-3a/renders/01–05).

## Findings

| Severity | Finding | Location |
| --- | --- | --- |
| Critical | none | |
| Important | none | |
| Minor | `git diff <base>..HEAD` also contains unrelated restore-CLI-session work (RestoreSessionPanel, restorableSessions, NewEpicCard, epicWorktreeMint) from a concurrent plan; not attributable to this plan, not reviewed as part of it | src/main/lib/epic/restorableSessions.cjs, src/renderer/components/epics/* |
| Minor | `GlobalControlsSection.tsx`, `EffectiveTree.tsx` and related tests were deleted in the same range (Library/Plugins slimming); full suite and typecheck show no dangling references | src/renderer/components/tabs, ui/EffectiveTree.tsx |
| Minor | Screenshots are fixture-driven so file contents differ from mock renders; no pixel diff (out of scope per fix PRD) | tests/web-ui/extensions-entry.tsx |
| Minor | Foreign dirty files (project-pages/*.html) ignored per instructions | — |

Review tooling: self-review of the security-relevant surface (IPC schema strict, cwd validated, remote deny, no renderer-named command). No secrets or path traversal found.
