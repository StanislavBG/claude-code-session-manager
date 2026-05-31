const { app, BrowserWindow, ipcMain, dialog, Menu, session, systemPreferences, globalShortcut, shell, clipboard, powerSaveBlocker } = require('electron');
const { spawn, execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { schemas, validated } = require('./ipcSchemas.cjs');
const { cleanChildEnv } = require('./lib/cleanEnv.cjs');
const { manager: ptyManager, registerPtyHandlers } = require('./pty.cjs');
const configMgr = require('./config.cjs');
const transcripts = require('./transcripts.cjs');
const usageMatrix = require('./usageMatrix.cjs');
const sessionsStore = require('./sessionsStore.cjs');
const billing = require('./usage.cjs');
const logs = require('./logs.cjs');
const voiceHotkey = require('./voiceHotkey.cjs');
const voiceWizard = require('./voiceWizard.cjs');
const scheduler = require('./scheduler.cjs');
const supervisor = require('./supervisor.cjs');
const watchers = require('./watchers.cjs');
const teams = require('./teams.cjs');
const queueOps = require('./queueOps.cjs');
const pluginInstall = require('./pluginInstall.cjs');
const otel = require('./otel.cjs');
const otelSettings = require('./otelSettings.cjs');
const { registerHistoryAggregatorHandlers } = require('./historyAggregator.cjs');
const memoryTool = require('./memoryTool.cjs');
const agentMemory = require('./agentMemory.cjs');
const { registerDocEditorHandlers } = require('./docEditor.cjs');
const git = require('./git.cjs');
const superagent = require('./superagent.cjs');
const { registerProjectSkillsHandlers } = require('./projectSkills.cjs');
const filesIpc = require('./files.cjs');
const searchIpc = require('./search.cjs');
const repoAnalyzer = require('./repoAnalyzer.cjs');
const hivesIpc = require('./hives.cjs');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { checkInsideHome } = require('./lib/insideHome.cjs');
const { openInEditor, openFileInEditor, openInFinder, openInTerminal } = require('./lib/openExternalApp.cjs');

let mainWindow = null;
let rebooting = false;
// powerSaveBlocker handle — keeps the system from suspending while the app runs
// so the scheduler's polling and jobs aren't frozen. -1 = not held.
let powerBlockerId = -1;

// Boot diagnostics — populated at app.whenReady so the renderer can poll their
// state via IPC and surface toasts on the failure paths. The first-paint
// deadline timer reads these into the boot log if ready-to-show never fires.
let bootClaudeBin = { resolved: 'claude', foundOnDisk: false };
let bootHomeSelfCheck = { ok: true };
const bootRecentIpcInvocations = [];
let firstPaintTimer = null;

// Wrap ipcMain.handle once to track which channels the renderer actually
// invokes — the boot log dumps the last 5 so a hang is attributable to a
// specific handler.
const originalIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function trackedHandle(channel, listener) {
  return originalIpcHandle(channel, (...args) => {
    bootRecentIpcInvocations.push({ channel, at: new Date().toISOString() });
    if (bootRecentIpcInvocations.length > 5) bootRecentIpcInvocations.shift();
    return listener(...args);
  });
};

const REBOOT_LOG = path.join(os.homedir(), '.claude', 'session-manager-reboot.log');

function logReboot(line) {
  try {
    fs.mkdirSync(path.dirname(REBOOT_LOG), { recursive: true });
    // 0o600 — reboot log can include npx paths and pid traces. Match the
    // mode used by logs.cjs / otelSettings.cjs for consistency.
    fs.appendFileSync(REBOOT_LOG, `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 });
  } catch { /* best-effort */ }
}

// Writes a diagnostic dump when the renderer fails to fire ready-to-show
// within the boot deadline. Sync I/O is fine — this is the failure path and
// the user is already staring at a blank window.
function writeFirstPaintFailureLog() {
  try {
    const logDir = path.join(os.homedir(), '.claude', 'session-manager', 'logs');
    fs.mkdirSync(logDir, { recursive: true });

    const ymd = new Date().toISOString().slice(0, 10);
    const logPath = path.join(logDir, `boot-${ymd}.log`);

    const homeCheck = checkInsideHome(os.homedir());
    const lines = [
      `=== first-paint deadline exceeded @ ${new Date().toISOString()} ===`,
      `process.versions: ${JSON.stringify(process.versions)}`,
      `process.platform: ${process.platform}`,
      `process.arch: ${process.arch}`,
      `os.homedir(): ${os.homedir()}`,
      `claudeBin: ${JSON.stringify(bootClaudeBin)}`,
      `homeSelfCheck: ${JSON.stringify(homeCheck)}`,
      `recentIpcInvocations: ${JSON.stringify(bootRecentIpcInvocations)}`,
      'RENDERER DID NOT FIRE ready-to-show WITHIN 10s — likely renderer JS error or main-process IPC hang.',
      '',
    ];
    fs.appendFileSync(logPath, lines.join('\n'), { mode: 0o600 });

    // Keep last 3 boot-*.log files; unlink older ones.
    try {
      const entries = fs.readdirSync(logDir)
        .filter((f) => /^boot-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .map((f) => {
          const full = path.join(logDir, f);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* */ }
          return { full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const e of entries.slice(3)) {
        try { fs.unlinkSync(e.full); } catch { /* */ }
      }
    } catch { /* */ }
  } catch (err) {
    console.error('[firstPaint] failed to write boot log:', err?.message);
  }
}

function resolveNpx() {
  const isWin = process.platform === 'win32';
  try {
    const out = execFileSync(isWin ? 'where' : 'which', ['npx'], {
      encoding: 'utf8',
      env: process.env,
    }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch { /* fall through to candidates */ }

  const candidates = isWin
    ? []
    : ['/usr/local/bin/npx', '/opt/homebrew/bin/npx', '/usr/bin/npx'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const nvm = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvm).sort().reverse();
    for (const v of versions) {
      const p = path.join(nvm, v, 'bin', 'npx');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* no nvm */ }
  return null;
}

function relaunchViaNpx() {
  const npxPath = resolveNpx();
  if (!npxPath) throw new Error('npx not found on PATH');

  fs.mkdirSync(path.dirname(REBOOT_LOG), { recursive: true });
  const logFd = fs.openSync(REBOOT_LOG, 'a', 0o600);
  // `--yes` auto-accepts install prompt; `@latest` forces registry resolution
  // of the dist-tag so a freshly published version is picked up.
  const child = spawn(npxPath, ['--yes', 'claude-code-session-manager@latest'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: cleanChildEnv(),
  });
  // fd was dup'd into the child at spawn time; closing the parent copy frees
  // our file table slot and ensures the child owns the lifetime of the log.
  try { fs.closeSync(logFd); } catch { /* */ }

  if (!child.pid) throw new Error('spawn returned no pid');
  logReboot(`spawned ${npxPath} pid=${child.pid}`);
  child.unref();
  return child;
}

async function rebootApp() {
  ptyManager.killAll();
  configMgr.closeAllWatchers();
  transcripts.closeAll();
  watchers.manager.killAll();

  // Rewrite persisted tabs with fresh session IDs so the next boot starts
  // new claude sessions instead of resuming old ones.
  await sessionsStore.markFreshRestart();

  const useDevServer = process.env.SM_DEV === '1';
  if (useDevServer) {
    // Dev mode: can't exit — concurrently -k would kill Vite too.
    // Flag prevents window-all-closed from calling app.quit().
    rebooting = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    createWindow();
    ptyManager.attachWindow(mainWindow);
    configMgr.attachWindow(mainWindow);
    transcripts.attachWindow(mainWindow);
    usageMatrix.attachWindow(mainWindow);
    voiceHotkey.init(mainWindow).catch((e) => {
      logs.writeLine({ scope: 'voice-hotkey', level: 'error', message: 'reinit failed', meta: { error: e?.message } });
    });
    scheduler.attachWindow(mainWindow);
    watchers.attachWindow(mainWindow);
    pluginInstall.attachWindow(mainWindow);
    superagent.attachWindow(mainWindow);
    rebooting = false;
    return;
  }

  let childOk = false;
  try {
    const child = relaunchViaNpx();
    // Wait briefly for async ENOENT/spawn errors to surface before we exit —
    // spawn reports missing binaries via the 'error' event, not synchronously.
    await new Promise((resolve) => {
      const timer = setTimeout(() => { childOk = true; resolve(); }, 400);
      child.once('error', (err) => {
        clearTimeout(timer);
        logReboot(`child error: ${err.message}`);
        resolve();
      });
    });
  } catch (err) {
    logReboot(`relaunchViaNpx threw: ${err.message}`);
    console.warn('[main] npx relaunch failed:', err.message);
  }

  if (!childOk) {
    logReboot('falling back to app.relaunch()');
    app.relaunch();
  }
  app.exit(0);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    title: 'Claude Session Manager',
    backgroundColor: '#0b0d10',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Boot-time detection 3: if ready-to-show never fires (blank window from
  // renderer JS error or main-process IPC hang), write a diagnostic dump so
  // the user has a postmortem instead of just an empty window.
  if (firstPaintTimer) clearTimeout(firstPaintTimer);
  firstPaintTimer = setTimeout(() => { writeFirstPaintFailureLog(); }, 10_000);

  mainWindow.once('ready-to-show', () => {
    if (firstPaintTimer) { clearTimeout(firstPaintTimer); firstPaintTimer = null; }
    mainWindow.maximize();
    mainWindow.show();
  });

  // Native right-click menu — Copy / Paste / Select All everywhere. Roles
  // hook into Electron's built-in clipboard/selection plumbing, which xterm.js
  // (and Monaco, and Tiptap) all participate in via the standard DOM
  // selection API, so this single block covers Terminal + Doc Editor + plain
  // text inputs without per-component wiring.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.editFlags.canCopy) items.push({ label: 'Copy', role: 'copy' });
    if (params.editFlags.canPaste) items.push({ label: 'Paste', role: 'paste' });
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Select All', role: 'selectAll' });
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  const distIndex = path.join(__dirname, '..', '..', 'dist', 'index.html');
  const useDevServer = process.env.SM_DEV === '1';
  if (useDevServer) {
    mainWindow.loadURL('http://localhost:5173');
  } else if (fs.existsSync(distIndex)) {
    mainWindow.loadFile(distIndex);
  } else {
    // Hard-fail in production rather than silently load a remote URL. If
    // dist/index.html is missing the install is broken — surface clearly
    // instead of blindly trying http://localhost:5173, which would (a) load
    // remote content and (b) almost always fail in a packaged install.
    console.error('[main] dist/index.html missing and SM_DEV is not set — refusing to load remote content. Reinstall or set SM_DEV=1 for dev.');
    app.exit(1);
    return;
  }

  mainWindow.on('closed', () => {
    if (firstPaintTimer) { clearTimeout(firstPaintTimer); firstPaintTimer = null; }
    mainWindow = null;
  });
}

// --- IPC skeleton (filled in later phases) ---

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('app:home-dir', () => os.homedir());

ipcMain.handle('app:cwd', () => process.cwd());

// E2E plumbing: tests set SM_E2E=1 to suppress the voice wizard auto-trigger.
// The renderer reads this once on mount.
ipcMain.handle('app:is-e2e', () => process.env.SM_E2E === '1');

ipcMain.handle('app:engage-rules-path', () => process.env.SESSION_MANAGER_ENGAGE_RULES || null);

// Boot diagnostics — renderer polls these to surface toasts when `claude` isn't
// on disk or the home self-check failed (e.g. macOS /Users symlink mismatch).
ipcMain.handle('app:claude-bin-status', () => bootClaudeBin);
ipcMain.handle('app:home-self-check', () => bootHomeSelfCheck);

ipcMain.handle('app:pick-directory', async () => {
  console.log('[main] pick-directory invoked');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: os.homedir(),
    title: 'Choose project directory for new session',
  });
  console.log('[main] pick-directory result:', result);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.on('app:reboot-app', () => rebootApp());

// Image paste — Ctrl+V in the Terminal pane. Reads the OS clipboard via
// Electron's native API (renderer's navigator.clipboard.read() doesn't expose
// raw image MIME types under contextIsolation), saves the bitmap to a temp
// PNG, and returns the path. Renderer types the path into the PTY so claude
// can `@<path>`-reference it.
ipcMain.handle('clipboard:paste-image', async () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { ok: false, empty: true };
    const buf = img.toPNG();
    if (!buf || buf.length === 0) return { ok: false, empty: true };
    const dir = path.join(os.tmpdir(), 'session-manager-clipboard');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `clipboard-${Date.now()}.png`);
    await fsp.writeFile(file, buf);
    return { ok: true, path: file, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

// Hooks tab "Test fire": run a hook command with a fake event payload piped
// to stdin. shell:true is intentional — Claude Code's hook field is a shell
// string. Timeout is enforced via SIGKILL on a timer because spawn's built-in
// `timeout` option only sends SIGTERM, which a wedged shell may ignore.
ipcMain.handle('app:test-fire-hook', async (_e, payload) => {
  // Zod-validate up front so a malformed renderer payload can never reach the
  // shell. We `safeParse` (not throw) because the existing return shape is
  // `{ exitCode, stdout, stderr, durationMs }` — callers (Hooks.tsx) don't
  // wrap the call in try/catch.
  const parsed = schemas.appTestFireHook.safeParse(payload);
  if (!parsed.success) {
    return { exitCode: -1, stdout: '', stderr: `invalid payload: ${parsed.error.message}`, durationMs: 0 };
  }
  const command = parsed.data.command;
  const env = parsed.data.env ?? null;
  const stdin = typeof parsed.data.payload === 'string' ? parsed.data.payload : '';
  const requested = parsed.data.timeoutMs;
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, 30_000)
    : 5_000;

  if (!command.trim()) {
    return { exitCode: -1, stdout: '', stderr: 'empty command', durationMs: 0 };
  }

  // Require main window focused and explicit user confirmation before exec.
  if (!mainWindow || !mainWindow.isFocused()) {
    return { exitCode: -1, stdout: '', stderr: 'window not focused', durationMs: 0 };
  }
  const detail = command.length > 500 ? command.slice(0, 500) + '…' : command;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Run'],
    defaultId: 0,
    cancelId: 0,
    message: 'Run hook command?',
    detail,
  });
  if (response !== 1) {
    return { exitCode: -1, stdout: '', stderr: 'user cancelled', durationMs: 0 };
  }

  const MAX_BUF = 1024 * 1024; // 1 MiB per stream

  return await new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, {
        shell: true,
        env: cleanChildEnv(env ?? {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: `spawn failed: ${err?.message ?? String(err)}`,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, timeoutMs);

    child.stdout.on('data', (b) => {
      if (stdoutLen < MAX_BUF) {
        stdoutChunks.push(b);
        stdoutLen += b.length;
      }
    });
    child.stderr.on('data', (b) => {
      if (stderrLen < MAX_BUF) {
        stderrChunks.push(b);
        stderrLen += b.length;
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `spawn error: ${err?.message ?? String(err)}`,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const tail = timedOut
        ? `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}[killed: timeout after ${timeoutMs}ms]`
        : stderr;
      resolve({
        exitCode: typeof code === 'number' ? code : (signal ? -1 : 0),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: tail,
        durationMs: Date.now() - startedAt,
      });
    });

    try {
      child.stdin.end(stdin);
    } catch {
      // child may have already exited; close handler will resolve.
    }
  });
});

// StatusBar: best-effort current branch for the active tab's cwd. Returns null
// for non-git dirs, detached HEAD, missing git, or timeouts so callers can
// render `—` without branching on error shape. 1s ceiling keeps a wedged git
// (network filesystem, hung index lock) from blocking the renderer.
ipcMain.handle('app:git-branch', validated(schemas.appGitBranch, async ({ cwd }) => {
  // Both renderer callsites (AlmanacFooter, AlmanacSidebar) already `.catch`
  // rejections and render `—`, so a ZodError throw is handled correctly.
  return await new Promise((resolve) => {
    execFile('git', ['branch', '--show-current'], { cwd, timeout: 1000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const out = String(stdout).trim();
      resolve(out.length ? out : null);
    });
  });
}));

// Containment check for the open-in-{editor,finder,terminal} handlers lives
// in lib/insideHome.cjs — single chokepoint for the /home/bilkoEVIL prefix-trap.
// Editor / finder / terminal logic lives in lib/openExternalApp.cjs.

ipcMain.handle('app:open-in-editor', validated(schemas.openInEditor, async ({ cwd, editor }) => {
  const r = checkInsideHome(cwd);
  if (!r.ok) throw new Error(r.error);
  return openInEditor({ cwd, editor });
}));

ipcMain.handle('app:open-external', validated(schemas.openExternal, async ({ url }) => {
  // URL filter mirrors setWindowOpenHandler at line ~631: without it, the
  // renderer could be tricked into asking shell.openExternal to launch
  // `file:///etc/passwd`, `javascript:…`, or `mailto:…`. Stick to web URLs.
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { ok: false, error: 'only http/https URLs are allowed' };
  }
  await shell.openExternal(url);
  return { ok: true };
}));

