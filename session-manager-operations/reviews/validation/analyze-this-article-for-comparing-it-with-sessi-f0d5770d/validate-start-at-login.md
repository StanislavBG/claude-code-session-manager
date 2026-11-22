# Validation: start-at-login plan

Base: 525abf7e (known). Commits: 653cc2f3 (plan), 6a896d32 (apply), 8560fa0d (ipc-main), bc2667aa (preload), 56af217e (toggle), 71661722 (readme). The base..HEAD range also holds unrelated Task commits; they were not reviewed here.

Gates re-run: one vitest run of all seven named test files (54 tests passed); `npm run lint` exit 0 (includes lint:readme); `npm run typecheck` exit 0.

## login-item-plan — VERIFIED
- Pure module, exports planLoginItem: loginItemPlan.cjs:126, :190; no fs/env use in the file.
- Unsupported cases: dev :130; npx on win32 :150; packaged Linux without appImagePath :137; npx without npxPath :156.
- Packaged darwin/win32 gives electron-login-item, starts app, no files: :133-135.
- Linux xdg-autostart: entryPath :145/:170, desktop entry with Type/Name/Terminal/marker :35-47; Exec is quoted appImagePath :146 or `/bin/sh "<script>"` :171.
- darwin npx launch-agent: :177-187; plist Label, /bin/sh, RunAtLoad, Aqua :49-70.
- scriptPath/scriptText on every npx plan :159-163; layout entry `loginItemPlan: process`; tests cover the cases (loginItemPlan.test.cjs, passed).

## login-item-apply — VERIFIED
- createLoginItem takes the listed arguments; APPIMAGE from env and npx from resolveNpx: loginItem.cjs:52-67.
- status() fields and rules: marker :27-33, Hidden/X-GNOME off :36-46, script exists for npx :93, electron path :73-83.
- setEnabled(true): script mode 0700 first, then entry, via writeTextAtomic :122-123; unsupported throws the plan reason :115; electron path :116-118.
- setEnabled(false): rm entry and script with force :125-126; foreign file throws naming the path :105-110, called at :120.
- No spawn, no settings file (grep found none); layout entry `loginItem: process`; tests passed (on/off linux+darwin, packaged darwin, hand-disabled, unsupported, foreign).

## login-item-ipc-main — VERIFIED
- loginItemIpc.cjs:19-33: status channel, strict zod payload, { ok:false, error } on a bad payload or a throw, { ok:true, status } on success.
- index.cjs wiring in try/catch next to registerUpdaterIpc with the specified arguments (dev = SM_DEV or SM_E2E === '1', appId run.bilko.session-manager, resolveNpx).
- loginItemIpc.test.cjs passed.

## login-item-preload-api — VERIFIED
- preload/index.cjs loginItem block exactly as specified; api.d.ts LoginItemStatus and loginItem block as specified; apiSurface.json has both entries (remote: deny); preload-surface test passed.

## start-at-login-toggle — VERIFIED
- SettingsStartAtLogin.tsx: testid :48, status read on mount :24-31, descriptions :6-14, disabled when unsupported or pending :52, ok:false and thrown error go to the toast and leave state unchanged :36-41.
- AppSettings.tsx renders it in the Startup tab; page-app-settings.md invariant line added; tests passed.

## start-at-login-readme — VERIFIED
- README.md "### Start at login" in the Install section: off by default, App Settings > Startup, npx@latest with the cached fallback within two minutes, a packaged build starts the app; file locations and removal; not offered for npx on Windows or in a dev run. lint:readme passed.
- Slightly loose: README says a launch agent plist on macOS and desktop entry on Linux; the packaged Linux AppImage case is mentioned in one sentence only.

## Code-reading checks
- Nothing is spawned: no child_process in loginItem.cjs or loginItemPlan.cjs. The macOS launch agent is not `launchctl`-loaded; it takes effect at next login (stated in the header comment).
- Writes only from main via atomicFs (loginItem.cjs:12,122-123). The renderer refusal in src/main/files.cjs:53-54 is unchanged (no diff against base).
- Off by default and no preference file: status is derived from the entry file or app.getLoginItemSettings(); nothing is written until setEnabled(true); no settings store added.
- A foreign entry is never removed: refuseForeign runs before both the on and off branches (:120).
- Quoting: tested with home `/tmp/lip/it's a home`: Exec=/bin/sh "/tmp/lip/it's a home/.claude/session-manager/start-at-login.sh"; script has `LOG='/tmp/lip/it'\''s a home/...'`; `sh -n` OK. The plist uses XML escaping (:26-33).

## Real-machine plan (linux, not packaged, home /home/bilko, npx /usr/bin/npx) — read-only, nothing written
Entry path: /home/bilko/.config/autostart/claude-code-session-manager.desktop
```
[Desktop Entry]
Type=Application
Name=Session Manager
Comment=Start Session Manager at login
Exec=/bin/sh "/home/bilko/.claude/session-manager/start-at-login.sh"
Terminal=false
X-GNOME-Autostart-enabled=true
X-Session-Manager-Login-Item=1
```
Script /home/bilko/.claude/session-manager/start-at-login.sh (`sh -n`: OK):
```
#!/bin/sh
# Written by Session Manager to start it at login.
# To remove it, turn off App Settings > Startup > 'Start at login'.
LOG='/home/bilko/.claude/session-manager/start-at-login.log'
log() {
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"
}
NPX='/usr/bin/npx'
if [ ! -x "$NPX" ]; then
  NPX=$(command -v npx 2>/dev/null || true)
fi
if [ -z "$NPX" ] || [ ! -x "$NPX" ]; then
  NPX=
  for LOGIN_SH in "$SHELL" /bin/bash /bin/zsh; do
    if [ -n "$LOGIN_SH" ] && [ -x "$LOGIN_SH" ]; then
      NPX=$("$LOGIN_SH" -lc 'command -v npx' 2>/dev/null | tail -n 1)
      if [ -n "$NPX" ] && [ -x "$NPX" ]; then break; fi
      NPX=
    fi
  done
fi
if [ -z "$NPX" ] || [ ! -x "$NPX" ]; then
  log 'npx not found'
  exit 1
fi
PATH="$(dirname "$NPX"):$PATH"
export PATH
log "starting $NPX --yes claude-code-session-manager@latest"
START=$(date +%s)
"$NPX" --yes claude-code-session-manager@latest >> "$LOG" 2>&1
STATUS=$?
ELAPSED=$(( $(date +%s) - START ))
if [ "$STATUS" -ne 0 ] && [ "$ELAPSED" -lt 120 ]; then
  log "exited $STATUS after ${ELAPSED}s; retrying once offline"
  "$NPX" --yes --offline claude-code-session-manager >> "$LOG" 2>&1
  STATUS=$?
  log "offline run exited $STATUS"
fi
exit "$STATUS"
```

## Visual check
The switch was not launched in the app. A visual check by the owner is still due.

## Findings
Critical: none.
Important: none.
Minor:
- loginItem.cjs:126 — turning off removes start-at-login.sh without checking it was ours (only the entry file is marker-checked); a user's own file at that path would be deleted.
- loginItem.cjs:93 — status only checks that the script exists, not that it is executable or current.
