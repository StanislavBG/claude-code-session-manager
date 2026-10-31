'use strict';

/**
 * autoStartedSession.cjs — recognises an Epic that cross-project feedback
 * auto-started (nobody watching its first turn) and supplies the no-ask turn
 * instruction for it. Takes the stop sentinel as an argument so it never
 * requires chatRunner.cjs. See epicMint.cjs for the autoApprove stamp.
 */

/** True only for an Epic stamped producer 'cross-project-feedback' + autoApprove. Never throws. */
function isAutoStartedEpic(cwd, claudeSessionId) {
  try {
    if (!cwd || !claudeSessionId) return false;
    const { readActiveIndex } = require('../epic/epicMint.cjs');
    const { sessions } = readActiveIndex(cwd);
    for (const session of Object.values(sessions)) {
      if (session && session.claudeSessionId === claudeSessionId) {
        const source = session.source;
        return !!(source && source.producer === 'cross-project-feedback' && source.autoApprove);
      }
    }
    return false;
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

module.exports = { isAutoStartedEpic, autoStartTurnInstruction };
