/**
 * VoiceSettings — persists voice hotkey configuration to disk.
 *
 * Storage: ~/.config/session-manager/voice.json
 * Shape: {
 *   accelerator: string, mode: 'hold'|'toggle', global: boolean, schemaVersion: 1,
 *   // F5 device picker (optional, additive):
 *   device?: { selectedDeviceId: string|null, selectedLabel: string|null, schemaVersion: 1 },
 *   // F7 first-run wizard (optional, additive):
 *   wizard?: { completedSchema: number|null, completedAt: string|null }
 * }
 *
 * Mirrors the atomic write pattern from sessionsStore.cjs (tmp file + rename).
 *
 * F1 v1: schema migrations are out of scope; we just stamp `schemaVersion: 1`
 * on every write so a future loader can branch. See PRD F1 v2 §Open Questions.
 *
 * F5/F7 invariant: writes preserve unknown top-level keys so the hotkey-config
 * writer doesn't clobber the device/wizard subtrees (and vice versa).
 * Last-writer-wins within a single subtree is acceptable per F5 PRD v2 §Persistence.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SCHEMA_VERSION = 1;
const DEVICE_SCHEMA_VERSION = 1;
// F7: bumping this constant invalidates all completed wizards globally.
// Trade-off accepted per F7 PRD v2 §Schema-version bump policy.
const WIZARD_SCHEMA = 1;
// F8: turn-detector subtree. Bumping invalidates persisted state and falls
// back to defaults (mode='off', enabled=false) on next load.
const TURN_DETECTOR_SCHEMA = 1;

function defaultsForPlatform() {
  // Cmd+Option+V is unbound by default on macOS (PRD F1 v2). Linux/Windows
  // share Ctrl+Shift+Space — also unbound on default GNOME 45 / KDE 6 / Win.
  if (process.platform === 'darwin') {
    return { accelerator: 'Cmd+Option+V', mode: 'hold', global: false, schemaVersion: SCHEMA_VERSION };
  }
  return { accelerator: 'Ctrl+Shift+Space', mode: 'hold', global: false, schemaVersion: SCHEMA_VERSION };
}

function storePath() {
  return path.join(os.homedir(), '.config', 'session-manager', 'voice.json');
}

// PRD F1 v2 §Chord schema. Anchored, requires ≥1 modifier so a bare
// alphanumeric can't bind a hotkey that fires while typing in a text box.
// Modifier order matches Electron's accelerator grammar; key part is letter,
// digit, F1-F24, or one of a small whitelist.
const ACCELERATOR_RE = /^(CommandOrControl|CmdOrCtrl|Cmd|Command|Ctrl|Control|Alt|Option|Shift|Super|Meta)(\+(CommandOrControl|CmdOrCtrl|Cmd|Command|Ctrl|Control|Alt|Option|Shift|Super|Meta))*\+([A-Z]|[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Backspace|Delete|Escape|Esc)$/;

function isValidConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (typeof cfg.accelerator !== 'string' || cfg.accelerator.length === 0) return false;
  if (!ACCELERATOR_RE.test(cfg.accelerator)) return false;
  if (cfg.mode !== 'hold' && cfg.mode !== 'toggle') return false;
  if (typeof cfg.global !== 'boolean') return false;
  // PRD §"Hold-mode-global removed": globalShortcut has no keyup so hold
  // can't be implemented faithfully. Reject the combo at write time.
  if (cfg.global === true && cfg.mode === 'hold') return false;
  return true;
}

function normalize(cfg) {
  return {
    accelerator: String(cfg.accelerator),
    mode: cfg.mode === 'toggle' ? 'toggle' : 'hold',
    global: !!cfg.global,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * Read the raw on-disk JSON object (or null if absent / unparseable). Used
 * internally so writers can preserve unknown subtrees on partial updates.
 */
async function readRaw() {
  const p = storePath();
  try {
    const raw = await fsp.readFile(p, 'utf8');
    const data = JSON.parse(raw);
    return (data && typeof data === 'object') ? data : null;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('[voiceSettings] readRaw failed:', e.message);
    }
    return null;
  }
}

