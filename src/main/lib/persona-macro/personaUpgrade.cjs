'use strict';
/**
 * The one place that decides whether an installed bundled persona is behind the bundled
 * seedVersion, and performs the two user actions: take the bundled version (backup first,
 * user frontmatter edits kept) or keep mine (dismissed until the next seedVersion bump).
 * Boot upgrade pass: ../../seedAgentPersonas.cjs.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  PERSONAS, readSeedVersion, personaBodyHash, normalizeNewlines, buildUpgradedPersona,
  backupPathFor, bundledSourceDir, destAgentsDir,
} = require('../../seedAgentPersonas.cjs');
const { schedulerHome } = require('../scheduler/schedulerPaths.cjs');
const { SHIPPED_PERSONA_SEEDS } = require('./shippedPersonaSeeds.cjs');
const { splitFrontmatter } = require('../prd/prdFrontmatter.cjs');
const { writeTextAtomic, validatePath, validateWrite } = require('../../config.cjs');

function dismissalsPath() {
  return path.join(schedulerHome(), 'persona-upgrade-dismissals.json');
}

/** { [name]: bundledVersion } — {} for a missing or malformed file; invalid values dropped. */
function readDismissals() {
  try {
    const raw = JSON.parse(fs.readFileSync(dismissalsPath(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) if (Number.isInteger(v) && v >= 1) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Status for an installed persona that is behind its bundled version, else null. Never throws. */
function personaUpgradeFor(name, installedText, { shippedSeeds = SHIPPED_PERSONA_SEEDS, srcDir = bundledSourceDir(), dismissals = readDismissals() } = {}) {
  try {
    if (!PERSONAS.includes(name)) return null;
    const bundledText = fs.readFileSync(path.join(srcDir, `${name}.md`), 'utf8');
    const installedVersion = readSeedVersion(installedText);
    const bundledVersion = readSeedVersion(bundledText);
    if (installedVersion >= bundledVersion) return null;
    if ((dismissals[name] ?? 0) >= bundledVersion) return null;
    const hash = personaBodyHash(installedText);
    const edited = !(shippedSeeds[name] ?? []).some((e) => e.bodySha256 === hash);
    const bundledBody = splitFrontmatter(normalizeNewlines(bundledText)).body.trim();
    return { installedVersion, bundledVersion, edited, bundledBody };
  } catch {
    return null;
  }
}

/** Keep mine: remember that `name` was dismissed at `bundledVersion`. */
async function dismissPersonaUpgrade(name, bundledVersion) {
  if (!PERSONAS.includes(name)) throw new Error(`not a bundled persona: ${name}`);
  if (!Number.isInteger(bundledVersion) || bundledVersion < 1) throw new Error('bundledVersion must be an integer >= 1');
  const file = dismissalsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeTextAtomic(file, JSON.stringify({ ...readDismissals(), [name]: bundledVersion }, null, 2));
  return { ok: true };
}

/** Take the bundled version: back up the installed file, keep the user's changed frontmatter lines. */
async function takeBundledPersona(name, { shippedSeeds = SHIPPED_PERSONA_SEEDS, srcDir = bundledSourceDir(), destDir = destAgentsDir() } = {}) {
  if (!PERSONAS.includes(name)) throw new Error(`not a bundled persona: ${name}`);
  const destPath = path.join(destDir, `${name}.md`);
  if (!fs.existsSync(destPath)) throw new Error(`${name}.md is not installed`);
  const installedBytes = fs.readFileSync(destPath);
  const installedText = installedBytes.toString('utf8');
  const bundledText = fs.readFileSync(path.join(srcDir, `${name}.md`), 'utf8');
  const seedVersion = readSeedVersion(bundledText);
  if (readSeedVersion(installedText) >= seedVersion) throw new Error(`${name}.md is not behind the bundled version`);

  validateWrite(validatePath(destPath)); // before any write, so a doomed write leaves no orphan backup

  const backupPath = backupPathFor(name, installedBytes);
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    await writeTextAtomic(backupPath, installedBytes);
  }

  const { fm } = splitFrontmatter(normalizeNewlines(bundledText));
  const { name: _n, seedVersion: _s, ...bundledFm } = fm;
  const baseline = [...(shippedSeeds[name] ?? []), { fm: bundledFm }];
  await writeTextAtomic(destPath, buildUpgradedPersona(bundledText, installedText, baseline));

  const dismissals = readDismissals();
  if (name in dismissals) {
    delete dismissals[name];
    await writeTextAtomic(dismissalsPath(), JSON.stringify(dismissals, null, 2));
  }
  return { backupPath, seedVersion };
}

module.exports = { personaUpgradeFor, readDismissals, dismissPersonaUpgrade, takeBundledPersona };
