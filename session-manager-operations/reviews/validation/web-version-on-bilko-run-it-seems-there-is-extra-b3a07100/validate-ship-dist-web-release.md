# Validation: ship-dist-web-in-package-and-installers, builder-publish-worktree-outside-tmp

Base: 9d159322. Commits: 8e18cf3a (package.json, build-scripts test), 78c42e1c (builder SKILL.md).
Self-review only (no extra review tooling run); diff is 3 files, +78/-12.

## ship-dist-web-in-package-and-installers — VERIFIED
- `build` runs both vite configs: package.json:40. `prepublishOnly` = write-build-info then `npm run build`: package.json:50 (write-build-info stays first).
- `dist:stage` = `npm run build && node scripts/package/stage.cjs`: package.json:42; stage.cjs untouched (not in diff), so the missing-path guard stays.
- scripts/package/__tests__/build-scripts.test.cjs exists (+48 lines). `npx vitest run build-scripts stage`: 3 files, 51 tests passed.
- Gate `npm run build`: exit 0; dist/index.html (1009 B) and dist-web/index.html (819 B) both present. vite outDirs: vite.config.ts:16 `dist`, vite.web.config.ts:34 `dist-web`.
- `npm pack --dry-run`: lists `dist-web/index.html` (819B) and `dist/index.html` (1.0kB).

## builder-publish-worktree-outside-tmp — VERIFIED
- Worktree at `$HOME/.cache/sm-publish/v<version>`; created at SKILL.md:43-44, removed at :97; "Never under /tmp" explained at :46-48.
- After `npm ci`: `npm run typecheck` and `npm run test:unit` (:54-55), stop on failure (:58-59). `test -f dist-web/index.html && test -f dist/index.html` at :64, stop before publish if missing (:65).
- Step 10 (:100-110): cache-busted `curl registry.npmjs.org/<pkg>?t=<epoch>`, tarball `curl -sI`, and says unchanged `npm view` for minutes is normal lag.
- Gate `grep -q .cache/sm-publish SKILL.md`: exit 0.

## Findings
- Critical: none.
- Important: none.
- Minor: SKILL.md:60-61 says "plus any web build that produces dist-web/", which is vague now that `npm run build` produces both. Harmless; the existence check at :64 is the real guard.
- Minor: I did not run the full `test:unit` suite (outside either PRD's gate).
