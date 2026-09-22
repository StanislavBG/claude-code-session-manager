# memory-clusters — session-manager

This folder stores the per-project **Memory Clusters** cache — the LLM-derived semantic
grouping of a project's workspace memories (`~/.claude/projects/<encodedCwd>/memory/*.md`)
that the Memory tab's Clusters view renders. Backend: `src/main/memoryAggregate.cjs`.

## Storage layout

```
session-manager-operations/memory-clusters/
  clusters.json   — the cached clustering result for this cwd
```

Path helper: `opsPath(cwd, 'memory-clusters', 'clusters.json')` (via
`src/main/lib/opsOwnership.cjs`) — one file per project, keyed by the real cwd rather than
an encoded slug.

## Required shape

```ts
{
  workspace: string,               // encoded workspace slug (memory dir lookup key)
  generatedAt: number | null,      // Date.now() of the last claude -p clustering pass
  clusters: {
    id: string,
    name: string,
    summary: string,
    memberSlugs: string[],         // memory slugs, ref memory-clusters entry -> memoryEntry.name
    links: { from: string; to: string; label?: string }[],
  }[],
  orphans: string[],                // memory slugs that fit no cluster
}
```

## Ownership

Sole writer per `src/main/lib/opsOwnership.cjs`'s `OWNERS` table: **`memory-clusters`**. Every
write path in `memoryAggregate.cjs` calls
`config.writeJson(clustersCachePath(realCwd), result, { writer: 'memory-clusters' })`. There is
no declared delegation into this namespace.

## Regenerable, not authoritative

This cache is **purely derived state** — it holds no information that cannot be recomputed from
the underlying memory files. It is rebuilt only when the renderer passes `refresh: true` (the
cost gate on the `claude -p` clustering pass); a plain `memory:aggregate` call is cache-only and
never touches disk. Because it is fully regenerable, this folder is never migrated or
backfilled — a project that pre-dates this namespace (or one with a stale/missing cache) simply
regenerates the next time a user clicks Refresh. Do not treat a missing or empty `clusters.json`
as an error condition.
