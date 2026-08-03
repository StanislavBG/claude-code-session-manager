---
title: Wire Epic-context digest into scheduled PRD dispatch + provenance
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-mscg8i3u-2
dependsOn: [950-epic-context-digest-builder]
---
# Goal

In `src/main/scheduler.cjs`'s job-run path, where the job's `prompt` is built from the PRD's own frontmatter body (`prompt = parsed.body + FINISH_PROTOCOL`, currently ~line 2055-2062), prepend the digest produced by PRD 950's `buildContextDigest` (from `src/main/lib/epicContextDigest.cjs`) whenever `job.epicId` resolves to an Epic in that cwd's active-index.json. This is additive only — the PRD body and FINISH_PROTOCOL suffix stay byte-for-byte unchanged, so a PRD remains fully self-contained and completable even if the digest is empty or fails to build. Also persist provenance into the run's `meta.json` sidecar so which Epic-session context (if any) a job was dispatched with is inspectable after the fact without re-deriving it, and document the new step in PRD_AUTHORING.md.

# Acceptance criteria

- [ ] When `job.epicId` (or PRD frontmatter's `sourcePromptId`) resolves to a known Epic for that cwd (same resolution `resolveOriginSessionId` in scheduler.cjs already performs, ~line 98), the built `prompt` has the digest text prepended before the PRD body — verified by an added test asserting `prompt.startsWith(digestText)` in that case.
- [ ] When `job.epicId` does not resolve (missing, or not present in active-index.json), the digest step is a silent no-op — `prompt` equals exactly `parsed.body + FINISH_PROTOCOL` as it does today, verified by a test.
- [ ] If `buildContextDigest` throws or rejects, the error is caught, logged via the run's `safeLog`, and the job still dispatches using the un-prefixed PRD body — a digest failure must never block or fail a job dispatch. Covered by a test that makes `buildContextDigest` reject and asserts the job still proceeds.
- [ ] The existing `resolveOriginSessionId(cwd, epicId)` result (already computed for job rows per PRD 832) and a new boolean `contextDigestApplied` field are written into both `config.writeJsonSync(metaPath, {...})` call sites in the exit and error handlers (currently ~line 2265 and ~line 2291).
- [ ] `git diff -- src/main/lib/sessionSlots.cjs` is empty — this change does not touch concurrency/metering.
- [ ] PRD body content itself (the markdown a human/PRD-author wrote) is never rewritten or persisted with the digest merged in — the digest is only injected into the in-memory `prompt` string passed to `claude -p`, confirmed by re-reading the on-disk `.md` PRD file after a test run and asserting it is unchanged.
- [ ] `PRD_AUTHORING.md` gains a short new subsection documenting this digest-prepend step, explicitly restating that a PRD's own body must remain sufficient on its own (the self-containment rule already stated near scheduler.cjs's own ~line 2399 comment) — digest context is additive, not a dependency.
- [ ] New/extended tests at `src/main/__tests__/scheduler-epic-digest.test.cjs` (or an existing scheduler test file, if a closer fit) cover the three prepend/no-op/failure cases above.
- [ ] `timeout 300 npx vitest run src/main/__tests__/scheduler-epic-digest.test.cjs` (or wherever the tests landed) passes.
- [ ] `npm run typecheck` passes with no new errors.

# Implementation notes

PRD 950 (dependency) lands `src/main/lib/epicContextDigest.cjs` exporting async `buildContextDigest({ cwd, epicId, maxChars })` — read its actual landed signature/return shape first (it may have changed slightly during execution; don't assume the PRD 950 text verbatim). In `scheduler.cjs`: the prompt is built around where `parsed = splitFrontmatter(...)` / `prompt = parsed.body + FINISH_PROTOCOL` happens (search for `FINISH_PROTOCOL` and `parsed.body`); `job.epicId` is already a field on job rows (see line ~1198, ~1320); `resolveOriginSessionId(cwd, epicId)` is already defined at ~line 98 and reads a small TTL-cached active-index lookup — reuse it directly, don't re-derive. The two `config.writeJsonSync(metaPath, {...})` sites to extend are in the child-exit handler's error branch (~line 2265) and success/exit branch (~line 2291) — both currently include `slug, cwd, sessionId, exitCode, ...`; add `originSessionId` and `contextDigestApplied` alongside those existing fields, not a new sidecar file. `PRD_AUTHORING.md` lives at `~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md`.

# Out of scope

- Resuming or forking the Epic's own claude session for PRD execution (--resume) — explicitly rejected direction; PRD jobs keep their own fresh --session-id.
- Serializing PRDs of the same Epic to run one-at-a-time — not part of this change.
- Any UI surfacing of the digest or originSessionId/contextDigestApplied fields.
- Changing the PRD markdown frontmatter schema (sourcePromptId/epicId fields already exist and are unchanged).

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
