# Validation: fix wave 1

Base: f09026c4 (known). Commits: 45bea35f (chat link), fe0d566e (ci-windows), c8ef78d4 (fence), eb59efe5 (zod dual), 906da4a7 (zod bump).
Gates were run in the foreground. zod 4 gates ran in a private `npm ci` node_modules (worktree symlink removed; the main checkout was untouched, and its zod stays 3.25.76).

## chat-link-outside-root-toast — VERIFIED
- `src/renderer/lib/handleChatLinkClick.ts:39` uses `primaryRead.error?.startsWith('path outside home')`, which covers both message forms.
- The test (`handleChatLinkClick.test.ts` `it.each`) covers the bare text, the new `...and project roots: /etc/passwd` text, and `EACCES` (no toast).
- The diff for this file is one line, so there is no other behavior change.
- Gate `vitest run handleChatLinkClick chatFileLinks` + typecheck: green.

## ci-windows-job-test-list — VERIFIED
- `ci-windows-job.test.cjs` `UNIT_FILES` now has 12 entries, with the 3 new ones appended in the order of the ci.yml line (the order assertion passes).
- A new `lists only test files that exist on disk` test uses `fs.existsSync`.
- ci.yml is not in the diff.
- Gate `vitest run ci-windows-job`: green.

## remote-files-read-fence — VERIFIED
- `remoteIpcDispatch.cjs` exports `remoteArgFence` and `PATH_FENCED_CHANNELS` (files:read, files:list, transcript:readRef, transcript:path, memory:read).
- `invoke` calls the fence before the handler and returns `{ok:false,reason:'path_fenced'}`. It fails closed if `fenceCtx` is missing for a fenced channel.
- Secret segments and basenames are matched on both the raw path and the realpath, lower-cased on win32.
- Project-root containment reuses `isContainedIn` from `insideHome.cjs`. Home listing is allowed for files:list only.
- All 7 required test scenarios are present and pass: project file, home file, ~/.ssh key, symlink into ~/.ssh, .env, win32 upper-case, home listing. There is also a test that the handler is not called.
- The dispatcher is still unwired, and `webRemote.cjs`, `index.cjs` and `files.cjs` are untouched.
- Gate `vitest run remoteIpcDispatch apiSurface winPaths` + typecheck: green.

## zod-v4-dual-compatible-code — VERIFIED
- `rg "z.record("` across `src/main` shows no single-argument call.
  - `ipcSchemas.cjs:841-842` were converted in `eb59efe5`.
  - The other sites were already two-argument (`ipcSchemas.cjs:191,195,290,1023,1114`; `mcpToolCatalog.cjs:30`).
  - Fewer than the PRD's "8 sites" needed changing; the PRD count was an over-estimate.
- There is no `.errors`, `.flatten()` or `.format()` use on a ZodError. `webRemote.cjs:949` only checks `e.name`.
- The gate passed on zod 3.25.76 (22 files, 286 tests, typecheck exit 0) and again on zod 4.6.7.

## zod-v4-bump — VERIFIED
- `package.json:141` has `"zod": "^4.6.7"`. `package-lock.json` `node_modules/zod` resolves to 4.6.7.
- In the private node_modules (zod 4.6.7), the vitest gate passed 22 files and 286 tests, and typecheck exited 0.
- `npm audit --omit=dev --audit-level=high` reported 0 vulnerabilities (exit 0).
- No source or test changes were needed for the bump (commit 906da4a7 touches only the two package files).
- The first two vitest attempts hit the 300s/600s timeout on a cold install (import 5878s cumulative). The third run, with a warm cache, was green. This is a timing problem, not a failure.

## Findings
- Critical: none.
- Important: none.
- Minor:
  - `remoteIpcDispatch.cjs` (`remoteArgFence`, `mode:'root'`): if a registered project root is the home directory itself, any non-secret file under home is readable. The `ALWAYS` list does not cover `~/.claude` session data. Consider refusing project roots equal to home.
  - `remoteIpcDispatch.cjs` (`isSecretPath`): the `.config/gcloud` check works, but `.env` variants are matched on the basename only. `foo.env` is allowed, which is acceptable.
  - The zod-dual PRD's "8 sites" count did not match reality (2 changed). This is documentation drift only.
  - Self-review of the diff (no `/code-review` was run beyond the above): no path traversal, secrets or duplicated helpers found. The fence reuses `isContainedIn`.
