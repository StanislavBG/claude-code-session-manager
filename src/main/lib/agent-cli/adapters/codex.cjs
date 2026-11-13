'use strict';
// OpenAI Codex CLI (0.168) adapter: builds headless/interactive argv and
// translates `codex exec --json` JSONL into the Claude stream-json events
// from ../agentCliEvents.cjs. Pure module — spawning is the caller's job.

const {
  initEvent, textEvent, toolUseEvent, toolResultEvent, resultEvent, safeJsonLine,
} = require('../agentCliEvents.cjs');

const BYPASS = '--dangerously-bypass-approvals-and-sandbox';

function modelArgs(model) {
  return typeof model === 'string' && model ? ['-m', model] : [];
}

function hasId(id) {
  return typeof id === 'string' && id.length > 0;
}

function headlessSpawn({ prompt, nativeSessionId, model } = {}) {
  const head = hasId(nativeSessionId) ? ['exec', 'resume', nativeSessionId] : ['exec'];
  return {
    args: [...head, '--json', BYPASS, '--skip-git-repo-check', ...modelArgs(model), '-'],
    stdin: prompt,
  };
}

function interactiveArgs({ nativeSessionId, model } = {}) {
  const head = hasId(nativeSessionId) ? ['resume', nativeSessionId] : [];
  return [...head, BYPASS, ...modelArgs(model)];
}

const str = (v) => (typeof v === 'string' ? v : undefined);

// Per item type: the Claude tool name + input, and the tool_result on completion.
const TOOL_ITEMS = {
  command_execution: {
    use: (it) => ({ name: 'Bash', input: { command: str(it.command) ?? '' } }),
    result: (it) => ({
      content: str(it.aggregated_output) ?? '',
      isError: (typeof it.exit_code === 'number' && it.exit_code !== 0) || it.status === 'failed',
    }),
  },
  file_change: {
    use: (it) => ({ name: 'Edit', input: { changes: Array.isArray(it.changes) ? it.changes : [] } }),
    result: () => ({ content: 'ok', isError: false }),
  },
  mcp_tool_call: {
    use: (it) => ({
      name: `mcp__${str(it.server) ?? 'unknown'}__${str(it.tool) ?? 'unknown'}`,
      input: it.arguments && typeof it.arguments === 'object' ? it.arguments : {},
    }),
    result: (it) => {
      const errMsg = str(it.error?.message) ?? str(it.error);
      if (errMsg || it.status === 'failed') return { content: errMsg ?? 'failed', isError: true };
      return { content: it.result ?? 'ok', isError: false };
    },
  },
  web_search: {
    use: (it) => ({ name: 'WebSearch', input: { query: str(it.query) ?? '' } }),
    result: () => ({ content: 'ok', isError: false }),
  },
  todo_list: {
    use: (it) => ({ name: 'TodoWrite', input: { todos: Array.isArray(it.items) ? it.items : [] } }),
    result: () => ({ content: 'ok', isError: false }),
  },
};

function createParser() {
  let sessionId = null;
  let resultEmitted = false;
  let lastError = null;
  const texts = [];
  const startedIds = new Set();

  function emitUse(it, spec, out) {
    const { name, input } = spec.use(it);
    out.push(toolUseEvent({ id: it.id, name, input }));
    if (hasId(it.id)) startedIds.add(it.id);
  }

  function onItem(phase, it, out) {
    if (!it || typeof it !== 'object') return;
    if (it.type === 'agent_message') {
      if (phase === 'completed' && typeof it.text === 'string') {
        texts.push(it.text);
        out.push(textEvent(it.text));
      }
      return;
    }
    const spec = TOOL_ITEMS[it.type];
    if (!spec) return; // reasoning, error items, unknown types
    if (phase === 'started') {
      if (!(hasId(it.id) && startedIds.has(it.id))) emitUse(it, spec, out);
      return;
    }
    if (!(hasId(it.id) && startedIds.has(it.id))) emitUse(it, spec, out);
    const { content, isError } = spec.result(it);
    out.push(toolResultEvent({ toolUseId: it.id, content, isError }));
  }

  function handle(evt, out) {
    switch (evt.type) {
      case 'thread.started':
        if (hasId(evt.thread_id)) {
          sessionId = evt.thread_id;
          out.push(initEvent(sessionId, 'codex'));
        }
        return;
      case 'item.started':
        onItem('started', evt.item, out);
        return;
      case 'item.completed':
        onItem('completed', evt.item, out);
        return;
      case 'turn.completed': {
        if (resultEmitted) return;
        resultEmitted = true;
        const u = evt.usage && typeof evt.usage === 'object' ? evt.usage : {};
        out.push(resultEvent({
          ok: true,
          text: texts.join('\n\n'),
          usage: {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cache_read_input_tokens: u.cached_input_tokens,
          },
          nativeSessionId: sessionId ?? undefined,
        }));
        return;
      }
      case 'turn.failed':
        if (resultEmitted) return;
        resultEmitted = true;
        out.push(resultEvent({
          ok: false,
          text: str(evt.error?.message) ?? 'codex turn failed',
          nativeSessionId: sessionId ?? undefined,
        }));
        return;
      case 'error':
        lastError = str(evt.message) ?? 'codex error';
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

module.exports = { id: 'codex', headlessSpawn, createParser, interactiveArgs };
