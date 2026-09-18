/**
 * smProcNames.cjs — kernel `comm` names for the processes Session Manager
 * itself leaves in the user's process list (pn-03). `claude` children are
 * named separately (procName.cjs smArgv0 / pn-02).
 *
 * Every name is <= 15 chars (Linux TASK_COMM_LEN). `session-manager` is
 * EXACTLY 15, so NEVER derive another name from it by suffixing — it would
 * truncate back to `session-manager` and be indistinguishable from main.
 */
'use strict';

const path = require('node:path');
const { aliasBinFor } = require('./procName.cjs');

const PROC_NAMES = Object.freeze({
  main: 'session-manager',
  mcpServer: 'sm-mcp-server',
  watchdog: 'sm-watchdog',
  inhibitHold: 'sm-inhibit-hold',
  shell: 'sm-shell',
});

// Shells whose argv0-basename behaviour (sh/rsh/ksh emulation, $0-branching rc
// files) is known to be safe under the `sm-shell` alias. Anything else spawns
// the real path — never guess at another shell's argv0 semantics.
const ALIASABLE_SHELLS = new Set(['bash', 'zsh']);

/**
 * On Linux Node's process.title setter calls prctl(PR_SET_NAME), changing
 * `comm`. It overwrites the argv memory region, but process.argv is a JS
 * array copied at startup and is unaffected. Never throws.
 */
function setProcessTitle(name) {
  try { process.title = name; } catch { /* naming must never break boot */ }
}

/** Alias `shell` as `sm-shell` iff it is bash/zsh; otherwise return it unchanged. Fail-open. */
function aliasedShellBin(shell) {
  try {
    if (typeof shell !== 'string' || !shell) return shell;
    if (!ALIASABLE_SHELLS.has(path.basename(shell))) return shell;
    return aliasBinFor(shell, PROC_NAMES.shell);
  } catch { return shell; }
}

/** `sh` aliased as `sm-inhibit-hold` for the systemd-inhibit poll holder. Fail-open. */
function inhibitHolderShell() {
  try { return aliasBinFor('/bin/sh', PROC_NAMES.inhibitHold); } catch { return '/bin/sh'; }
}

module.exports = { PROC_NAMES, ALIASABLE_SHELLS, setProcessTitle, aliasedShellBin, inhibitHolderShell };
