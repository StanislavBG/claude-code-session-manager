/**
 * usageMatrix.cjs — per-tab agentic-ops aggregator.
 *
 * Watches the same classified transcript events that transcripts.cjs streams
 * to the renderer and maintains a small rolling state per tab: turn count,
 * token velocity (5-min window), cache age, subagent fan-out, and behavioral
 * flags (geometric context growth, cache cold-start risk, long session).
 *
 * Lives in main rather than the renderer so a renderer reload does not lose
 * the rolling counters — multi-hour sessions are the primary use case and
 * losing the velocity series at a reload would make the dashboard useless
 * exactly when it matters most.
 *
 * Broadcasts `usage:matrix:tick` on a 5-second cadence (and once on demand
 * via the `usage:matrix:snapshot` handler at mount).
 */

'use strict';

const path = require('node:path');
const { ipcMain } = require('electron');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

const TICK_MS = 5_000;
const TOKEN_WINDOW_MS = 5 * 60_000; // 5 min rolling window for tokens/min
const TURN_RING = 20;               // per-turn input-token series cap
const TOOL_RING = 100;              // recent tool-name series cap
const CACHE_TTL_MS = 60 * 60_000;   // Anthropic prefix cache ~60 min
const CACHE_WARN_MS = 50 * 60_000;  // start warning at 50 min

const BURN_LOW = 5_000;       // tokens/min
const BURN_CRITICAL = 30_000; // tokens/min
const LONG_SESSION_TURNS = 70;
const GEOMETRIC_MIN_TOKENS = 50_000; // don't flag tiny series

/** Map<tabId, TabState> */
const tabs = new Map();
let window = null;
let tickTimer = null;
let dirty = false;

function attachWindow(w) {
  window = w;
  if (!tickTimer) {
    tickTimer = setInterval(broadcastIfChanged, TICK_MS);
  }
}

function workspaceName(cwd) {
  if (!cwd) return '(unknown)';
  return path.basename(cwd) || cwd;
}

function blankTab(tabId, cwd, sessionUuid) {
  return {
    tabId,
    cwd,
    sessionUuid,
    workspace: workspaceName(cwd),
    startedAt: Date.now(),
    lastEventAt: 0,
    lastAssistantAt: 0,
    lastUserAt: 0,
    lastPlanAt: 0,
    turns: 0,
    cumulativeUsage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    perTurnInputTokens: [],
    tokenWindow: [], // [{ts, tokens}]
    toolSeries: [],  // [{ts, name}]
    agentSpawns: 0,
    agentsActive: new Map(), // toolUseId -> {at}
  };
}

function ensureTab(tabId, cwd, sessionUuid) {
  let t = tabs.get(tabId);
  if (!t) {
    t = blankTab(tabId, cwd, sessionUuid);
    tabs.set(tabId, t);
  }
  return t;
}

/**
 * Feed one classified transcript event into the per-tab aggregator. Called
 * from transcripts.cjs for every event, both during replay and live.
 */
function recordEvent({ tabId, cwd, sessionUuid, ev }) {
  if (!tabId || !ev) return;
  const t = ensureTab(tabId, cwd, sessionUuid);
  const now = Date.now();
  t.lastEventAt = now;

  switch (ev.kind) {
    case 'usage': {
      // Each usage rollup = one assistant turn in Claude Code's transcript.
      const u = ev.data || {};
      const inTok = (u.input_tokens || 0)
        + (u.cache_creation_input_tokens || 0)
        + (u.cache_read_input_tokens || 0);
      const outTok = u.output_tokens || 0;
      t.cumulativeUsage.input += u.input_tokens || 0;
      t.cumulativeUsage.output += outTok;
      t.cumulativeUsage.cacheRead += u.cache_read_input_tokens || 0;
      t.cumulativeUsage.cacheCreate += u.cache_creation_input_tokens || 0;
      t.turns += 1;
      t.lastAssistantAt = now;

      t.perTurnInputTokens.push(inTok);
      if (t.perTurnInputTokens.length > TURN_RING) t.perTurnInputTokens.shift();

      t.tokenWindow.push({ ts: now, tokens: inTok + outTok });
      pruneWindow(t.tokenWindow, now);
      dirty = true;
      break;
    }
    case 'tool_use': {
      const name = ev.data?.name;
      if (name) {
        t.toolSeries.push({ ts: now, name });
        if (t.toolSeries.length > TOOL_RING) t.toolSeries.shift();
      }
      dirty = true;
      break;
    }
    case 'agent_spawn': {
      t.agentSpawns += 1;
      const id = ev.data?.toolUseId;
      if (id) t.agentsActive.set(id, { at: now });
      dirty = true;
      break;
    }
    case 'tool_result': {
      const id = ev.data?.toolUseId;
      if (id && t.agentsActive.has(id)) {
        t.agentsActive.delete(id);
        dirty = true;
      }
      break;
    }
    case 'plan': {
      t.lastPlanAt = now;
      dirty = true;
      break;
    }
    default:
      break;
  }
}

function pruneWindow(arr, now) {
  const cutoff = now - TOKEN_WINDOW_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
}

function removeTab(tabId) {
  if (tabs.delete(tabId)) dirty = true;
}

/**
 * Build a derived snapshot. Heavy work happens here, not on the hot
 * recordEvent path — recordEvent only appends to ring buffers and flips a
 * dirty bit.
 */
