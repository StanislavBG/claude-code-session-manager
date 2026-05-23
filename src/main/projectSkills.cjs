/**
 * ProjectSkills — per-project skill enable/disable state.
 *
 * Storage: <cwd>/.claude/project-skills.json
 *   Format: { skills: Array<{ skillId: string; enabled: boolean }>, schemaVersion: 1 }
 *
 * Reads enumerate all skills under <cwd>/.claude/skills/ and <home>/.claude/skills/
 * and merge their enable state from the project-local config. Skills not listed in
 * the JSON default to `enabled: true` (i.e., opt-out per project).
 *
 * IPC:
 *   - project-skills:get(cwd) -> SkillState[]
 *   - project-skills:set(cwd, skillId, enabled) -> { ok: boolean }
 *
 * Atomic writes go through config.cjs::writeJson. cwd is validated via
 * validatePath which constrains it to allowedRoots (home + registered project
 * dirs).
 */

const { ipcMain } = require('electron');
const path = require('node:path');
const { z } = require('zod');
const { readJson, writeJson, addAllowedRoot } = require('./config.cjs');

const SCHEMA_VERSION = 1;

function projectSkillsPath(cwd) {
  return path.join(cwd, '.claude', 'project-skills.json');
}

/**
 * Load the project-skills.json record for a cwd. Missing file => empty record.
 * Returns { skills: Array<{skillId, enabled}>, schemaVersion }.
 */
async function loadRecord(cwd) {
  const filePath = projectSkillsPath(cwd);
  const r = await readJson(filePath);
  if (!r.exists || !r.data || typeof r.data !== 'object') {
    return { skills: [], schemaVersion: SCHEMA_VERSION };
  }
  const data = r.data;
  const skills = Array.isArray(data.skills) ? data.skills : [];
  // Filter for well-formed entries; tolerate corruption silently.
  const clean = [];
  const seen = new Set();
  for (const s of skills) {
    if (!s || typeof s.skillId !== 'string' || typeof s.enabled !== 'boolean') continue;
    if (seen.has(s.skillId)) continue;
    seen.add(s.skillId);
    clean.push({ skillId: s.skillId, enabled: s.enabled });
  }
  return { skills: clean, schemaVersion: SCHEMA_VERSION };
}

async function saveRecord(cwd, record) {
  const filePath = projectSkillsPath(cwd);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    skills: record.skills,
    savedAt: Date.now(),
  };
  return writeJson(filePath, payload);
}

/** Return the array of skill enable-states for a project cwd. */
async function getProjectSkills(cwd) {
  // Register cwd so writeJson is permitted under <cwd>/.claude.
  addAllowedRoot(cwd);
  const record = await loadRecord(cwd);
  return record.skills;
}

/** Upsert a single skillId's enabled flag. */
async function setProjectSkill(cwd, skillId, enabled) {
  addAllowedRoot(cwd);
  const record = await loadRecord(cwd);
  const idx = record.skills.findIndex((s) => s.skillId === skillId);
  if (idx >= 0) {
    record.skills[idx] = { skillId, enabled };
  } else {
    record.skills.push({ skillId, enabled });
  }
  await saveRecord(cwd, record);
  return { ok: true };
}

// ──────────────────────────────────────────── IPC schemas
const projectSkillsCwd = z.object({
  cwd: z.string().min(1).max(4096),
});

const projectSkillsSet = z.object({
  cwd: z.string().min(1).max(4096),
  skillId: z.string().min(1).max(256),
  enabled: z.boolean(),
});

function validated(schema, handler) {
  return (_event, payload) => {
    const parsed = schema.parse(payload);
    return handler(parsed);
  };
}

function registerProjectSkillsHandlers() {
  ipcMain.handle(
    'project-skills:get',
    validated(projectSkillsCwd, ({ cwd }) => getProjectSkills(cwd)),
  );
  ipcMain.handle(
    'project-skills:set',
    validated(projectSkillsSet, ({ cwd, skillId, enabled }) =>
      setProjectSkill(cwd, skillId, enabled),
    ),
  );
}

module.exports = {
  registerProjectSkillsHandlers,
  // Exported for tests / direct use.
  getProjectSkills,
  setProjectSkill,
  projectSkillsPath,
};
