const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    homeDir: () => ipcRenderer.invoke('app:home-dir'),
    cwd: () => ipcRenderer.invoke('app:cwd'),
    engageRulesPath: () => ipcRenderer.invoke('app:engage-rules-path'),
    pickDirectory: () => ipcRenderer.invoke('app:pick-directory'),
    gitBranch: (cwd) => ipcRenderer.invoke('app:git-branch', { cwd }),
    resolveBuildTarget: (cwd) => ipcRenderer.invoke('build:resolve-target', { cwd }),
    rebootApp: () => ipcRenderer.send('app:reboot-app'),
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
    alive: (tabIds) => ipcRenderer.invoke('pty:alive', { tabIds }),
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
    page: (tabId, startLine, endLine) =>
      ipcRenderer.invoke('transcript:page', { tabId, startLine, endLine }),
    readRef: (ref) => ipcRenderer.invoke('transcript:readRef', ref),
    pathFor: (cwd, sessionUuid) =>
      ipcRenderer.invoke('transcript:path', { cwd, sessionUuid }),
    usageFor: (cwd, sessionIds) =>
      ipcRenderer.invoke('transcript:usageFor', { cwd, sessionIds }),
    // Main sends one batch (array) per flush — see transcripts.cjs's doFlush —
    // so the handler is array-shaped, not per-event, letting subscribers
    // (live.ts, chat.ts) commit their store once per batch instead of once
    // per event.
    onEvent: (tabId, handler) => {
      const channel = `transcript:event:${tabId}`;
      const listener = (_e, events) => handler(events);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  },
  sessions: {
    load: () => ipcRenderer.invoke('sessions:load'),
    save: (payload) => ipcRenderer.invoke('sessions:save', payload),
  },
  layout: {
    load: () => ipcRenderer.invoke('layout:load'),
    save: (payload) => ipcRenderer.invoke('layout:save', payload),
  },
  billing: {
    fetch: () => ipcRenderer.invoke('billing:fetch'),
  },
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
  },
  agents: {
    listPersonas: () => ipcRenderer.invoke('agents:list-personas'),
    savePersona: (payload) => ipcRenderer.invoke('agents:save-persona', payload),
    deletePersona: (payload) => ipcRenderer.invoke('agents:delete-persona', payload),
    removeOverride: (payload) => ipcRenderer.invoke('agents:remove-override', payload),
    // Fired after any save/delete/removeOverride so every mounted
    // subscriber (Agent Library, Tag Library) re-fetches the same file.
    onChanged: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('agents:changed', listener);
      return () => ipcRenderer.removeListener('agents:changed', listener);
    },
  },
  logs: {
    // ctx is optional: { cwd, tabId, epicId, tags } — when present and
    // level is 'error', main also appends a tagged line to that project's
    // own session-manager-operations/logs/ (see opsErrorLog.cjs).
    write: (scope, level, message, meta, ctx) =>
      ipcRenderer.send('log:write', { scope, level, message, meta, ...ctx }),
    dir: () => ipcRenderer.invoke('log:dir'),
  },
  config: {
    readJson: (path) => ipcRenderer.invoke('config:read-json', { path }),
    readText: (path, opts) => ipcRenderer.invoke('config:read-text', { path, maxBytes: opts?.maxBytes }),
    writeJson: (path, data, writer) => ipcRenderer.invoke('config:write-json', { path, data, writer }),
    writeText: (path, text, writer) => ipcRenderer.invoke('config:write-text', { path, text, writer }),
    listDir: (path, opts) => ipcRenderer.invoke('config:list-dir', { path, opts }),
    exists: (path) => ipcRenderer.invoke('config:exists', { path }),
    watch: (paths) => ipcRenderer.send('config:watch', { paths }),
    unwatch: (paths) => ipcRenderer.send('config:unwatch', { paths }),
    parseImports: (path) => ipcRenderer.invoke('config:parse-imports', { path }),
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
    scanProjects: () => ipcRenderer.invoke('history:scan-projects'),
    dashboard: (req) => ipcRenderer.invoke('history:dashboard', req),
  },
  files: {
    list: (path, showHidden) => ipcRenderer.invoke('files:list', { path, showHidden }),
    read: (path) => ipcRenderer.invoke('files:read', { path }),
    write: (path, content) => ipcRenderer.invoke('files:write', { path, content }),
    create: (parentPath, name, kind) => ipcRenderer.invoke('files:create', { parentPath, name, kind }),
    rename: (path, newName) => ipcRenderer.invoke('files:rename', { path, newName }),
    delete: (path) => ipcRenderer.invoke('files:delete', { path }),
    duplicate: (path) => ipcRenderer.invoke('files:duplicate', { path }),
    saveBinary: (path, base64, writer) => ipcRenderer.invoke('files:save-binary', { path, base64, writer }),
  },
  docEdit: {
    run: (payload) => ipcRenderer.invoke('docedit:run', payload),
    runInSession: (payload) => ipcRenderer.invoke('docedit:run-in-session', payload),
    onSessionResult: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('docedit:session-result', listener);
      return () => ipcRenderer.removeListener('docedit:session-result', listener);
    },
  },
  // Consolidated shell open/reveal — see shell:open in index.cjs.
  // as: 'editor' | 'fileInEditor' | 'finder' | 'terminal' | 'external' | 'openPath' | 'revealPath'
  shell: {
    open: (opts) => ipcRenderer.invoke('shell:open', opts),
  },
  schedule: {
    state: () => ipcRenderer.invoke('schedule:state'),
    sessionSlots: () => ipcRenderer.invoke('schedule:session-slots'),
    setSessionSlots: (cap) => ipcRenderer.invoke('schedule:set-session-slots', { cap }),
    setConfig: (partial) => ipcRenderer.invoke('schedule:set-config', partial),
    resetJob: (slug) => ipcRenderer.invoke('schedule:reset-job', { slug }),
    runNow: () => ipcRenderer.invoke('schedule:run-now'),
    forceTick: () => ipcRenderer.invoke('schedule:force-tick'),
    resume: () => ipcRenderer.invoke('schedule:resume'),
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
    pasteText: () => ipcRenderer.invoke('clipboard:paste-text'),
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', { text }),
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
    aggregate: (workspace, refresh) =>
      ipcRenderer.invoke('memory:aggregate', refresh ? { workspace, refresh: true } : { workspace }),
    stale: (workspace, cwd) =>
      ipcRenderer.invoke('memory:stale', { ...(workspace ? { workspace } : {}), ...(cwd ? { cwd } : {}) }),
  },
  projectBrief: {
    get: (cwd) => ipcRenderer.invoke('project-brief:get', { cwd }),
    refresh: (cwd) => ipcRenderer.invoke('project-brief:refresh', { cwd }),
    setPin: (cwd, block, pinned) => ipcRenderer.invoke('project-brief:set-pin', { cwd, block, pinned }),
    update: (cwd, patch) => ipcRenderer.invoke('project-brief:update', { cwd, patch }),
  },
  projectPages: {
    get: (cwd) => ipcRenderer.invoke('project-pages:get', { cwd }),
  },
  bilkoHost: {
    get: (cwd) => ipcRenderer.invoke('bilko-host:get', { cwd }),
    prepareBundle: (cwd, slug) => ipcRenderer.invoke('bilko-host:prepare-bundle', { cwd, slug }),
    addDocument: (cwd, subpath, title, source) =>
      ipcRenderer.invoke('bilko-host:add-document', { cwd, subpath, title, source }),
    removeDocument: (cwd, id) => ipcRenderer.invoke('bilko-host:remove-document', { cwd, id }),
  },
  promptSessionTranscript: {
    append: (cwd, epicId, turn) =>
      ipcRenderer.invoke('promptSessionTranscript:append', { cwd, epicId, ...turn }),
    read: (cwd, epicId, limit) =>
      ipcRenderer.invoke('promptSessionTranscript:read', { cwd, epicId, ...(limit ? { limit } : {}) }),
  },
  auditLog: {
    append: (kind, fields) => ipcRenderer.invoke('auditLog:append', { kind, ...fields }),
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
  },
  git: {
    // Returns null when cwd is not a git repo, git is missing, or the call
    // times out (5s ceiling). The existing `app.gitBranch` is intentionally
    // kept — StatusBar still uses it for the cheap per-tab branch readout.
    status: (cwd) => ipcRenderer.invoke('git:status', { cwd }),
    fileStatus: (cwd) => ipcRenderer.invoke('git:file-status', { cwd }),
  },
  chat: {
    /** Spawn a headless claude -p job. Results arrive via the on* listeners. */
    run: (payload) => ipcRenderer.invoke('chat:run', payload),
    /** Cancel an in-flight run for the given tabId. Resolves once the run has
     *  fully settled (terminal event fired). No-op if none running. */
    cancel: (tabId) => ipcRenderer.invoke('chat:cancel', { tabId }),
    onQueued: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('chat:run:queued', listener);
      return () => ipcRenderer.removeListener('chat:run:queued', listener);
    },
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
    onToolUse: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('chat:run:tool-use', listener);
      return () => ipcRenderer.removeListener('chat:run:tool-use', listener);
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
    onNotice: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('chat:run:notice', listener);
      return () => ipcRenderer.removeListener('chat:run:notice', listener);
    },
    /** Fires when a main-process caller pushes a prompt into an open tab's
     *  queue from outside the renderer (Web Remote / admin HTTP / MCP). */
    onExternalSend: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('chat:external-send', listener);
      return () => ipcRenderer.removeListener('chat:external-send', listener);
    },
    /** Classify a queued PromptTicket's text as 'inline' or 'develop'. */
    classifyTicket: (payload) => ipcRenderer.invoke('chat:classify-ticket', payload),
    /** Author a mechanical draft PRD from a queued PromptTicket classified 'develop'. */
    createPrd: (payload) => ipcRenderer.invoke('chat:create-prd', payload),
  },
  exchanges: {
    /** List exchanges for a project (durable chat-run log), newest-first.
     *  `sessionId` filters to one session; `limit`/`offset` for pagination. */
    list: (payload) => ipcRenderer.invoke('exchanges:list', payload),
  },
  promptSessions: {
    /** Fires when the main process (currently only the scheduler's
     *  response-event append) appends an event to a PromptSession's chain on
     *  disk — lets an already-hydrated Epic pick it up live instead of
     *  waiting for a restart. */
    onEventAppended: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('promptSession:event-appended', listener);
      return () => ipcRenderer.removeListener('promptSession:event-appended', listener);
    },
    /** Main-side read-merge-write of a cwd's active-index.json
     *  (lib/activeIndexMerge.cjs) — replaces persistActiveIndex's old
     *  renderer-side read-merge-write. Payload carries only this renderer's
     *  own in-memory contribution for the cwd; disk stays main's truth. */
    mergeActiveIndex: (payload) => ipcRenderer.invoke('promptSessions:merge-active-index', payload),
    /** Mints a brand-new 'proposed' Epic through main's own ensureEpic()
     *  (lib/promptSessionsCreateEpic.cjs) instead of the renderer
     *  hand-constructing the PromptSession record itself. Unused today —
     *  additive step 1 of a two-PRD chain; a later PRD routes
     *  createPromptSession through this. */
    create: (payload) => ipcRenderer.invoke('promptSessions:create-epic', payload),
  },
});
