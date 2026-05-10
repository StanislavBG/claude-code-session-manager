# Plan 3 — Fusion Ranking & Catalog Integration

**Goal:** Combine Plan 1 (web) + Plan 2 (personalized) signals into a single ranked list, dedupe against existing `catalog.ts`, and emit a human-reviewable diff.

## Scoring formula

```
final = 0.55 * web_score + 0.30 * personal_score + 0.15 * novelty_score
```

- **web_score** (0..1): from Plan 1 composite.
- **personal_score** (0..1): cosine-sim against user's browser corpus (0 if Plan 2 unavailable → reweight web to 0.85 + novelty 0.15).
- **novelty_score**: 1 if `id` not in `catalog.ts`, 0.3 if present but `source` changed, 0 if identical.
- **penalty**: -0.2 if repo has <10 stars AND no official flag AND no recent commits (30d).

## Dedupe keys (first match wins)

1. `normalized_id` = lowercase, strip `@scope/`, strip `-mcp`/`-skill`/`-plugin` suffix.
2. `canonical_source` = parse URL, keep `host + path-without-trailing-slash`.
3. `sha1(name+primary_action)` — primary_action = install command or config stanza.

## Emit format

`research/candidates/YYYY-MM-DD-HHMM-merged.json`:

```json
{
  "generated_at": "...",
  "summary": { "new": N, "updated": N, "kept": N, "demoted": N },
  "add": [ { "id": "...", "kind": "mcp|skill|plugin", "final_score": 0.xx, "web": 0.xx, "personal": 0.xx, "novelty": 0.xx, "install": "...", "rationale": "..." } ],
  "update": [ ... ],
  "demote": [ { "id": "...", "reason": "stale|low-stars|superseded" } ]
}
```

## Human approval loop

1. Script writes `candidates/*-merged.json`.
2. User opens Skills Library tab → new "Pending review (N)" banner.
3. Accept/Reject/Defer per entry → writes to `catalog.ts` via codegen (not hand-edit).
4. Rejected entries persisted in `research/rejections.json` so future passes don't resurface them.

## Codegen for `catalog.ts`

- Read existing `catalog.ts` AST via `@typescript-eslint/parser`.
- For each accepted entry, append to corresponding array literal (`CATALOG_MCP`, `CATALOG_SKILLS`, `CATALOG_PLUGINS`).
- Re-emit file with `prettier`.
- Guard: abort if AST parse fails; never overwrite with best-effort regex.

## Telemetry (local only)

- Track: passes run, candidates proposed, accepted, rejected, time-to-review.
- Stored in `research/telemetry.json`.
- Surface in Overview tab as a small sparkline.

## Success criteria

- Zero duplicates introduced per pass.
- ≥60% of auto-proposed entries accepted by user over 5 passes (else tune weights).
- Entire merge pipeline <10s wall time.
