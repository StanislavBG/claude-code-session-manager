/**
 * guard-destructive-git-policy.cjs — decision logic for
 * scripts/hooks/guard-destructive-git.cjs, split out so it can be
 * `require()`d in-process (by tests, notably) with no CLI-level side effects.
 *
 * guard-destructive-git.cjs itself runs its CLI as a require-time side
 * effect (stdin -> decision -> process.exit, not gated on
 * `require.main === module` — see src/main/lib/guardShims.cjs's header for
 * why: the installed shim invokes the real script via a plain `require()`,
 * so gating on `require.main` would silently stop the shim from ever running
 * the guard). Requiring THIS module never reads stdin or calls
 * `process.exit`, so it's safe to load from a test process — but `decide()`
 * is not fully I/O-free: for a destructive verdict outside a
 * path-recognized managed worktree, it shells out to a real `git
 * rev-parse` (see `isInsideManagedWorktreeByBranch` below) before returning.
 * Most `expectDenied(...)` cases in the test file hit this, so most test
 * runs still spawn a `git` child process per denied case — fewer spawns
 * than the old ~50-CLI-process-per-run shape, not zero.
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// Duplicated from src/main/lib/gitWorktree.cjs's KIND_CONFIG — see
// guard-destructive-git.cjs's header for why this is a deliberate
// duplication, not a require. Same SM_WORKTREE_ROOT-else-tmpdir base as
// schedulerPaths.worktreeBase().
const WORKTREE_BASE = process.env.SM_WORKTREE_ROOT || os.tmpdir();
const WORKTREE_ROOTS = ['job', 'epic'].map((k) => path.join(WORKTREE_BASE, `session-manager-${k}-worktrees`));
const BRANCH_PREFIXES = ['sm-job/', 'sm-epic/'];

const MAX_SH_C_DEPTH = 5;

/** Quote-aware split on top-level `&&`, `||`, `;`, `|`, and newlines. */
function splitTopLevel(cmd) {
  const parts = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (inSingle) {
      cur += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '"' && cmd[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; cur += c; continue; }
    if (c === '"') { inDouble = true; cur += c; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') { parts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return { parts: parts.map((s) => s.trim()).filter(Boolean), unterminatedQuote: inSingle || inDouble };
}

/** Quote-aware whitespace tokenizer. Returns null on an unterminated quote. */
function tokenize(str) {
  const tokens = [];
  let cur = '';
  let started = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inSingle) {
      if (c === "'") inSingle = false; else cur += c;
      started = true;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false; else cur += c;
      started = true;
      continue;
    }
    if (c === "'") { inSingle = true; started = true; continue; }
    if (c === '"') { inDouble = true; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { tokens.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) tokens.push(cur);
  if (inSingle || inDouble) return null;
  return tokens;
}

function isFlagWithChar(rest, longForms, shortChar) {
  for (const t of rest) {
    if (longForms.includes(t)) return true;
    if (shortChar && t.startsWith('-') && !t.startsWith('--') && t.includes(shortChar)) return true;
  }
  return false;
}

/** Skip git's global options (`-C <dir>`, `-c <k>=<v>`, `--git-dir=...`, ...) to find the subcommand. */
function subcommandOf(args) {
  const OPTS_WITH_SEPARATE_ARG = new Set(['-C', '-c', '--namespace', '--super-prefix']);
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (OPTS_WITH_SEPARATE_ARG.has(t)) { i += 2; continue; }
    if (t.startsWith('-')) { i += 1; continue; }
    return { subcommand: t, rest: args.slice(i + 1) };
  }
  return null;
}

/** Extract an explicit `git -C <dir>` argument (or `git -C=<dir>`), if present, from the tokens AFTER `git`. */
function gitDashCDirOf(args) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '-C' && args[i + 1] != null) return args[i + 1];
    if (t.startsWith('-C') && t.length > 2) return t.slice(2);
    if (!t.startsWith('-')) break; // reached the subcommand — no more global opts
  }
  return null;
}

/**
 * Text-level check for whether an UNPARSABLE segment mentions a verb this
 * guard actually polices. Used only to narrow the unparsable-command fallback
 * — an unparsable command that mentions none of these is allowed through
 * rather than blanket-blocked, since blocking every command merely containing
 * the substring "git" (e.g. a heredoc `git commit -m "$(cat <<'EOF' ...)"`)
 * was itself a false-positive incident.
 */
function mentionsPolicedDestructiveToken(text) {
  if (/\b(stash|reset|checkout|restore|clean)\b/.test(text)) return true;
  if (/\badd\s+(-A\b|--all\b|\.(?:\s|$))/.test(text)) return true;
  if (/\bcommit\b.*(-a\b|--all\b)/.test(text)) return true;
  return false;
}

