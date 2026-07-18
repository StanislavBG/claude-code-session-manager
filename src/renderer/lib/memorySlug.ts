/**
 * Shared workspace-memory slug validation. Memory.tsx (new-memory form) and
 * MemoryNaturalPanel.tsx (direct-add from chat) both create `.md` entries via
 * `memory.create`/`memory.write` and must agree with memoryTool.cjs's
 * `SLUG_RE = /^[a-z0-9-_]+\.md$/` on what a valid stem looks like.
 */
export const MEMORY_SLUG_RE = /^[a-z0-9-_]+$/
