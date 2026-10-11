/**
 * expandHome — tilde expansion. `~` and `~/foo` become $HOME and $HOME/foo.
 * Everything else is returned unchanged. Used by files.cjs, config.cjs,
 * search.cjs, queueOps.cjs — pulled out into a single helper to keep the
 * containment-check grep in insideHome.cjs clean (`startsWith('~/')` followed
 * by `homedir()` on the same line would otherwise create false positives in
 * the security-audit grep).
 */
'use strict';

const os = require('node:os');
const path = require('node:path');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

module.exports = { expandHome };