ipcMain.handle('app:open-file-in-editor', validated(schemas.openFileInEditor, async ({ path: p, line, col, editor }) => {
  const home = os.homedir();
  const abs = path.isAbsolute(p) ? p : path.resolve(home, p);
  // Allowed roots: $HOME (the usual case) plus our own clipboard temp dir
  // (clipboard-paste writes PNGs there; clicks on those paths from the
  // terminal must resolve). Resolve symlinks on both sides — on macOS
  // /tmp is a symlink to /private/tmp, so a literal prefix check fails.
  const clipboardDirRaw = path.join(os.tmpdir(), 'session-manager-clipboard');
  let clipboardDirReal = clipboardDirRaw;
  try { clipboardDirReal = fs.realpathSync(clipboardDirRaw); } catch { /* not yet created */ }
  let absReal = abs;
  try { absReal = fs.realpathSync(abs); } catch { /* file may not exist yet — fall through to access() below */ }
  const inClipboardTmp =
    absReal === clipboardDirReal ||
    absReal.startsWith(clipboardDirReal + path.sep) ||
    abs === clipboardDirRaw ||
    abs.startsWith(clipboardDirRaw + path.sep);
  if (!inClipboardTmp) {
    const r = checkInsideHome(abs);
    if (!r.ok) throw new Error(r.error);
  }
  return openFileInEditor({ path: abs, line, col, editor });
}));

