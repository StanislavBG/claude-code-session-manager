'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * autoStartedSession.cjs — recognises an Epic that cross-project feedback
 * auto-started (nobody watching its first turn) and supplies the no-ask turn
 * instruction for it. Takes the stop sentinel as an argument so it never
 * requires chatRunner.cjs. See epicMint.cjs for the autoApprove stamp.
 */

/** Finds the Epic by claude session id → { epicId, session } or null. Never throws. */
function findEpic(cwd, claudeSessionId) {
  try {
    if (!cwd || !claudeSessionId) return null;
    const { readActiveIndex } = require('../epic/epicMint.cjs');
    const { sessions } = readActiveIndex(cwd);
    for (const [key, session] of Object.entries(sessions)) {
      if (session && session.claudeSessionId === claudeSessionId) {
        return { epicId: session.id || key, session };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function stampedAutoStart(session) {
  const source = session && session.source;
  return !!(source && source.producer === 'cross-project-feedback' && source.autoApprove);
}

/** True only for an Epic stamped producer 'cross-project-feedback' + autoApprove. Never throws. */
function isAutoStartedEpic(cwd, claudeSessionId) {
  const found = findEpic(cwd, claudeSessionId);
  return !!found && stampedAutoStart(found.session);
}

function hasMarkdown(dir) {
  try {
    const entries = fs.readdirSync(dir, { recursive: true });
    return entries.some((e) => String(e).toLowerCase().endsWith('.md'));
  } catch {
    return false; // missing folder = empty
  }
}

/**
 * True when the Epic is auto-started, tagged bug or feature, and has no PRD
 * file under prds/ or prds-archived/ (timestamped subfolders included). Never throws.
 */
function autoStartNeedsPlan(cwd, claudeSessionId) {
  try {
    const found = findEpic(cwd, claudeSessionId);
    if (!found || !stampedAutoStart(found.session)) return false;
    const tag = found.session.tag;
    if (tag !== 'bug' && tag !== 'feature') return false;
    const { resolveEpicPrdWriteDir } = require('../prd/prdLocations.cjs');
    const prds = resolveEpicPrdWriteDir(cwd, found.epicId);
    const archived = path.join(path.dirname(prds), 'prds-archived');
    return !hasMarkdown(prds) && !hasMarkdown(archived);
  } catch {
    return false;
  }
}

const AUTO_START_FOLLOW_UP_PROMPT =
  'Your first turn ended with nothing queued. Queue the plan now with the /develop skill. ' +
  'If nothing needs building, say why and stop.';

/** Sends one automatic follow-up turn when the first turn left no plan. Never throws. */
function autoStartFollowUp({ cwd, tabId, sessionId, send }) {
  try {
    if (typeof send !== 'function') return false;
    if (!autoStartNeedsPlan(cwd, sessionId)) return false;
    const r = send(tabId, AUTO_START_FOLLOW_UP_PROMPT, { origin: 'scheduler', sessionId, cwd });
    if (r && typeof r.catch === 'function') r.catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function autoStartTurnInstruction(stopSentinel) {
  return (
    `IMPORTANT: This session was started automatically and nobody is watching. ` +
    `Never ask questions and never print ${stopSentinel}. First check the report below ` +
    `against this codebase. If it holds and the Mission is to plan or fix, finish the plan ` +
    `in this turn and queue it with the /develop skill. If it does not hold, say why and ` +
    `stop. End with a short report.\n\n`
  );
}

module.exports = {
  isAutoStartedEpic,
  autoStartNeedsPlan,
  autoStartFollowUp,
  autoStartTurnInstruction,
  AUTO_START_FOLLOW_UP_PROMPT,
};