function buildSnapshot() {
  const now = Date.now();
  const out = [];

  let totalSubagentsActive = 0;
  let totalSubagentsSpawned = 0;
  let totalTokensToday = 0;
  let combinedTokensPerMin = 0;

  for (const t of tabs.values()) {
    pruneWindow(t.tokenWindow, now);
    const windowTokens = t.tokenWindow.reduce((s, e) => s + e.tokens, 0);
    const windowMin = Math.min(TOKEN_WINDOW_MS, now - (t.tokenWindow[0]?.ts ?? now)) / 60_000;
    const tokensPerMin = windowMin > 0.1 ? Math.round(windowTokens / windowMin) : 0;
    combinedTokensPerMin += tokensPerMin;

    const intensity = tokensPerMin >= BURN_CRITICAL
      ? 'critical'
      : tokensPerMin >= BURN_LOW
      ? 'medium'
      : tokensPerMin > 0
      ? 'low'
      : 'idle';

    const cacheAgeMs = t.lastAssistantAt ? now - t.lastAssistantAt : null;
    const cacheState = cacheAgeMs == null
      ? 'cold'
      : cacheAgeMs > CACHE_TTL_MS
      ? 'cold'
      : cacheAgeMs > CACHE_WARN_MS
      ? 'expiring'
      : 'warm';

    const avgPerTurn = t.perTurnInputTokens.length > 0
      ? Math.round(t.perTurnInputTokens.reduce((s, n) => s + n, 0) / t.perTurnInputTokens.length)
      : 0;

    const geometricGrowth = detectGeometricGrowth(t.perTurnInputTokens);

    // State derivation. Order matters — earlier branches win.
    let state;
    if (t.lastPlanAt > 0 && (now - t.lastPlanAt) < 60_000 && t.lastPlanAt >= t.lastAssistantAt) {
      state = 'plan';
    } else if (t.agentsActive.size > 0 && (now - t.lastAssistantAt) > 10_000) {
      state = 'background';
    } else if (t.lastEventAt > 0 && (now - t.lastEventAt) < 30_000) {
      state = 'executing';
    } else {
      state = 'idle';
    }

    const subagentsActive = t.agentsActive.size;
    totalSubagentsActive += subagentsActive;
    totalSubagentsSpawned += t.agentSpawns;
    totalTokensToday += t.cumulativeUsage.input + t.cumulativeUsage.output;

    const alerts = [];
    if (geometricGrowth) {
      alerts.push({
        level: 'warn',
        code: 'geometric-growth',
        message: `Per-turn input grew geometrically (avg ${(avgPerTurn / 1000).toFixed(0)}k). Run /compact.`,
      });
    }
    if (t.turns >= LONG_SESSION_TURNS) {
      alerts.push({
        level: 'warn',
        code: 'long-session',
        message: `Session is at turn ${t.turns}. Context resubmissions cost ${(avgPerTurn / 1000).toFixed(0)}k tokens each.`,
      });
    }
    if (cacheState === 'expiring' && state === 'idle') {
      const minLeft = Math.max(0, Math.round((CACHE_TTL_MS - (cacheAgeMs ?? 0)) / 60_000));
      alerts.push({
        level: 'info',
        code: 'cache-cold-start',
        message: `Cache cold-start in ${minLeft}m. Next command will incur full cache_creation cost.`,
      });
    }
    if (cacheState === 'cold' && t.lastAssistantAt > 0) {
      alerts.push({
        level: 'info',
        code: 'cache-cold',
        message: 'Cache expired. Next command pays full cache_creation pricing.',
      });
    }
    if (subagentsActive >= 4) {
      alerts.push({
        level: 'info',
        code: 'subagent-fanout',
        message: `${subagentsActive} subagents in flight. Consider waiting before fanning out more.`,
      });
    }

    out.push({
      tabId: t.tabId,
      workspace: t.workspace,
      cwd: t.cwd,
      state,
      turns: t.turns,
      lastEventAt: t.lastEventAt,
      lastAssistantAt: t.lastAssistantAt,
      cacheAgeMs,
      cacheState,
      tokensPerMin,
      intensity,
      avgTokensPerTurn: avgPerTurn,
      cumulativeUsage: { ...t.cumulativeUsage },
      subagentsActive,
      subagentsSpawned: t.agentSpawns,
      geometricGrowth,
      alerts,
    });
  }

  // Most active first.
  out.sort((a, b) => b.tokensPerMin - a.tokensPerMin || b.lastEventAt - a.lastEventAt);

  return {
    generatedAt: now,
    tabs: out,
    totals: {
      activeSessions: out.length,
      subagentsActive: totalSubagentsActive,
      subagentsSpawned: totalSubagentsSpawned,
      tokensTotal: totalTokensToday,
      combinedTokensPerMin,
    },
  };
}

/**
 * Geometric growth: avg of last 3 turns > 1.8 × avg of prior 3 turns,
 * and last-3 avg above GEOMETRIC_MIN_TOKENS so trivial sessions don't flag.
 */
function detectGeometricGrowth(series) {
  if (series.length < 6) return false;
  const tail = series.slice(-3);
  const prev = series.slice(-6, -3);
  const tailAvg = tail.reduce((s, n) => s + n, 0) / 3;
  const prevAvg = prev.reduce((s, n) => s + n, 0) / 3;
  if (tailAvg < GEOMETRIC_MIN_TOKENS) return false;
  if (prevAvg <= 0) return false;
  return tailAvg / prevAvg >= 1.8;
}

function broadcastIfChanged() {
  if (!dirty) return;
  dirty = false;
  if (!window) return;
  sendIfAlive(window, 'usage:matrix:tick', buildSnapshot());
}

function registerHandlers() {
  ipcMain.handle('usage:matrix:snapshot', () => buildSnapshot());
}

function closeAll() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  tabs.clear();
}

module.exports = {
  attachWindow,
  recordEvent,
  removeTab,
  registerHandlers,
  closeAll,
};
