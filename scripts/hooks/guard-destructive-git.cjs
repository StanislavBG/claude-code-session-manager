#!/usr/bin/env node
/**
 * guard-destructive-git.cjs — PreToolUse hook that denies a `Bash` tool call
 * whose command would run a destructive git operation (stash/reset --hard/
 * checkout --/restore/clean -f|-d|-x/add -A|./--all/commit -a) against a
 * SHARED working tree.
 *
 * Why this exists: standards.md tells an executor never to stash/reset/clean
 * a tree it shares with other in-flight jobs or a human's own WIP, but prose
 * is something a model under pressure can fail to weigh. Two real incidents
 * on 2026-09-01 happened with that rule already written down: live trading
 * config stashed and never restored (social-signals-trader), and ~1,400 lines
 * across four PRDs stashed plus three files deleted from disk (starry-night-
 * ships). A PreToolUse hook is the one lever that sits OUTSIDE the model and
 * can refuse the call before it ever reaches git — see guard-prd-writes.cjs's
 * header for the fuller argument for why a hook, not a rule, is the fix.
 *
 * ── Scope: shared trees only ─────────────────────────────────────────────
 * A scheduler job or Epic running inside its OWN linked worktree
 * (`sm-job/<slug>` / `sm-epic/<epicId>`, minted by src/main/lib/gitWorktree.cjs)
 * owns that checkout exclusively — destroying it harms nobody, so every one
 * of the operations above is permitted there. This hook only denies when the
 * command's cwd is the shared base tree (or any other tree not recognized as
 * one of ours). Detection intentionally duplicates just gitWorktree.cjs's two
 * branch-prefix constants and its worktree-root path shape (see
 * WORKTREE_ROOTS/BRANCH_PREFIXES below) rather than requiring that module —
 * this script runs standalone, outside the app's process, and must not pull
 * the whole main-process require graph into a hook invoked on every Bash call.
 * src/main/lib/gitWorktree.cjs stays the source of truth for those constants;
 * if it ever renames the prefixes or root folder names, update them here too.
 *
 * ── Fail-closed on ambiguous parsing ─────────────────────────────────────
 * Command strings can hide a destructive git call inside `sh -c '...'`,
 * chained with `&&`/`;`/`|`/newlines, or preceded by env assignments / `git -C
 * <dir>`. This hook parses those shapes explicitly. When a segment cannot be
 * confidently tokenized (e.g. an unterminated quote) AND it textually mentions
 * `git`, the DEFAULT is to DENY, not allow — the inverse of guard-prd-writes.cjs's
 * fail-OPEN contract. That asymmetry is deliberate: guard-prd-writes guards a
 * narrow, low-consequence path (a hand-written PRD file) where a false deny
 * merely inconveniences an executor that has a real MCP tool alternative
 * anyway; this hook guards irreversible loss of a human's or a sibling job's
 * uncommitted work, where a false ALLOW is the one outcome with no undo. Any
 * OTHER internal error (malformed stdin JSON, an unexpected payload shape)
 * still fails open — a broken guard must never brick the whole Bash tool.
 *
 * ── Install (per-project, NOT machine-wide) ─────────────────────────────
 * Add to this project's `.claude/settings.json` (not `~/.claude/settings.json`
 * — project scope only, so the guard applies to sessions run against THIS
 * repo, not every project on the machine):
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Bash",
 *           "hooks": [
 *             { "type": "command", "command": "node scripts/hooks/guard-destructive-git.cjs" }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * ── Adopting this hook in a DIFFERENT (non-session-manager) project ──────
 * DON'T HAND-WRITE THIS. Session Manager installs it: open New Session in
 * that project and press "Fix it" on the readiness banner's destructive-git-
 * guard row (src/main/lib/delegationReadiness.cjs's installDestructiveGitGuard,
 * which merges into any existing hooks block instead of clobbering it).
 *
 * The standardized approach is REFERENCE, not vendor — do NOT copy this file
 * into the adopting repo. Vendoring drifts (guard-prd-writes.cjs already saw
 * this happen with its one adopter), and the enforcement logic belongs with
 * the owner (this repo), not forked into every consumer.
 *
 * This file lives in the session-manager repo, so a relative
 * `node scripts/hooks/guard-destructive-git.cjs` command only resolves when
 * the hook runs with THIS repo as cwd. Pasting that relative string into
 * another project yields a hook that exits non-zero WITHOUT code 2 — a
 * non-blocking error — so it silently guards nothing. Any other project's
 * `.claude/settings.json` must reference this file by its ABSOLUTE path:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Bash",
 *           "hooks": [
 *             {
 *               "type": "command",
 *               "command": "node /home/bilko/Projects/session-manager/scripts/hooks/guard-destructive-git.cjs"
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * This is still opt-in per project, same as above — never auto-install this
 * into every project's settings without the human choosing to add it there.
 *
 * ── Uninstall ────────────────────────────────────────────────────────────
 * Remove the `PreToolUse` entry above from `.claude/settings.json`. The
 * script is inert with no settings.json entry pointing at it — deleting the
 * file itself is optional and has no other effect.
 *
 * ── Contract ─────────────────────────────────────────────────────────────
 * - Reads a PreToolUse payload on stdin: { tool_name, tool_input, cwd, ... }.
 * - Only inspects `Bash` calls; every other tool_name is allowed by
 *   construction (the matcher already scopes this hook to Bash, but the
 *   tool_name check below is a second, defense-in-depth gate in case the
 *   matcher is ever widened).
 * - Read-only git (`status`, `diff`, `log`, `show`, `stash list`, `stash
 *   show`, `rev-parse`, plain `git add <path>`, `git commit -m ...`) is
 *   never touched by the rules below and always passes through.
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// Duplicated from src/main/lib/gitWorktree.cjs's KIND_CONFIG — see this
// file's header for why this is a deliberate duplication, not a require.
const WORKTREE_ROOTS = [
  path.join(os.tmpdir(), 'session-manager-job-worktrees'),
  path.join(os.tmpdir(), 'session-manager-epic-worktrees'),
];
const BRANCH_PREFIXES = ['sm-job/', 'sm-epic/'];

const MAX_SH_C_DEPTH = 5;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // Fail open if stdin never closes/errors for some reason.
    process.stdin.on('error', () => resolve(data));
  });
}

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
      // exact incident shape (real precedent: `starry-night-ships`, see this
      // file's header) walk straight past the guard.
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

/** Returns the first destructive verdict found anywhere in `command`, or null. */
function findDestructiveVerdict(command, depth = 0) {
  if (depth > MAX_SH_C_DEPTH) return null;
  const { parts, unterminatedQuote } = splitTopLevel(command);
  if (unterminatedQuote) {
    if (/\bgit\b/i.test(command)) {
      return { verb: 'an unparsable command mentioning git', alt: 'this hook could not confidently parse this command\'s quoting to confirm it is safe — split it into a plain, simply-quoted git invocation, or stop and report' };
    }
    return null;
  }

  for (const segment of parts) {
    const tokens = tokenize(segment);
    if (tokens === null) {
      if (/\bgit\b/i.test(segment)) {
        return { verb: 'an unparsable command mentioning git', alt: 'this hook could not confidently parse this command\'s quoting to confirm it is safe — split it into a plain, simply-quoted git invocation, or stop and report' };
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

    if (SH_WRAPPERS.has(head)) {
      const cIdx = cmdTokens.indexOf('-c');
      if (cIdx !== -1 && cmdTokens[cIdx + 1] != null) {
        const nested = findDestructiveVerdict(cmdTokens[cIdx + 1], depth + 1);
        if (nested) return nested;
      }
      continue;
    }

    if (head === 'git') {
      const verdict = evaluateGit(cmdTokens.slice(1));
      if (verdict) return verdict;
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

function allow() {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    continue: true,
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`[guard-destructive-git] malformed stdin JSON, failing open: ${e?.message}`);
    return allow();
  }

  try {
    if (payload.tool_name !== 'Bash') return allow();

    const command = payload?.tool_input?.command;
    if (!command || typeof command !== 'string') return allow();

    const verdict = findDestructiveVerdict(command);
    if (!verdict) return allow();

    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    if (isExemptSharedTree(cwd)) return allow();

    const reason = [
      `Blocked: \`${verdict.verb}\` in what this hook believes is a SHARED working tree (${cwd}).`,
      verdict.alt,
      'You are normally inside your own sm-job/<slug> or sm-epic/<epicId> worktree for this kind of operation — run `git rev-parse --git-common-dir` to check; this guard permits the same command there.',
    ].join(' ');
    return deny(reason);
  } catch (e) {
    console.error(`[guard-destructive-git] internal error, failing open: ${e?.message}`);
    return allow();
  }
}

main().catch((e) => {
  console.error(`[guard-destructive-git] unhandled error, failing open: ${e?.message}`);
  allow();
});
