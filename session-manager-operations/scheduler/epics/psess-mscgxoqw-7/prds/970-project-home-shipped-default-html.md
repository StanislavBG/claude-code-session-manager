---
title: Ship a default Project Home HTML and fall back to it when no generated page exists
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-mscgxoqw-7
dependsOn: [project-home-hosted-html-spec]
---
# Goal

Ship a default Project Home HTML document with the app so a project that has never run "Generate My Project Home" still renders a real page instead of an empty state, and make the main-process read path fall back to it. Per the human's decision in Epic "Project Home Layout": session-manager ships with a default which the Generate action then replaces with a newly generated document.

# Acceptance criteria

- [ ] A default Project Home HTML document is added as a build-time asset (decide the exact location following this repo's existing asset conventions — check how other bundled non-code assets are handled and included in the vite build / electron package before choosing; state the chosen path and why in the PRD completion notes). It must be a self-contained static HTML document with inline CSS, no network calls, and no runtime JS dependency on the app — same guarantees as generated output, since it is displayed through the identical sandboxed iframe path.
- [ ] The default document's CONTENT is honest and project-agnostic: it explains what Project Home is, that this is the shipped default rather than a generated page, and prompts the reader to press "Generate My Project Home". It contains ZERO fabricated project-specific content — no invented stats, no placeholder project name presented as real, no lorem ipsum — per the pipeline spec's standing never-fabricate rule.
- [ ] Visual consistency: the default document uses the same design kit tokens the generated pages use (src/renderer/lib/projectPages/library/kit.tsx's PK palette/fonts) so the shipped default and a generated page read as the same system rather than two different products. If the simplest way to guarantee that is to GENERATE the default at build time from the same kit rather than hand-writing HTML, prefer that — state which approach you took and why.
- [ ] src/main/projectPages.cjs's get() falls back to the shipped default when the per-project session-manager-operations/project-pages/output/home.html (or manifest.json) is absent, instead of returning the null empty-state signal for the home lens. The returned payload must distinguish default-from-generated so the UI can label provenance — add an explicit field (e.g. `isDefault: boolean` and a null/absent generatedAt for the default case) rather than making the renderer infer it.
- [ ] src/preload's ProjectPagesGetResult / ProjectPagesOutput types are updated to carry that provenance flag, and the renderer compiles.
- [ ] The fallback is read-only and never writes the default into the project's own session-manager-operations/ folder — projectPages.cjs is a read-only backend by design (see its own header comment) and must stay that way; a project's output dir is written only by the project-home-builder Epic's own session.
- [ ] Path safety: the shipped default is read from the app's own install/build directory, NOT through config.cjs's validatePath (whose allowedRoots is the user's home dir and would reject or mis-resolve an app-bundle path). Read the existing validatePath usage in projectPages.cjs before changing anything and keep validatePath applied to the per-project cwd path exactly as it is today — only the default-asset read bypasses it, and it must resolve from a fixed app-relative path with no user input in it.
- [ ] A unit test covers: (a) generated output present → returns it with isDefault false, (b) output absent → returns the shipped default with isDefault true, (c) the default path resolution does not depend on cwd.
- [ ] The default renders correctly in both light and dark app themes if the app has both — since it is inside an iframe it does not inherit app CSS, so confirm explicitly what it looks like against the app's background and state the result; if it can only be verified visually and no screenshot tooling is wired for this surface, say so plainly rather than claiming visual confirmation that was not performed.
- [ ] timeout 300 npm run typecheck passes; timeout 300 npm run test:unit passes; npm run lint:selectors passes.

# Implementation notes

Read session-manager-operations/architecture/project-pages-pipeline.md first — sibling PRD 968 rewrites it to specify the shipped-default requirement, its provenance/honesty constraints, and the default-vs-generated UI distinction. That text wins over this PRD if they disagree.

Current read path, verified 2026-08-03 (read the file yourself, it is short — ~65 lines):
src/main/projectPages.cjs
  outputDir(cwd) = path.join(cwd, 'session-manager-operations', 'project-pages', 'output')
  const LENSES = ['home', 'marketing', 'feature', 'architecture']   // note: PRD 969 adds 'brief' — if 969 has already landed when you run, respect its version
  get({cwd}) validates cwd via config.validatePath, reads manifest.json then every <lens>.html, and returns { output: null } if the manifest is missing/unparseable, if ANY lens html is missing, or if generatedAt is not a string.
  Registered as ipcMain.handle('project-pages:get', ...) from registerProjectPagesIpc(), called by index.cjs line ~65.

The consumer is src/renderer/components/tabs/projecthome/projectpages/ProjectPagesSection.tsx, which treats `output === null` as the "no pages yet, show Generate Now" empty state. Adding a fallback changes that contract — make sure the section still behaves sensibly (it should now show the default document with a provenance chip rather than the bare empty state for the home lens). Keep that change minimal here; the full ProjectHome.tsx layout refactor is sibling PRD 970 and this PRD should not pre-empt it.

Do NOT reuse config.cjs's validatePath for the app-bundle asset read — allowedRoots is the user home dir and the app bundle may live outside it (npx/global npm install). Use a path derived from __dirname / app.getAppPath() with no user-controlled segment.

# Out of scope

- Refactoring ProjectHome.tsx's layout to make the hosted HTML its primary content (sibling PRD 970)
- Adding the brief lens (sibling PRD 969)
- Any write path into a project's project-pages/ folder
- Per-project customization of the default

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
