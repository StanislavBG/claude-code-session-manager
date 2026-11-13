'use strict';
// OpenCode (`opencode run`) adapter: builds argv for opencode 1.19 and
// translates `opencode run --format json` JSONL into the Claude stream-json
// events from ../agentCliEvents.cjs. The prompt goes over stdin (verified live
// on 1.19.5), so it never hits argv limits. OpenCode emits no terminal result
// event; end() synthesizes one from the last step_finish reason, the exit
// code, and any error event seen. Pure module.

const {
  initEvent, textEvent, toolUseEvent, toolResultEvent, resultEvent, safeJsonLine,
} = require('../agentCliEvents.cjs');

const HEADLESS_FLAGS = ['run', '--format', 'json', '--auto'];

const hasId = (id) => typeof id === 'string' && id.length > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const sessionArgs = (id) => (hasId(id) ? ['--session', id] : []);
const modelArgs = (model) => (typeof model === 'string' && model ? ['--model', model] : []);

function headlessSpawn({ prompt, nativeSessionId, model } = {}) {
  return {
    args: [...HEADLESS_FLAGS, ...sessionArgs(nativeSessionId), ...modelArgs(model)],
    stdin: typeof prompt === 'string' ? prompt : '',
  };
}

function interactiveArgs({ nativeSessionId, model } = {}) {
  return ['--auto', ...sessionArgs(nativeSessionId), ...modelArgs(model)];
}

function errorMessage(evt) {
  if (typeof evt.message === 'string' && evt.message) return evt.message;
  const err = isObj(evt.error) ? evt.error : {};
  if (isObj(err.data) && typeof err.data.message === 'string' && err.data.message) return err.data.message;
  if (typeof err.name === 'string' && err.name) return err.name;
  return 'opencode error';
}

function createParser() {
  let sessionId = null;
  let lastReason = null;
  let errorSeen = null;
  let ended = false;
  const texts = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  function handle(evt, out) {
    if (sessionId === null && hasId(evt.sessionID)) {
      sessionId = evt.sessionID;
      out.push(initEvent(sessionId, 'opencode'));
    }
    const part = isObj(evt.part) ? evt.part : null;
    switch (evt.type) {
      case 'text':
        if (part && typeof part.text === 'string' && part.text) {
          texts.push(part.text);
          out.push(textEvent(part.text));
        }
        return;
      case 'tool_use': {
        if (!part || !hasId(part.callID)) return;
        const state = isObj(part.state) ? part.state : {};
        out.push(toolUseEvent({ id: part.callID, name: part.tool, input: state.input }));
        out.push(toolResultEvent({
          toolUseId: part.callID,
          content: state.output ?? '',
          isError: state.status === 'error',
        }));
        return;
      }
      case 'step_finish': {
        if (!part) return;
        const t = isObj(part.tokens) ? part.tokens : {};
        usage.input_tokens += num(t.input);
        usage.output_tokens += num(t.output);
        usage.cache_read_input_tokens += num(isObj(t.cache) ? t.cache.read : 0);
        if (typeof part.reason === 'string') lastReason = part.reason;
        return;
      }
      case 'error':
        errorSeen = errorMessage(evt);
        return;
      default: // step_start and unknown types: no event
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
    end({ exitCode } = {}) {
      if (ended) return [];
      ended = true;
      const nativeSessionId = sessionId ?? undefined;
      if (errorSeen !== null) {
        return [resultEvent({ ok: false, text: errorSeen, usage: { ...usage }, nativeSessionId })];
      }
      if (lastReason === 'stop' && exitCode === 0) {
        return [resultEvent({ ok: true, text: texts.join(''), usage: { ...usage }, nativeSessionId })];
      }
      return [];
    },
    nativeSessionId() {
      return sessionId;
    },
  };
}

module.exports = { id: 'opencode', headlessSpawn, createParser, interactiveArgs };
