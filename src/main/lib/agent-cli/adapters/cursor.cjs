'use strict';
// Cursor Agent CLI (`cursor-agent` / `agent`) adapter: builds print-mode argv
// and translates `--output-format stream-json` JSONL into the Claude
// stream-json events from ../agentCliEvents.cjs. The CLI documents no stdin
// prompt, so the prompt is the positional argument — guarded below Linux's
// MAX_ARG_STRLEN (131072 bytes). A failed stream may end without a terminal
// `result`; end() emits nothing and the runner's no-result fallback reports
// stderr. Pure module.

const {
  initEvent, textEvent, toolUseEvent, toolResultEvent, resultEvent, safeJsonLine,
} = require('../agentCliEvents.cjs');

const MAX_ARGV_PROMPT_BYTES = 120000;
const HEADLESS_FLAGS = ['--print', '--output-format', 'stream-json', '--force', '--trust'];
const TOOL_NAMES = Object.freeze({
  readToolCall: 'Read',
  writeToolCall: 'Write',
  shellToolCall: 'Bash',
  editToolCall: 'Edit',
});

const hasId = (id) => typeof id === 'string' && id.length > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const resumeArgs = (id) => (hasId(id) ? ['--resume', id] : []);
const modelArgs = (model) => (typeof model === 'string' && model ? ['--model', model] : []);

function headlessSpawn({ prompt, nativeSessionId, model } = {}) {
  const p = typeof prompt === 'string' ? prompt : '';
  const bytes = Buffer.byteLength(p, 'utf8');
  if (bytes > MAX_ARGV_PROMPT_BYTES) {
    return {
      error: `cursor prompt is ${bytes} bytes, over the ${MAX_ARGV_PROMPT_BYTES}-byte argv limit `
        + '(cursor-agent takes the prompt only as a command-line argument)',
    };
  }
  return {
    args: [...HEADLESS_FLAGS, ...resumeArgs(nativeSessionId), ...modelArgs(model), p],
    stdin: '',
  };
}

function interactiveArgs({ nativeSessionId, model } = {}) {
  return ['--force', ...resumeArgs(nativeSessionId), ...modelArgs(model)];
}

function assistantText(message) {
  if (!isObj(message) || !Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

// tool_call is { <kindKey>: { args, result? } } or { function: { name, arguments } }.
function toolEntry(toolCall) {
  if (!isObj(toolCall)) return null;
  const key = Object.keys(toolCall)[0];
  if (!key || !isObj(toolCall[key])) return null;
  const body = toolCall[key];
  if (key === 'function') {
    return { name: typeof body.name === 'string' && body.name ? body.name : 'function', input: body.arguments, body };
  }
  return { name: TOOL_NAMES[key] ?? key, input: body.args, body };
}

function createParser() {
  let sessionId = null;
  let resultEmitted = false;
  const texts = [];

  function handle(evt, out) {
    switch (evt.type) {
      case 'system':
        if (evt.subtype === 'init' && hasId(evt.session_id)) {
          sessionId = evt.session_id;
          out.push(initEvent(sessionId, 'cursor'));
        }
        return;
      case 'assistant': {
        const text = assistantText(evt.message);
        if (text) {
          texts.push(text);
          out.push(textEvent(text));
        }
        return;
      }
      case 'tool_call': {
        const entry = toolEntry(evt.tool_call);
        if (!entry) return;
        if (evt.subtype === 'started') {
          out.push(toolUseEvent({ id: evt.call_id, name: entry.name, input: entry.input }));
        } else if (evt.subtype === 'completed') {
          const r = isObj(entry.body.result) ? entry.body.result : {};
          const isError = !!r.error;
          const payload = isError ? r.error : r.success;
          out.push(toolResultEvent({
            toolUseId: evt.call_id,
            content: JSON.stringify(payload ?? null),
            isError,
          }));
        }
        return;
      }
      case 'result': {
        if (resultEmitted) return;
        resultEmitted = true;
        const ok = evt.subtype === 'success' && evt.is_error !== true;
        const joined = texts.join('');
        const text = joined || (typeof evt.result === 'string' ? evt.result : '');
        out.push(resultEvent({ ok, text, nativeSessionId: sessionId ?? undefined }));
        return;
      }
      default: // 'user' echoes the prompt; unknown types: dropped
    }
  }

  return {
    push(line) {
      const out = [];
      try {
        const evt = safeJsonLine(line);
        if (evt) handle(evt, out);
      } catch {
        return [];
      }
      return out;
    },
    end() {
      return [];
    },
    nativeSessionId() {
      return sessionId;
    },
  };
}

module.exports = { id: 'cursor', headlessSpawn, createParser, interactiveArgs, MAX_ARGV_PROMPT_BYTES };
