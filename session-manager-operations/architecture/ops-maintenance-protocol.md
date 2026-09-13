# Operations-folder maintenance protocol

`session-manager-operations/` is the backbone for this app's own runtime state AND ships as the
template for what every other project's operations root looks like once session-manager opens a
TAB on it. Because it accumulates fast (concurrent writers-in-code plus ad-hoc skill/agent output)
and is never pruned automatically, it silently drifts from the source of truth that governs it:
`CLAUDE.md`'s OWNERS table + lifecycle rules, and each namespace's own `README.md`. This document
is the repeatable protocol for detecting and resolving that drift.

Two things implement this protocol today: `scripts/audit-ops-hygiene.cjs` (session-manager's own
repo, hardcodes this project's OWNERS vocabulary — Patterns C/D/E/F, its own, not this doc's) and
`scripts/ops-sweep.cjs` plus the `session-manager-dev:ops-sweep` skill (portable, runs against ANY
project's `session-manager-operations/`, including one with no CLAUDE.md at all — Pattern H below).
**Both are built and runnable today.** The only unbuilt piece is a scheduled/cron cadence — see
Cadence.

The first run of this protocol against session-manager's own ops folder (2026-08-02) found real
drift and resolved most of it. That run's narrative — concrete file counts, dates, and what was and
wasn't touched — is a frozen, point-in-time record, not durable policy, so it lives in
[`../reviews/2026-08-02-ops-maintenance-protocol-run-log.md`](../reviews/2026-08-02-ops-maintenance-protocol-run-log.md)
rather than here; that doc links back here for the durable rules its run was exercising.

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

## Patterns and their detection rules

### Pattern A — retired-in-docs, live-in-code namespace
A namespace is declared retired in one doc layer (e.g. CLAUDE.md prose) while another doc layer
(the OWNERS table, or a README) still describes it as actively owned/writable — or code itself
still writes there. **Detection**: the ownership doc contains both "retired/gone" language and
"owner/owns" language about the same namespace in the same clause; `scripts/ops-sweep.cjs`'s
`CONTRADICTION` finding automates this. **Action**: don't delete anything on sight — file a
proposed Epic to make the real decision (keep as a corrected doc, or fully retire: drop the OWNERS
entry + write grant, archive the files, rewrite the README).

### Pattern B — undocumented namespace
Every folder under `session-manager-operations/` must appear in exactly one of (a)
`opsOwnership.cjs`'s `OWNERS` keys or (b) the ownership doc's non-OWNERS enumeration. **Detection**:
a folder in neither is undocumented even if its own README is fine; `scripts/ops-sweep.cjs`'s
`UNDOCUMENTED` finding. **Action**: doc-only fix, low risk — update the enumeration in the same PR
that adds the folder.

### Pattern C — legacy flat structure not fully migrated
A namespace declares an old flat layout "RETIRED and auto-consolidated" at boot, but on-disk file
counts under the flat path don't shrink between runs. **Detection**: a nonzero flat-layout file
count that doesn't shrink between app restarts is the signal; cross-reference against the
namespace's own in-flight state (queue/history) before treating any of it as cleanup work —
`scripts/audit-ops-hygiene.cjs` implements this for `scheduler/prds/` vs `scheduler/prds-archived/`.
**Action**: investigate before touching — a nonzero count can be legitimate in-flight work, not
stuck debt.

### Pattern D — orphaned top-level session/epic JSON
A top-level archived record (e.g. `prompt-sessions/*.json`) has no matching subdirectory under the
namespace it should have minted (e.g. `scheduler/epics/<id>/`). **Detection**: has to be scripted,
not eyeballed — inspect the record's own event chain for dispatch evidence, then search dependent
namespaces for a match under a *different* auto-minted id before concluding anything is lost;
`scripts/audit-ops-hygiene.cjs` implements this for `prompt-sessions/` vs `scheduler/epics/`.
**Action**: a record with no dispatch evidence and no match elsewhere is a genuine never-worked
artifact, safe to age out under a retention policy; a record *with* dispatch evidence but no
matching dir indicates real data loss and must never be deleted, only escalated.

### Pattern G — time-boxed archival with no retention policy
*(Renamed from Pattern E in an earlier revision of this doc. That letter collided with
`scripts/audit-ops-hygiene.cjs`'s own Pattern E — a different check, hand-authored-PRD detection —
so cross-references between this doc and that script's comments could mean two different things
under the same letter. Renamed to the next free letter, G, so the two never collide again.)*

Any namespace that archives completed work (an `archived/`, `processed/`, or `-archived` subfolder)
needs an explicit answer, in that namespace's own README, to "how long do we keep this, and
who/what prunes it." Silence isn't neutral — it's how an archive folder grows unbounded with
nobody able to say whether any of it is safe to remove. **Detection**: `scripts/ops-sweep.cjs`'s
`NO_RETENTION_POLICY` finding — a namespace has files under an archive/processed subfolder but no
retention/prune/expire language in its README (or no README at all).

### Pattern H — generalizing to other projects
*(Renamed from Pattern F in an earlier revision of this doc, for the same reason as Pattern G above
— that letter collided with `scripts/audit-ops-hygiene.cjs`'s own Pattern F, a different check,
referential integrity. Renamed to the next free letter, H.)*

This protocol was authored by reading *this* project's own CLAUDE.md and code. **This part is
built**: `scripts/ops-sweep.cjs` plus the `session-manager-dev:ops-sweep` skill run it against ANY
project's `session-manager-operations/` — including one with a different OWNERS vocabulary than
session-manager's own, or no CLAUDE.md at all. Only a scheduled/cron cadence remains unbuilt (see
Cadence). Portability constraints a sweep run against another project must honor:

