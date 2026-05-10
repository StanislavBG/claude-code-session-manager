const { app, BrowserWindow, ipcMain, dialog, Menu, session, systemPreferences, globalShortcut, shell } = require('electron');
const { spawn, execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { schemas } = require('./ipcSchemas.cjs');
const { cleanChildEnv } = require('./lib/cleanEnv.cjs');
const { manager: ptyManager, registerPtyHandlers } = require('./pty.cjs');
const configMgr = require('./config.cjs');
const transcripts = require('./transcripts.cjs');
const sessionsStore = require('./sessionsStore.cjs');
const billing = require('./usage.cjs');
const logs = require('./logs.cjs');
const voiceHotkey = require('./voiceHotkey.cjs');
const voiceWizard = require('./voiceWizard.cjs');
const scheduler = require('./scheduler.cjs');
const watchers = require('./watchers.cjs');
const otel = require('./otel.cjs');
const otelSettings = require('./otelSettings.cjs');
const { registerHistoryAggregatorHandlers } = require('./historyAggregator.cjs');

let mainWindow = null;
let rebooting = false;

const REBOOT_LOG = path.join(os.homedir(), '.claude', 'session-manager-reboot.log');

function logReboot(line) {
  try {
    fs.mkdirSync(path.dirname(REBOOT_LOG), { recursive: true });
    // 0o600 — reboot log can include npx paths and pid traces. Match the
    // mode used by logs.cjs / otelSettings.cjs for consistency.
    fs.appendFileSync(REBOOT_LOG, `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 });
  } catch { /* best-effort */ }
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
    voiceHotkey.init(mainWindow).catch((e) => {
      logs.writeLine({ scope: 'voice-hotkey', level: 'error', message: 'reinit failed', meta: { error: e?.message } });
    });
    scheduler.attachWindow(mainWindow);
    watchers.attachWindow(mainWindow);
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
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
    mainWindow = null;
  });
}

// --- IPC skeleton (filled in later phases) ---

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('app:home-dir', () => os.homedir());

ipcMain.handle('app:cwd', () => process.cwd());

ipcMain.handle('app:engage-rules-path', () => process.env.SESSION_MANAGER_ENGAGE_RULES || null);

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

// Hooks tab "Test fire": run a hook command with a fake event payload piped
// to stdin. shell:true is intentional — Claude Code's hook field is a shell
// string. Timeout is enforced via SIGKILL on a timer because spawn's built-in
// `timeout` option only sends SIGTERM, which a wedged shell may ignore.
ipcMain.handle('app:test-fire-hook', async (_e, payload) => {
  const command = typeof payload?.command === 'string' ? payload.command : '';
  const env = payload && typeof payload.env === 'object' && payload.env !== null ? payload.env : null;
  const stdin = typeof payload?.payload === 'string' ? payload.payload : '';
  const requested = Number(payload?.timeoutMs);
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
ipcMain.handle('app:git-branch', async (_e, payload) => {
  const cwd = payload && typeof payload.cwd === 'string' ? payload.cwd : null;
  if (!cwd) return null;
  return await new Promise((resolve) => {
    execFile('git', ['branch', '--show-current'], { cwd, timeout: 1000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const out = String(stdout).trim();
      resolve(out.length ? out : null);
    });
  });
});

// Returns the resolved path of a command, or null if not found on PATH.
function findCommand(name) {
  try {
    const out = execFileSync(
      process.platform === 'win32' ? 'where' : 'which',
      [name],
      { encoding: 'utf8', env: process.env, timeout: 500 },
    ).trim().split(/\r?\n/)[0];
    if (out) return out;
  } catch { /* not found */ }
  return null;
}

ipcMain.handle('app:open-in-editor', async (_e, payload) => {
  const { cwd, editor } = schemas.openInEditor.parse(payload);
  const home = os.homedir();
  if (!path.resolve(cwd).startsWith(home)) throw new Error('cwd outside home');
  const candidates = (editor && editor !== 'auto')
    ? [editor]
    : [process.env.VISUAL, process.env.EDITOR, 'code', 'cursor', 'subl', 'nano'].filter(Boolean);
  for (const cmd of candidates) {
    if (!findCommand(cmd)) continue;
    const child = spawn(cmd, [cwd], { detached: true, stdio: 'ignore', env: cleanChildEnv() });
    child.unref();
    return { ok: true, editor: cmd };
  }
  return { ok: false, error: 'no editor found' };
});

ipcMain.handle('app:open-in-finder', async (_e, payload) => {
  const { cwd } = schemas.openInFinder.parse(payload);
  const home = os.homedir();
  if (!path.resolve(cwd).startsWith(home)) throw new Error('cwd outside home');
  await shell.openPath(cwd);
  return { ok: true };
});

ipcMain.handle('app:open-in-terminal', async (_e, payload) => {
  const { cwd } = schemas.openInTerminal.parse(payload);
  const home = os.homedir();
  if (!path.resolve(cwd).startsWith(home)) throw new Error('cwd outside home');
  if (process.platform === 'linux') {
    const terms = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
    for (const t of terms) {
      if (!findCommand(t)) continue;
      const args = t === 'gnome-terminal'
        ? ['--working-directory=' + cwd]
        : ['-e', `bash -c "cd '${cwd.replace(/'/g, "'\\''")}' && exec bash"`];
      const child = spawn(t, args, { detached: true, stdio: 'ignore', env: cleanChildEnv() });
      child.unref();
      return { ok: true, terminal: t };
    }
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore', env: cleanChildEnv() }).unref();
    return { ok: true, terminal: 'Terminal.app' };
  }
  return { ok: false, error: 'no terminal found' };
});