ipcMain.handle('app:open-in-finder', validated(schemas.openInFinder, async ({ cwd }) => {
  const r = checkInsideHome(cwd);
  if (!r.ok) throw new Error(r.error);
  return openInFinder({ cwd });
}));

ipcMain.handle('app:open-in-terminal', validated(schemas.openInTerminal, async ({ cwd }) => {
  const r = checkInsideHome(cwd);
  if (!r.ok) throw new Error(r.error);
  return openInTerminal({ cwd });
}));

ipcMain.handle('app:archive-project', validated(schemas.archiveProject, async ({ encoded }) => {
  const home = os.homedir();
  const src = path.join(home, '.claude', 'projects', encoded);
  const dst = path.join(home, '.claude', 'projects-archive', encoded);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst);
  return { ok: true };
}));

registerPtyHandlers();
configMgr.registerConfigHandlers();
transcripts.registerTranscriptHandlers();
usageMatrix.registerHandlers();
sessionsStore.registerSessionsHandlers();
billing.registerBillingHandlers();
logs.registerLogHandlers();
voiceHotkey.registerHotkeyHandlers();
voiceWizard.registerWizardHandlers();
scheduler.registerScheduleHandlers();
watchers.registerWatcherHandlers();
teams.registerTeamsHandlers();
queueOps.registerQueueOpsHandlers();
registerHistoryAggregatorHandlers();
pluginInstall.registerPluginInstallHandlers();
memoryTool.registerMemoryHandlers();
agentMemory.registerAgentMemoryHandlers();
registerDocEditorHandlers();
git.register(ipcMain);
superagent.registerSuperAgentHandlers();
registerProjectSkillsHandlers();
filesIpc.registerFilesHandlers();
searchIpc.registerSearchHandlers();
repoAnalyzer.register(ipcMain);
hivesIpc.registerHiveHandlers();

