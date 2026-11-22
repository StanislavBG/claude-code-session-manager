/**
 * externalContract.cjs — sole owner of the outside-contract version number.
 *
 * RULE: a change that breaks an outside caller of an admin route, an MCP
 * tool, an audit event or the admin-api.json shape increments
 * CONTRACT_VERSION. Additive changes (a new route, a new optional field) do
 * not.
 *
 * Why top-level lib/: the contract spans the admin HTTP transport, the MCP
 * server, the audit log and the token file — no single domain subfolder owns
 * it. Outside apps read the number (health route, unknown-route 404,
 * admin-api.json) instead of probing for a missing route.
 */

'use strict';

const CONTRACT_VERSION = 1;

// Read once; null when package.json is unreadable.
let APP_VERSION = null;
try { APP_VERSION = require('../../../package.json').version || null; } catch { APP_VERSION = null; }

/** @returns {{ contractVersion: number, appVersion: string | null }} */
function contractInfo() {
  return { contractVersion: CONTRACT_VERSION, appVersion: APP_VERSION };
}

module.exports = { CONTRACT_VERSION, contractInfo };