ipcMain.handle('app:archive-project', async (_e, payload) => {
  const { encoded } = schemas.archiveProject.parse(payload);
  const home = os.homedir();
  const src = path.join(home, '.claude', 'projects', encoded);
  const dst = path.join(home, '.claude', 'projects-archive', encoded);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst);
  return { ok: true };
});

registerPtyHandlers();
configMgr.registerConfigHandlers();
transcripts.registerTranscriptHandlers();
sessionsStore.registerSessionsHandlers();
billing.registerBillingHandlers();
logs.registerLogHandlers();
voiceHotkey.registerHotkeyHandlers();
voiceWizard.registerWizardHandlers();
scheduler.registerScheduleHandlers();
watchers.registerWatcherHandlers();
registerHistoryAggregatorHandlers();

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

  process.on('uncaughtException', (err) => {
    logs.writeLine({ scope: 'main', level: 'error', message: 'uncaughtException', meta: { error: err?.message, stack: err?.stack } });
  });
  process.on('unhandledRejection', (reason) => {
    const r = reason instanceof Error ? { error: reason.message, stack: reason.stack } : { reason: String(reason) };
    logs.writeLine({ scope: 'main', level: 'error', message: 'unhandledRejection', meta: r });
  });

  // Inject Content-Security-Policy for all renderer responses.
  const CSP = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.anthropic.com",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
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
  voiceHotkey.init(mainWindow).catch((e) => {
    logs.writeLine({ scope: 'voice-hotkey', level: 'error', message: 'init failed', meta: { error: e?.message } });
  });
  scheduler.attachWindow(mainWindow);
  watchers.attachWindow(mainWindow);
  scheduler.init().catch((e) => {
    logs.writeLine({ scope: 'scheduler', level: 'error', message: 'init failed', meta: { error: e?.message } });
  });

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
  ptyManager.killAll();
  configMgr.closeAllWatchers();
  transcripts.closeAll();
  watchers.manager.killAll();
  // Best-effort flush of any pending OTEL spans. shutdown() has its own 2s
  // ceiling so a wedged exporter can't hold quit.
  otel.shutdown().catch(() => {});
});
