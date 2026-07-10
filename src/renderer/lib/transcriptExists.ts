/**
 * Single source of truth for "does a JSONL transcript already exist on disk
 * for this session id?" — used by both the raw-PTY startup-command resolver
 * (sessions.ts) and the chat resume/create decision (chat.ts) so the two
 * surfaces never diverge on how they answer the same question.
 */
export async function transcriptExists(cwd: string, sessionId: string): Promise<boolean> {
  const jsonlPath = await window.api.transcripts.pathFor(cwd, sessionId)
  return window.api.config.exists(jsonlPath)
}
