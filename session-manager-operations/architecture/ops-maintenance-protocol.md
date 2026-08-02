# Operations-folder maintenance protocol

`session-manager-operations/` is the backbone for this app's own runtime state AND ships as the
template for what every other project's operations root looks like once session-manager opens a
TAB on it. Because it accumulates fast (5 concurrent writers-in-code plus ad-hoc skill/agent
output) and is never pruned automatically, it silently drifts from the source of truth that
governs it: `CLAUDE.md`'s OWNERS table + lifecycle rules, and each namespace's own `README.md`.
This document is the repeatable protocol for detecting and resolving that drift — first run
manually against this project's own operations folder (below), later to be automated by a sweep
agent that runs it against every project's operations root (see Pattern F).

## Source-of-truth hierarchy (highest wins)

1. **Code** — `src/main/lib/opsOwnership.cjs`'s `OWNERS` table + `src/main/config.cjs`'s
   per-namespace write-grant comments, and whichever module actually calls `writeJson`/
   `writeTextAtomic` with that namespace's writer tag. This is what *actually happens* at runtime.
2. **CLAUDE.md** — the project's own declared architecture. Should describe (1) exactly; when it
   doesn't, CLAUDE.md is stale, not the code (unless the code is the bug).
3. **Each namespace's own `README.md`** — should describe (1) and agree with (2). A namespace
   README describing a writer or workflow that no longer exists is stale documentation, not a
   sign the underlying data should be deleted.
4. **On-disk content** — the actual files. Never treated as its own source of truth; only ever
   checked against 1–3.

A cleanup action is only "safe" when at least two of the three doc layers (code / CLAUDE.md /
README) agree on what should happen to a namespace. When code, CLAUDE.md, and the README
disagree with each other (Pattern A below), that's a stop-and-decide case, not an
auto-delete — file a proposed Epic, don't act unilaterally.

**Update 2026-08-02: Pattern A resolved.** Decision: full retirement (option a). The `feedback`
`OWNERS` entry and its `config.cjs` write grant are removed; the 69 historical files were
archived to `session-manager-operations/feedback/archived-2026-08-02/`; `feedback/README.md` now
points readers at `/propose-epic`; `CLAUDE.md`'s two contradictory bullets now agree. Zero open
(un-triaged) items were on disk at decision time, confirming the folder had no live manual-inbox
usage independent of the now-retired `/process-feedback` pass.

## Patterns (found by running this protocol against session-manager's own ops folder, 2026-08-02)

### Pattern A — retired-in-docs, live-in-code namespace
`feedback/` is declared retired in CLAUDE.md's "status: 'proposed' is the human gate" bullet
("The retired machinery — `session-manager-operations/feedback/`... is gone") while the same
CLAUDE.md's OWNERS bullet two paragraphs earlier still lists `feedback → feedback` as a current
owner — CLAUDE.md contradicts itself. Code confirms the retirement is real but incomplete:
`rcaFeedbackHook.cjs` no longer writes there (it now files proposed Epics — see its own header
comment), yet `config.cjs:139-146` still grants write access to `session-manager-operations/feedback/`
with a comment claiming rcaFeedbackHook uses it, and `opsOwnership.cjs` still lists it as an owned
namespace. `feedback/README.md` still instructs readers to file via the now-nonexistent
`/process-feedback` skill. Three layers, three different stories, 72 files (2.9 MB) sitting on
disk as a result. **Action**: don't delete the files — file a proposed Epic to make a real
decision (keep as a manual-only inbox with corrected docs, or fully retire: drop the OWNERS entry
+ write grant, archive the 72 files, rewrite the README to point at `/propose-epic`). Filed as
Epic (see bottom of this doc).

### Pattern B — undocumented namespace (CLAUDE.md's "deliberately NOT in OWNERS" list is incomplete)
CLAUDE.md names exactly `architecture/`, `design-mocks/`, `HUMAN_LEARN/`, `reviews/` as folders
that live under the ops root without an OWNERS entry. In practice `browser/`, `logs/`,
`project-pages/`, and now `bilko-host/` also exist as non-OWNERS artifact folders — each with its
own README correctly self-declaring that status, but CLAUDE.md's own enumeration never grew to
match. **Detection**: every folder under `session-manager-operations/` must appear in exactly one
of (a) `opsOwnership.cjs`'s `OWNERS` keys or (b) CLAUDE.md's non-OWNERS enumeration. A folder in
neither is undocumented at the CLAUDE.md level even if its own README is fine. **Action**: doc-only
fix, low risk — update CLAUDE.md's enumeration whenever a new artifact folder's README lands,
same PR that adds the folder.

