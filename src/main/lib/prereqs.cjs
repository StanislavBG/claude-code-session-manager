/**
 * prereqs.cjs — first-run prerequisite checklist (git, Claude Code CLI,
 * Claude sign-in, and Git Bash on Windows). Each missing item carries the
 * OFFICIAL one-line install command so a UI can offer one-click installs.
 * Detection only — never runs an installer. Probes are injectable
 * (opts.execFile / hasCredentials / exists) so tests spawn nothing.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const childProcess = require('node:child_process');
const { pathWithUserBins } = require('./cleanEnv.cjs');
const { resolveClaudeBin } = require('./claudeBin.cjs');
const { readCredentials } = require('./credentials.cjs');

const PROBE_TIMEOUT_MS = 5000;
const GIT_URL = 'https://git-scm.com/downloads';
const CLAUDE_SETUP_URL = 'https://docs.claude.com/en/docs/claude-code/setup';
const WINGET_GIT = 'winget install --id Git.Git -e --source winget';

const execFileP = promisify(childProcess.execFile);

/** Default probe: no shell, 5 s timeout, PATH widened with the user bin dirs. */
function defaultExecFile(cmd, args) {
  return execFileP(cmd, args, {
    env: { ...process.env, PATH: pathWithUserBins() },
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
}

async function defaultHasCredentials() {
  const r = await readCredentials();
  return r.kind === 'ok';
}

function errText(e) {
  const msg = (e && (e.message || e.code)) || String(e);
  return String(msg).split('\n')[0].slice(0, 200);
}

/** Run a probe; resolves {ok, out} and never rejects (timeout/ENOENT → ok:false). */
async function probe(execFile, cmd, args) {
  try {
    const r = await execFile(cmd, args);
    const out = typeof r === 'string' ? r : (r && r.stdout) || '';
    return { ok: true, out: String(out).trim(), error: null };
  } catch (e) {
    return { ok: false, out: '', error: errText(e) };
  }
}

function item(id, label, ok, version, detail, fix) {
  return { id, label, ok, version: ok ? version : null, detail: ok ? null : detail, fix: ok ? null : fix };
}

function gitFix(platform) {
  if (platform === 'darwin') return { command: 'xcode-select --install', shell: 'sh', url: GIT_URL };
  if (platform === 'win32') return { command: WINGET_GIT, shell: 'powershell', url: GIT_URL };
  // linux: distro-specific — point at the package-manager docs instead of a command.
  return { command: '', shell: 'sh', url: GIT_URL };
}

async function checkGit(platform, execFile) {
  const ver = await probe(execFile, 'git', ['--version']);
  let ok = ver.ok;
  let detail = ver.error;
  if (ok && platform === 'darwin') {
    // /usr/bin/git on macOS is a stub that prompts for the Command Line Tools.
    const xc = await probe(execFile, 'xcode-select', ['-p']);
    if (!xc.ok) {
      const which = await probe(execFile, 'which', ['git']);
      if (!which.ok || which.out === '/usr/bin/git' || !which.out) {
        ok = false;
        detail = 'Xcode Command Line Tools are not installed';
      }
    }
  }
  const version = ver.out.replace(/^git version\s+/, '').split(/\s/)[0] || null;
  const fix = gitFix(platform);
  const missing = platform === 'linux'
    ? `${detail || 'git not found'} — install it with your distro's package manager`
    : (detail || 'git not found');
  return item('git', 'Git', ok, version, missing, fix);
}

async function checkClaudeCli(platform, execFile, claudeBin) {
  const bin = claudeBin || resolveClaudeBin();
  const r = await probe(execFile, bin, ['--version']);
  const win = platform === 'win32';
  return item('claude-cli', 'Claude Code CLI', r.ok, r.out.split('\n')[0] || null,
    r.error || 'claude not found', {
      command: win ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
      shell: win ? 'powershell' : 'sh',
      url: CLAUDE_SETUP_URL,
    });
}

async function checkClaudeAuth(platform, hasCredentials) {
  let ok = false;
  try { ok = !!(await hasCredentials()); } catch { ok = false; }
  return item('claude-auth', 'Claude account', ok, null,
    'Not signed in — run `claude` and sign in to your Claude account', {
      command: 'claude',
      shell: platform === 'win32' ? 'powershell' : 'sh',
      url: CLAUDE_SETUP_URL,
    });
}

function checkGitBash(exists) {
  const candidates = [];
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  candidates.push(path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'));
  let found = null;
  for (const c of candidates) {
    try { if (exists(c)) { found = c; break; } } catch { /* treat as absent */ }
  }
  return item('git-bash', 'Git Bash', !!found, found,
    'Claude Code on Windows needs Git for Windows (bash.exe)',
    { command: WINGET_GIT, shell: 'powershell', url: GIT_URL });
}

/**
 * @param {{platform?: string, execFile?: Function, hasCredentials?: Function,
 *          claudeBin?: string, exists?: (p: string) => boolean}} [opts]
 * @returns {Promise<Array<{id:string,label:string,ok:boolean,version:string|null,detail:string|null,
 *          fix:{command:string,shell:'sh'|'powershell',url?:string}|null}>>}
 */
async function checkPrereqs(opts = {}) {
  const {
    platform = process.platform,
    execFile = defaultExecFile,
    hasCredentials = defaultHasCredentials,
    claudeBin,
    exists = fs.existsSync,
  } = opts;
  const jobs = [checkGit(platform, execFile)];
  if (platform === 'win32') jobs.push(Promise.resolve(checkGitBash(exists)));
  jobs.push(checkClaudeCli(platform, execFile, claudeBin), checkClaudeAuth(platform, hasCredentials));
  return Promise.all(jobs);
}

module.exports = { checkPrereqs };
