/**
 * Renderer-side mirror of main/lib/encodeCwd.cjs.
 *
 * The Memory tab needs to derive the workspace label BEFORE calling
 * memory.list() so the toolbar can show "Workspace · <label>" while the
 * IPC is in flight. We could round-trip via IPC, but that adds a tick of
 * loading state.
 *
 * Invariant: this function MUST produce the same output as
 * `src/main/lib/encodeCwd.cjs::encodeCwd(cwd)`. Pinned by
 * tests/unit/encode-workspace-mirror.spec.ts.
 */
export function encodeWorkspace(cwd: string | null): string {
  if (!cwd || !cwd.trim()) return 'default'
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}