// OTEL telemetry export (opt-in via ~/.config/session-manager/otel.json).
ipcMain.handle('otel:get-config', async () => otelSettings.load());
ipcMain.handle('otel:set-config', async (_e, cfg) => {
  if (!otelSettings.isValid(cfg)) {
    return { ok: false, error: 'invalid config' };
  }
  const saved = await otelSettings.save(cfg);
  const result = await otel.applyConfig(saved);
  return { ok: !!result?.ok, error: result?.error ?? null, config: saved, status: otel.status() };
});
ipcMain.handle('otel:status', () => otel.status());
ipcMain.handle('otel:config-path', () => otelSettings.storePath());

// --- App lifecycle ---

// E2E under xvfb-run has no working GPU; the GPU process exits ~15 seconds
// in and Chromium responds with a renderer reload that races our test
// fixtures. Disabling hardware accel sidesteps the entire crash chain.
// Must run before app.whenReady() — Electron rejects late changes.
if (process.env.SM_E2E === '1') {
  try { app.disableHardwareAcceleration(); } catch { /* */ }
}

// Single-instance lock (PRD F1 v2 §requestSingleInstanceLock).
// In dev mode we skip the lock so two-dev-instance workflows still work.
// E2E tests also skip so playwright.electron.launch can run multiple specs
// back-to-back without the prior app's lock causing the next launch to quit.
const isDev = process.env.SM_DEV === '1' || process.env.SM_E2E === '1';
if (!isDev) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }
}

