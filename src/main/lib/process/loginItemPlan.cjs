'use strict';
// Plan the login item that starts Session Manager when the user logs in. Pure: reads no file
// and no env var; the caller passes everything in and writes whatever the plan names.
// Packaged darwin/win32 -> Electron's own login item. Linux -> an XDG autostart entry.
// npx install on darwin -> a LaunchAgent. Every npx plan runs start-at-login.sh, which runs
// the same `npx --yes claude-code-session-manager@latest` the in-app reboot uses.

const PKG = 'claude-code-session-manager';
const DEFAULT_APP_ID = 'run.bilko.session-manager';

function joinHome(homeDir, rel) {
  return `${String(homeDir).replace(/\/+$/, '')}/${rel}`;
}

// POSIX sh single-quoted literal; an embedded ' becomes '\''.
function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// Desktop-entry Exec argument: double-quoted, with " ` $ \ backslash-escaped. A literal % is
// doubled because Exec treats %x as a field code.
function execQuote(s) {
  return `"${String(s).replace(/["`$\\]/g, (c) => `\\${c}`).replace(/%/g, '%%')}"`;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function desktopEntry(exec) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Session Manager',
    'Comment=Start Session Manager at login',
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'X-Session-Manager-Login-Item=1',
    '',
  ].join('\n');
}

function launchAgentPlist(label, scriptPath) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    `    <string>${xmlEscape(scriptPath)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>LimitLoadToSessionType</key>',
    '  <string>Aqua</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function startScript({ logPath, npxPath }) {
  return [
    '#!/bin/sh',
    '# Written by Session Manager to start it at login.',
    "# To remove it, turn off App Settings > Startup > 'Start at login'.",
    `LOG=${shQuote(logPath)}`,
    'log() {',
    '  mkdir -p "$(dirname "$LOG")" 2>/dev/null',
    `  printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"`,
    '}',
    `NPX=${shQuote(npxPath)}`,
    'if [ ! -x "$NPX" ]; then',
    '  NPX=$(command -v npx 2>/dev/null || true)',
    'fi',
    'if [ -z "$NPX" ] || [ ! -x "$NPX" ]; then',
    '  NPX=',
    '  for LOGIN_SH in "$SHELL" /bin/bash /bin/zsh; do',
    '    if [ -n "$LOGIN_SH" ] && [ -x "$LOGIN_SH" ]; then',
    `      NPX=$("$LOGIN_SH" -lc 'command -v npx' 2>/dev/null | tail -n 1)`,
    '      if [ -n "$NPX" ] && [ -x "$NPX" ]; then break; fi',
    '      NPX=',
    '    fi',
    '  done',
    'fi',
    'if [ -z "$NPX" ] || [ ! -x "$NPX" ]; then',
    "  log 'npx not found'",
    '  exit 1',
    'fi',
    'PATH="$(dirname "$NPX"):$PATH"',
    'export PATH',
    `log "starting $NPX --yes ${PKG}@latest"`,
    'START=$(date +%s)',
    `"$NPX" --yes ${PKG}@latest >> "$LOG" 2>&1`,
    'STATUS=$?',
    'ELAPSED=$(( $(date +%s) - START ))',
    'if [ "$STATUS" -ne 0 ] && [ "$ELAPSED" -lt 120 ]; then',
    '  log "exited $STATUS after ${ELAPSED}s; retrying once offline"',
    `  "$NPX" --yes --offline ${PKG} >> "$LOG" 2>&1`,
    '  STATUS=$?',
    '  log "offline run exited $STATUS"',
    'fi',
    'exit "$STATUS"',
    '',
  ].join('\n');
}

function unsupported(reason) {
  return { supported: false, reason };
}

/**
 * @param {{ platform: string, packaged: boolean, dev: boolean, homeDir?: string,
 *   appImagePath?: string|null, npxPath?: string|null, appId?: string }} opts
 */
function planLoginItem(opts) {
  const { platform, packaged, dev, homeDir, appImagePath, npxPath } = opts || {};
  const appId = (opts && opts.appId) || DEFAULT_APP_ID;

  if (dev) return unsupported('A dev run is not started at login; only an installed app is.');

  if (packaged) {
    if (platform === 'darwin' || platform === 'win32') {
      return { supported: true, mechanism: 'electron-login-item', starts: 'app' };
    }
    if (platform !== 'linux') return unsupported(`Start at login is not available on ${platform}.`);
    if (!appImagePath) {
      return unsupported('This Linux build is not running from an AppImage, so there is no file to start at login.');
    }
    if (!homeDir) return unsupported('No home folder is known, so there is nowhere to write the login item.');
    return {
      supported: true,
      mechanism: 'xdg-autostart',
      starts: 'app',
      entryPath: joinHome(homeDir, `.config/autostart/${PKG}.desktop`),
      entryText: desktopEntry(execQuote(appImagePath)),
    };
  }

  if (platform === 'win32') {
    return unsupported('Start at login is not available for an npx install on Windows; use the installer build.');
  }
  if (platform !== 'linux' && platform !== 'darwin') {
    return unsupported(`Start at login is not available on ${platform}.`);
  }
  if (!npxPath) return unsupported('npx was not found, so there is no command to start at login.');
  if (!homeDir) return unsupported('No home folder is known, so there is nowhere to write the login item.');

  const scriptPath = joinHome(homeDir, '.claude/session-manager/start-at-login.sh');
  const scriptText = startScript({
    logPath: joinHome(homeDir, '.claude/session-manager/start-at-login.log'),
    npxPath,
  });

  if (platform === 'linux') {
    return {
      supported: true,
      mechanism: 'xdg-autostart',
      starts: 'npx',
      entryPath: joinHome(homeDir, `.config/autostart/${PKG}.desktop`),
      entryText: desktopEntry(`/bin/sh ${execQuote(scriptPath)}`),
      scriptPath,
      scriptText,
    };
  }

  const label = `${appId}.login`;
  return {
    supported: true,
    mechanism: 'launch-agent',
    starts: 'npx',
    label,
    entryPath: joinHome(homeDir, `Library/LaunchAgents/${label}.plist`),
    entryText: launchAgentPlist(label, scriptPath),
    scriptPath,
    scriptText,
  };
}

module.exports = { planLoginItem, shQuote, execQuote, xmlEscape };