1. Read that target project's own `CLAUDE.md` (if present) as the SoR for what that project's ops
   folders are supposed to contain.
2. Read each namespace's own `README.md` inside that project's ops root the same way Patterns
   A–D do here — namespace-README-vs-declared-architecture is a portable check even when the
   declared architecture differs project to project.
3. Never delete based on file age or size alone (Pattern G) — only based on a documented,
   agreed-upon retention rule for that specific namespace in that specific project.
4. Report findings as a per-project diff (what's undocumented, what's contradictory, what's past
   its own stated retention) rather than executing changes directly — every actual
   delete/migrate/archive action still goes through that project's own proposed-Epic gate, never a
   direct filesystem mutation by the sweep itself. This mirrors the `status: 'proposed'` human gate
   this project already uses for its own Epics — the sweep is a *finder*, not an *actor*.

## Finding types emitted by `scripts/ops-sweep.cjs`

All eight finding types below come from `scripts/ops-sweep.cjs` (the portable sweep — Pattern H).
`scripts/audit-ops-hygiene.cjs` reports its own Patterns C/D/E/F in a different, unstructured
report shape and does not emit any of these `type` values.

| Finding type | What it flags | Pattern |
| --- | --- | --- |
| `MISSING_README` | Namespace dir has no `README.md`. | — |
| `UNDOCUMENTED` | Namespace name never mentioned anywhere in the ownership doc. | B |
| `CONTRADICTION` | The ownership doc contains both "retired/gone" and "owner/owns" language for the same namespace, or the namespace's own README and the ownership doc disagree on retired-vs-active status. | A |
| `NO_RETENTION_POLICY` | Namespace has an archived/processed subfolder with files but no retention/prune/expire language in its README. | G |
| `EPIC_INDEX_ORPHAN_ROWS` | `prompt-sessions/active-index.json` has a row with no matching `prompt-sessions/<id>.json` file — reuses `src/main/health.cjs`'s `computeEpicIndexDrift` so the two never disagree. | — |
| `CLAUDE_MD_OVER_BUDGET` | The target's root `CLAUDE.md` exceeds its own self-declared SIZE BUDGET header. | — |
| `OPS_PATH_LITERAL` | A `.cjs` file under `src/main/` (outside `lib/opsOwnership.cjs` itself) spells the `session-manager-operations` literal instead of building the path via `opsPath()`/`resolveOpsRoot()`. Only meaningful when the swept target IS the session-manager repo. | — |
| `NESTED_CLAUDE_MD_OVER_BUDGET` | Any `CLAUDE.md` strictly below the repo root (excluding `node_modules`/`.git`) exceeds the fixed 4000-byte nested-doc cap. | — |

## Cadence

`/ops-sweep` — the skill plus `scripts/ops-sweep.cjs` — is built and runnable today, on demand,
against any project. The only unbuilt piece is a scheduled cadence: no cron trigger exists yet.
Suggested cadence once that's built: monthly per active project, plus triggered whenever a new
top-level folder appears under a project's `session-manager-operations/` (Pattern B is cheap to
catch early and expensive to catch late).
