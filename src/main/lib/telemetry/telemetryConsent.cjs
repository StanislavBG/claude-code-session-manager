'use strict';

/**
 * telemetryConsent — the write-path the `telemetry:set-config` IPC handler
 * delegates to, pulled out of src/main/index.cjs so it can be unit-tested
 * without an Electron runtime (index.cjs requires('electron') at module
 * load, which vitest can't satisfy).
 *
 * The one side effect beyond a plain settings save: turning telemetry OFF
 * clears the pending queue file, so a later re-enable never resends a
 * payload that only ever accumulated while the user was opted out. It does
 * NOT touch telemetry-sent.json or the backlog watermarks — those describe
 * history already delivered, and clearing them would make a re-enable
 * resend it. See session-manager-operations/architecture/telemetry.md.
 */

function resolveDeps(deps = {}) {
  return {
    telemetrySettings: deps.telemetrySettings || require('./telemetrySettings.cjs'),
    telemetryClient: deps.telemetryClient || require('./telemetryClient.cjs'),
  };
}

async function applyConsentUpdate(cfg, depsOverride) {
  const deps = resolveDeps(depsOverride);
  const before = await deps.telemetrySettings.load();
  const saved = await deps.telemetrySettings.save(cfg);
  // Live client caches settings at init; push the saved copy so opt-out
  // stops ingest + egress immediately and a re-enable resumes in-process.
  if (typeof deps.telemetryClient.applySettings === 'function') deps.telemetryClient.applySettings(saved);
  if (before.enabled && !saved.enabled) {
    await deps.telemetryClient.clearQueue();
  }
  return saved;
}

module.exports = { applyConsentUpdate };