// Global webContents hardening — applies to DevTools, future webContents, etc.
// Must be registered before app.whenReady so it captures the first window too.
app.on('web-contents-created', (_e, wc) => {
  const useDevServer = process.env.SM_DEV === '1';

  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    const allowed = useDevServer
      ? ['http://localhost:5173', 'http://127.0.0.1:5173']
      : [];
    if (!allowed.some((a) => url.startsWith(a))) {
      event.preventDefault();
      console.warn('[main] blocked will-navigate to', url);
    }
  });

  wc.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});

app.whenReady().then(async () => {
  logs.pruneOld();
  logs.writeLine({ scope: 'main', level: 'info', message: 'app start', meta: { version: app.getVersion(), platform: process.platform } });

  // Boot-time detection 1: surface `claude` binary resolution so a missing
  // install becomes visible to the renderer instead of failing silently on
  // first spawn attempt.
  const claudeResolved = resolveClaudeBin();
  const claudeFoundOnDisk = claudeResolved !== 'claude';
  bootClaudeBin = { resolved: claudeResolved, foundOnDisk: claudeFoundOnDisk };
  if (claudeFoundOnDisk) {
    console.log(`[claudeBin] resolved=${claudeResolved}`);
  } else {
    console.warn('[claudeBin] FALLBACK no candidate found; spawn will rely on PATH');
  }

  // Boot-time detection 2: symlinked /Users on macOS can make os.homedir()
  // realpath to a path outside itself, which breaks every cwd containment
  // check downstream. Surface here rather than failing on first session spawn.
  bootHomeSelfCheck = checkInsideHome(os.homedir());
  if (!bootHomeSelfCheck.ok) {
    console.error(`[insideHome] SELF-CHECK FAILED: ${bootHomeSelfCheck.error}; sessions will not be able to spawn`);
  }

  process.on('uncaughtException', (err) => {
    logs.writeLine({ scope: 'main', level: 'error', message: 'uncaughtException', meta: { error: err?.message, stack: err?.stack } });
  });
  process.on('unhandledRejection', (reason) => {
    const r = reason instanceof Error ? { error: reason.message, stack: reason.stack } : { reason: String(reason) };
    logs.writeLine({ scope: 'main', level: 'error', message: 'unhandledRejection', meta: r });
  });

  // Inject Content-Security-Policy for all renderer responses.
  // frame-src / frame-ancestors locked to 'none' — the app is a top-level
  // Electron BrowserWindow; iframes/embedding have no legitimate use.
  const CSP = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    // Google Fonts: stylesheet served from fonts.googleapis.com, font files
    // from fonts.gstatic.com. Required for the Almanac UI (Newsreader serif,
    // Geist sans, IBM Plex Mono). The alternative — bundling via @fontsource
    // — adds ~3 packages and ~2MB to the renderer build; the network fetch
    // happens once per cold launch and is cached by Electron's HTTP cache.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    // schemastore.org is used by Monaco for JSON schema validation
    // (settings.json, keybindings.json — see App.tsx::installMonacoSchemas).
    // The json.schemastore.org URL redirects to www.schemastore.org, so both
    // hosts must be in the allowlist or CSP blocks the redirect.
    "connect-src 'self' https://api.anthropic.com https://registry.npmjs.org https://json.schemastore.org https://www.schemastore.org",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ') + ';';
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });

  // Grant microphone / media permissions only for trusted origins.
  const MEDIA_PERMS = new Set(['media', 'audioCapture', 'microphone']);
  const isTrustedOrigin = (url) =>
    (typeof url === 'string') &&
    (url.startsWith('file://') || url.startsWith('http://localhost:5173'));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    cb(MEDIA_PERMS.has(permission) && isTrustedOrigin(details?.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return MEDIA_PERMS.has(permission) && isTrustedOrigin(requestingOrigin);
  });
  // macOS: trigger the OS-level mic consent prompt up front. Safe no-op on
  // other platforms (systemPreferences.askForMediaAccess is darwin-only).
  if (process.platform === 'darwin' && typeof systemPreferences.askForMediaAccess === 'function') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* */ }
  }

  const template = [
    {
      label: 'Session Manager',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('app:new-session');
            }
          },
        },
        {
          label: 'Restart App',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: rebootApp,
        },
        {
          label: 'Reboot Session',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('app:reboot-session');
            }
          },
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: 'Dev',
      submenu: [
        { label: 'Toggle DevTools', accelerator: 'F12', role: 'toggleDevTools' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', role: 'reload' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  createWindow();
  ptyManager.attachWindow(mainWindow);
  configMgr.attachWindow(mainWindow);
  transcripts.attachWindow(mainWindow);
  usageMatrix.attachWindow(mainWindow);
  voiceHotkey.init(mainWindow).catch((e) => {
    logs.writeLine({ scope: 'voice-hotkey', level: 'error', message: 'init failed', meta: { error: e?.message } });
  });
  scheduler.attachWindow(mainWindow);
  watchers.attachWindow(mainWindow);
  pluginInstall.attachWindow(mainWindow);
  superagent.attachWindow(mainWindow);
  scheduler.init().catch((e) => {
    logs.writeLine({ scope: 'scheduler', level: 'error', message: 'init failed', meta: { error: e?.message } });
  });

  // Keep the machine awake while the app is open. The scheduler polls billing
  // usage every 2 min and runs `claude -p` jobs that must survive an idle
  // laptop — a system suspend (GNOME/Pop!_OS idle or lid timeout) would freeze
  // both. `prevent-app-suspension` stops suspend but still lets the display
  // dim/sleep, so battery impact is limited to keeping the CPU resumable.
  // On Linux this routes through the org.freedesktop.login1 inhibitor.
  try {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    logs.writeLine({ scope: 'main', level: 'info', message: 'powerSaveBlocker started', meta: { id: powerBlockerId } });
  } catch (e) {
    logs.writeLine({ scope: 'main', level: 'warn', message: 'powerSaveBlocker failed', meta: { error: e?.message } });
  }

  // OTEL: load persisted config and start the exporter only if `enabled`.
  // Failures are non-fatal — the app must keep working without telemetry.
  otelSettings.load()
    .then((cfg) => otel.applyConfig(cfg))
    .then((res) => {
      if (res && !res.ok && res.error) {
        logs.writeLine({ scope: 'otel', level: 'warn', message: 'init failed', meta: { error: res.error } });
      }
    })
    .catch((e) => {
      logs.writeLine({ scope: 'otel', level: 'error', message: 'init failed', meta: { error: e?.message } });
    });
});

app.on('will-quit', () => {
  // PRD F1 v2 §IPC plumbing: must unregisterAll on will-quit.
  try { globalShortcut.unregisterAll(); } catch { /* */ }
  voiceHotkey.disposeOnQuit();
  if (powerBlockerId !== -1) {
    try { powerSaveBlocker.stop(powerBlockerId); } catch { /* */ }
    powerBlockerId = -1;
  }
});

app.on('window-all-closed', () => {
  if (rebooting) return; // new window is about to be created
  ptyManager.killAll();
  configMgr.closeAllWatchers();
  transcripts.closeAll();
  watchers.manager.killAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  supervisor.stopSupervisor();
  ptyManager.killAll();
  configMgr.closeAllWatchers();
  transcripts.closeAll();
  watchers.manager.killAll();
  // Best-effort flush of any pending OTEL spans. shutdown() has its own 2s
  // ceiling so a wedged exporter can't hold quit.
  otel.shutdown().catch(() => {});
});
