/**
 * replyClaims.cjs — the single decider for whether a cross-project reply's
 * release claim is true.
 *
 * Used by crossProjectReply.cjs (the app route) and
 * scripts/scheduler-mcp-server.cjs (the MCP server), so it must load outside
 * Electron: requires only node built-ins, ../util/atomicFs.cjs and
 * ../git/gitExec.cjs.
 *
 * - findUnfilledPlaceholders: version-ish template tokens left in a message
 *   ('{version}', '{{appVersion}}', '${release}', '<semver>', ...).
 * - findSessionManagerVersions: the x.y.z a message names as a Session
 *   Manager release ('Session Manager 0.143.0', 'SM v0.143.0').
 * - normalizeReleaseClaim: validates a caller's `{ commits }` claim.
 * - isSessionManagerRepo / checkReleaseContains: verify with git that tag
 *   v<version> contains every claimed commit. Never throws.
 */
'use strict';

const path = require('node:path');
const { readJsonOrSync } = require('../util/atomicFs.cjs');

const SM_PACKAGE_NAME = 'claude-code-session-manager';
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const MAX_COMMITS = 20;

/** True only for a string of 7-40 hex chars (either case) — the one commit-hash rule. */
function isCommitHash(v) {
  return typeof v === 'string' && COMMIT_RE.test(v);
}

const PLACEHOLDER_NAMES = [
  'version', 'appversion', 'app_version', 'app-version', 'release',
  'releaseversion', 'release_version', 'smversion', 'sm_version', 'semver',
];
// Longest first so alternation never stops at a prefix ('release' vs 'release_version').
const NAME_ALT = PLACEHOLDER_NAMES.slice()
  .sort((a, b) => b.length - a.length)
  .map((n) => n.replace(/[-_]/g, (c) => `\\${c}`))
  .join('|');
const INNER = `[ \\t]*(?:${NAME_ALT})[ \\t]*`;
// Two-char openers before one-char ones so '{{x}}' / '${x}' match whole.
const PLACEHOLDER_SRC = [
  `\\{\\{${INNER}\\}\\}`,
  `\\$\\{${INNER}\\}`,
  `\\{${INNER}\\}`,
  `<${INNER}>`,
  `\\[${INNER}\\]`,
  `%${INNER}%`,
].join('|');

function findUnfilledPlaceholders(message, opts = {}) {
  if (typeof message !== 'string') return [];
  const allowVersionToken = !!(opts && opts.allowVersionToken);
  const re = new RegExp(PLACEHOLDER_SRC, 'gi');
  const out = [];
  for (const m of message.matchAll(re)) {
    const tok = m[0];
    if (allowVersionToken && tok === '{version}') continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

const SM_VERSION_SRC = '\\b(?:[Ss][Ee][Ss][Ss][Ii][Oo][Nn] [Mm][Aa][Nn][Aa][Gg][Ee][Rr]|SM)'
  + '(?:\\s+(?:release|version|app))?\\s+v?(\\d+\\.\\d+\\.\\d+)\\b';

function findSessionManagerVersions(message) {
  if (typeof message !== 'string') return [];
  const out = [];
  for (const m of message.matchAll(new RegExp(SM_VERSION_SRC, 'g'))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function normalizeReleaseClaim(raw) {
  const fail = (error) => ({ ok: false, error });
  if (!isPlainObject(raw)) return fail('release must be an object { commits: [...] }');
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'commits') {
    return fail('release must have exactly one key, commits');
  }
  const { commits } = raw;
  if (!Array.isArray(commits) || commits.length < 1 || commits.length > MAX_COMMITS) {
    return fail(`release.commits must be an array of 1-${MAX_COMMITS} commit hashes`);
  }
  const out = [];
  for (const c of commits) {
    if (!isCommitHash(c)) {
      return fail(`release.commits has an invalid commit hash: ${JSON.stringify(c)}`);
    }
    const lc = c.toLowerCase();
    if (!out.includes(lc)) out.push(lc);
  }
  return { ok: true, value: { commits: out } };
}

function isSessionManagerRepo(cwd) {
  if (typeof cwd !== 'string' || !cwd) return false;
  let pkg;
  try {
    pkg = readJsonOrSync(path.join(cwd, 'package.json'), null);
  } catch {
    return false;
  }
  return !!pkg && typeof pkg === 'object' && !Array.isArray(pkg) && pkg.name === SM_PACKAGE_NAME;
}

function defaultRunGit(cwd, args) {
  const { execGit } = require('../git/gitExec.cjs');
  return execGit(cwd, args, { timeout: 15000 });
}

async function checkReleaseContains(input, opts = {}) {
  try {
    const { repoCwd, version, commits } = input || {};
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      return { ok: false, error: `release version ${JSON.stringify(version)} is not x.y.z` };
    }
    if (typeof repoCwd !== 'string' || !repoCwd) {
      return { ok: false, error: 'no repository to check the release against' };
    }
    const claim = normalizeReleaseClaim({ commits });
    if (!claim.ok) return { ok: false, error: claim.error };
    const runGit = (opts && typeof opts.runGit === 'function') ? opts.runGit : defaultRunGit;
    const tag = `v${version}`;
    const git = async (args) => { await runGit(repoCwd, args); };

    try {
      await git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]);
    } catch {
      return { ok: false, error: `release tag ${tag} does not exist` };
    }
    for (const c of claim.value.commits) {
      try {
        await git(['rev-parse', '-q', '--verify', `${c}^{commit}`]);
      } catch {
        return { ok: false, error: `commit ${c} is not known to this repository` };
      }
      try {
        await git(['merge-base', '--is-ancestor', c, tag]);
      } catch {
        return { ok: false, error: `release tag ${tag} does not contain commit ${c}` };
      }
    }
    return { ok: true, tag };
  } catch (err) {
    return { ok: false, error: `release check failed: ${err && err.message ? err.message : String(err)}` };
  }
}

module.exports = {
  findUnfilledPlaceholders,
  findSessionManagerVersions,
  normalizeReleaseClaim,
  isSessionManagerRepo,
  checkReleaseContains,
  isCommitHash,
  MAX_COMMITS,
};