/**
 * Atomic full-file write of a merged object. Preserves any keys not touched
 * by the caller. Complexity: O(k) over top-level keys; k is tiny.
 *
 * Serialized through `writeQueue` so concurrent F1/F5/F7 saves cannot
 * read-then-merge-then-write atop each other and silently drop a patch.
 * The queue is per-process; cross-process coordination is not in scope.
 */
let writeQueue = Promise.resolve();
async function writeMerged(patch) {
  const run = async () => {
    const p = storePath();
    await fsp.mkdir(path.dirname(p), { recursive: true }).catch(() => {});
    const existing = (await readRaw()) || {};
    const next = { ...existing, ...patch };
    const body = JSON.stringify(next, null, 2) + '\n';
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    // chmod tmp explicitly because some platforms ignore the mode arg on
    // writeFile when the file pre-exists. Then rename for atomicity.
    try { await fsp.chmod(tmp, 0o600); } catch { /* */ }
    await fsp.rename(tmp, p);
    return { ok: true };
  };
  // Tail-promise pattern: each call awaits the previous, so writes are
  // ordered. Errors do not poison the queue.
  const next = writeQueue.then(run, run);
  writeQueue = next.catch(() => {});
  return next;
}

/** Read voice config from disk; create with defaults if absent. */
async function load() {
  const data = await readRaw();
  if (data === null) {
    const def = defaultsForPlatform();
    await save(def);
    return def;
  }
  if (!isValidConfig(data)) {
    // Treat malformed file as "create defaults" — we never lose user data
    // because we don't overwrite their accelerator silently; we just don't
    // honor a broken config. The user can hand-edit voice.json in v1.
    console.warn('[voiceSettings] invalid config on disk, using defaults');
    const def = defaultsForPlatform();
    await save(def);
    return def;
  }
  return normalize(data);
}

/**
 * Atomic write of the hotkey config keys, preserving any other subtrees
 * (notably F5 `device`). Tmp file + rename per sessionsStore.cjs:46-48.
 */
async function save(cfg) {
  const n = normalize(cfg);
  return writeMerged({
    accelerator: n.accelerator,
    mode: n.mode,
    global: n.global,
    schemaVersion: n.schemaVersion,
  });
}

// ──────────────────────────────────────────── F5 device-pref helpers
// Device prefs share `voice.json` to keep one canonical settings file. They
// live under the `device` subtree so the F1 normalizer doesn't strip them.

const DEFAULT_DEVICE = Object.freeze({
  selectedDeviceId: null,
  selectedLabel: null,
  schemaVersion: DEVICE_SCHEMA_VERSION,
});

function isValidDevicePref(d) {
  if (!d || typeof d !== 'object') return false;
  const id = d.selectedDeviceId;
  const lbl = d.selectedLabel;
  if (id !== null && typeof id !== 'string') return false;
  if (lbl !== null && typeof lbl !== 'string') return false;
  return true;
}

function normalizeDevice(d) {
  return {
    selectedDeviceId: typeof d.selectedDeviceId === 'string' && d.selectedDeviceId ? d.selectedDeviceId : null,
    selectedLabel: typeof d.selectedLabel === 'string' && d.selectedLabel ? d.selectedLabel : null,
    schemaVersion: DEVICE_SCHEMA_VERSION,
  };
}

/** Read F5 device pref. Defaults are returned (and persisted) on absence. */
async function loadDevice() {
  const raw = await readRaw();
  const sub = raw && typeof raw === 'object' ? raw.device : null;
  if (!isValidDevicePref(sub)) {
    // Don't auto-write on load — empty/missing device is the legitimate
    // fresh-install state. The first setDevicePref will materialize it.
    return { ...DEFAULT_DEVICE };
  }
  return normalizeDevice(sub);
}

/** Atomic write of just the device subtree, preserving other keys. */
async function saveDevice(d) {
  if (!isValidDevicePref(d)) {
    throw new Error('Invalid device pref shape');
  }
  return writeMerged({ device: normalizeDevice(d) });
}

// ──────────────────────────────────────────── F7 wizard-state helpers
// Wizard state lives under the `wizard` subtree of voice.json. Mirrors the F5
// device pattern: additive, preserves other subtrees on write, returns a
// safe default when absent so the wizard arms on first launch.

