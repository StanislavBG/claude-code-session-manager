'use strict';

/**
 * telemetryBoot.cjs — the WHEN, not the WHAT, for telemetry egress: decides
 * when the once-per-machine profile goes out and when an accumulated batch
 * gets a delivery attempt. Called once from index.cjs's app.whenReady.
 *
 * Cadence (product owner's explicit instruction): existing errors go out on
 * load and on a new version; new errors accumulate and are sent daily. This
 * module owns exactly the two non-daily send triggers — boot and
 * version-change — plus the periodic machine-profile heartbeat
 * (telemetrySettings.isMachineReportDue) that turns "ever installed" into
 * "actively installed". It never calls flush() outside those two triggers —
 * the daily cadence is telemetryClient's own internal timer.
 *
 * Pure orchestration: every dependency is injectable via `deps` (mirrors
 * telemetryClient.cjs's own test-hook style) so this runs under plain vitest
 * with no Electron runtime and no real network/CLI probes.
 */

function resolveDeps(deps = {}) {
  return {
    telemetrySettings: deps.telemetrySettings || require('./telemetrySettings.cjs'),
    telemetryClient: deps.telemetryClient || require('./telemetryClient.cjs'),
    buildMachineProfile: deps.buildMachineProfile || require('./machineProfile.cjs').buildMachineProfile,
    telemetryCounters: deps.telemetryCounters || require('./telemetryCounters.cjs'),
  };
}

/**
 * bootSequence({ now, appVersion, installChannel, deps }) — call once per
 * process from app.whenReady.
 *
 *  1. flush('boot') — always, so a freshly-installed version delivers
 *     everything the previous version accumulated.
 *  2. flush('version-change') — only when this install's persisted
 *     lastMachineReportVersion differs from the running appVersion (the same
 *     signal that also gates the machine-profile heartbeat below).
 *  3. install upsert — sent once via telemetryClient.reportInstall(profile)
 *     when telemetrySettings.isMachineReportDue() is true (a version bump, OR
 *     the 30-day liveness heartbeat). lastMachineReportAt/Version are only
 *     persisted when reportInstall() reports success — a failed/dropped
 *     upsert stays due so the next boot retries, rather than being marked
 *     done regardless of outcome.
 *     This lands in bilko.run's app_installs table (the sole source for
 *     every install-shaped number on the site). It replaces the former
 *     track('install.machine', profile) call, which duplicated the same
 *     facts into funnel_events for no reader — app_installs is now the only
 *     destination for a machine profile.
 *  4. app.launch — one counter event per boot, via telemetryCounters so the
 *     shape lives in exactly one place across every counter this PRD adds.
 */
async function bootSequence({ now = Date.now(), appVersion, installChannel, deps: depsOverride } = {}) {
  const deps = resolveDeps(depsOverride);
  const { telemetrySettings, telemetryClient, buildMachineProfile, telemetryCounters } = deps;

  const settings = await telemetrySettings.load();
  const versionChanged = settings.lastMachineReportVersion !== appVersion;

  await telemetryClient.flush('boot');
  if (versionChanged) {
    await telemetryClient.flush('version-change');
  }

  if (telemetrySettings.isMachineReportDue(settings, { now, appVersion })) {
    const profile = await buildMachineProfile();
    const reportResult = await telemetryClient.reportInstall(profile);
    if (reportResult && reportResult.accepted) {
      await telemetrySettings.save({
        lastMachineReportAt: new Date(now).toISOString(),
        lastMachineReportVersion: appVersion,
      });
    }
  }

  telemetryCounters.trackAppLaunch({ installChannel, appVersion });
}

module.exports = { bootSequence };
