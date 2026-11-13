'use strict';
// Google Antigravity CLI (`agy`) adapter: builds headless/interactive argv and
// translates agy's `--output-format stream-json` NDJSON (every line carries an
// `event` field: init / step_update / result) into the Claude stream-json
// events from ../agentCliEvents.cjs. The prompt is delivered over stdin as one
// `--input-format stream-json` user line, never in argv; agy exits after stdin
// closes. `--conversation <id>` resumes. Pure module.

const {
  initEvent, textEvent, toolUseEvent, toolResultEvent, resultEvent, safeJsonLine,
} = require('../agentCliEvents.cjs');

const SKIP_PERMS = '--dangerously-skip-permissions';
const HEADLESS_FLAGS = ['--input-format', 'stream-json', '--output-format', 'stream-json', SKIP_PERMS];

const str = (v) => (typeof v === 'string' ? v : undefined);
const hasId = (id) => typeof id === 'string' && id.length > 0;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sessionArgs = (id) => (hasId(id) ? ['--conversation', id] : []);
const modelArgs = (model) => (typeof model === 'string' && model ? ['--model', model] : []);

function headlessSpawn({ prompt, nativeSessionId, model } = {}) {
  return {
    args: [...HEADLESS_FLAGS, ...sessionArgs(nativeSessionId), ...modelArgs(model)],
    stdin: JSON.stringify({ event: 'user', message: { content: typeof prompt === 'string' ? prompt : '' } }) + '\n',
  };
}

function interactiveArgs({ nativeSessionId, model } = {}) {
  return [SKIP_PERMS, ...sessionArgs(nativeSessionId), ...modelArgs(model)];
}

function pickUsage(u) {
  if (!isObj(u)) return undefined;
  const out = {};
  for (const k of ['input_tokens', 'output_tokens']) {
    if (typeof u[k] === 'number' && Number.isFinite(u[k])) out[k] = u[k];
  }
  return out;
}

function createParser() {
  let sessionId = null;
  let resultEmitted = false;
  let initEmitted = false;
  const texts = [];
  const toolStarted = new Set();
  const toolDone = new Set();

  // conversation_id may sit at the top level or inside the event payload.
  function convId(evt, payload) {
    const id = str(evt.conversation_id) ?? (isObj(payload) ? str(payload.conversation_id) : undefined);
    return hasId(id) ? id : undefined;
  }

  function adopt(id) {
    if (id && !sessionId) sessionId = id;
  }

  function handleStep(evt, out) {
    const s = evt.step_update;
    if (!isObj(s)) return;
    adopt(convId(evt, s));
    if (s.step_type === 'agent_response') {
      const delta = str(s.text_delta);
      if (delta) {
        texts.push(delta);
        out.push(textEvent(delta));
      }
      return;
    }
    if (s.step_type !== 'tool') return; // user_input / checkpoint / unknown: ignored
    const key = `${sessionId ?? convId(evt, s) ?? ''}:${s.step_index}`;
    const startTool = () => {
      if (toolStarted.has(key)) return;
      toolStarted.add(key);
      out.push(toolUseEvent({
        id: key,
        name: str(s.tool_name) ?? 'unknown',
        input: isObj(s.tool_info) ? s.tool_info : {},
      }));
    };
    if (s.state === 'ACTIVE') {
      startTool();
    } else if (s.state === 'DONE') {
      if (toolDone.has(key)) return;
      startTool(); // keep tool_use/tool_result paired if ACTIVE was never seen
      toolDone.add(key);
      out.push(toolResultEvent({ toolUseId: key, content: '', isError: false }));
    }
  }

  function handleResult(evt, out) {
    const r = evt.result;
    if (!isObj(r) || resultEmitted) return;
    resultEmitted = true;
    adopt(convId(evt, r));
    const text = texts.join('') || str(r.response) || str(r.error) || '';
    out.push(resultEvent({
      ok: r.status === 'SUCCESS',
      text,
      usage: pickUsage(r.usage),
      nativeSessionId: sessionId ?? undefined,
    }));
  }

  function handle(evt, out) {
    switch (evt.event) {
      case 'init': {
        adopt(convId(evt, evt.init));
        if (sessionId && !initEmitted) {
          initEmitted = true;
          out.push(initEvent(sessionId, 'antigravity'));
        }
        return;
      }
      case 'step_update':
        handleStep(evt, out);
        return;
      case 'result':
        handleResult(evt, out);
        return;
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
        return []; // never throw from push; drop the line
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

module.exports = { id: 'antigravity', headlessSpawn, createParser, interactiveArgs };