### Pattern C — legacy flat structure not fully migrated
CLAUDE.md states the flat `scheduler/prds/` layout is "RETIRED and auto-consolidated into
`prds-archived/` at boot." On disk today, `scheduler/prds/` (top-level) still holds 73 files and
`scheduler/prds-archived/` holds 179 — the claimed boot-time consolidation is either not running,
not covering every file, or the 73 remaining files are legitimately still in flight (unclaimed
PRDs, not yet archived because not yet completed). **Detection**: nonzero top-level
`scheduler/prds/` file count that doesn't shrink between app restarts is the signal; distinguish
"stuck legacy debt" from "normal in-flight PRDs" by cross-referencing against `scheduler/state/`
queue/history before treating any of it as cleanup work. **Action**: investigate before touching —
filed as part of the same hygiene Epic as Pattern D below, not auto-migrated by this protocol.

### Pattern D — orphaned top-level session/epic JSON
`prompt-sessions/`'s 46 top-level archived `*.json` files were cross-referenced against
`scheduler/epics/`'s 35 directories: 29 have no matching `scheduler/epics/<id>/` directory. This
is expected for Epics that never authored a PRD (discussion-tag Epics, abandoned proposals) — NOT
automatically an orphan/leak. **Detection**: a top-level `prompt-sessions/*.json` with no
`scheduler/epics/<same-id>/` dir AND no PRD-dispatch events in its own event chain is a genuine
never-worked Epic, safe to age out under a retention policy; one *with* PRD history but a missing
`scheduler/epics/` dir would indicate real data loss and must never be deleted, only escalated.
**Action**: the distinguishing check (PRD-dispatch event presence) has to be scripted, not
eyeballed — filed as part of the hygiene Epic; no deletion happened this session.

### Pattern E — time-boxed archival with no retention policy
`feedback/processed/` holds 70 files dated 2026-06-10 through 2026-07-12 with no expressed
retention window anywhere (README, CLAUDE.md, or code) — it will grow forever. This is a policy
gap, not a bug: every namespace that archives completed work (`feedback/processed/`,
`prompt-sessions/` archived epics, `scheduler/prds-archived/`) needs an explicit answer to "how
long do we keep this, and who/what prunes it" recorded in that namespace's own README. Silence
here isn't neutral — it's how a folder gets to 42 MB (prompt-sessions/) or 3.2 MB (scheduler/)
with nobody able to say whether any of it is safe to remove.

### Pattern F — generalizing to other projects (for the future sweep agent)
This protocol was authored by reading *this* project's own CLAUDE.md and code. A sweep agent
that runs it against another project's `session-manager-operations/` must NOT assume
session-manager's own OWNERS vocabulary applies there — it must:
1. Read that target project's own `CLAUDE.md` (or absence thereof) as the SoR for what that
   project's ops folders are supposed to contain.
2. Read each namespace's own `README.md` inside that project's ops root the same way Patterns
   A–E do here — namespace-README-vs-declared-architecture is a portable check even when the
   declared architecture differs project to project.
3. Never delete based on file age or size alone (Pattern E) — only based on a documented,
   agreed-upon retention rule for that specific namespace in that specific project.
4. Report findings as a per-project diff (what's undocumented, what's contradictory, what's
   past its own stated retention) rather than executing changes directly — every actual
   delete/migrate/archive action still goes through that project's own proposed-Epic gate,
   never a direct filesystem mutation by the sweep agent itself. This mirrors the
   `status: 'proposed'` human gate this project already uses for its own Epics — the sweep
   agent is a *finder*, not an *actor*.

## Cadence

Run manually today (no scheduled trigger yet — see the filed Epic to build the sweep agent).
Suggested cadence once automated: monthly per active project, plus triggered whenever a new
top-level folder appears under a project's `session-manager-operations/` (Pattern B is cheap to
catch early and expensive to catch late).

## What this session did NOT do

No files were deleted or migrated this session — every finding above (A, C, D) was routed to a
proposed Epic instead of acted on directly, per the source-of-truth rule: two-of-three doc layers
must agree before a destructive action is "safe," and none of A/C/D cleared that bar without
further investigation. Pattern B (doc-only, CLAUDE.md enumeration) was low-risk enough to fix
directly — see the CLAUDE.md diff in this same commit.
