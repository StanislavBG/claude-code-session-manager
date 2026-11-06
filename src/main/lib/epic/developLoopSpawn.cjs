'use strict';
/**
 * developLoopSpawn.cjs — per-session opt-out of the session-manager-dev plugin.
 *
 * Session Manager installs the plugin (/develop, /builder, /send-feedback) at
 * user scope, so every claude session gets it. An Epic whose row has
 * `developLoop === false` wants a "pure claude" session: the launch passes
 * `--settings '{"enabledPlugins":{"<key>":false}}'`, which outranks the user
 * scope for that one session only. Every other Epic / plain tab gets no args.
 */
const { ENABLED_KEY } = require('../../seedDevPlugin.cjs');

function developLoopOffSettingsArgs(epic) {
  if (epic?.developLoop !== false) return [];
  return ['--settings', JSON.stringify({ enabledPlugins: { [ENABLED_KEY]: false } })];
}

module.exports = { developLoopOffSettingsArgs };
