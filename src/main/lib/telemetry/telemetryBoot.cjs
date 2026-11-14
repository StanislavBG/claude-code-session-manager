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
    buildMachineProfile: deps.buildMachineProfile || require('../machineProfile.cjs').buildMachineProfile,
    telemetryCounters: deps.telemetryCounters || require('./telemetryCounters.cjs'),
    getSeedStatus: deps.getSeedStatus || (() => require('../../seedStatus.cjs').getSeedStatus()),
    fsp: deps.fsp || require('node:fs/promises'),
    homedir: deps.homedir || require('node:os').homedir,
  };
}

/**
 * removeLegacyWatermarks({ fsp, homedir }) — one-shot migration for the
 * retired errors-<date>.jsonl backlog replay: its delivery
 * watermarks file has no reader any more. Best-effort: resolves true when a
 * file was removed, false otherwise (absent, unreadable home, EACCES, ...).
 * Never throws — telemetry housekeeping must not break boot.
 */
async function removeLegacyWatermarks({ fsp, homedir } = {}) {
  try {
    const path = require('node:path');
    const file = path.join(homedir(), '.claude', 'session-manager', 'telemetry-watermarks.json');
    await fsp.unlink(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Maps getSeedStatus() to enum-only strings (never the fix text or a path).
 * Any failure or malformed shape yields null — never a throw.
 */
function buildSeeds(getSeedStatus) {
  try {
    const s = getSeedStatus();
    const pick = (id) => {
      const v = s && s[id] && s[id].status;
      return typeof v === 'string' ? v : null;
    };
    return {
      devPlugin: pick('dev-plugin'),
      schedulerMcp: pick('scheduler-mcp'),
      agentPersonas: pick('agent-personas'),
    };
  } catch {
    return null;
  }
}

/**
 * seedsJson(seeds) — the single serialization of a buildSeeds() result that is
 * persisted as telemetrySettings.lastSeedsReported and compared against it.
 * Both upsert paths (bootSequence, reportSeedsIfChanged) use this so they
 * write the identical string. A null seeds snapshot yields null.
 */
function seedsJson(seeds) {
  return seeds ? JSON.stringify(seeds) : null;
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
 *     done regardless of outcome. On acceptance it also persists
 *     lastSeedsReported (seedsJson of the seeds it sent), so
 *     reportSeedsIfChanged skips an identical re-send.
 *     This lands in bilko.run's app_installs table (the sole source for
 *     every install-shaped number on the site). It replaces the former
 *     track('install.machine', profile) call, which duplicated the same
 *     facts into funnel_events for no reader — app_installs is now the only
 *     destination for a machine profile.
 *  4. app.launch — one counter event per boot, via telemetryCounters so the
 *     shape lives in exactly one place across every counter this PRD adds.
 *  5. removeLegacyWatermarks — deletes the retired backlog's watermarks file
 *     if one is still on disk (best-effort, never throws).
 */
async function bootSequence({ now = Date.now(), appVersion, installChannel, deps: depsOverride } = {}) {
  const deps = resolveDeps(depsOverride);
  const { telemetrySettings, telemetryClient, buildMachineProfile, telemetryCounters, getSeedStatus, fsp, homedir } = deps;

  const settings = await telemetrySettings.load();
  const versionChanged = settings.lastMachineReportVersion !== appVersion;

  await telemetryClient.flush('boot');
  if (versionChanged) {
    await telemetryClient.flush('version-change');
  }

  if (telemetrySettings.isMachineReportDue(settings, { now, appVersion })) {
    const seeds = buildSeeds(getSeedStatus);
    const profile = { ...(await buildMachineProfile()), seeds };
    const reportResult = await telemetryClient.reportInstall(profile);
    if (reportResult && reportResult.accepted) {
      // Record the seeds this upsert delivered so reportSeedsIfChanged does not
      // re-send an identical install record once the seeders settle.
      const sentSeedsJson = seedsJson(seeds);
      await telemetrySettings.save({
        lastMachineReportAt: new Date(now).toISOString(),
        lastMachineReportVersion: appVersion,
        ...(sentSeedsJson ? { lastSeedsReported: sentSeedsJson } : {}),
      });
    }
  }

  telemetryCounters.trackAppLaunch({ installChannel, appVersion });

  await removeLegacyWatermarks({ fsp, homedir });
}

/**
 * reportSeedsIfChanged({ deps }) — call once the boot seeders settle.
 *
 * bootSequence snapshots getSeedStatus() before the seeders finish, so a fresh
 * install's first upsert reports every step 'pending', and the next upsert
 * would only come on a version bump or the 30-day heartbeat. This re-sends the
 * install record whenever the settled seeds differ from the last ones an
 * upsert delivered (telemetrySettings.lastSeedsReported, JSON of the 3 enum
 * values). lastSeedsReported is persisted only when reportInstall() reports
 * accepted, so a dropped/failed upsert retries on the next settle.
 * Resolves { sent, accepted }.
 */
async function reportSeedsIfChanged({ deps: depsOverride } = {}) {
  const deps = resolveDeps(depsOverride);
  const { telemetrySettings, telemetryClient, buildMachineProfile, getSeedStatus } = deps;

  const seeds = buildSeeds(getSeedStatus);
  if (!seeds) return { sent: false, accepted: false };
  const currentSeedsJson = seedsJson(seeds);

  const settings = await telemetrySettings.load();
  if (settings && settings.lastSeedsReported === currentSeedsJson) return { sent: false, accepted: false };

  const profile = { ...(await buildMachineProfile()), seeds };
  const reportResult = await telemetryClient.reportInstall(profile);
  const accepted = !!(reportResult && reportResult.accepted);
  if (accepted) {
    await telemetrySettings.save({ lastSeedsReported: currentSeedsJson });
  }
  return { sent: true, accepted };
}

module.exports = { bootSequence, buildSeeds, removeLegacyWatermarks, reportSeedsIfChanged };