/**
 * Evaluate one `git <...>` invocation (args = tokens AFTER `git`). Returns
 * `{ verb, alt }` when destructive, or null when this invocation is fine
 * (read-only, or a form this guard doesn't restrict).
 */
function evaluateGit(args) {
  const parsed = subcommandOf(args);
  if (!parsed) return null;
  const { subcommand, rest } = parsed;

  switch (subcommand) {
    case 'stash': {
      const sub = rest.find((a) => !a.startsWith('-'));
      if (sub === 'list' || sub === 'show') return null;
      return {
        verb: 'git stash',
        alt: 'do not stash on a shared tree — a stash you never restore silently strands someone else\'s work; commit or discard only paths you created, or stop and report',
      };
    }
    case 'reset': {
      const hasHard = rest.includes('--hard');
      const positional = rest.filter((a) => !a.startsWith('-'));
      if (hasHard) {
        return {
          verb: 'git reset --hard',
          alt: 'never hard-reset a shared tree — this discards a sibling job\'s or the human\'s uncommitted work outright; undo only your own change with `git checkout -- <your-path>` inside your own sm-job/ or sm-epic/ worktree, or stop and report',
        };
      }
      if (positional.length > 0) {
        return {
          verb: 'git reset <path>',
          alt: 'do not `git reset` a path on a shared tree — that can unstage a sibling job\'s or the human\'s in-progress staging, not just your own',
        };
      }
      return null;
    }
    case 'checkout': {
      const dashIdx = rest.indexOf('--');
      if (dashIdx !== -1 && rest.slice(dashIdx + 1).length > 0) {
        return {
          verb: 'git checkout -- <path>',
          alt: 'never discard tracked-file edits on a shared tree with `checkout --` — that can erase a sibling job\'s or the human\'s uncommitted work; scope changes to files you created, or stop and report',
        };
      }
      // `.` is never a valid branch/commit name, so `git checkout .` (no
      // `--` at all) is unambiguously the pathspec form — and, like
      // `checkout -- .`, discards every dirty tracked file in the tree. Git
      // accepts this bare form; requiring `--` before flagging it let this
      // exact incident shape (real precedent: `starry-night-ships`, see
      // guard-destructive-git.cjs's header) walk straight past the guard.
      const positional = rest.filter((a) => a !== '--' && !a.startsWith('-'));
      if (positional.includes('.')) {
        return {
          verb: 'git checkout .',
          alt: 'never discard tracked-file edits on a shared tree with `checkout .` — that can erase a sibling job\'s or the human\'s uncommitted work; scope changes to files you created, or stop and report',
        };
      }
      return null;
    }
    case 'restore': {
      if (rest.includes('-n') || rest.includes('--dry-run')) return null;
      const positional = rest.filter((a) => !a.startsWith('-'));
      if (positional.length > 0) {
        return {
          verb: 'git restore',
          alt: 'never `git restore` tracked paths on a shared tree — that discards whatever is currently dirty there, which may not be yours',
        };
      }
      return null;
    }
    case 'clean': {
      if (isFlagWithChar(rest, ['--dry-run'], 'n')) return null;
      const hasF = isFlagWithChar(rest, ['--force'], 'f');
      const hasD = isFlagWithChar(rest, [], 'd');
      const hasX = isFlagWithChar(rest, [], 'x');
      if (hasF || hasD || hasX) {
        return {
          verb: 'git clean -f/-d/-x',
          alt: 'never force-clean a shared tree — that deletes files git doesn\'t track, which may be a sibling job\'s scratch output or the human\'s untracked WIP',
        };
      }
      return null;
    }
    case 'add': {
      const hasBlanket = rest.some((a) => a === '-A' || a === '--all' || a === '.');
      if (hasBlanket) {
        return {
          verb: 'git add -A/./--all',
          alt: 'stage only the exact paths you created or modified — `git add <path> [<path>...]` — a blanket add on a shared tree captures a sibling job\'s or the human\'s in-progress edits and mis-attributes them to your commit',
        };
      }
      return null;
    }
    case 'commit': {
      const hasAll = isFlagWithChar(rest, ['--all'], 'a');
      if (hasAll) {
        return {
          verb: 'git commit -a',
          alt: 'commit only the paths you explicitly `git add`ed — `git commit -a`/`--all` on a shared tree sweeps up whatever a sibling job or the human currently has dirty',
        };
      }
      return null;
    }
    default:
      return null;
  }
}

const SH_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash']);

/**
 * Returns the first destructive verdict found anywhere in `command`, or null.
 * `baseCwd` is the shell's starting cwd; a `cd <dir>` segment updates the
 * EFFECTIVE cwd for every subsequent segment in the same top-level command
 * (segments share one shell), and an explicit `git -C <dir>` overrides it for
 * that one invocation only. The returned verdict carries the effective cwd at
 * the point the destructive call was found, so the caller checks exemption
 * against where the command actually runs, not just `payload.cwd`.
 */
