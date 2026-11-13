'use strict';
// Shared contract for non-Claude agent-CLI adapters: each adapter translates
// its CLI's native JSON output into these Claude stream-json event shapes,
// which src/main/chatRunner.cjs processLine already consumes. Pure module.

const AGENT_CLI_IDS = Object.freeze(['claude', 'codex', 'gemini', 'antigravity', 'cursor', 'opencode']);
const MAX_LINE_CHARS = 8 * 1024 * 1024;
const MAX_TOOL_RESULT_CHARS = 4000;
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens'];

function isAgentCliId(x) {
  return typeof x === 'string' && AGENT_CLI_IDS.includes(x);
}

function isNonClaudeAgentCli(x) {
  return isAgentCliId(x) && x !== 'claude';
}

function initEvent(nativeSessionId, cli) {
  return { type: 'system', subtype: 'init', session_id: nativeSessionId, agent_cli: cli };
}

function textEvent(text) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function toolUseEvent({ id, name, input } = {}) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}

function toolResultContent(content) {
  let s;
  if (typeof content === 'string') s = content;
  else {
    try { s = JSON.stringify(content); } catch { s = String(content); }
    if (typeof s !== 'string') s = String(content);
  }
  return s.length > MAX_TOOL_RESULT_CHARS ? s.slice(0, MAX_TOOL_RESULT_CHARS) : s;
}

function toolResultEvent({ toolUseId, content, isError } = {}) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: toolResultContent(content), is_error: !!isError }],
    },
  };
}

function cleanUsage(usage) {
  const out = {};
  for (const k of USAGE_KEYS) {
    const v = usage[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

function resultEvent({ ok, text, usage, nativeSessionId } = {}) {
  const ev = {
    type: 'result',
    subtype: ok ? 'success' : 'error',
    is_error: !ok,
    result: text,
    session_id: nativeSessionId,
  };
  if (usage && typeof usage === 'object') ev.usage = cleanUsage(usage);
  return ev;
}

function safeJsonLine(line) {
  if (typeof line !== 'string' || line.length > MAX_LINE_CHARS) return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

module.exports = {
  AGENT_CLI_IDS,
  isAgentCliId,
  isNonClaudeAgentCli,
  initEvent,
  textEvent,
  toolUseEvent,
  toolResultEvent,
  resultEvent,
  safeJsonLine,
};
