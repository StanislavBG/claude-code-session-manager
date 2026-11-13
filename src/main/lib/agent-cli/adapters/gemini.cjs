'use strict';
// Google Gemini CLI (0.68) adapter: builds headless/interactive argv and
// translates `--output-format stream-json` JSONL into the Claude stream-json
// events from ../agentCliEvents.cjs. Headless mode reads the prompt from a
// non-TTY stdin. Gemini accepts a caller-chosen session UUID, so the first
// turn passes the Epic's claudeSessionId as --session-id. Pure module.

const {
  initEvent, textEvent, toolUseEvent, toolResultEvent, resultEvent, safeJsonLine,
} = require('../agentCliEvents.cjs');

const YOLO = ['--approval-mode', 'yolo'];
const HEADLESS_FLAGS = ['--output-format', 'stream-json', ...YOLO, '--skip-trust'];

const str = (v) => (typeof v === 'string' ? v : undefined);
const hasId = (id) => typeof id === 'string' && id.length > 0;
const modelArgs = (model) => (typeof model === 'string' && model ? ['-m', model] : []);

function sessionArgs(nativeSessionId, claudeSessionId) {
  if (hasId(nativeSessionId)) return ['--resume', nativeSessionId];
  return hasId(claudeSessionId) ? ['--session-id', claudeSessionId] : [];
}

function headlessSpawn({ prompt, nativeSessionId, claudeSessionId, model } = {}) {
  return {
    args: [...HEADLESS_FLAGS, ...sessionArgs(nativeSessionId, claudeSessionId), ...modelArgs(model)],
    stdin: prompt,
  };
}

function interactiveArgs({ nativeSessionId, claudeSessionId, model } = {}) {
  return [...YOLO, ...sessionArgs(nativeSessionId, claudeSessionId), ...modelArgs(model)];
}

function createParser() {
  let sessionId = null;
  let resultEmitted = false;
  let lastError = null;
  const texts = [];

  function handle(evt, out) {
    switch (evt.type) {
      case 'init':
        if (hasId(evt.session_id)) {
          sessionId = evt.session_id;
          out.push(initEvent(sessionId, 'gemini'));
        }
        return;
      case 'message':
        if (evt.role === 'assistant' && typeof evt.content === 'string') {
          texts.push(evt.content);
          out.push(textEvent(evt.content));
        }
        return; // role 'user' echoes the prompt: dropped
      case 'tool_use':
        out.push(toolUseEvent({
          id: evt.tool_id,
          name: str(evt.tool_name) ?? 'unknown',
          input: evt.parameters && typeof evt.parameters === 'object' ? evt.parameters : {},
        }));
        return;
      case 'tool_result': {
        const isError = evt.status === 'error';
        const content = isError
          ? (str(evt.error?.message) ?? str(evt.output) ?? 'error')
          : (evt.output ?? '');
        out.push(toolResultEvent({ toolUseId: evt.tool_id, content, isError }));
        return;
      }
      case 'error':
        lastError = str(evt.message) ?? 'gemini error';
        return;
      case 'result': {
        if (resultEmitted) return;
        resultEmitted = true;
        const ok = evt.status === 'success';
        const s = evt.stats && typeof evt.stats === 'object' ? evt.stats : {};
        const text = ok
          ? texts.join('')
          : (str(evt.error?.message) ?? lastError ?? 'gemini turn failed');
        out.push(resultEvent({
          ok,
          text,
          usage: {
            input_tokens: s.input_tokens,
            output_tokens: s.output_tokens,
            cache_read_input_tokens: s.cached,
          },
          nativeSessionId: sessionId ?? undefined,
        }));
        return;
      }
      default:
    }
  }

  return {
    push(line) {
      const out = [];
      try {
        const evt = safeJsonLine(line);
        if (evt) handle(evt, out);
      } catch {
        // never throw from push; drop the line
      }
      return out;
    },
    end() {
      if (resultEmitted || lastError === null) return [];
      resultEmitted = true;
      return [resultEvent({ ok: false, text: lastError, nativeSessionId: sessionId ?? undefined })];
    },
    nativeSessionId() {
      return sessionId;
    },
  };
}

module.exports = { id: 'gemini', headlessSpawn, createParser, interactiveArgs };
