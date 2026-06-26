const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    homeDir: () => ipcRenderer.invoke('app:home-dir'),
    cwd: () => ipcRenderer.invoke('app:cwd'),
    engageRulesPath: () => ipcRenderer.invoke('app:engage-rules-path'),
    pickDirectory: () => ipcRenderer.invoke('app:pick-directory'),
    gitBranch: (cwd) => ipcRenderer.invoke('app:git-branch', { cwd }),
    rebootApp: () => ipcRenderer.send('app:reboot-app'),
    openInEditor: (cwd, editor) => ipcRenderer.invoke('app:open-in-editor', { cwd, editor }),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', { url }),
    openFileInEditor: (filePath, line, col, editor) => ipcRenderer.invoke('app:open-file-in-editor', { path: filePath, line, col, editor }),
    openInFinder: (cwd) => ipcRenderer.invoke('app:open-in-finder', { cwd }),
    openInTerminal: (cwd) => ipcRenderer.invoke('app:open-in-terminal', { cwd }),
    archiveProject: (encoded) => ipcRenderer.invoke('app:archive-project', { encoded }),
    testFireHook: (args) => ipcRenderer.invoke('app:test-fire-hook', args),
    // F7: lets the renderer suppress the wizard auto-trigger under SM_E2E=1.
    isE2E: () => ipcRenderer.invoke('app:is-e2e'),
    // `--simple` CLI flag → { simple, cwd }. Renderer reads once on mount to
    // boot a stripped single-terminal layout in the launch directory.
    launchMode: () => ipcRenderer.invoke('app:launch-mode'),
    // Boot diagnostics (v0.10.1) — renderer polls at mount to surface
    // missing-claude-bin / home-symlink-mismatch as toasts.
    claudeBinStatus: () => ipcRenderer.invoke('app:claude-bin-status'),
    homeSelfCheck: () => ipcRenderer.invoke('app:home-self-check'),
    onNewSession: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('app:new-session', listener);
      return () => ipcRenderer.removeListener('app:new-session', listener);
    },
    onRebootSession: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('app:reboot-session', listener);
      return () => ipcRenderer.removeListener('app:reboot-session', listener);
    },
  },
  pty: {
    spawn: (payload) => ipcRenderer.invoke('pty:spawn', payload),
    write: (payload) => ipcRenderer.send('pty:write', payload),
    resize: (payload) => ipcRenderer.send('pty:resize', payload),
    kill: (tabId) => ipcRenderer.send('pty:kill', tabId),
    onData: (tabId, handler) => {
      const channel = `pty:data:${tabId}`;
      const listener = (_e, data) => handler(data);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    onExit: (tabId, handler) => {
      const channel = `pty:exit:${tabId}`;
      const listener = (_e, info) => handler(info);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    onWriteError: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('pty:write-error', listener);
      return () => ipcRenderer.removeListener('pty:write-error', listener);
    },
  },
  transcripts: {
    subscribe: (payload) => ipcRenderer.invoke('transcript:subscribe', payload),
    unsubscribe: (tabId) => ipcRenderer.invoke('transcript:unsubscribe', { tabId }),
    closeTab: (tabId) => ipcRenderer.invoke('transcript:close', { tabId }),
    buffer: (tabId) => ipcRenderer.invoke('transcript:buffer', { tabId }),
    pathFor: (cwd, sessionUuid) =>
      ipcRenderer.invoke('transcript:path', { cwd, sessionUuid }),
    onEvent: (tabId, handler) => {
      const channel = `transcript:event:${tabId}`;
      const listener = (_e, ev) => handler(ev);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  },
  sessions: {
    load: () => ipcRenderer.invoke('sessions:load'),
    save: (payload) => ipcRenderer.invoke('sessions:save', payload),
  },
  billing: {
    fetch: () => ipcRenderer.invoke('billing:fetch'),
  },
  usageMatrix: {
    snapshot: () => ipcRenderer.invoke('usage:matrix:snapshot'),
    onTick: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('usage:matrix:tick', listener);
      return () => ipcRenderer.removeListener('usage:matrix:tick', listener);
    },
  },
  logs: {
    write: (scope, level, message, meta) =>
      ipcRenderer.send('log:write', { scope, level, message, meta }),
    dir: () => ipcRenderer.invoke('log:dir'),
  },
  config: {
    readJson: (path) => ipcRenderer.invoke('config:read-json', { path }),
    readText: (path) => ipcRenderer.invoke('config:read-text', { path }),
    writeJson: (path, data) => ipcRenderer.invoke('config:write-json', { path, data }),
    writeText: (path, text) => ipcRenderer.invoke('config:write-text', { path, text }),
    listDir: (path, opts) => ipcRenderer.invoke('config:list-dir', { path, opts }),
    exists: (path) => ipcRenderer.invoke('config:exists', { path }),
    watch: (paths) => ipcRenderer.send('config:watch', { paths }),
    unwatch: (paths) => ipcRenderer.send('config:unwatch', { paths }),
    onChanged: (handler) => {
      const listener = (_e, info) => handler(info);
      ipcRenderer.on('config:changed', listener);
      return () => ipcRenderer.removeListener('config:changed', listener);
    },
  },
  voice: {
    onHotkey: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('voice:hotkey', listener);
      return () => ipcRenderer.removeListener('voice:hotkey', listener);
    },
    onHotkeyConfigChanged: (handler) => {
      const listener = (_e, cfg) => handler(cfg);
      ipcRenderer.on('voice:hotkey-changed', listener);
      return () => ipcRenderer.removeListener('voice:hotkey-changed', listener);
    },
    getHotkeyConfig: () => ipcRenderer.invoke('voice:get-hotkey-config'),
    setHotkeyConfig: (cfg) => ipcRenderer.invoke('voice:set-hotkey', cfg),
    getHotkeyConfigPath: () => ipcRenderer.invoke('voice:get-hotkey-config-path'),
    setRecording: (recording) => ipcRenderer.send('voice:set-recording', !!recording),
    // F5 device picker prefs (~/.config/session-manager/voice.json `device` key).
    getDevicePref: () => ipcRenderer.invoke('voice:get-device-pref'),
    setDevicePref: (pref) => ipcRenderer.invoke('voice:set-device-pref', pref),
    // F7 first-run wizard state (~/.config/session-manager/voice.json `wizard` key).
    getWizardState: () => ipcRenderer.invoke('voice:wizard-state'),
    markWizardComplete: () => ipcRenderer.invoke('voice:wizard-complete'),
    // F8 turn-detector settings (~/.config/session-manager/voice.json `turnDetector` key).
    // MVP: settings persistence + kill switch only; no model is actually loaded in v1.
    getTurnDetector: () => ipcRenderer.invoke('voice:get-turn-detector'),
    setTurnDetector: (state) => ipcRenderer.invoke('voice:set-turn-detector', state),
  },
  watchers: {
    add: (payload) => ipcRenderer.invoke('watchers:add', payload),
    list: (tabId) => ipcRenderer.invoke('watchers:list', { tabId }),
    remove: (watcherId) => ipcRenderer.invoke('watchers:remove', { watcherId }),
    killTab: (tabId) => ipcRenderer.invoke('watchers:kill-tab', { tabId }),
    onLine: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('watcher:line', listener);
      return () => ipcRenderer.removeListener('watcher:line', listener);
    },
    onClosed: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('watcher:closed', listener);
      return () => ipcRenderer.removeListener('watcher:closed', listener);
    },
  },
  otel: {
    getConfig: () => ipcRenderer.invoke('otel:get-config'),
    setConfig: (cfg) => ipcRenderer.invoke('otel:set-config', cfg),
    status: () => ipcRenderer.invoke('otel:status'),
    configPath: () => ipcRenderer.invoke('otel:config-path'),
  },
  history: {
    aggregate: (req) => ipcRenderer.invoke('history:aggregate', req),
    listConversations: () => ipcRenderer.invoke('history:list-conversations'),
    scanProjects: () => ipcRenderer.invoke('history:scan-projects'),
  },
  files: {
    list: (path, showHidden) => ipcRenderer.invoke('files:list', { path, showHidden }),
    read: (path) => ipcRenderer.invoke('files:read', { path }),
    write: (path, content) => ipcRenderer.invoke('files:write', { path, content }),
    create: (parentPath, name, kind) => ipcRenderer.invoke('files:create', { parentPath, name, kind }),
    rename: (path, newName) => ipcRenderer.invoke('files:rename', { path, newName }),
    delete: (path) => ipcRenderer.invoke('files:delete', { path }),
    openExternal: (path) => ipcRenderer.invoke('files:open-external', { path }),
    showInFinder: (path) => ipcRenderer.invoke('files:show-in-finder', { path }),
  },
  search: {
    files: (cwd, query, opts) => ipcRenderer.invoke('search:files', { cwd, query, opts }),
    text: (cwd, query, opts) => ipcRenderer.invoke('search:text', { cwd, query, opts }),
  },
  repo: {
    analyze: (cwd) => ipcRenderer.invoke('repo:analyze', { cwd }),
  },
  hives: {
    list: () => ipcRenderer.invoke('hives:list'),
    get: (slug) => ipcRenderer.invoke('hives:get', { slug }),
    save: (slug, hive) => ipcRenderer.invoke('hives:save', { slug, hive }),
    delete: (slug) => ipcRenderer.invoke('hives:delete', { slug }),
  },
  schedule: {
    state: () => ipcRenderer.invoke('schedule:state'),
    setConfig: (partial) => ipcRenderer.invoke('schedule:set-config', partial),
    resetJob: (slug) => ipcRenderer.invoke('schedule:reset-job', { slug }),
    runNow: () => ipcRenderer.invoke('schedule:run-now'),
    forceTick: () => ipcRenderer.invoke('schedule:force-tick'),
    resume: () => ipcRenderer.invoke('schedule:resume'),
    refreshReset: () => ipcRenderer.invoke('schedule:refresh-reset'),
    rescan: () => ipcRenderer.invoke('schedule:rescan'),
    clearQueue: () => ipcRenderer.invoke('schedule:clear-queue'),
    openFolder: () => ipcRenderer.invoke('schedule:open-folder'),
    readPrd: (slug) => ipcRenderer.invoke('schedule:read-prd', { slug }),
    readLog: (runId, slug) => ipcRenderer.invoke('schedule:read-log', { runId, slug }),
    writePrd: (slug, body) => ipcRenderer.invoke('schedule:write-prd', { slug, body }),
    listPrds: () => ipcRenderer.invoke('schedule:list-prds'),
    health: () => ipcRenderer.invoke('schedule:health'),
    onState: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('schedule:state', listener);
      return () => ipcRenderer.removeListener('schedule:state', listener);
    },
    // Bundle D — queue ops (queueOps.cjs).
    lintQueue: () => ipcRenderer.invoke('schedule:lint-queue'),
    archivePrds: (slugs) => ipcRenderer.invoke('schedule:archive-prd', { slugs }),
    retagPrds: (items) => ipcRenderer.invoke('schedule:retag-prd', { items }),
    // History — last N completed/failed jobs from queue.json.
    getHistory: (limit) => ipcRenderer.invoke('schedule:get-history', limit !== undefined ? { limit } : {}),
  },
  supervisor: {
    tickNow: () => ipcRenderer.invoke('supervisor:tick-now'),
    getLog: () => ipcRenderer.invoke('supervisor:get-log'),
  },
  teams: {
    list: () => ipcRenderer.invoke('teams:list'),
  },
  plugins: {
    install: (payload) => ipcRenderer.invoke('plugins:install', payload),
    abort: (slug) => ipcRenderer.invoke('plugins:abort', slug),
    onInstallProgress: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('plugins:install-progress', listener);
      return () => ipcRenderer.removeListener('plugins:install-progress', listener);
    },
  },
  clipboard: {
    pasteImage: () => ipcRenderer.invoke('clipboard:paste-image'),
  },
  memory: {
    list: (workspace) => ipcRenderer.invoke('memory:list', workspace ? { workspace } : {}),
    read: (name, workspace) => ipcRenderer.invoke('memory:read', workspace ? { name, workspace } : { name }),
    write: (name, content, workspace) =>
      ipcRenderer.invoke('memory:write', workspace ? { name, content, workspace } : { name, content }),
    delete: (name, workspace) =>
      ipcRenderer.invoke('memory:delete', workspace ? { name, workspace } : { name }),
    create: (name, description, workspace) => {
      const payload = { name };
      if (description) payload.description = description;
      if (workspace) payload.workspace = workspace;
      return ipcRenderer.invoke('memory:create', payload);
    },
  },
  agentMemory: {
    list: (agentId) => ipcRenderer.invoke('agent-memory:list', { agentId }),
    get: (agentId, entryId) => ipcRenderer.invoke('agent-memory:get', { agentId, entryId }),
    set: (agentId, entryId, body, category) => {
      const payload = { agentId, entryId, body };
      if (category) payload.category = category;
      return ipcRenderer.invoke('agent-memory:set', payload);
    },
    delete: (agentId, entryId) => ipcRenderer.invoke('agent-memory:delete', { agentId, entryId }),
    listAgents: () => ipcRenderer.invoke('agent-memory:list-agents'),
  },
  docEditor: {
    pickFile: (payload) => ipcRenderer.invoke('doc-editor:pick-file', payload),
    readFile: (p) => ipcRenderer.invoke('doc-editor:read-file', { path: p }),
    writeFile: (p, text) => ipcRenderer.invoke('doc-editor:write-file', { path: p, text }),
  },
  git: {
    // Returns null when cwd is not a git repo, git is missing, or the call
    // times out (5s ceiling). The existing `app.gitBranch` is intentionally
    // kept — StatusBar still uses it for the cheap per-tab branch readout.
    status: (cwd) => ipcRenderer.invoke('git:status', { cwd }),
    fileStatus: (cwd) => ipcRenderer.invoke('git:file-status', { cwd }),
  },
  superagent: {
    /** Start a SuperAgent boss run on a tab — writes a structured prompt to
     *  the PTY asking Claude to pick + dispatch specialists. Single live run
     *  per tab; starting again on a running tab terminates the prior one. */
    start: (payload) => ipcRenderer.invoke('superagent:start', payload),
    status: (tabId) => ipcRenderer.invoke('superagent:status', { tabId }),
    stop: (tabId) => ipcRenderer.invoke('superagent:stop', { tabId }),
    onStateChanged: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('superagent:state-changed', listener);
      return () => ipcRenderer.removeListener('superagent:state-changed', listener);
    },
  },
  webRemote: {
    /** Current connection state (no token values). */
    getStatus: () => ipcRenderer.invoke('webRemote:get-status'),
    /** Turn remote control on. Initiates relay connection if a device is paired. */
    enable: () => ipcRenderer.invoke('webRemote:enable'),
    /** Turn remote control off. Immediately drops relay connection. */
    disable: () => ipcRenderer.invoke('webRemote:disable'),
    /** Allow MUTATE-tier commands (pty spawn/write, scheduler writes). Default off. */
    enableControl: () => ipcRenderer.invoke('webRemote:enable-control'),
    /** Block MUTATE-tier commands — mobile becomes read-only mirror. */
    disableControl: () => ipcRenderer.invoke('webRemote:disable-control'),
    /** Pair a new device using the 8-character OTP shown in the web UI. */
    pair: (otp) => ipcRenderer.invoke('webRemote:pair', { otp }),
    /** Revoke a paired device by its deviceId. */
    revokeDevice: (deviceId) => ipcRenderer.invoke('webRemote:revoke-device', { deviceId }),
    /** Read the last N lines of today's audit log (default 50). */
    auditTail: (lines) => ipcRenderer.invoke('webRemote:audit-tail', lines ? { lines } : {}),
    /** Push event from main when connection status changes. */
    onStatus: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('webRemote:status', listener);
      return () => ipcRenderer.removeListener('webRemote:status', listener);
    },
    /** Push event when the relay revokes this device's token. */
    onTokenRevoked: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('webRemote:token-revoked', listener);
      return () => ipcRenderer.removeListener('webRemote:token-revoked', listener);
    },
    /** Revoke ALL paired devices and tear down every session immediately. */
    revokeAll: () => ipcRenderer.invoke('webRemote:revoke-all'),
    confirmSas: () => ipcRenderer.invoke('webRemote:confirm-sas'),
    /** Push event when revokeAll completes (main broadcasts webRemote:revoked-all). */
    onRevokedAll: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('webRemote:revoked-all', listener);
      return () => ipcRenderer.removeListener('webRemote:revoked-all', listener);
    },
  },
  chat: {
    /** Spawn a headless claude -p job. Results arrive via the on* listeners. */
    run: (payload) => ipcRenderer.invoke('chat:run', payload),
    /** Cancel an in-flight run for the given tabId. No-op if none running. */
    cancel: (tabId) => ipcRenderer.send('chat:cancel', { tabId }),
    onRunStarted: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('chat:run:started', listener);
      return () => ipcRenderer.removeListener('chat:run:started', listener);
    },
    onOutput: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('chat:run:output', listener);
      return () => ipcRenderer.removeListener('chat:run:output', listener);
    },
    onNeedsInput: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('chat:run:needs-input', listener);
      return () => ipcRenderer.removeListener('chat:run:needs-input', listener);
    },
    onComplete: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('chat:run:complete', listener);
      return () => ipcRenderer.removeListener('chat:run:complete', listener);
    },
    onError: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('chat:run:error', listener);
      return () => ipcRenderer.removeListener('chat:run:error', listener);
    },
  },
  kg: {
    /** Knowledge Graph distilled from the prompt log (~/.claude/knowledge-log),
     *  segregated per project. `cwd` selects which project's graph; omit for the
     *  most-active project. */
    get: (cwd) => ipcRenderer.invoke('kg:get', { cwd }),
    /** Projects seen in the log, with per-project graph stats (for the selector). */
    projects: () => ipcRenderer.invoke('kg:projects'),
    ingest: () => ipcRenderer.invoke('kg:ingest'),
    ask: (question, cwd) => ipcRenderer.invoke('kg:ask', { question, cwd }),
    /** Purge graphs: one project (cwd) or all (`{ all: true }`). */
    clear: (arg) => ipcRenderer.invoke('kg:clear', arg ?? {}),
    /** Toggle the recurring `claude -p` extraction on/off. */
    setExtraction: (enabled) => ipcRenderer.invoke('kg:set-extraction', { enabled }),
    /** Set capture mode: 'llm' | 'lite' | 'off'. */
    setCaptureMode: (mode) => ipcRenderer.invoke('kg:set-capture-mode', { mode }),
    onIngestProgress: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('kg:ingest-progress', listener);
      return () => ipcRenderer.removeListener('kg:ingest-progress', listener);
    },
  },
});
