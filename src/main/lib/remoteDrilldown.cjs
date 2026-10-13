'use strict';

// Pure builders for the phone remote's drill-down lists: projects (open tabs),
// then one project's Epics in every lifecycle status. readIndex is injected
// (production passes epicMint's readActiveIndex) so this module stays pure.

const path = require('node:path');

const STATUS_RANK = { active: 0, proposed: 1, completed: 2 };

function readSessions(readIndex, cwd) {
  try {
    const sessions = readIndex(cwd)?.sessions;
    return sessions && typeof sessions === 'object' ? sessions : {};
  } catch {
    return {};
  }
}

function tabTitle(tab) {
  return tab.label || path.basename(tab.cwd);
}

function validTabs(tabs) {
  return (Array.isArray(tabs) ? tabs : []).filter((t) => t && typeof t.cwd === 'string' && t.cwd);
}

function toMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function epicUpdatedAt(epic) {
  for (const v of [epic.updatedAt, epic.completedAt, epic.createdAt]) {
    if (v !== undefined && v !== null && v !== '') return toMs(v);
  }
  return null;
}

function listRemoteProjects(tabs, readIndex) {
  const seen = new Set();
  const out = [];
  for (const tab of validTabs(tabs)) {
    if (seen.has(tab.cwd)) continue;
    seen.add(tab.cwd);
    const counts = { proposed: 0, active: 0, completed: 0 };
    for (const epic of Object.values(readSessions(readIndex, tab.cwd))) {
      if (epic && Object.prototype.hasOwnProperty.call(counts, epic.status)) counts[epic.status] += 1;
    }
    out.push({ cwd: tab.cwd, title: tabTitle(tab), mainTabId: tab.id ?? tab.sessionId, counts });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

function listRemoteProjectSessions(tabs, readIndex, cwd, { completedLimit = 20 } = {}) {
  const tab = validTabs(tabs).find((t) => t.cwd === cwd);
  if (!tab) return null;
  const project = { cwd: tab.cwd, title: tabTitle(tab), mainTabId: tab.id ?? tab.sessionId };
  const rows = [];
  for (const epic of Object.values(readSessions(readIndex, tab.cwd))) {
    if (!epic || !Object.prototype.hasOwnProperty.call(STATUS_RANK, epic.status)) continue;
    const firstLine = typeof epic.goalText === 'string' ? epic.goalText.split('\n')[0].trim().slice(0, 80).trim() : '';
    rows.push({
      epicId: epic.id,
      claudeSessionId: typeof epic.claudeSessionId === 'string' && epic.claudeSessionId ? epic.claudeSessionId : null,
      title: firstLine || epic.id,
      status: epic.status,
      tag: epic.tag,
      agentType: epic.agentType,
      spawnCwd: epic.worktree?.dir || epic.cwd || tab.cwd,
      updatedAt: epicUpdatedAt(epic),
    });
  }
  rows.sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    if (a.updatedAt === b.updatedAt) return 0;
    if (a.updatedAt === null) return 1;
    if (b.updatedAt === null) return -1;
    return b.updatedAt - a.updatedAt;
  });
  let completed = 0;
  const sessions = rows.filter((s) => s.status !== 'completed' || ++completed <= completedLimit);
  return { project, sessions };
}

module.exports = { listRemoteProjects, listRemoteProjectSessions };