function findDestructiveVerdict(command, baseCwd, depth = 0) {
  if (depth > MAX_SH_C_DEPTH) return null;
  const { parts, unterminatedQuote } = splitTopLevel(command);
  if (unterminatedQuote) {
    if (mentionsPolicedDestructiveToken(command)) {
      return { verb: 'an unparsable command mentioning git', alt: 'this hook could not confidently parse this command\'s quoting to confirm it is safe — split it into a plain, simply-quoted git invocation, or stop and report', cwd: baseCwd };
    }
    return null;
  }

  let effectiveCwd = baseCwd;

  for (const segment of parts) {
    const tokens = tokenize(segment);
    if (tokens === null) {
      if (mentionsPolicedDestructiveToken(segment)) {
        return { verb: 'an unparsable command mentioning git', alt: 'this hook could not confidently parse this command\'s quoting to confirm it is safe — split it into a plain, simply-quoted git invocation, or stop and report', cwd: effectiveCwd };
      }
      continue;
    }
    if (tokens.length === 0) continue;

    // Strip leading env assignments (FOO=bar git ...).
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const cmdTokens = tokens.slice(i);
    if (cmdTokens.length === 0) continue;

    const head = path.basename(cmdTokens[0]);

    if (head === 'cd' && cmdTokens[1] != null) {
      const target = cmdTokens[1];
      effectiveCwd = path.isAbsolute(target) ? target : path.resolve(effectiveCwd || process.cwd(), target);
      continue;
    }

    if (SH_WRAPPERS.has(head)) {
      const cIdx = cmdTokens.indexOf('-c');
      if (cIdx !== -1 && cmdTokens[cIdx + 1] != null) {
        const nested = findDestructiveVerdict(cmdTokens[cIdx + 1], effectiveCwd, depth + 1);
        if (nested) return nested;
      }
      continue;
    }

    if (head === 'git') {
      const gitArgs = cmdTokens.slice(1);
      const verdict = evaluateGit(gitArgs);
      if (verdict) {
        const dashC = gitDashCDirOf(gitArgs);
        const invocationCwd = dashC
          ? (path.isAbsolute(dashC) ? dashC : path.resolve(effectiveCwd || process.cwd(), dashC))
          : effectiveCwd;
        return { ...verdict, cwd: invocationCwd };
      }
    }
  }
  return null;
}

function isInsideManagedWorktreeByPath(cwd) {
  if (!cwd) return false;
  const resolved = path.resolve(cwd);
  return WORKTREE_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

function isInsideManagedWorktreeByBranch(cwd) {
  if (!cwd) return false;
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 3_000,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return BRANCH_PREFIXES.some((p) => branch.startsWith(p));
  } catch {
    return false;
  }
}

function isExemptSharedTree(cwd) {
  return isInsideManagedWorktreeByPath(cwd) || isInsideManagedWorktreeByBranch(cwd);
}

function buildAllow() {
  return { continue: true };
}

function buildDeny(reason) {
  return {
    continue: true,
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Decision function: PreToolUse payload in, hook-response object out. No
 * stdin/stdout and no `process.exit` — safe to call in-process (e.g. from
 * tests) — but for a destructive verdict outside a path-recognized managed
 * worktree it does shell out to `git rev-parse` (see
 * `isInsideManagedWorktreeByBranch`); it is not I/O-free in that case.
 */
function decide(payload) {
  try {
    if (payload.tool_name !== 'Bash') return buildAllow();

    const command = payload?.tool_input?.command;
    if (!command || typeof command !== 'string') return buildAllow();

    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const verdict = findDestructiveVerdict(command, cwd);
    if (!verdict) return buildAllow();

    const effectiveCwd = verdict.cwd || cwd;
    if (isExemptSharedTree(effectiveCwd)) return buildAllow();

    const reason = [
      `Blocked: \`${verdict.verb}\` in what this hook believes is a SHARED working tree (${effectiveCwd}).`,
      verdict.alt,
      'You are normally inside your own sm-job/<slug> or sm-epic/<epicId> worktree for this kind of operation — run `git rev-parse --git-common-dir` to check; this guard permits the same command there.',
    ].join(' ');
    return buildDeny(reason);
  } catch (e) {
    console.error(`[guard-destructive-git] internal error, failing open: ${e?.message}`);
    return buildAllow();
  }
}

/** Mirrors the CLI's stdin-JSON handling so it can be exercised without a spawn. */
function parsePayload(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`[guard-destructive-git] malformed stdin JSON, failing open: ${e?.message}`);
    return {};
  }
}

module.exports = { decide, parsePayload };
