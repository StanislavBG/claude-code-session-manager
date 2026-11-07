/**
 * Cross-project global behavior prefs — small machine-level file distinct
 * from scheduler-machine.json (that one is scheduler fire policy; this one is
 * app UI behavior). Read by layout.ts at boot to pick the initial focused
 * panel, written by SessionManagerConfig.tsx's "Behavior" section.
 */
import { appSettingsFile } from './appSettingsFile'

export interface AppPrefs {
  openToHomeOnLaunch?: boolean
}

export const APP_PREFS_FILE = '~/.claude/session-manager/app-prefs.json'

const file = appSettingsFile<AppPrefs>(APP_PREFS_FILE)

export const readAppPrefs = (): Promise<AppPrefs> => file.read()

export const writeAppPrefs = (patch: AppPrefs): Promise<void> => file.patch(patch)
