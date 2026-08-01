/**
 * Renderer-side logger. Mirrors to console so DevTools still works, and
 * forwards to the main process which appends to <userData>/logs/.
 * Workers can't reach window.api directly — they postMessage({type:'log',...})
 * to their host, which forwards via this module.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

/**
 * Optional attribution for an error line — when supplied (and level is
 * 'error'), main also appends a tagged line to that project's own
 * `session-manager-operations/logs/` (opsErrorLog.cjs), on top of the
 * always-on machine-global mirror. Omit when the error has no clear
 * project/tab owner (e.g. a boot-time or cross-project failure).
 */
export interface LogCtx {
  cwd?: string
  tabId?: string
  epicId?: string
  tags?: string[]
}

function emit(scope: string, level: Level, message: string, meta?: unknown, ctx?: LogCtx): void {
  try {
    window.api?.logs?.write(scope, level, message, meta, ctx)
  } catch {
    /* preload unavailable in tests / early boot */
  }
  const fn = level === 'error'
    ? console.error
    : level === 'warn'
      ? console.warn
      : console.log
  if (meta !== undefined) fn(`[${scope}]`, message, meta)
  else fn(`[${scope}]`, message)
}

export const log = {
  debug: (scope: string, msg: string, meta?: unknown) => emit(scope, 'debug', msg, meta),
  info: (scope: string, msg: string, meta?: unknown) => emit(scope, 'info', msg, meta),
  warn: (scope: string, msg: string, meta?: unknown) => emit(scope, 'warn', msg, meta),
  error: (scope: string, msg: string, meta?: unknown, ctx?: LogCtx) => emit(scope, 'error', msg, meta, ctx),
}
