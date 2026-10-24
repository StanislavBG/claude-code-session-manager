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

// Enum mappers — user-authored values never leave the machine; only the closed
// shipped sets do. Sets are required lazily so this module stays light.
function mapTag(tag) {
  if (typeof tag !== 'string' || !tag) return null;
  try {
    const { EpicTagSchema } = require('../promptSessionSchema.cjs');
    return EpicTagSchema.options.includes(tag) ? tag : 'other';
  } catch { return 'other'; }
}

function mapAgentType(agentType) {
  if (typeof agentType !== 'string' || !agentType) return null;
  try {
    const { PERSONAS } = require('../../seedAgentPersonas.cjs');
    return PERSONAS.includes(agentType) ? agentType : 'custom';
  } catch { return 'custom'; }
}

function trackEpicCreate({ tag, agentType } = {}, deps) {
  track('epic.create', { tag: mapTag(tag), agentType: mapAgentType(agentType) }, deps);
}

function trackPrdCreate({ agentType } = {}, deps) {
  track('prd.create', { agentType: mapAgentType(agentType) }, deps);
}

function trackSchedulerJobFinish({ status } = {}, deps) {
  track('scheduler.job.finish', { status: status || null }, deps);
}

module.exports = {
  trackAppLaunch,
  trackSessionOpen,
  trackEpicCreate,
  trackPrdCreate,
  trackSchedulerJobFinish,
};
