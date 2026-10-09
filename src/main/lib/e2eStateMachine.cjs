/**
 * Pure E2E session state machine for the web-remote relay.
 * No Electron, no I/O — importable in unit tests.
 *
 * State transitions:
 *   idle        → pending_sas   : successful deriveSessionKey + deriveSas
 *   idle        → failed        : crypto derivation error
 *   pending_sas → authenticated : user confirms SAS
 *   pending_sas → failed        : deriveSas threw after sessionKey succeeded
 *   any         → idle          : disconnect / reset
 */

/** @returns {{ state: string, sessionKey: Buffer|null, pendingSas: string|null }} */
function makeState(state = 'idle', sessionKey = null, pendingSas = null) {
  return { state, sessionKey, pendingSas };
}

/**
 * Attempt to confirm the SAS.  Pure — does not mutate; returns the next state.
 * @param {{ state: string, sessionKey: Buffer|null, pendingSas: string|null }} e2eState
 * @returns {{ ok: boolean, error?: string, next: { state: string, sessionKey: Buffer|null, pendingSas: string|null } }}
 */
function confirmSas(e2eState) {
  if (e2eState.state !== 'pending_sas') {
    const errorMap = {
      idle: 'no_e2e_session',
      failed: 'e2e_failed',
      authenticated: 'already_authenticated',
    };
    const error = errorMap[e2eState.state] ?? 'unexpected_state';
    return { ok: false, error, next: e2eState };
  }
  return {
    ok: true,
    next: makeState('authenticated', e2eState.sessionKey, null),
  };
}

module.exports = { makeState, confirmSas };
