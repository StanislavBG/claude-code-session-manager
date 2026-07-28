'use strict';

/**
 * exchanges.cjs — durable append-only log of completed terminal-chat exchanges.
 *
 * Appends one NDJSON record per successful chat run to:
 *   ~/.claude/knowledge-log/exchanges/<encodeCwd(cwd)>.jsonl
 *
 * Record shape (contract for PRDs 324 + 325):
 *   { ts, sessionId, cwd, prompt, result, summary, degraded?, promptId? }
 *
 * Summary is produced by the shared Haiku summarizer (summarize.cjs). On
 * summarization failure the record is still written with `degraded` set — the
 * exchange is never lost due to an API call failing.
 *
 * `promptId` (PRD 749) is the originating PromptTicket.id when the exchange
 * was dispatched from a queued ticket (chat.ts's per-tab queue, PRD 748) —
 * omitted for a fresh manual send with no ticket. Forward-only: existing
 * historical records simply lack the field, never backfilled/synthesized.
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { encodeCwd } = require('./lib/encodeCwd.cjs');
const { validatePath } = require('./config.cjs');
const { summarize } = require('./lib/summarize.cjs');

const HOME = os.homedir();
const EXCHANGES_DIR = path.join(HOME, '.claude', 'knowledge-log', 'exchanges');

/**
 * Record a completed exchange. Creates the exchanges directory if needed.
 * Appends one JSON line; uses O_APPEND so concurrent writes from separate
 * processes are safe (each line is a single write, POSIX O_APPEND atomic for
 * pipe-sized payloads).
 *
 * @param {{ sessionId: string, cwd: string, prompt: string, result: string, promptId?: string }} opts
 * @returns {Promise<void>}
 */
async function recordExchange({ sessionId, cwd, prompt, result, promptId }) {
  const encoded = encodeCwd(cwd);
  const filePath = path.join(EXCHANGES_DIR, `${encoded}.jsonl`);

  // Security: validate that the target path stays within home dir
  validatePath(EXCHANGES_DIR);

  // Summarize — always resolves; never throws
  const { summary, model, degraded } = await summarize(result);

  const record = {
    ts: new Date().toISOString(),
    sessionId,
    cwd,
    prompt,
    result,
    summary,
    model,
    ...(degraded ? { degraded } : {}),
    ...(promptId ? { promptId } : {}),
  };

  const line = JSON.stringify(record) + '\n';

  await fsp.mkdir(EXCHANGES_DIR, { recursive: true });
  await fsp.appendFile(filePath, line, { encoding: 'utf8' });
}

// Match kg.cjs MAX_TAIL_BYTES — prevents a huge log from blocking the main thread.
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const DEFAULT_LIMIT = 100;

/**
 * Read exchanges for a project, newest-first. Bounded to MAX_TAIL_BYTES from
 * the end of the file so large logs never block the main thread.
 *
 * @param {{ cwd: string, sessionId?: string, limit?: number, offset?: number }}
 * @returns {Promise<object[]>}
 */
async function listExchanges({ cwd, sessionId, limit = DEFAULT_LIMIT, offset = 0 }) {
  const encoded = encodeCwd(cwd);
  const filePath = path.join(EXCHANGES_DIR, `${encoded}.jsonl`);

  let stat;
  try { stat = await fsp.stat(filePath); } catch { return []; }

  // Tail up to MAX_TAIL_BYTES from the end of the file.
  const readLen = Math.min(stat.size, MAX_TAIL_BYTES);
  const startPos = stat.size - readLen;

  let raw;
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(readLen);
      const { bytesRead } = await fd.read(buf, 0, readLen, startPos);
      raw = buf.slice(0, bytesRead).toString('utf8');
    } finally {
      await fd.close();
    }
  } catch { return []; }

  // If we started mid-file, skip the (possibly incomplete) first line.
  let text = raw;
  if (startPos > 0) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }

  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (rec && typeof rec.ts === 'string') records.push(rec);
    } catch { /* skip malformed */ }
  }

  // Newest-first
  records.reverse();

  const filtered = sessionId
    ? records.filter((r) => r.sessionId === sessionId)
    : records;

  return filtered.slice(offset, offset + limit);
}

module.exports = { recordExchange, listExchanges, EXCHANGES_DIR };
