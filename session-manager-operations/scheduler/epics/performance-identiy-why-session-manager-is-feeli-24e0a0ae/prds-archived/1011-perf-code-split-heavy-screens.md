---
title: Perf P5b: code-split the heavy screens out of the 2.48 MB single boot chunk
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
dependsOn: [perf-screen-memo]
---
# Goal

The renderer ships as one 2.48 MB chunk (dist/assets/index-*.js), parsed in full at boot, because screenComponents.tsx statically imports every screen. That pulls in react-force-graph-2d (and its d3-force dependency) via Plugins -> SkillReferenceGraph.tsx:2 for a graph that is rarely opened, plus recharts via History and the whole Scheduler cockpit. Only EditorView's Tiptap body is lazy today (EditorView.tsx:57). Split the heavy, rarely-first-opened screens behind React.lazy so boot parses less JavaScript.

# Acceptance criteria

- [ ] SkillReferenceGraph (and with it react-force-graph-2d) is loaded via React.lazy + Suspense, not statically imported.
- [ ] The History screen (and with it recharts) is loaded via React.lazy + Suspense.
- [ ] The Scheduler screen is loaded via React.lazy + Suspense.
- [ ] Each lazy boundary has a Suspense fallback consistent with the existing one at EditorView.tsx:428, and is wrapped in the existing ErrorBoundary so a chunk-load failure surfaces as a pane error rather than a blank app.
- [ ] timeout 600 npm run build succeeds and the main index chunk in dist/assets/ is at least 600 KB smaller than the 2,485,459-byte baseline. The result reports the exact before and after byte sizes.
- [ ] The split chunks are emitted as separate files (listed in the result by name and size).
- [ ] Existing tests that mock react-force-graph-2d still pass — see the vi.mock at src/renderer/state/__tests__/layout.test.ts:12, which exists precisely because this module was transitively imported via screenComponents. Update or remove that mock if the transitive import is gone, and say which.
- [ ] Navigating to each lazily-loaded screen still renders it (covered by the existing e2e or a new unit test that awaits the lazy boundary).
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.
- [ ] The result states explicitly whether react-force-graph-2d is still needed at all, with evidence, so the human can decide about removing the dependency.

# Implementation notes

Target project: /home/bilko/Projects/session-manager

Depends on perf-screen-memo landing first — both edit screenComponents.tsx and serialising them avoids a conflict. Do not start until it is complete.

Key files: src/renderer/components/screenComponents.tsx, src/renderer/components/tabs/plugins/SkillReferenceGraph.tsx:2, src/renderer/components/tabs/History.tsx (a 12-line wrapper; the real dashboard is behind it), src/renderer/components/tabs/Scheduler.tsx, vite config.

Follow the pattern already in the repo at src/renderer/components/tabs/EditorView.tsx:57 and :428 (lazy + Suspense) rather than inventing a new one.

Do NOT lazy-load Home / the terminal path / VoiceModal — Home is the boot destination and VoiceModal is on the privacy-critical recording path (CLAUDE.md privacy invariant: RecordingStatus must be mountable immediately).

This changes what ships in the published npm package. Do not publish, bump the version, or tag — build and verify only. Release is a separate, human-triggered step.

createWindow hard-fails if dist/index.html is missing and must never fall back to a remote URL (CLAUDE.md). Do not introduce any runtime chunk fetch from a non-file origin.

Renderer tests use vitest (npm run test:unit).

# Out of scope

- Publishing to npm, bumping the version, or tagging a release
- Removing the react-force-graph-2d dependency from package.json (report the finding; the human decides)
- Splitting Monaco or its workers — already separate chunks
- Any renderer-runtime behaviour change beyond the lazy boundaries

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
