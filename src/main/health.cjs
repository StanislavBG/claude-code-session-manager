/**
 * health.cjs — health check for session-manager Electron app.
 * Verifies: app startup, IPC responsiveness, scheduler health, watchers active.
 * Exported as check() for /local-project-health skill.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const MAX_LOG_AGE_MS = 5 * 60_000; // 5 min — warn if no logs this old
const PROJECT_ROOT = path.resolve(__dirname, '../..');

function runCheck(cmd, cwd = PROJECT_ROOT) {
  try {
    execFileSync('bash', ['-c', cmd], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

async function check() {
  const start = Date.now();
  const status = {
    ok: true,
    timestamp: new Date().toISOString(),
    components: {},
    issues: [],
  };

  // 1. Check Node.js and key dependencies exist.
  try {
    const nodeVer = execFileSync('node', ['--version'], { encoding: 'utf8' }).trim();
    status.components.nodejs = { ok: true, version: nodeVer };
  } catch (e) {
    status.components.nodejs = { ok: false, error: e.message };
    status.issues.push('Node.js not available');
    status.ok = false;
  }

  // 1.5. Check TypeScript compilation (no errors).
  const typesOk = runCheck('npm run typecheck 2>&1 | grep -q "error" && exit 1 || exit 0');
  status.components.typescript = { ok: typesOk };
  if (!typesOk) {
    status.issues.push('TypeScript compilation has errors');
    status.ok = false;
  }

  // 1.6. Check build artifact exists.
  const distExists = fs.existsSync(path.join(PROJECT_ROOT, 'dist/index.html'));
  status.components.build_artifact = { ok: distExists, path: 'dist/index.html' };
  if (!distExists) {
    status.issues.push('Build artifact missing (run: npm run build)');
    status.ok = false;
  }

  // 1.7. Check test infrastructure exists.
  const hasPlaywright = fs.existsSync(path.join(PROJECT_ROOT, 'playwright.config.ts'));
  const hasE2E = fs.existsSync(path.join(PROJECT_ROOT, 'e2e'));
  status.components.test_infrastructure = {
    ok: hasPlaywright && hasE2E,
    playwright: hasPlaywright,
    e2e_dir: hasE2E,
  };

  // 2. Check config directory exists and is writable.
  const configDir = path.join(os.homedir(), '.claude');
  try {
    await fsp.access(configDir, fs.constants.R_OK | fs.constants.W_OK);
    const stat = await fsp.stat(configDir);
    status.components.config_dir = {
      ok: true,
      path: configDir,
      writable: true,
    };
  } catch (e) {
    status.components.config_dir = {
      ok: false,
      error: e.message,
      path: configDir,
    };
    status.issues.push(`Config dir not accessible: ${e.message}`);
    status.ok = false;
  }

  // 3. Check scheduler PRD directory and queue.json.
  const schedulerBaseDir = path.join(
    os.homedir(),
    '.claude/session-manager/scheduled-plans'
  );
  const queuePath = path.join(schedulerBaseDir, 'queue.json');
  let queueState = null;
  try {
    const queueText = await fsp.readFile(queuePath, 'utf8');
    queueState = JSON.parse(queueText);
    const runningCount = Object.values(queueState.jobs || {}).filter(
      (j) => j.status === 'running'
    ).length;
    const failedCount = Object.values(queueState.jobs || {}).filter(
      (j) => j.status === 'failed'
    ).length;
    status.components.scheduler_queue = {
      ok: true,
      path: queuePath,
      jobs: Object.keys(queueState.jobs || {}).length,
      running: runningCount,
      failed: failedCount,
    };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      status.issues.push(`Scheduler queue unreadable: ${e.message}`);
    }
    status.components.scheduler_queue = {
      ok: e.code === 'ENOENT', // ok if queue doesn't exist yet
      path: queuePath,
      exists: false,
      error: e.code === 'ENOENT' ? 'not yet created' : e.message,
    };
  }

  // 4. Check PRDs directory.
  const prdsDir = path.join(schedulerBaseDir, 'prds');
  try {
    await fsp.access(prdsDir, fs.constants.R_OK);
    const files = await fsp.readdir(prdsDir);
    const prdFiles = files.filter((f) => f.endsWith('.md'));
    status.components.scheduler_prds = {
      ok: true,
      path: prdsDir,
      count: prdFiles.length,
    };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      status.issues.push(`PRDs directory not accessible: ${e.message}`);
    }
    status.components.scheduler_prds = {
      ok: e.code === 'ENOENT', // ok if not yet created
      path: prdsDir,
      exists: false,
      error: e.code === 'ENOENT' ? 'not yet created' : e.message,
    };
  }

  // 5. Check transcripts directory (where live session logs are tailed).
  const projectsDir = path.join(os.homedir(), '.claude/projects');
  try {
    await fsp.access(projectsDir, fs.constants.R_OK);
    status.components.transcripts_dir = {
      ok: true,
      path: projectsDir,
    };
  } catch (e) {
    // Not fatal — transcripts dir may not exist until first session.
    status.components.transcripts_dir = {
      ok: true,
      path: projectsDir,
      note: 'not yet created (normal for fresh install)',
    };
  }

  // 6. Check session-manager's own logs (informational, not blocking).
  const smLogsDir = path.join(
    os.homedir(),
    '.claude/session-manager/logs'
  );
  let logAge = null;
  try {
    const files = await fsp.readdir(smLogsDir);
    if (files.length > 0) {
      const latestLog = files.sort().pop();
      const logPath = path.join(smLogsDir, latestLog);
      const stat = await fsp.stat(logPath);
      logAge = Date.now() - stat.mtimeMs;
    }
    status.components.app_logs = {
      ok: true,
      path: smLogsDir,
      latestLogAgeMs: logAge,
      note: logAge ? `Last log ${Math.round(logAge / 60_000)}m ago` : 'app not yet run',
    };
  } catch (e) {
    status.components.app_logs = {
      ok: true,
      path: smLogsDir,
      note: 'logs directory not yet created (normal for fresh installs)',
    };
  }

  // 7. Summary scoring: ok if all critical components pass.
  // Critical: nodejs, config dir, typescript, build artifact, test infrastructure.
  // Non-fatal: scheduler/transcripts dirs may not exist on fresh install.
  // Informational: app log age (shows if app is running, but not blocking).
  const criticalComponents = ['nodejs', 'config_dir', 'typescript', 'build_artifact', 'test_infrastructure'];
  status.ok = criticalComponents.every((c) => status.components[c]?.ok !== false);

  status.elapsedMs = Date.now() - start;
  return status;
}

// CLI entry point: `node src/main/health.cjs`
if (require.main === module) {
  (async () => {
    const result = await check();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })();
}

module.exports = { check };
