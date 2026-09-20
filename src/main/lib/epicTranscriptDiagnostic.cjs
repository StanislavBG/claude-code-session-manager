'use strict';

/**
 * epicTranscriptDiagnostic.cjs — read-only scan for Epics whose claude
 * transcript is not where the project-scoped lookup would put it.
 *
 *   mislocated — exactly one transcript exists and it is not under
 *                <encodeCwd(project cwd)> (i.e. only a worktree encoding).
 *   duplicated — the same session id has transcripts under 2+ encodings; the
 *                state in which `claude --resume` fails from any third cwd.
 *
 * Bounded: walks Epic records of the supplied project cwds and stats each
 * Epic's candidate paths via resolveEpicTranscriptPath. Never enumerates
 * ~/.claude/projects. Writes nothing. Complexity: O(epics x candidates).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeCwd } = require('./encodeCwd.cjs');
const { readActiveIndex } = require('./epicMint.cjs');
const { opsPath } = require('./opsOwnership.cjs');
const { resolveEpicTranscriptPath } = require('./epicTranscriptPath.cjs');

/** [epicId, session] pairs: active-index rows plus archived per-Epic `<id>.json` records. */
function epicRecords(cwd) {
  const out = new Map();
  try {
    for (const [id, s] of Object.entries(readActiveIndex(cwd).sessions || {})) out.set(id, s);
  } catch { /* unreadable index → archives only */ }
  let dir;
  let names = [];
  try {
    dir = opsPath(cwd, 'prompt-sessions');
    names = fs.readdirSync(dir);
  } catch { /* no ops dir → skip */ }
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'active-index.json') continue;
    const id = name.slice(0, -5);
    if (out.has(id)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))?.session;
      if (s && typeof s === 'object') out.set(id, s);
    } catch { /* malformed record → skip */ }
  }
  return out;
}

/**
 * @param {{ cwds: string[], homeDir?: string }} opts
 * @returns {Array<{ sessionId: string, epicId: string, cwd: string, paths: string[], classification: 'mislocated'|'duplicated' }>}
 */
function scanEpicTranscripts({ cwds, homeDir = os.homedir() }) {
  const findings = [];
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  for (const cwd of cwds || []) {
    const sessions = epicRecords(cwd);
    const home = path.join(projectsDir, encodeCwd(cwd));
    for (const [epicId, s] of sessions) {
      const sessionId = s && s.claudeSessionId;
      if (!sessionId || typeof sessionId !== 'string') continue;
      let res;
      try {
        res = resolveEpicTranscriptPath({ cwd, claudeSessionId: sessionId, deps: { homeDir } });
      } catch {
        continue;
      }
      const paths = res.existingPaths;
      if (paths.length > 1) {
        findings.push({ sessionId, epicId, cwd, paths, classification: 'duplicated' });
      } else if (paths.length === 1 && path.dirname(paths[0]) !== home) {
        findings.push({ sessionId, epicId, cwd, paths, classification: 'mislocated' });
      }
    }
  }
  return findings;
}

module.exports = { scanEpicTranscripts };
