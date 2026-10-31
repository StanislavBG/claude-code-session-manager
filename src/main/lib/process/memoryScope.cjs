'use strict';

/**
 * memoryScope.cjs — wrap a command in a transient systemd user scope with
 * memory limits so a runaway process hits its own cgroup limit instead of the
 * machine's global OOM. Degrades to a plain spawn wherever scopes are
 * unavailable (callers use scopeSupported()).
 *
 * `systemd-run --scope` execs the command in place, so the spawned pid stays
 * the job's own pid and detached process groups keep working.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_CAP_MB = 10240;
const DEFAULT_MAX_FRACTION = 0.45;
const HIGH_FRACTION = 0.85;
const DEFAULT_SWAP_MAX_MB = 4096;

/**
 * @param {{ totalRamMb?: number, env?: Record<string, string | undefined> }} [opts]
 * @returns {{ memoryMaxMb: number, memoryHighMb: number, swapMaxMb: number } | null} null = disabled
 */
function memoryLimitsFor(opts = {}) {
  const env = opts.env || process.env;
  const raw = env.SM_JOB_MEMORY_MAX_MB;
  let max;
  if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0) {
    max = Math.floor(Number(raw));
  } else {
    const total = Number(opts.totalRamMb);
    if (!Number.isFinite(total) || total <= 0) return null;
    max = Math.min(DEFAULT_MAX_CAP_MB, Math.floor(total * DEFAULT_MAX_FRACTION));
  }
  if (max <= 0) return null;
  return {
    memoryMaxMb: max,
    memoryHighMb: Math.floor(HIGH_FRACTION * max),
    swapMaxMb: DEFAULT_SWAP_MAX_MB,
  };
}

/** @type {boolean | null} */
let cachedSupport = null;

/** Test hook: forget the cached probe result. */
function _resetScopeSupportCache() {
  cachedSupport = null;
}

/**
 * @param {{ platform?: string, spawnSync?: typeof childProcess.spawnSync, fs?: { existsSync: (p: string) => boolean }, env?: Record<string, string | undefined> }} [deps]
 * @returns {boolean}
 */
function scopeSupported(deps = {}) {
  if (cachedSupport !== null) return cachedSupport;
  const platform = deps.platform || process.platform;
  const spawnSync = deps.spawnSync || childProcess.spawnSync;
  const fsImpl = deps.fs || fs;
  const env = deps.env || process.env;
  let ok = false;
  try {
    if (platform === 'linux') {
      const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
      const found = dirs.some((d) => fsImpl.existsSync(path.join(d, 'systemd-run')));
      if (found) {
        const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], {
          stdio: 'ignore',
          timeout: 5000,
        });
        ok = !!r && !r.error && r.status === 0;
      }
    }
  } catch {
    ok = false;
  }
  cachedSupport = ok;
  return ok;
}

/** @param {string} unit */
function sanitizeUnit(unit) {
  const s = String(unit == null ? '' : unit).replace(/[^A-Za-z0-9:_.\\-]/g, '-').replace(/\.scope$/, '');
  return s || 'sm-job';
}

/**
 * @param {{ command: string, args?: string[], unit: string, limits: { memoryMaxMb: number, memoryHighMb: number, swapMaxMb: number }, systemdRunPath?: string }} o
 * @returns {{ command: string, args: string[] }}
 */
function wrapInMemoryScope(o) {
  const { command, args = [], unit, limits, systemdRunPath } = o;
  return {
    command: systemdRunPath || 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--unit=${sanitizeUnit(unit)}.scope`,
      '-p', `MemoryHigh=${limits.memoryHighMb}M`,
      '-p', `MemoryMax=${limits.memoryMaxMb}M`,
      '-p', `MemorySwapMax=${limits.swapMaxMb}M`,
      '-p', 'OOMPolicy=continue',
      '--',
      command,
      ...args,
    ],
  };
}

/**
 * Stop a scope by unit name. Never throws.
 * @param {string} unit
 * @param {{ spawnSync?: typeof childProcess.spawnSync }} [deps]
 * @returns {boolean}
 */
function stopScope(unit, deps = {}) {
  try {
    const spawnSync = deps.spawnSync || childProcess.spawnSync;
    const r = spawnSync('systemctl', ['--user', 'stop', `${sanitizeUnit(unit)}.scope`], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return !!r && !r.error && r.status === 0;
  } catch {
    return false;
  }
}

module.exports = {
  memoryLimitsFor,
  scopeSupported,
  wrapInMemoryScope,
  stopScope,
  sanitizeUnit,
  _resetScopeSupportCache,
};
