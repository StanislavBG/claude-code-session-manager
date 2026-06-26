'use strict';

/**
 * exchanges.cjs — durable append-only log of completed terminal-chat exchanges.
 *
 * Appends one NDJSON record per successful chat run to:
 *   ~/.claude/knowledge-log/exchanges/<encodeCwd(cwd)>.jsonl
 *
 * Record shape (contract for PRDs 324 + 325):
 *   { ts, sessionId, cwd, prompt, result, summary, degraded? }
 *
 * Summary is produced by the shared Haiku summarizer (summarize.cjs). On
 * summarization failure the record is still written with `degraded` set — the
 * exchange is never lost due to an API call failing.
 */

const fsp = require('node:fs/promises');
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
 * @param {{ sessionId: string, cwd: string, prompt: string, result: string }} opts
 * @returns {Promise<void>}
 */
async function recordExchange({ sessionId, cwd, prompt, result }) {
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
  };

  const line = JSON.stringify(record) + '\n';

  await fsp.mkdir(EXCHANGES_DIR, { recursive: true });
  await fsp.appendFile(filePath, line, { encoding: 'utf8' });
}

module.exports = { recordExchange, EXCHANGES_DIR };
