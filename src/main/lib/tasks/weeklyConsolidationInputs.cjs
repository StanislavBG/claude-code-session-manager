'use strict';

/**
 * weeklyConsolidationInputs.cjs — what the weekly memory + docs consolidation
 * pass may read: this project's own session transcripts and the Lessons blocks
 * headless PRD jobs handed over, both inside a half-open window [since, until).
 *
 * Pure + dependency-injected (deps.*); the defaults lazy-require the real
 * readers. Read-only: never writes a transcript or a job record.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { encodeCwd } = require('../util/encodeCwd.cjs');

const MAX_TRANSCRIPTS = 200;
const MAX_LESSON_LINES = 3;
const MAX_LESSON_CHARS = 200;
const HEAD_BYTES = 64 * 1024;

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** Half-open window test: since <= t < until. */
function inWindow(t, sinceMs, untilMs) {
  return typeof t === 'number' && Number.isFinite(t) && t >= sinceMs && t < untilMs;
}

function defaultDeps() {
  return {
    projectsDir: path.join(os.homedir(), '.claude', 'projects'),
    readdir: (d) => { try { return fs.readdirSync(d); } catch { return []; } },
    stat: (p) => { try { return fs.statSync(p); } catch { return null; } },
    // First lines only — never the whole file.
    readFirstCwd: (file) => {
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(HEAD_BYTES);
        const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
        for (const line of buf.toString('utf8', 0, n).split('\n').slice(0, 20)) {
          if (!line.includes('"cwd"')) continue;
          try { const o = JSON.parse(line); if (o && typeof o.cwd === 'string') return o.cwd; } catch { /* torn line */ }
        }
      } catch { /* unreadable */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
      return null;
    },
    mainRootOf: (cwd) => require('../cwdClassify.cjs').worktreeMainRootOf(cwd),
    readJobs: () => require('../scheduler/queueStore.cjs').readMergedSync().jobs,
    // Finished jobs leave the queue for the per-project history shard.
    readHistory: (cwd) => {
      const { readHistoryFileTailSync } = require('../scheduler/queueHistory.cjs');
      const { projectHistoryPath } = require('../scheduler/queueStore.cjs');
      return readHistoryFileTailSync(projectHistoryPath(cwd), { maxRows: 500 });
    },
    // The project key gitWorktree mints into <root>/<key>/<name> (same function).
    worktreeKeyOf: (cwd) => {
      const { worktreeDirFor } = require('../git/gitWorktree.cjs');
      return path.basename(path.dirname(worktreeDirFor('epic', cwd, 'x')));
    },
    runsDir: () => require('../scheduler/schedulerPaths.cjs').runsDir(),
    readResultText: (logPath) => require('../../scheduler.cjs').extractResultTextFromLog(logPath),
    readStructured: (logPath) => require('../../scheduler.cjs').extractStructuredOutputFromLog(logPath),
  };
}

function withDefaults(deps) {
  return { ...defaultDeps(), ...(deps || {}) };
}

/** True when `sessionCwd` is the project root or one of its worktrees. */
function belongsToProject(sessionCwd, root, d) {
  if (typeof sessionCwd !== 'string' || !sessionCwd) return false;
  const norm = (p) => path.resolve(p);
  if (norm(sessionCwd) === norm(root)) return true;
  let main = null;
  try { main = d.mainRootOf(sessionCwd); } catch { main = null; }
  if (main && norm(main) === norm(root)) return true;
  return deadWorktreeOf(sessionCwd, root, d);
}

/** Dead managed worktree (git admin gone): match the project key in its path. */
function deadWorktreeOf(sessionCwd, root, d) {
  const parts = path.resolve(sessionCwd).split(path.sep);
  const i = parts.findIndex((p) => p === 'session-manager-epic-worktrees' || p === 'session-manager-job-worktrees');
  if (i < 0 || !parts[i + 1]) return false;
  let key = null;
  try { key = d.worktreeKeyOf(root); } catch { key = null; }
  return !!key && parts[i + 1] === key;
}

/**
 * listProjectTranscripts({ cwd, sinceMs, untilMs, deps }) →
 *   { transcripts: [{ path, sessionId, mtimeMs, cwd }], truncated, total, range: { since, until } }
 */
