'use strict';
// Machine-level runtime state for non-Claude agent-CLI Epics (not an ops-root
// namespace, so opsOwnership.cjs is not involved). Two artifacts per Epic,
// keyed by the app-level claudeSessionId UUID:
//   <root>/sessions/<id>.json     — sidecar mapping to the CLI's native session id
//   <root>/transcripts/<id>.jsonl — Claude-transcript-compatible JSONL so the
//                                   existing tail / Chat feed / usage readers work
// <root> = $SM_AGENT_CLI_STATE_DIR or schedulerPaths.agentCliStateRoot()
// (<SM_SCHEDULER_HOME or ~/.claude/session-manager>/agent-cli),
// resolved per call so tests (and env changes) take effect without re-require.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomicSync, readJsonOrSync } = require('../util/atomicFs.cjs');
const schedulerPaths = require('../scheduler/schedulerPaths.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIR_MODE = 0o700;

function rootDir() {
  const env = process.env.SM_AGENT_CLI_STATE_DIR;
  if (typeof env === 'string' && env.trim()) return env;
  return schedulerPaths.agentCliStateRoot();
}

function assertId(claudeSessionId) {
  if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
    throw new Error(`agentCliSessionStore: invalid claudeSessionId ${JSON.stringify(String(claudeSessionId))}`);
  }
  return claudeSessionId;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

function sessionPathFor(claudeSessionId) {
  return path.join(rootDir(), 'sessions', `${assertId(claudeSessionId)}.json`);
}

function transcriptPathFor(claudeSessionId) {
  return path.join(rootDir(), 'transcripts', `${assertId(claudeSessionId)}.jsonl`);
}

function readNativeSession(claudeSessionId) {
  const v = readJsonOrSync(sessionPathFor(claudeSessionId), null);
  if (!v || typeof v !== 'object' || typeof v.nativeSessionId !== 'string') return null;
  return { cli: v.cli, nativeSessionId: v.nativeSessionId, updatedAt: v.updatedAt };
}

function writeNativeSession(claudeSessionId, { cli, nativeSessionId } = {}) {
  const file = sessionPathFor(claudeSessionId);
  if (typeof nativeSessionId !== 'string' || !nativeSessionId) {
    throw new Error('agentCliSessionStore: nativeSessionId must be a non-empty string');
  }
  ensureDir(path.dirname(file));
  const rec = { cli, nativeSessionId, updatedAt: new Date().toISOString() };
  writeJsonAtomicSync(file, rec);
  return rec;
}

/**
 * Appends Claude-transcript-shaped JSONL lines for one CLI run. Consecutive
 * assistant text events coalesce into one line, flushed at the next
 * tool_use / tool_result / result event or close(). Never throws on I/O.
 */
function createTranscriptWriter({ claudeSessionId, cwd, cli } = {}) {
  const file = transcriptPathFor(claudeSessionId);
  let pendingText = null;
  let logged = false;
  let dirReady = false;

  function append(type, message) {
    const line = {
      type,
      message,
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: claudeSessionId,
      cwd,
      agentCli: cli,
    };
    try {
      if (!dirReady) { ensureDir(path.dirname(file)); dirReady = true; }
      fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
    } catch (e) {
      if (!logged) {
        logged = true;
        console.warn(`[agentCliSessionStore] transcript write failed for ${claudeSessionId}: ${e && e.message}`);
      }
    }
  }

  function flushText() {
    if (pendingText === null) return;
    const text = pendingText;
    pendingText = null;
    append('assistant', { role: 'assistant', content: [{ type: 'text', text }] });
  }

  function userPrompt(text) {
    flushText();
    append('user', { role: 'user', content: typeof text === 'string' ? text : String(text ?? '') });
  }

  function event(ev) {
    try {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'system') return;
      if (ev.type === 'result') {
        flushText();
        if (ev.usage && typeof ev.usage === 'object') {
          append('assistant', { role: 'assistant', content: [], usage: ev.usage });
        }
        return;
      }
      if (ev.type !== 'assistant' && ev.type !== 'user') return;
      const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          if (ev.type === 'assistant') pendingText = (pendingText ?? '') + block.text;
        } else if (block.type === 'tool_use') {
          flushText();
          append('assistant', { role: 'assistant', content: [block] });
        } else if (block.type === 'tool_result') {
          flushText();
          append('user', { role: 'user', content: [block] });
        }
      }
    } catch (e) {
      if (!logged) {
        logged = true;
        console.warn(`[agentCliSessionStore] transcript event failed for ${claudeSessionId}: ${e && e.message}`);
      }
    }
  }

  function close() {
    flushText();
  }

  return { userPrompt, event, close };
}

module.exports = {
  readNativeSession,
  writeNativeSession,
  transcriptPathFor,
  createTranscriptWriter,
};
