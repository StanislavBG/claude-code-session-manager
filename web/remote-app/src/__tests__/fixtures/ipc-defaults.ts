// Per-channel default replies for the real-chain spec's fake ipcMain. Each value is shaped like the matching
// return type in src/preload/api.d.ts (arrays are [], required object fields present) so the real renderer
// never trips over a bare null (`n.every`, `.length` of undefined). Channels not listed here fall back to null.

export interface IpcDefaultsCtx {
  /** Absolute project root the harness registered (also the single tab's cwd). */
  projectCwd: string;
  homeDir: string;
}

const billingData = {
  usage: {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 0, resets_at: null },
    seven_day_sonnet: null, seven_day_opus: null, seven_day_oauth_apps: null, limits: [], extra_usage: null,
  },
  subscriptionType: null, rateLimitTier: null, credentialsExpiresAt: null, fetchedAt: 0,
};

export function ipcDefaults(ctx: IpcDefaultsCtx): Record<string, unknown> {
  return {
    'app:launch-mode': { simple: false, cwd: ctx.projectCwd },
    'app:home-dir': ctx.homeDir,
    'app:update-status': { current: '0.0.0-test', latest: null, behind: false },
    'app:prereqs': [],
    'telemetry:get-config': {
      enabled: false, installId: 'test-install', endpoint: '', noticeAckedAt: new Date(0).toISOString(),
      lastMachineReportAt: null, lastMachineReportVersion: '', lastDailyFlushAt: null, schemaVersion: 1,
    },
    'customerFeedback:list': [],
    'macros:list': [],
    'agents:list-personas': [],
    'schedule:list-prds': [],
    'app:git-branch': null, // string | null
    'app:home-self-check': { ok: true },
    'app:is-e2e': false,
    'mcp:catalog': { ok: true, tools: [], recipes: [] },
    'voice:get-turn-detector': { enabled: false, mode: 'off', schemaVersion: 1 },
    'transcript:subscribe': { ok: true, path: null },
    'transcript:unsubscribe': { ok: true },
    'transcript:close': { ok: true },
    'transcript:buffer': [],
    'transcript:usageFor': {},
    'transcript:exists': false,
    'voice:get-hotkey-config': { accelerator: 'F9', mode: 'toggle', global: false, schemaVersion: 1 },
    'layout:load': null, // LayoutEnvelope | null — null is the legal "nothing saved" answer
    'billing:fetch': { kind: 'ok', data: billingData },
    'schedule:session-slots': { total: 4, inUse: 0, holders: [], min: 0, max: 10, default: 4, envOverride: false },
    'schedule:state': {
      config: { enabled: false, offsetMinutes: 0, defaultCwd: ctx.projectCwd, firePolicy: 'manual', utilizationThreshold: 90, schemaVersion: 1 },
      lastTick: null, jobs: [], lastRunAt: null, nextReset: null, paused: null, utilization: null,
      effectiveConcurrency: { value: 4, source: 'config' },
    },
    'sessions:load': {
      tabs: [{ id: 'tab-chain', sessionId: 'chain-claude-session', cwd: ctx.projectCwd, label: 'chain-proj', presetId: null }],
      activeTabId: 'tab-chain',
    },
    'promptSessions:list-archived': { ok: true, ids: [] },
    'promptSessions:load-active-index': { exists: false, data: null },
    'promptSessions:read-archived': { exists: false, data: null },
    'promptSessions:read-session-transcript': { exists: false, text: '' },
  };
}