function listProjectTranscripts({ cwd, sinceMs, untilMs, deps } = {}) {
  const d = withDefaults(deps);
  const range = { since: sinceMs, until: untilMs };
  const found = [];
  if (!cwd || typeof cwd !== 'string') return { transcripts: [], truncated: 0, total: 0, range };
  const enc = encodeCwd(cwd);
  for (const folder of d.readdir(d.projectsDir) || []) {
    // Cheap name filter first: the project's own folder (or a sibling sharing its
    // prefix, rejected below by the real cwd) and managed worktree folders.
    if (!folder.startsWith(enc) && !folder.includes('worktrees')) continue;
    const dir = path.join(d.projectsDir, folder);
    const inWin = [];
    for (const name of d.readdir(dir) || []) {
      if (!name.endsWith('.jsonl')) continue; // also skips subagents/ directories
      const file = path.join(dir, name);
      const st = d.stat(file);
      if (!st || !inWindow(st.mtimeMs, sinceMs, untilMs)) continue;
      inWin.push({ file, name, mtimeMs: st.mtimeMs });
    }
    if (!inWin.length) continue;
    // A folder is one cwd; read it once, from the newest in-window file.
    inWin.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let sessionCwd = null;
    for (const f of inWin) { sessionCwd = d.readFirstCwd(f.file); if (sessionCwd) break; }
    if (!belongsToProject(sessionCwd, cwd, d)) continue;
    for (const f of inWin) found.push({ path: f.file, sessionId: f.name.slice(0, -'.jsonl'.length), mtimeMs: f.mtimeMs, cwd: sessionCwd });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
  const transcripts = found.slice(0, MAX_TRANSCRIPTS);
  return { transcripts, truncated: found.length - transcripts.length, total: found.length, range };
}

function clip(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > MAX_LESSON_CHARS ? t.slice(0, MAX_LESSON_CHARS) : t;
}

/** Trailing 'Lessons' block of a result text → up to 3 lines, or []. Lenient. */
function parseLessonsBlock(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*lessons\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i.test(lines[i])) { at = i; break; }
  }
  if (at < 0) return [];
  const out = [];
  for (let i = at + 1; i < lines.length && out.length < MAX_LESSON_LINES; i++) {
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(lines[i]);
    if (!m) { if (!lines[i].trim()) continue; break; }
    out.push(clip(m[1]));
  }
  return out;
}

function lessonsFromField(v) {
  if (typeof v === 'string') return v.split('\n').map((l) => clip(l.replace(/^\s*[-*]\s+/, ''))).filter(Boolean).slice(0, MAX_LESSON_LINES);
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').map(clip).filter(Boolean).slice(0, MAX_LESSON_LINES);
  return [];
}

/**
 * collectLessons({ cwd, sinceMs, untilMs, deps }) →
 *   { lessons: [{ slug, jobId, source, lines }], range: { since, until } }
 */
function collectLessons({ cwd, sinceMs, untilMs, deps } = {}) {
  const d = withDefaults(deps);
  const range = { since: sinceMs, until: untilMs };
  const lessons = [];
  if (!cwd || typeof cwd !== 'string') return { lessons, range };
  let live = [];
  try { live = d.readJobs(cwd) || []; } catch { live = []; }
  let hist = [];
  try { hist = d.readHistory(cwd) || []; } catch { hist = []; }
  const seen = new Set();
  const jobs = [];
  for (const j of [...live, ...hist]) {
    if (!j || typeof j !== 'object') continue;
    const id = j.id ?? j.runId;
    if (id != null) { if (seen.has(id)) continue; seen.add(id); }
    jobs.push(j);
  }
  for (const job of jobs) {
    if (!job || typeof job !== 'object' || !job.finishedAt || !job.runId || !job.slug) continue;
    if (!belongsToProject(job.cwd, cwd, d)) continue;
    if (!inWindow(toMs(job.finishedAt), sinceMs, untilMs)) continue;
    const jobId = job.id ?? job.runId ?? null;
    const slug = job.slug ?? null;
    let logPath = null;
    try { logPath = path.join(d.runsDir(), String(job.runId), `${job.slug}.log`); } catch { continue; }
    if (job.agentType === 'validator') {
      let so = null;
      try { so = d.readStructured(logPath); } catch { so = null; }
      if (!so || typeof so !== 'object') continue;
      const top = lessonsFromField(so.lessons);
      if (top.length) lessons.push({ slug, jobId, source: 'validator', lines: top });
      for (const v of Array.isArray(so.verdicts) ? so.verdicts : []) {
        const lines = lessonsFromField(v && v.lessons);
        if (lines.length) lessons.push({ slug: (v && v.prd) || slug, jobId, source: 'validator', lines });
      }
    } else {
      let text = null;
      try { text = d.readResultText(logPath); } catch { text = null; }
      const lines = parseLessonsBlock(text);
      if (lines.length) lessons.push({ slug, jobId, source: 'dev-lead', lines });
    }
  }
  return { lessons, range };
}

module.exports = {
  listProjectTranscripts, collectLessons, parseLessonsBlock, inWindow,
  MAX_TRANSCRIPTS, MAX_LESSON_LINES, MAX_LESSON_CHARS,
};
