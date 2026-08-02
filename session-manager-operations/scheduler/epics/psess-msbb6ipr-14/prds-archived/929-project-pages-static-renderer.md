---
title: Project Pages — port component library into a static HTML renderer
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 25
sourcePromptId: psess-msbb6ipr-14
---
# Goal

Port the saved Project Pages component library into real, typechecked .tsx source and compile it into a deterministic, Node-invocable static HTML renderer. The library defines 3 lenses (marketing/feature/architecture), each a stack of slots with 3-4 variant components and 3 named presets — read the saved source before writing anything. The renderer's job is purely mechanical: given a project summary JSON and a slot→variant picks JSON, produce 3 fully self-contained HTML strings (inline CSS, locally-hosted fonts, zero network calls, zero client-side JS) — no live React recomposition inside the app, ever. This PRD does NOT implement summary synthesis or variant selection (later PRDs in this chain) — it only builds the renderer and a CLI entrypoint that already-produced summary.json/picks.json can be fed into.

# Acceptance criteria

- [ ] Read session-manager-operations/design-mocks/project-pages-component-library/README.md and source/*.jsx (00 through 40, in that numeric order — later files splice slots into earlier globals via IIFEs) before writing any code.
- [ ] Ported source lives at src/renderer/lib/projectPages/library/ as real .tsx modules: kit.tsx (design tokens + shared primitives, from 00-*.jsx, WITHOUT the sample PROJ constant — that becomes the ProjectPageSummary input type, not a hardcoded value), marketingSlots.tsx, featureSlots.tsx, architectureSlots.tsx (slot/variant/preset definitions per lens, from 10/11, 20/21, 30-*.jsx respectively — folded into single files per lens rather than kept split core/depth), and index.ts exporting a typed LENS_LIBRARY: Record<'marketing'|'feature'|'architecture', PageLensDef> where PageLensDef = { id, label, blurb, slots: SlotDef[], presets: PresetDef[] } (SlotDef = { id, label, variants: VariantDef[] }, VariantDef = { id, label, note, component: React.ComponentType<{ summary: ProjectPageSummary }> }).
- [ ] Define ProjectPageSummary type in src/renderer/lib/projectPages/summaryType.ts matching the shape documented in session-manager-operations/architecture/project-pages-pipeline.md's Stage 1 section (identity, stats[], pillars[], feature, architecture, quotes[] — quotes[] may be empty). Every ported slot-variant component takes `summary: ProjectPageSummary` as a prop instead of reading the sample library's hardcoded global PROJ constant.
- [ ] Define ProjectPagePicks type: Record<lensId, Record<slotId, variantId>>.
- [ ] Add src/renderer/lib/projectPages/render.tsx exporting `renderProjectPages(summary: ProjectPageSummary, picks: ProjectPagePicks): { marketing: string; feature: string; architecture: string }` using react-dom/server's renderToStaticMarkup — each returned string is a complete <!DOCTYPE html> document with inline <style> (no external stylesheet links) and self-hosted @font-face src (see 'Fonts' below), and renders ONLY the slots present in that lens's picks, in the lens's defined slot order, falling back to the lens's preset v1 pick for any slot missing from picks.
- [ ] Fonts: extract the 3 font families (Geist, IBM Plex Mono, Newsreader) as local static assets (the saved bundle's manifest has them gzip+base64 inside its __bundler/manifest script — decode and save the woff2 files, do not fetch from Google Fonts) to a location the renderer can inline as base64 data: URIs in the generated HTML's @font-face src, OR document a deliberate simpler fallback (e.g. font-family stack with system fallbacks and no embedded font data) if embedding all variants is impractical in this PRD's scope — state the choice explicitly in the PR/commit, do not silently drop fonts without saying so.
- [ ] Add scripts/render-project-pages.cjs — a Bash-invocable CLI: `node scripts/render-project-pages.cjs <summary.json path> <picks.json path> <output dir>` that requires a pre-built bundle (see build step below), calls renderProjectPages, and writes marketing.html/feature.html/architecture.html into <output dir> plus a manifest.json ({ generatedAt: null — leave this field out or note the executor must stamp it, since Date.now() is unavailable in some contexts; the calling agent stamps this, not the script; OR have the script accept generatedAt as a 4th CLI arg and require the caller to pass it}). Choose ONE of these two approaches and document it in the script's header comment.
- [ ] Add an esbuild-based build step (npm script `build:project-pages`, e.g. `node scripts/build-project-pages-renderer.mjs` using the esbuild devDependency — add esbuild to package.json devDependencies if not already present as a direct dependency) that bundles src/renderer/lib/projectPages/render.tsx (entry) into a single CJS file scripts/render-project-pages/dist/renderer.cjs, which render-project-pages.cjs requires. Document in a header comment on both scripts that render-project-pages.cjs requires `npm run build:project-pages` to have been run first if the dist bundle is missing or stale — the CLI should print a clear error (not a cryptic MODULE_NOT_FOUND) if the bundle is absent.
- [ ] New unit test src/renderer/lib/projectPages/__tests__/render.test.tsx: build a minimal stub ProjectPageSummary + ProjectPagePicks covering at least one variant per slot in each of the 3 lenses, call renderProjectPages, and assert each returned string starts with '<!DOCTYPE html>', contains no `<script` tag, contains no `googleapis.com` or other external URL, and contains the summary's `identity.name` somewhere in the marketing output.
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/lib/projectPages/__tests__/render.test.tsx passes

# Implementation notes

Saved component library: session-manager-operations/design-mocks/project-pages-component-library/ (README.md + source/*.jsx — read-only reference, do not edit in place, only port from it). Canonical spec: session-manager-operations/architecture/project-pages-pipeline.md (Stage 0 + Stage 1 sections — Stage 1's ProjectPageSummary shape is defined there; this PRD only needs the TYPE, not the synthesis logic). Local agent protocol referencing this work: .claude/agents/project-home-builder.md. This app already has react-dom ^18.3.1 (react-dom/server is part of that package, no new dependency needed) and vite ^6 (which vendors esbuild — check node_modules/.bin/esbuild or add esbuild directly as a devDependency, whichever is more reliable for a standalone build script outside Vite's own pipeline). This app's convention is 'No CommonJS in renderer, no ES modules in main' (CLAUDE.md) — src/renderer/lib/projectPages/*.tsx follows the renderer's existing ESM/TS conventions; the CLI wrapper scripts/render-project-pages.cjs is a build/ops script outside src/, so .cjs is fine there (matches scripts/mint-epic.cjs and other existing scripts/*.cjs). Do not wire this into the app's main process or any IPC yet — that's a later PRD in this chain (project-home-project-pages-ui). This PRD's deliverable is standalone and testable via its own unit test + the CLI script run manually.

# Out of scope

- ProjectPageSummary synthesis (reading brief.json/git/repo to produce a real summary) — later PRD, done by the Epic agent directly, not by this renderer.
- Variant selection / scoring logic — separate PRD.
- Any Project Home UI change — separate PRD.
- Screenshot capture for FvShot-style placeholders — leave as the honest placeholder pattern from the saved library.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
