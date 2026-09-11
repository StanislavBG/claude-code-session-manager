'use strict';

/**
 * telemetryCounters.cjs — the ONE place every usage counter event is emitted
 * from, so 'session.open'/'epic.create'/'scheduler.job.finish'/'app.launch'
 * each have exactly one call site's worth of shape logic even though they're
 * fired from four different subsystems (pty.cjs, epicMint.cjs,
 * scheduleJobTransitions.cjs, telemetryBoot.cjs).
 *
 * Structural props only — no free text, no cwd, no path — so a counter event
 * can never carry a prompt/transcript/project-name leak by accident. Lazily
 * requires telemetryClient.cjs (mirrors opsErrorLog.cjs's lazy require of
 * opsOwnership.cjs) so this module stays Electron-free and importable from a
 * plain-Node test.
 */

function track(name, props, deps) {
  try {
    const telemetryClient = (deps && deps.telemetryClient) || require('./telemetryClient.cjs');
    telemetryClient.track(name, props);
  } catch { /* counters must never break the caller */ }
}

function trackAppLaunch({ installChannel, appVersion } = {}, deps) {
  track('app.launch', { installChannel: installChannel || null, appVersion: appVersion || null }, deps);
}

function trackSessionOpen(deps) {
  track('session.open', {}, deps);
}

function trackEpicCreate(deps) {
  track('epic.create', {}, deps);
}

function trackSchedulerJobFinish({ status } = {}, deps) {
  track('scheduler.job.finish', { status: status || null }, deps);
}

module.exports = {
  trackAppLaunch,
  trackSessionOpen,
  trackEpicCreate,
  trackSchedulerJobFinish,
};
