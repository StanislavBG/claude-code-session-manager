const { app, BrowserWindow, ipcMain, dialog, Menu, session, systemPreferences, globalShortcut, shell, clipboard, nativeImage, powerSaveBlocker, protocol } = require('electron');
const { spawn, execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { schemas, validated } = require('./ipcSchemas.cjs');
const { cleanChildEnv } = require('./lib/cleanEnv.cjs');
const { manager: ptyManager, registerPtyHandlers } = require('./pty.cjs');
const browserView = require('./browserView.cjs');
const browserCapture = require('./browserCapture.cjs');
const configMgr = require('./config.cjs');
const transcripts = require('./transcripts.cjs');
const usageMatrix = require('./usageMatrix.cjs');
const sessionsStore = require('./sessionsStore.cjs');
const billing = require('./usage.cjs');
const { probeMcpStatus } = require('./mcpStatus.cjs');
const logs = require('./logs.cjs');
const crashDiagnostics = require('./crashDiagnostics.cjs');
// Start the local minidump collector before app-ready (required by Electron).
// Catches renderer/GPU SIGSEGV/SIGABRT; OOM-kills leave no dump but are caught
// by the sentinel + render-process-gone hooks in crashDiagnostics.init().
crashDiagnostics.startCrashReporter();
const voiceHotkey = require('./voiceHotkey.cjs');
const voiceWizard = require('./voiceWizard.cjs');
const scheduler = require('./scheduler.cjs');
const { createAdminServer } = require('./adminServer.cjs');
const adminServer = createAdminServer(scheduler.remote);
const { createBrowserAgentServer } = require('./browserAgentServer.cjs');
const browserAgentServer = createBrowserAgentServer({
  listTabs: () => browserView.listViews(),
  screenshot: ({ viewId }) => browserView.captureShotForAgent({ viewId }),
  action: (params) => browserView.dispatchViewAction(params),
  dom: ({ viewId }) => browserView.captureAgentDom({ viewId }),
});
const supervisor = require('./supervisor.cjs');
const watchers = require('./watchers.cjs');
const teams = require('./teams.cjs');
const queueOps = require('./queueOps.cjs');
const pluginInstall = require('./pluginInstall.cjs');
const { seedDevPlugin } = require('./seedDevPlugin.cjs');
const otel = require('./otel.cjs');
const otelSettings = require('./otelSettings.cjs');
const { registerHistoryAggregatorHandlers, finalizeClosedDays } = require('./historyAggregator.cjs');
const memoryTool = require('./memoryTool.cjs');
const { registerMemoryAggregateIpc } = require('./memoryAggregate.cjs');
const agentMemory = require('./agentMemory.cjs');
const git = require('./git.cjs');
const superagent = require('./superagent.cjs');
const filesIpc = require('./files.cjs');
const { registerDocEditHandlers } = require('./docEdit.cjs');
const searchIpc = require('./search.cjs');
const repoAnalyzer = require('./repoAnalyzer.cjs');
const hivesIpc = require('./hives.cjs');
const webRemote = require('./webRemote.cjs');
const chatRunner = require('./chatRunner.cjs');
const { listExchanges } = require('./exchanges.cjs');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { checkInsideHome, assertInsideHome } = require('./lib/insideHome.cjs');
const { openInEditor, openFileInEditor, openInFinder, openInTerminal } = require('./lib/openExternalApp.cjs');

let mainWindow = null;
let rebooting = false;
// powerSaveBlocker handle — keeps the system from suspending while the app runs
// so the scheduler's polling and jobs aren't frozen. -1 = not held.
let powerBlockerId = -1;
// Linux-only backstop. Electron's `powerSaveBlocker('prevent-app-suspension')`
// leans on org.gnome.SessionManager, which COSMIC (Pop!_OS 24.04+) doesn't
// implement — under COSMIC it silently registers only a *delay*-mode logind
// lock, which postpones suspend by seconds instead of blocking it, so the
// machine idle-suspends with the app open. We spawn our own block-mode
// `systemd-inhibit` child, which talks straight to logind and is
// desktop-agnostic. Handle to the child so we can release it on quit.
let systemdInhibitChild = null;
// Belt-and-suspenders: re-assert the inhibitor on a slow cadence so it can never
// stay dead (idempotent — startSystemdInhibit no-ops if a live holder exists).
let inhibitReassertTimer = null;

function startSystemdInhibit() {
  if (process.platform !== 'linux') return;
  // Idempotent: if a live child already holds the lock, don't spawn a second.
  if (systemdInhibitChild && systemdInhibitChild.exitCode === null && !systemdInhibitChild.killed) return;
  try {
    // `sleep:idle` blocks both explicit suspend and the idle-action timer.
    // The holder is a poll on OUR pid rather than `sleep infinity`: when the
    // main process dies — graceful quit, SIGKILL, OR an OOM crash — `kill -0`
    // fails within one tick and the holder exits, releasing the lock. Without
    // this the child reparents to init on a hard kill and the inhibitor leaks
    // forever (one stranded lock per crash). 5s tick = worst-case 5s of stale
    // lock after death, which errs toward "stay awake" — the safe direction.
    // Absolute path — a GUI/desktop-launched Electron can boot with a minimal
    // PATH that lacks /usr/bin, so a bare `systemd-inhibit` would ENOENT.
    const inhibitBin = require('node:fs').existsSync('/usr/bin/systemd-inhibit')
      ? '/usr/bin/systemd-inhibit' : 'systemd-inhibit';
    const child = spawn(inhibitBin, [
      '--what=sleep:idle',
      '--who=Claude Session Manager',
      '--why=Scheduler polling and claude -p jobs must survive idle',
      '--mode=block',
      'sh', '-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 5; done`,
    ], { stdio: 'ignore', detached: false });
    child.on('error', (e) => {
      logs.writeLine({ scope: 'main', level: 'warn', message: 'systemd-inhibit spawn failed', meta: { error: e?.message } });
    });
    // Self-heal: if the holder ever dies while the app is alive (a missed
    // suspend, an external kill, a transient spawn that didn't hold), revive it.
    // Without this the lock is held exactly once at boot and never recovers —
    // the machine then idle-suspends with the app open (the reported bug).
    child.on('exit', (code, signal) => {
      logs.writeLine({ scope: 'main', level: 'warn', message: 'systemd-inhibit holder exited', meta: { code, signal } });
      if (!teardownDone && systemdInhibitChild === child) {
        systemdInhibitChild = null;
        setTimeout(() => { if (!teardownDone) startSystemdInhibit(); }, 2000);
      }
    });
    if (child.pid) {
      systemdInhibitChild = child;
      logs.writeLine({ scope: 'main', level: 'info', message: 'systemd-inhibit block lock held', meta: { pid: child.pid } });
    }
  } catch (e) {
    logs.writeLine({ scope: 'main', level: 'warn', message: 'systemd-inhibit unavailable', meta: { error: e?.message } });
  }
}

function stopSystemdInhibit() {
  if (systemdInhibitChild) {
    try { systemdInhibitChild.kill('SIGTERM'); } catch { /* */ }
    systemdInhibitChild = null;
  }
}

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
    browserView.attachWindow(mainWindow);
    browserCapture.attachWindow(mainWindow);
    voiceHotkey.init(mainWindow).catch((e) => {
      logs.writeLine({ scope: 'voice-hotkey', level: 'error', message: 'reinit failed', meta: { error: e?.message } });
    });
    scheduler.attachWindow(mainWindow);
    watchers.attachWindow(mainWindow);
    pluginInstall.attachWindow(mainWindow);
    superagent.attachWindow(mainWindow);
    chatRunner.attachWindow(mainWindow);
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
  runShutdownCleanup();   // app.exit bypasses will-quit
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
      // Enables Chromium's built-in PDF viewer so the Editor's PdfPane iframe
      // renders .pdf over smfile:// instead of triggering a download. The only
      // Pepper "plugin" in modern Electron is the PDF viewer (Flash is gone).
      plugins: true,
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
  // Release any stale chokidar watchers that were opened by the previous
  // renderer frame. Fires on Ctrl+R and HMR full-page reloads — the fresh
  // renderer will re-register its own watches, so the old sender's contribution
  // must be unwound first to avoid refcount ratcheting.
  mainWindow.webContents.on('did-start-navigation', () => {
    configMgr.releaseWatchesForSender(mainWindow.webContents.id);
  });

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
    runShutdownCleanup();   // app.exit bypasses will-quit
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

// Simple mode: `npx claude-code-session-manager --simple` boots straight into a
// single full-window terminal running `claude --dangerously-skip-permissions`
// in the directory the command was run from — no nav, tabs, or config surface.
// The flag arrives via bin/cli.cjs, which forwards process.argv to Electron.
// cwd is the launch dir (cli.cjs inherits the user's shell cwd).
ipcMain.handle('app:launch-mode', () => ({
  simple: process.argv.includes('--simple'),
  cwd: process.cwd(),
}));

// MCP Servers tab (PRD 456 consumes this): probes live connection status via
// `claude mcp list`. Read-only, single in-flight call — no polling.
ipcMain.handle('mcp:status', () => probeMcpStatus());

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

// Recorder export "Save to file…" (PRD 412) — native Save As dialog, written
// directly since the path is user-chosen, not renderer input.
ipcMain.handle('browser:save-recording', validated(schemas.browserSaveRecording, async ({ defaultName, text }) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    await fsp.writeFile(result.filePath, text, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}));

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

// Text paste — same rationale as clipboard:paste-image above: the renderer's
// navigator.clipboard.readText() requires the 'clipboard-read' permission,
// which setPermissionRequestHandler denies (MEDIA_PERMS only), so it always
// rejects. Reading via Electron's main-process clipboard.readText() sidesteps
// that permission gate entirely — no permission-handler changes needed.
ipcMain.handle('clipboard:paste-text', async () => {
  try {
    const text = clipboard.readText();
    return { ok: true, text: text || '' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

// Recorder export "Copy to clipboard" (PRD 412) — write side.
ipcMain.handle('clipboard:write-text', validated(schemas.clipboardWriteText, ({ text }) => {
  try {
    clipboard.writeText(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}));

// PRD 407 Capture panel — write side of paste-image's read. Writes a
// screenshot capture to the OS clipboard as an image.
ipcMain.handle('browser:copy-image', validated(schemas.browserCopyImage, ({ dataUrl }) => {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (!img || img.isEmpty()) return { ok: false, error: 'empty image' };
    clipboard.writeImage(img);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}));

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

// Consolidated shell open/reveal endpoint. One channel, discriminated on `as`,
// replaces five app:open-* handlers plus files:open-external / show-in-finder.
// Each branch keeps its own boundary guard (home-scope or http(s)-only).
ipcMain.handle('shell:open', validated(schemas.shellOpen, async (opts) => {
  switch (opts.as) {
    case 'editor': {
      const r = checkInsideHome(opts.cwd);
      if (!r.ok) throw new Error(r.error);
      return openInEditor({ cwd: opts.cwd, editor: opts.editor });
    }
    case 'finder': {
      const r = checkInsideHome(opts.cwd);
      if (!r.ok) throw new Error(r.error);
      return openInFinder({ cwd: opts.cwd });
    }
    case 'terminal': {
      const r = checkInsideHome(opts.cwd);
      if (!r.ok) throw new Error(r.error);
      return openInTerminal({ cwd: opts.cwd });
    }
    case 'external': {
      // Without this, the renderer could ask shell.openExternal to launch
      // `file:///etc/passwd`, `javascript:…`, or `mailto:…`. Web URLs only.
      const url = opts.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return { ok: false, error: 'only http/https URLs are allowed' };
      }
      await shell.openExternal(url);
      return { ok: true };
    }
    case 'fileInEditor': {
      const home = os.homedir();
      const abs = path.isAbsolute(opts.path) ? opts.path : path.resolve(home, opts.path);
      // Allowed roots: $HOME plus our own clipboard temp dir (clipboard-paste
      // writes PNGs there; terminal clicks on those paths must resolve).
      // Resolve symlinks on both sides — on macOS /tmp → /private/tmp.
      const clipboardDirRaw = path.join(os.tmpdir(), 'session-manager-clipboard');
      let clipboardDirReal = clipboardDirRaw;
      try { clipboardDirReal = fs.realpathSync(clipboardDirRaw); } catch { /* not yet created */ }
      let absReal = abs;
      try { absReal = fs.realpathSync(abs); } catch { /* may not exist yet — access() below */ }
      const inClipboardTmp =
        absReal === clipboardDirReal ||
        absReal.startsWith(clipboardDirReal + path.sep) ||
        abs === clipboardDirRaw ||
        abs.startsWith(clipboardDirRaw + path.sep);
      if (!inClipboardTmp) {
        const r = checkInsideHome(abs);
        if (!r.ok) throw new Error(r.error);
      }
      return openFileInEditor({ path: abs, line: opts.line, col: opts.col, editor: opts.editor });
    }
    case 'openPath':
      // validateHomePath runs inside filesIpc.openExternal.
      return filesIpc.openExternal(opts.path);
    case 'revealPath':
      return filesIpc.showInFinder(opts.path);
    default:
      return { ok: false, error: 'unknown open target' };
  }
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
registerMemoryAggregateIpc();
agentMemory.registerAgentMemoryHandlers();
git.register(ipcMain);
superagent.registerSuperAgentHandlers();
filesIpc.registerFilesHandlers();
registerDocEditHandlers();
searchIpc.registerSearchHandlers();
repoAnalyzer.register(ipcMain);
hivesIpc.registerHiveHandlers();
webRemote.registerRemoteHandlers();
chatRunner.registerChatHandlers();

// Exchanges: read the durable per-exchange log (written by chatRunner → recordExchange).
ipcMain.handle('exchanges:list', validated(schemas.exchangesList, async (payload) => {
  try {
    return await listExchanges(payload);
  } catch (e) {
    logs.writeLine({ scope: 'exchanges', level: 'error', message: 'listExchanges failed', meta: { error: e?.message } });
    return [];
  }
}));

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

// smfile:// — privileged scheme that serves home-scoped files to the in-app
// Editor's HTML preview iframe. Loading the user's HTML via a custom scheme
// (rather than srcdoc) gives the iframe document its OWN origin + empty CSP, so
// the page's own visualization scripts run — while the iframe is still
// sandboxed without allow-same-origin (opaque origin), keeping it walled off
// from the host app, its IPC bridge, and the user's filesystem. Must be
// registered before app.whenReady() (Electron rejects late scheme privileges).
protocol.registerSchemesAsPrivileged([
  { scheme: 'smfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Common content types for previewed assets. Anything unknown is served as
// octet-stream so the browser sniffs / downloads rather than mis-rendering.
const SMFILE_MIME = {
  '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.jsonl': 'application/jsonl', '.ndjson': 'application/x-ndjson', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain', '.csv': 'text/csv', '.xml': 'application/xml',
  '.pdf': 'application/pdf',
};

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
    // The embedded Browser tab's WebContentsView is a real browser — it must
    // be able to navigate anywhere. Exempt ONLY webContents registered by
    // browserView.cjs; the main window's lock below is unchanged.
    if (browserView.isBrowserViewContents(wc.id)) return;

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

  // Crash/OOM diagnostics: logs a postmortem if the PREVIOUS run died
  // uncleanly (the silent OOM-kill we've been chasing), then starts the memory
  // heartbeat + render/child-process-gone hooks for this run. See
  // crashDiagnostics.cjs for the full rationale.
  crashDiagnostics.init({
    logs,
    getPowerBlockerId: () => powerBlockerId,
    // If a suspend ever fires while we're alive, the OS lock lapsed — re-assert
    // our block-mode systemd-inhibit so the next idle window stays covered.
    onSuspendWhileAlive: () => { stopSystemdInhibit(); startSystemdInhibit(); },
  });

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
    "img-src 'self' data: blob: smfile:",
    "font-src 'self' data: https://fonts.gstatic.com",
    // schemastore.org is used by Monaco for JSON schema validation
    // (settings.json, keybindings.json — see App.tsx::installMonacoSchemas).
    // The json.schemastore.org URL redirects to www.schemastore.org, so both
    // hosts must be in the allowlist or CSP blocks the redirect.
    "connect-src 'self' https://api.anthropic.com https://registry.npmjs.org https://json.schemastore.org https://www.schemastore.org",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    // smfile: powers the Editor's sandboxed HTML preview iframe. The iframe is
    // sandboxed WITHOUT allow-same-origin, so its document has an opaque origin
    // and cannot reach the host even though it may run its own scripts.
    "frame-src smfile:",
    "frame-ancestors 'none'",
  ].join('; ') + ';';
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    // smfile:// serves the Editor's HTML-preview documents. They must NOT
    // inherit the app CSP — `frame-ancestors 'none'` would forbid framing them,
    // and `script-src 'self'` would block the page's own visualization scripts.
    // Isolation comes from the iframe sandbox (opaque origin), not from CSP.
    if (details.url.startsWith('smfile:')) { cb({}); return; }
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });

  // smfile:// handler — serves a single home-scoped file for the Editor's HTML
  // preview iframe (and its relative assets: ./chart.js, ./data.json, images).
  // URL shape: smfile://local/<absolute-path>. The pathname IS the absolute
  // path; assertInsideHome enforces containment + rejects symlink escapes. The
  // sandboxed iframe's relative requests resolve against this same scheme, so
  // co-located assets load while everything stays inside home.
  protocol.handle('smfile', async (request) => {
    try {
      const url = new URL(request.url);
      const abs = decodeURIComponent(url.pathname);
      const { realPath } = assertInsideHome(abs); // throws if outside home
      const st = await fs.promises.stat(realPath);
      if (st.isDirectory()) return new Response('Not a file', { status: 404 });
      if (st.size > 25 * 1024 * 1024) return new Response('Too large', { status: 413 });
      const buf = await fs.promises.readFile(realPath);
      const ext = path.extname(realPath).toLowerCase();
      const type = SMFILE_MIME[ext] || 'application/octet-stream';
      return new Response(buf, { headers: { 'content-type': type } });
    } catch (err) {
      return new Response(`smfile error: ${err && err.message}`, { status: 404 });
    }
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
  browserView.registerBrowserView({ mainWindow, ipcMain });
  browserCapture.attachWindow(mainWindow);
  browserCapture.registerBrowserCapture({ ipcMain, getView: browserView.getView });
  voiceHotkey.init(mainWindow).catch((e) => {
    logs.writeLine({ scope: 'voice-hotkey', level: 'error', message: 'init failed', meta: { error: e?.message } });
  });
  scheduler.attachWindow(mainWindow);
  watchers.attachWindow(mainWindow);
  pluginInstall.attachWindow(mainWindow);
  superagent.attachWindow(mainWindow);
  webRemote.attachWindow(mainWindow);
  chatRunner.attachWindow(mainWindow);
  scheduler.init().catch((e) => {
    logs.writeLine({ scope: 'scheduler', level: 'error', message: 'init failed', meta: { error: e?.message } });
  });
  adminServer.start().catch((e) => {
    logs.writeLine({ scope: 'admin-server', level: 'error', message: 'init failed', meta: { error: e?.message } });
  });
  browserAgentServer.start().catch((e) => {
    logs.writeLine({ scope: 'browser-agent-server', level: 'error', message: 'init failed', meta: { error: e?.message } });
  });
  // First-boot default: install the bundled session-manager-dev plugin (its 10
  // dev skills) from the app's own marketplace. One-shot + idempotent; never
  // throws. SM_SEED_DEV_PLUGIN_DISABLE=1 to opt out.
  seedDevPlugin({ logger: console }).catch((e) => {
    logs.writeLine({ scope: 'seed-dev-plugin', level: 'error', message: 'seed failed', meta: { error: e?.message } });
  });
  webRemote.init().catch((e) => {
    logs.writeLine({ scope: 'webRemote', level: 'error', message: 'init failed', meta: { error: e?.message } });
  });
  // History rollup finalize pass: deferred 30s past boot so it never competes
  // with first-paint, fire-and-forget (cron/offline refresh is PRD 651 — this
  // is just the one-shot in-app pass).
  setTimeout(() => {
    finalizeClosedDays().catch((e) => {
      logs.writeLine({ scope: 'history-rollup', level: 'error', message: 'finalizeClosedDays failed', meta: { error: e?.message } });
    });
  }, 30_000);
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
  // Linux backstop — Electron's blocker no-ops under COSMIC (see above).
  startSystemdInhibit();
  // Re-assert every 60s so a dead holder self-revives even if its exit handler
  // was missed. Idempotent; unref'd so it never holds the loop open at quit.
  if (process.platform === 'linux' && !inhibitReassertTimer) {
    inhibitReassertTimer = setInterval(() => { if (!teardownDone) startSystemdInhibit(); }, 60_000);
    if (inhibitReassertTimer.unref) inhibitReassertTimer.unref();
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

// Centralized teardown. `will-quit` fires on a normal quit, but `app.exit()`
// (in-app reboot, dist-missing abort) bypasses will-quit entirely — so those
// sites must call this directly, otherwise markCleanShutdown never runs and the
// next boot misreports a clean reboot as an UNCLEAN OOM crash, and the
// powerSaveBlocker/inhibitor leak until process death.
let teardownDone = false;
function runShutdownCleanup() {
  if (teardownDone) return;          // idempotent — will-quit may still fire after an app.exit path
  teardownDone = true;
  webRemote.destroy();
  // Mark a clean exit so the next boot can distinguish a graceful quit from an
  // OOM-kill / native crash (which leaves the sentinel `open`).
  crashDiagnostics.markCleanShutdown();
  // PRD F1 v2 §IPC plumbing: must unregisterAll on will-quit.
  try { globalShortcut.unregisterAll(); } catch { /* */ }
  voiceHotkey.disposeOnQuit();
  if (powerBlockerId !== -1) {
    try { powerSaveBlocker.stop(powerBlockerId); } catch { /* */ }
    powerBlockerId = -1;
  }
  if (inhibitReassertTimer) { clearInterval(inhibitReassertTimer); inhibitReassertTimer = null; }
  stopSystemdInhibit();
}

app.on('will-quit', runShutdownCleanup);

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
  adminServer.stop().catch(() => {});
  browserAgentServer.stop().catch(() => {});
  // Best-effort flush of any pending OTEL spans. shutdown() has its own 2s
  // ceiling so a wedged exporter can't hold quit.
  otel.shutdown().catch(() => {});
});
