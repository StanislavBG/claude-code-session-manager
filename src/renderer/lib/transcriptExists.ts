/**
 * Single source of truth for "does a JSONL transcript already exist on disk
 * for this session id?" — used by both the raw-PTY startup-command resolver
 * (sessions.ts) and the chat resume/create decision (chat.ts) so the two
 * surfaces never diverge on how they answer the same question. Uses the
 * remote-readable transcripts.exists (works on desktop and in the web shim).
 */
export async function transcriptExists(cwd: string, sessionId: string): Promise<boolean> {
  return window.api.transcripts.exists(cwd, sessionId)
}