const DEFAULT_WIZARD = Object.freeze({
  completedSchema: null,
  completedAt: null,
});

function isValidWizardState(w) {
  if (!w || typeof w !== 'object') return false;
  const cs = w.completedSchema;
  const ca = w.completedAt;
  if (cs !== null && typeof cs !== 'number') return false;
  if (ca !== null && typeof ca !== 'string') return false;
  return true;
}

function normalizeWizard(w) {
  return {
    completedSchema: typeof w.completedSchema === 'number' ? w.completedSchema : null,
    completedAt: typeof w.completedAt === 'string' && w.completedAt ? w.completedAt : null,
  };
}

/**
 * Read the F7 wizard subtree. Returns the default (un-completed) shape when
 * the subtree is missing or malformed — the wizard arms in that case. We do
 * NOT auto-write a default on load; the first markComplete materializes it.
 */
async function loadWizard() {
  const raw = await readRaw();
  const sub = raw && typeof raw === 'object' ? raw.wizard : null;
  if (!isValidWizardState(sub)) {
    return { ...DEFAULT_WIZARD };
  }
  return normalizeWizard(sub);
}

/** Atomic write of just the wizard subtree, preserving other keys. */
async function saveWizard(state) {
  if (!isValidWizardState(state)) {
    throw new Error('Invalid wizard state shape');
  }
  return writeMerged({ wizard: normalizeWizard(state) });
}

// ──────────────────────────────────────────── F8 turn-detector helpers
// Lives under the `turnDetector` subtree of voice.json. MVP-only fields;
// the actual smart-turn-v3 ONNX model is NOT loaded in v1 — see F8 PRD v2
// and the follow-up TODO in turnDetectorWorker.ts. Mirrors F5 device pattern.

const DEFAULT_TURN_DETECTOR = Object.freeze({
  enabled: false,
  mode: 'off',           // 'audio' | 'text' | 'off'
  schemaVersion: TURN_DETECTOR_SCHEMA,
});

const TURN_DETECTOR_MODES = new Set(['audio', 'text', 'off']);

function isValidTurnDetectorState(t) {
  if (!t || typeof t !== 'object') return false;
  if (typeof t.enabled !== 'boolean') return false;
  if (typeof t.mode !== 'string' || !TURN_DETECTOR_MODES.has(t.mode)) return false;
  return true;
}

function normalizeTurnDetector(t) {
  const mode = TURN_DETECTOR_MODES.has(t.mode) ? t.mode : 'off';
  const enabled = mode === 'off' ? false : !!t.enabled;
  return { enabled, mode, schemaVersion: TURN_DETECTOR_SCHEMA };
}

/**
 * Read the F8 turn-detector subtree. Returns DEFAULT (`mode: 'off'`) when the
 * subtree is missing or malformed — F8 MVP is opt-in, so a missing config
 * yields the safe pure-VAD path. We do NOT auto-write a default on load.
 */
async function loadTurnDetector() {
  const raw = await readRaw();
  const sub = raw && typeof raw === 'object' ? raw.turnDetector : null;
  if (!isValidTurnDetectorState(sub)) {
    return { ...DEFAULT_TURN_DETECTOR };
  }
  return normalizeTurnDetector(sub);
}

/** Atomic write of just the turnDetector subtree, preserving other keys. */
async function saveTurnDetector(state) {
  if (!isValidTurnDetectorState(state)) {
    throw new Error('Invalid turn-detector state shape');
  }
  return writeMerged({ turnDetector: normalizeTurnDetector(state) });
}

module.exports = {
  load,
  save,
  storePath,
  defaultsForPlatform,
  isValidConfig,
  SCHEMA_VERSION,
  // F5
  loadDevice,
  saveDevice,
  isValidDevicePref,
  DEFAULT_DEVICE,
  DEVICE_SCHEMA_VERSION,
  // F7
  loadWizard,
  saveWizard,
  isValidWizardState,
  DEFAULT_WIZARD,
  WIZARD_SCHEMA,
  // F8
  loadTurnDetector,
  saveTurnDetector,
  isValidTurnDetectorState,
  DEFAULT_TURN_DETECTOR,
  TURN_DETECTOR_SCHEMA,
};
