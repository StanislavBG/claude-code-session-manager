'use strict';

/**
 * promptSessionsCreateEpic.cjs — IPC entry point letting the renderer mint a
 * new Epic through main's own ensureEpic() instead of hand-constructing a
 * PromptSession record itself (state/promptSessions.ts's createPromptSession).
 *
 * Step 1 of a two-PRD chain (PRD 953 here; PRD 954 routes createPromptSession
 * through it): purely additive today — nothing calls this handler yet. Kept
 * as a sibling module (mirrors lib/activeIndexMerge.cjs, which does the same
 * "own file, own register*Handlers export, wired from index.cjs" shape for
 * the neighboring active-index merge IPC) rather than growing epicMint.cjs
 * itself, since this is IPC-registration plumbing, not Epic-minting logic.
 */

const { ensureEpic, readActiveIndex, MINT_AUTHORITY_NEW_EPIC_UI } = require('./epicMint.cjs');
const { validatePath } = require('../config.cjs');

/**
 * createEpicViaIpc(cwd, { goalText, tag?, agentType?, source? }) → Promise<{ epicId, session }>
 *
 * THE one Epic-creation path (epicMint.cjs's SINGLE-CREATOR LAW): this handler
 * holds `MINT_AUTHORITY_NEW_EPIC_UI`, the token that unlocks ensureEpic's mint
 * branch, because it is what the New Epic card calls when a human presses it.
 * Nothing else may hold it.
 *
 * Always mints a brand-new 'proposed' Epic — never joins an existing one — and
 * returns the just-written record read back from the active-index.json on disk, so the
 * response is guaranteed byte-identical to what a subsequent hydrate would
 * see — never a second, independently re-derived copy of the session shape.
 *
 * `ensureEpic`'s writes go through epicMint.cjs's own raw `fs` calls, not
 * config.cjs's writeJson/validateWrite — fine for its other callers
 * (the scheduler's join-only dispatch), which derives `cwd` from a
 * project the app already knows about, but this function is reachable from
 * the renderer over IPC with an arbitrary `cwd` string. Explicitly running
 * that `cwd` through config.cjs's own `validatePath` (allowedRoots = home dir
 * + every cwd a TAB has opened) closes the gap so this handler can't be used
 * to make main write session-manager-operations/ into an arbitrary
 * filesystem location — the same boundary every other renderer-facing path
 * IPC (config:read-json/write-json, lib/activeIndexMerge.cjs's own merge) is
 * already required to pass through.
 */
async function createEpicViaIpc(cwd, { goalText, tag, agentType, source } = {}) {
  validatePath(cwd);
  const { epicId } = await ensureEpic(cwd, {
    goalText,
    tag,
    agentType,
    source,
    mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI,
    status: 'proposed',
  });
  const index = readActiveIndex(cwd);
  return { epicId, session: index.sessions[epicId] };
}

function registerPromptSessionsCreateEpicHandlers() {
  const { ipcMain } = require('electron');
  const { schemas: s, validated: v } = require('../ipcSchemas.cjs');
  ipcMain.handle(
    'promptSessions:create-epic',
    v(s.promptSessionsCreateEpic, ({ cwd, goalText, tag, agentType, source }) =>
      createEpicViaIpc(cwd, { goalText, tag, agentType, source })),
  );
}

module.exports = { createEpicViaIpc, registerPromptSessionsCreateEpicHandlers };
