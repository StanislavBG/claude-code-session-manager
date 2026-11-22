#!/usr/bin/env node
'use strict';
/**
 * publish-preflight.cjs — dependency-free check, run BEFORE any version bump or tag, that a
 * release can actually reach npm. `npm whoami` alone is not enough: it passes for a token that
 * cannot publish (e.g. 'Bypass two-factor authentication' off → every `npm publish` gets E403).
 *
 *   node publish-preflight.cjs [--cwd <dir>]      (default: process.cwd())
 *
 * Prints exactly one line to stdout:
 *   NPM_PUBLISH_PREFLIGHT: OK — <detail>[; WARN: <warn>]          exit 0
 *   NPM_PUBLISH_PREFLIGHT: BLOCKED — <detail naming the credential> exit 1
 *
 * Mode: `ci` when <cwd>/.github/workflows/release.yml has a top-level `npm-publish:` job, else
 * `local`. CI mode blocks only when the newest completed v*-tag run's npm-publish job failed AND
 * the local check blocks.
 *
 * The npm auth token is read only to compare it against the redacted `token` field of
 * `npm token list --json`; it is never printed, logged or returned.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PREFIX = 'NPM_PUBLISH_PREFLIGHT:';
const TIMEOUT_MS = 30000;
const WARN_DAYS = 14;
const DAY_MS = 86400000;
const MAX_LINE = 400;

function defaultRun(cmd, args, { timeoutMs, cwd }) {
  const r = spawnSync(cmd, args, { cwd, timeout: timeoutMs, encoding: 'utf8', shell: false });
  return {
    status: r.error ? null : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? String(r.error.message) : ''),
  };
}

function defaultReadFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || 'no output';
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ');

function formatLine(ok, detail, warn) {
  let line = `${PREFIX} ${ok ? 'OK' : 'BLOCKED'} — ${clean(detail)}`;
  if (ok && warn) line += `; WARN: ${clean(warn)}`;
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function packageName(cwd, readFile) {
  const bt = parseJson(readFile(path.join(cwd, 'session-manager-operations', 'architecture', 'build-target.json')) || '');
  if (bt && typeof bt.packageName === 'string' && bt.packageName) return bt.packageName;
  const pj = parseJson(readFile(path.join(cwd, 'package.json')) || '');
  if (pj && typeof pj.name === 'string' && pj.name) return pj.name;
  return null;
}

function detectMode(cwd, readFile) {
  const yml = readFile(path.join(cwd, '.github', 'workflows', 'release.yml'));
  return yml && /^ {2}npm-publish:\s*$/m.test(yml) ? 'ci' : 'local';
}

/** The `_authToken` value in the npm userconfig for the registry's host, or null. */
function readInUseToken(ctx, registry) {
  const uc = ctx.exec('npm', ['config', 'get', 'userconfig']);
  if (uc.status !== 0) return null;
  const file = ctx.readFile(firstLine(uc.stdout));
  if (!file) return null;
  let host;
  try {
    host = new URL(registry).host;
  } catch {
    return null;
  }
  for (const raw of file.split(/\r?\n/)) {
    const m = /^\s*(\/\/[^:\s]+\/?):_authToken\s*=\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const keyHost = m[1].slice(2).split('/')[0];
    if (keyHost !== host) continue;
    const value = m[2].replace(/^["']|["']$/g, '').replace(/\$\{([^}]+)\}/g, (_, v) => ctx.env[v] || '');
    return value || null;
  }
  return null;
}

function pickEntry(entries, inUse) {
  if (inUse) {
    const hits = entries.filter((e) => {
      if (!e || typeof e.token !== 'string') return false;
      const parts = e.token.split('...');
      if (parts.length !== 2) return false;
      return inUse.startsWith(parts[0]) && inUse.endsWith(parts[1]);
    });
    if (hits.length === 1) return hits[0];
    return null;
  }
  const live = entries.filter((e) => e && !e.revoked);
  return live.length === 1 ? live[0] : null;
}

function scopeCovers(entry, pkg) {
  const pkgScopes = (Array.isArray(entry.scopes) ? entry.scopes : []).filter((s) => s && s.type === 'package');
  if (pkgScopes.length === 0) return true;
  const atScope = pkg.startsWith('@') ? pkg.split('/')[0] : null;
  return pkgScopes.some((s) => s.name == null || s.name === pkg || (atScope && s.name === atScope));
}

function checkLocal(ctx, pkg) {
  const reg = ctx.registry;
  const who = ctx.exec('npm', ['whoami', '--registry', reg]);
  if (who.status !== 0) {
    return { ok: false, detail: `npm whoami failed (${firstLine(who.stderr)}): no working npm login on this machine` };
  }
  const user = firstLine(who.stdout);

  let entry = null;
  let warn = null;
  const list = ctx.exec('npm', ['token', 'list', '--json', '--registry', reg]);
  const entries = list.status === 0 ? parseJson(list.stdout) : undefined;
  if (!Array.isArray(entries)) {
    const why = list.status !== 0 ? firstLine(list.stderr || list.stdout) : firstLine(list.stdout);
    warn = `token metadata unreadable (${why}); bypass-2FA not verified`;
  } else {
    entry = pickEntry(entries, readInUseToken(ctx, reg));
    if (!entry) warn = 'could not tell which npm token is in use; bypass-2FA not verified';
  }

  let expiryMs = NaN;
  if (entry) {
    const name = entry.name || entry.key || 'unnamed';
    expiryMs = entry.expiry ? Date.parse(entry.expiry) : NaN;
    if (entry.revoked) return { ok: false, detail: `npm token '${name}' is revoked` };
    if (Number.isFinite(expiryMs) && expiryMs < ctx.now()) {
      return { ok: false, detail: `npm token '${name}' expired on ${day(expiryMs)}` };
    }
    if (entry.bypass_2fa !== true) {
      return {
        ok: false,
        detail: `npm token '${name}' has 'Bypass two-factor authentication' off, so npm publish fails E403; regenerate it on npmjs.com with that box ticked`,
      };
    }
    if (!scopeCovers(entry, pkg)) return { ok: false, detail: `npm token '${name}' cannot write ${pkg}` };
  }

  const owners = ctx.exec('npm', ['owner', 'ls', pkg, '--registry', reg]);
  if (owners.status === 0) {
    const names = owners.stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
    if (!names.includes(user)) return { ok: false, detail: `npm user ${user} is not a maintainer of ${pkg}` };
  }

  if (!entry) return { ok: true, detail: `local npm login as ${user} can reach ${pkg}`, warn };
  const name = entry.name || entry.key || 'unnamed';
  if (Number.isFinite(expiryMs)) {
    const days = Math.ceil((expiryMs - ctx.now()) / DAY_MS);
    if (days <= WARN_DAYS) warn = `token '${name}' expires ${day(expiryMs)} (${days} days); renew it before then`;
  }
  return { ok: true, detail: `local npm token '${name}' can publish ${pkg} as ${user}`, warn };
}

/** → { state: 'ok'|'dead'|'unknown', tag?, runId? } */
function checkCi(ctx) {
  const list = ctx.exec('gh', ['run', 'list', '--workflow', 'release.yml', '--limit', '20', '--json', 'databaseId,headBranch,status,conclusion']);
  if (list.status !== 0) return { state: 'unknown' };
  const runs = parseJson(list.stdout);
  if (!Array.isArray(runs)) return { state: 'unknown' };
  const run = runs.find((r) => r && r.status === 'completed' && /^v\d/.test(String(r.headBranch || '')));
  if (!run) return { state: 'unknown' };
  const view = ctx.exec('gh', ['run', 'view', String(run.databaseId), '--json', 'jobs']);
  if (view.status !== 0) return { state: 'unknown' };
  const data = parseJson(view.stdout);
  const job = data && Array.isArray(data.jobs) ? data.jobs.find((j) => j && j.name === 'npm-publish') : null;
  if (!job) return { state: 'unknown' };
  const base = { tag: run.headBranch, runId: run.databaseId };
  if (job.conclusion === 'success' || job.conclusion === 'skipped') return { state: 'ok', ...base };
  if (job.conclusion === 'failure') return { state: 'dead', ...base };
  return { state: 'unknown' };
}

async function preflight(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const run = opts.run || defaultRun;
  const readFile = opts.readFile || defaultReadFile;
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const ctx = {
    readFile,
    env,
    now,
    exec: (cmd, args) => run(cmd, args, { timeoutMs: TIMEOUT_MS, cwd }),
  };
  const done = (ok, detail, warn) => ({ ok, line: formatLine(ok, detail, warn) });

  const pkg = packageName(cwd, readFile);
  if (!pkg) return done(false, 'no package name in build-target.json or package.json');

  const regOut = ctx.exec('npm', ['config', 'get', 'registry']);
  const regLine = regOut.status === 0 ? firstLine(regOut.stdout) : '';
  ctx.registry = /^https?:\/\//.test(regLine) ? regLine : 'https://registry.npmjs.org/';

  if (detectMode(cwd, readFile) === 'local') {
    const local = checkLocal(ctx, pkg);
    return done(local.ok, local.detail, local.warn);
  }

  const ci = checkCi(ctx);
  if (ci.state === 'ok') return done(true, `CI npm-publish succeeded on ${ci.tag} (run ${ci.runId})`);
  const local = checkLocal(ctx, pkg);
  const ciState = ci.state === 'dead'
    ? `CI npm-publish failed on ${ci.tag} (run ${ci.runId})`
    : 'CI npm-publish has no earlier tag run to judge';
  if (local.ok) return done(true, `${ciState}; local publish ready: ${local.detail}`, local.warn);
  if (ci.state === 'dead') return done(false, `${ciState} and ${local.detail}`);
  return done(true, `${ciState}; local check: ${local.detail}`);
}

function parseArgs(argv) {
  const out = { cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd' && argv[i + 1]) out.cwd = path.resolve(argv[++i]);
  }
  return out;
}

async function main() {
  const { cwd } = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = await preflight({ cwd });
  } catch (e) {
    result = { ok: false, line: formatLine(false, `preflight crashed (${firstLine(e && e.message)})`) };
  }
  process.stdout.write(result.line + '\n');
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = { preflight };
