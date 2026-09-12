/**
 * machineProfile — builds the "once per machine" telemetry payload: which
 * build (appVersion) this install id is running, plus basic hardware/OS specs.
 *
 * Deliberately anonymous: no hostname, no OS username, no homedir, no MAC
 * address, no hardware serial, no absolute filesystem path, no IANA timezone
 * name (offset only). machineDigest is a coarse hash of stable spec fields —
 * a hardware-CLASS fingerprint, never a device id — so individual records
 * can be joined back to a machine class without repeating the whole profile.
 *
 * Pure data plumbing: no network code, no call sites. Later PRDs consume it.
 */
'use strict';

const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const claudeBin = require('./claudeBin.cjs');

function resolveElectronApp() {
  try {
    // eslint-disable-next-line global-require
    const electron = require('electron');
    if (electron && typeof electron === 'object' && typeof electron.app === 'object') {
      return electron.app;
    }
  } catch { /* no electron runtime (plain vitest, or electron require resolved to a path string) */ }
  return null;
}

function resolvePackageVersion() {
  try {
    // src/main/lib/machineProfile.cjs -> src/main/lib -> src/main -> src -> repo root
    const pkg = require(path.join(__dirname, '..', '..', '..', 'package.json'));
    return (pkg && typeof pkg.version === 'string') ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * 'npx' when the app path lives inside an npm/npx cache dir, 'dev' when
 * SM_DEV is set, else 'unknown'. Injectable so tests never depend on real
 * process state.
 */
function resolveInstallChannel({ appPath = null, devFlag = !!process.env.SM_DEV } = {}) {
  if (devFlag) return 'dev';
  if (typeof appPath === 'string' && /[\\/](\.npm|_npx|npm-cache|npx-cache)[\\/]/i.test(appPath)) {
    return 'npx';
  }
  return 'unknown';
}

/**
 * Resolves the wire-level `env` discriminator ('prod' | 'dev' | 'test') from
 * the real signals the caller already has — never inferred downstream from
 * an appVersion string, which is how 1,526 pre-release/test `epic.create`
 * records ended up misread as production usage (see telemetry.md). `test`
 * takes priority: a vitest run that happens to report a `dev` installChannel
 * (SM_DEV set in the test env) is still test traffic, not dev usage.
 */
function resolveEnv({ isTestRunner = false, installChannel } = {}) {
  if (isTestRunner) return 'test';
  if (installChannel === 'dev') return 'dev';
  return 'prod';
}

/** sha256 of the concatenated stable spec fields, truncated to 12 hex chars. */
function computeMachineDigest(specs) {
  const material = [
    specs.platform,
    specs.osRelease,
    specs.arch,
    specs.cpuModel || '',
    String(specs.cpuCount),
    String(specs.totalMemMb),
  ].join('|');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 12);
}

/** Reads basic, non-identifying specs from node:os. Null-safe when os.cpus() is empty. */
function readSpecs(osModule) {
  const cpus = osModule.cpus() || [];
  const cpu0 = cpus[0] || null;
  return {
    platform: osModule.platform(),
    osRelease: osModule.release(),
    arch: osModule.arch(),
    cpuModel: cpu0 && typeof cpu0.model === 'string' ? cpu0.model.trim() : null,
    cpuSpeedMhz: cpu0 && typeof cpu0.speed === 'number' ? cpu0.speed : null,
    cpuCount: cpus.length,
    totalMemMb: Math.round(osModule.totalmem() / 1048576),
  };
}

/**
 * Builds the machine profile. All external dependencies are injectable so
 * this is fully testable under plain vitest with no Electron runtime and no
 * real Claude CLI.
 *
 * @param {object} [opts]
 * @param {object} [opts.osModule] - defaults to node:os
 * @param {function} [opts.probeClaudeVersion] - defaults to claudeBin.probeClaudeVersion; must resolve to a string or null and never block startup
 * @param {object|null} [opts.electronApp] - override for tests; when omitted, 'electron' is required lazily
 * @param {string} [opts.firstSeenAt] - ISO timestamp; defaults to now (callers that track a persisted first-seen value should pass it)
 */
async function buildMachineProfile(opts = {}) {
  const osModule = opts.osModule || os;
  const probeClaudeVersion = opts.probeClaudeVersion || claudeBin.probeClaudeVersion;
  const electronApp = Object.prototype.hasOwnProperty.call(opts, 'electronApp')
    ? opts.electronApp
    : resolveElectronApp();

  let appVersion = null;
  let appPath = null;
  if (electronApp) {
    try { appVersion = electronApp.getVersion(); } catch { /* not ready / not a real app object */ }
    try { appPath = electronApp.getAppPath(); } catch { /* not ready / not a real app object */ }
  }
  if (!appVersion) appVersion = resolvePackageVersion();

  const specs = readSpecs(osModule);
  const machineDigest = computeMachineDigest(specs);

  let claudeCliVersion = null;
  try {
    claudeCliVersion = await probeClaudeVersion();
  } catch {
    claudeCliVersion = null;
  }

  return {
    appVersion,
    installChannel: resolveInstallChannel({ appPath, devFlag: !!process.env.SM_DEV }),
    machineDigest,
    platform: specs.platform,
    osRelease: specs.osRelease,
    arch: specs.arch,
    cpuModel: specs.cpuModel,
    cpuCount: specs.cpuCount,
    cpuSpeedMhz: specs.cpuSpeedMhz,
    totalMemMb: specs.totalMemMb,
    nodeVersion: process.versions.node || null,
    electronVersion: process.versions.electron || null,
    chromeVersion: process.versions.chrome || null,
    v8Version: process.versions.v8 || null,
    claudeCliVersion,
    locale: Intl.DateTimeFormat().resolvedOptions().locale || null,
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    firstSeenAt: opts.firstSeenAt || new Date().toISOString(),
  };
}

module.exports = {
  buildMachineProfile,
  computeMachineDigest,
  resolveInstallChannel,
  resolveEnv,
};
