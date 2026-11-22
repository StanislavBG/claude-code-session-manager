'use strict';

/**
 * transcriptUsage.cjs — summarize one Claude Code transcript (JSONL) into
 * per-call token totals, the largest single-call context, and an approximate
 * breakdown of what filled it.
 *
 * Unlike historyAggregator's scanAggrLines (which sums every usage line),
 * this counts each model call ONCE: Claude Code writes one line per content
 * block, so several rows share a message.id and repeat its usage. Per id we
 * keep the row with the largest output_tokens.
 *
 * Only main-chain (non-sidechain) rows count; '<synthetic>' model rows are
 * ignored. Source sizes are approximated as characters / 4.
 */

const fs = require('node:fs');
const readline = require('node:readline');

const CHARS_PER_TOKEN = 4;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function textChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (typeof b === 'string') n += b.length;
    else if (b && typeof b === 'object' && typeof b.text === 'string') n += b.text.length;
  }
  return n;
}

function createAccumulator() {
  /** message.id -> { model, usage } */
  const callsById = new Map();
  /** tool_use id -> tool name */
  const toolNames = new Map();
  /** [tool_use_id, chars] — resolved at finish so order does not matter */
  const toolResults = [];
  let userChars = 0;

  function addRow(row) {
    if (!row || typeof row !== 'object' || row.isSidechain === true) return;
    const msg = row.message;
    if (!msg || typeof msg !== 'object') return;

    if (row.type === 'assistant') {
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b && b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
            toolNames.set(b.id, b.name);
          }
        }
      }
      const usage = msg.usage;
      if (!usage || typeof usage !== 'object') return;
      if (typeof msg.model !== 'string' || msg.model === '<synthetic>') return;
      const id = typeof msg.id === 'string' && msg.id ? msg.id : `__noid_${callsById.size}`;
      const prev = callsById.get(id);
      if (!prev || num(usage.output_tokens) > num(prev.usage.output_tokens)) {
        callsById.set(id, { model: msg.model, usage });
      }
      return;
    }

    if (row.type === 'user') {
      if (row.isMeta === true) return;
      const c = msg.content;
      if (typeof c === 'string') {
        userChars += c.length;
        return;
      }
      if (!Array.isArray(c)) return;
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_result') {
          toolResults.push([b.tool_use_id, textChars(b.content)]);
        } else if (b.type === 'text' && typeof b.text === 'string') {
          userChars += b.text.length;
        }
      }
    }
  }

  function addLine(line) {
    if (typeof line !== 'string' || !line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    try {
      addRow(row);
    } catch {
      /* defensive: never throw on a weird row */
    }
  }

  function finish() {
    let inputTokens = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;
    let largestContext = 0;
    const models = {};
    for (const { model, usage } of callsById.values()) {
      const i = num(usage.input_tokens);
      const cw = num(usage.cache_creation_input_tokens);
      const cr = num(usage.cache_read_input_tokens);
      inputTokens += i;
      cacheWriteTokens += cw;
      cacheReadTokens += cr;
      outputTokens += num(usage.output_tokens);
      if (i + cw + cr > largestContext) largestContext = i + cw + cr;
      models[model] = (models[model] || 0) + 1;
    }

    const toolChars = new Map();
    for (const [toolUseId, chars] of toolResults) {
      const name = (typeof toolUseId === 'string' && toolNames.get(toolUseId)) || 'unknown';
      const key = `tool:${name}`;
      toolChars.set(key, (toolChars.get(key) || 0) + chars);
    }

    const bySource = [];
    if (outputTokens > 0) bySource.push({ source: 'model_output', approxTokens: outputTokens });
    for (const [source, chars] of toolChars) {
      const approxTokens = Math.round(chars / CHARS_PER_TOKEN);
      if (approxTokens > 0) bySource.push({ source, approxTokens });
    }
    const userTokens = Math.round(userChars / CHARS_PER_TOKEN);
    if (userTokens > 0) bySource.push({ source: 'user_prompt', approxTokens: userTokens });
    bySource.sort((a, b) => b.approxTokens - a.approxTokens || a.source.localeCompare(b.source));

    return {
      calls: callsById.size,
      inputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      outputTokens,
      largestContext,
      models,
      bySource,
    };
  }

  return { addLine, finish };
}

/**
 * @param {Iterable<string>} lines JSONL strings
 */
function summarizeTranscriptUsage(lines) {
  const acc = createAccumulator();
  try {
    if (lines && typeof lines[Symbol.iterator] === 'function') {
      for (const line of lines) acc.addLine(line);
    }
  } catch {
    /* a throwing iterator still yields what was read so far */
  }
  return acc.finish();
}

/**
 * Stream a transcript file line by line.
 * @param {string} filePath
 * @returns {Promise<ReturnType<typeof summarizeTranscriptUsage> | null>}
 */
async function summarizeTranscriptFile(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    return null;
  }
  const acc = createAccumulator();
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) acc.addLine(line);
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch {
    return null;
  }
  return acc.finish();
}

module.exports = { summarizeTranscriptUsage, summarizeTranscriptFile };
