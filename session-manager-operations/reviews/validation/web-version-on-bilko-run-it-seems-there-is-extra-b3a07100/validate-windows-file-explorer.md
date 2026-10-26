# Validation — Windows File Explorer plan

Base: 51eb7ce0. Commits: 031c5995 (2294), 5ecb69ac (2295), cc7f22fd (2296), 2c9831c2 (2297), 56bd6cc9 (2298).
Gates re-run (foreground): all vitest gates green (83/17/148/25/128 tests), `npm run typecheck` green, `npm run lint` green.
/code-review and /security-review were not run as skills; self-reviewed the diff (path traversal, roots source, prefix trap).

## win-smfile-drive-letter-path — VERIFIED
- `smfileUrl` splits on `/[\\/]/` and encodes per segment: src/renderer/state/editor.ts (diff 031c5995), test editor.smfileUrl.test.ts.
- `smfileUrlToPath(pathname, platform)` in src/main/lib/smfileHeaders.cjs strips leading `/` before a drive on win32, win32-normalizes; posix only decodes. index.cjs handler calls it before assertInsideHome.
- Relative assets resolve via same normalization (`/C:/Users/me/site/chart.js` -> `C:\Users\me\site\chart.js`); covered by smfileUrlPath.test.cjs.
- Tests present (smfileUrlPath.test.cjs, editor.smfileUrl.test.ts); gate green.

## win-one-path-comparator — VERIFIED
- insideHome.cjs:`realpath` uses `realpathSync.native` w/ fallback, ENOENT parent walk; `isContainedIn` exported and used by `isContained`.
- `isContainedWin32`: lowercase, win32-normalized, trailing-sep trimmed (drive root `D:\` works), UNC vs non-UNC mismatch false, `\\?\` always false.
- config.cjs routed through isContainedIn (5ecb69ac); tests winPaths + configValidatePathWin32 pass.
- Minor: a UNC home matching itself is by normalized equality; OK.

## win-project-roots-in-files-pty — VERIFIED (with Important finding below)
- files.cjs `validateHomePath` -> `assertInsideHomeOrRoots(expandHome(abs), getAllowedRoots())`; pty.cjs uses `checkInsideHomeOrRoots(cwd, getAllowedRoots())`. Roots come from config.cjs registry, not the request.
- Error text `path outside home and project roots: <path>` (insideHome.cjs:144).
- `isCriticalPath` case-insensitive on win32, includes home; credential/ssh guards untouched.
- filesProjectRoots.test.cjs present; ci.yml windows vitest list gained the three files.

## win-renderer-path-separators — VERIFIED
- src/renderer/lib/pathSep.ts exports dirname/basename/join/segments/isUnder (+sepOf); FileTree.tsx and compactPath.ts adopt it; tests pathSep.test.ts, FileTree.winPaths.test.ts pass.
- Minor: pathSep.isUnder is case-sensitive (win32 case-insensitivity done in chatFileLinks wrapper) — fine for criteria.

## win-chat-terminal-file-links — VERIFIED (with Important finding below)
- chatFileLinks.ts FILE_LINK_RE matches `C:\..`, `C:/..`, `src\a.ts:12`; `mapGitBashPath` maps `/c/Users/..` -> `C:\Users\..` on win32; Terminal.tsx uses shared `resolveFileLinkTarget`; handleChatLinkClick uses `isUnderProject` (case-insensitive on win32). Tests extended; gate green.

## Findings
### Critical
- none
### Important
- src/renderer/lib/handleChatLinkClick.ts:39 compares `primaryRead.error === 'path outside home'`, but files.cjs now returns `path outside home and project roots: <path>` (insideHome.cjs:144). The "outside the project" toast therefore never fires for genuinely outside paths (silent no-op, violates "never swallow errors" convention). Fix: use `startsWith('path outside home')`, and update the handleChatLinkClick test to the new message.
### Minor
- pathSep.ts `isWin32()` sniffs navigator.userAgent rather than a platform source; acceptable per PRD (no new IPC).
- Legacy `assertInsideHome`/`checkInsideHome` still emit bare 'path outside home' (insideHome.cjs:103-128), so two message variants coexist.
