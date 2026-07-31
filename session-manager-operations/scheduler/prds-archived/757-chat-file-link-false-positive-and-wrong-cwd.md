---
title: Fix chat file-path callouts: stop matching prose identifiers, resolve across known project roots
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

The chat file-path-callout feature (`src/renderer/lib/chatFileLinks.ts`, landed in commit f8723ab) has two confirmed bugs reported by the user with reproducible screenshots: (1) its regex misclassifies plain prose like an ellipsis-prefixed ALL_CAPS identifier (e.g. `...TOOL_PROJECTS`, never a real path) as a file-path chip, producing a bogus clickable link that ENOENTs; (2) clicking a chip for a genuinely real filename (e.g. `projectsRegistry.ts`) that was mentioned while discussing a DIFFERENT project than the active tab's cwd fails with the same generic ENOENT, because `resolveFileLinkTarget` always joins relative matches onto the active tab's cwd with no awareness the file lives elsewhere. Fix the regex to stop matching non-path prose, and give the resolver a way to find a real match even when it's not under the tab's own cwd.

# Acceptance criteria

- [ ] Tighten `FILE_LINK_RE` (`chatFileLinks.ts:9`, currently `/(?:^|[\s(])((?:\.{1,2}\/)?[\w./-]+\.[A-Za-z]\w*(?::(\d+))?(?::(\d+))?)/g`) so it does not match tokens with no path separator (`/`) UNLESS the segment after the final dot is a plausible real extension: bounded length (≤ ~10 chars) AND not itself an ALL-CAPS-with-underscores token (a common JS/Python constant-naming pattern, not a file extension). Add unit tests in the existing/adjacent test file covering: `` `...TOOL_PROJECTS` `` (must NOT match), `` `TOOL_PROJECTS` `` alone (must NOT match), `projectsRegistry.ts` (must match), `src/config/tools.ts:174` (must match, with line number captured), `SessionManagerPage.tsx` (must match).
- [ ] In `resolveFileLinkTarget` (`chatFileLinks.ts:88-98`) and/or `openLinkifiedFilePath` (`handleChatLinkClick.ts:19-36`), when the naive `${cwd}/${filePath}` resolution ENOENTs, add a fallback: check whether the matched path exists under any OTHER currently-open tab's cwd (the renderer already tracks this via useSessions/sessionsStore — reuse existing tab-cwd enumeration, do not invent a new registry; see `TerminalChat.tsx:449` for an example of reading `useSessions.getState()`). If a match is found under a different tab's cwd, open it from there (the file viewer should not require switching tabs first). If no match anywhere, keep today's error but make the message explicit about which cwd(s) were tried, e.g. `ENOENT: not found under <tab-cwd> (tried N other open tabs)` instead of a bare path-not-found, so a genuinely-fictitious path is now distinguishable from a real file that's just outside every open tab's project.
- [ ] Do not weaken the boundary check already in `openLinkifiedFilePath` (the "path outside home" check at `handleChatLinkClick.ts:28`) — the new cross-tab fallback must still respect that boundary for each candidate cwd it tries.
- [ ] Add a test for the cross-cwd fallback: given two mocked open tabs with different cwds, a file-path chip resolves correctly to whichever tab's cwd actually contains the file.
- [ ] `npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run <path to chatFileLinks test file(s)>` passes.

# Implementation notes

Read first: `src/renderer/lib/chatFileLinks.ts` (`FILE_LINK_RE` at line 9, `resolveFileLinkTarget` at lines 88-98), `src/renderer/lib/handleChatLinkClick.ts` (`openLinkifiedFilePath` at lines 19-36, the `window.api.files.read` call at line 28 and its "path outside home" handling). For enumerating other open tabs' cwds, check `src/renderer/state` or wherever `useSessions`/`sessionsStore` exposes the current tab list — reuse that, don't add a new IPC round-trip if the renderer already holds this in memory. Two real production examples that triggered this bug (for test fixtures): the string `...TOOL_PROJECTS` appeared in an assistant message quoting a JS constant name from a completely different repo (`~/Projects/Bilko`), and `projectsRegistry.ts` / `SessionManagerPage.tsx` were mentioned as real files that live under `~/Projects/Bilko/src/data/` and `~/Projects/Bilko/src/pages/` respectively, while the active chat tab's cwd was `~/Projects/session-manager` the whole time.

# Out of scope

- Redesigning the callout UI/chip styling
- Any change to the MCP-consent-grant or URL-copy-button fixes from the same commit f8723ab — unrelated
- A full project-index/search feature — the cross-tab fallback only checks OTHER OPEN tabs' cwds, not an arbitrary filesystem search

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
