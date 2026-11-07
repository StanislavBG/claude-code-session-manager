import { useEffect, useState } from 'react'
import { ViewTabs } from '../ui/ViewTabs'
import { SourceChip } from '../ui/SourceChip'
import { Toggle } from '../ui/Toggle'
import { Choice } from '../ui/Choice'
import { VoiceModal } from '../layout/VoiceModal'
import { TerminalAppearanceCard } from './home/TerminalAppearanceCard'
import { SettingsTelemetry } from './SettingsTelemetry'
import { SettingsRemote } from './SettingsRemote'
import { SettingsUpdates } from './SettingsUpdates'
import { SettingsOpsRetention } from './SettingsOpsRetention'
import { DataModel } from './DataModel'
import { useDensity } from '../../lib/useDensity'
import { useHomeDir } from '../../lib/useHomeDir'
import { readAppPrefs, writeAppPrefs, APP_PREFS_FILE } from '../../lib/appPrefs'
import { UI_SETTINGS_PREFS_FILE } from '../../lib/uiSettingsPrefs'
import { toast } from '../../state/toast'

const TABS = [
  { key: 'voice', label: 'Voice' },
  { key: 'appearance', label: 'Appearance' },
  { key: 'telemetry', label: 'Telemetry' },
  { key: 'remote', label: 'Phone remote' },
  { key: 'updates', label: 'Updates & retention' },
  { key: 'startup', label: 'Startup' },
  { key: 'storage', label: 'Storage map' },
] as const
type TabKey = (typeof TABS)[number]['key']

const DENSITY_LABELS = { compact: 'Compact', roomy: 'Roomy' }
const SM_DIR = '.claude/session-manager'

function Chips({ files }: { files: Array<{ path: string; keyPath?: string[] }> }) {
  const home = useHomeDir()
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3" data-testid="app-settings-chips">
      {files.map((f) => {
        // Chip paths must be absolute for config.readText; expand a leading ~.
        const abs = f.path.startsWith('~/') ? (home ? home + f.path.slice(1) : null) : f.path
        return abs ? <SourceChip key={f.path} path={abs} keyPath={f.keyPath} /> : null
      })}
    </div>
  )
}

function Startup() {
  const [openHome, setOpenHome] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    readAppPrefs().then((p) => { if (alive) setOpenHome(p.openToHomeOnLaunch === true) })
    return () => { alive = false }
  }, [])
  const toggle = async (value: boolean) => {
    setOpenHome(value)
    setSaving(true)
    try {
      await writeAppPrefs({ openToHomeOnLaunch: value })
    } catch {
      setOpenHome(!value)
      toast.error('Failed to save "Open to Home on launch" — try again.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="p-4 max-w-3xl space-y-3 text-sm">
      <Toggle checked={openHome} onChange={toggle} disabled={saving} label="Open to Home on launch" />
    </div>
  )
}

function Appearance() {
  const { density, setDensity } = useDensity()
  return (
    <div className="p-4 max-w-3xl space-y-5 text-sm">
      <TerminalAppearanceCard />
      <section className="border border-line rounded p-3 space-y-1">
        <span className="text-fg-dim text-xs">Density</span>
        <Choice
          options={['compact', 'roomy']}
          value={density}
          onChange={(v) => setDensity(v as 'compact' | 'roomy')}
          labels={DENSITY_LABELS}
        />
        <span className="text-fg-faint text-[11px]">
          Compact tightens spacing across the app&apos;s chrome; Roomy is the default.
        </span>
      </section>
    </div>
  )
}

const f = (name: string, keyPath?: string[]) => ({ path: `~/${SM_DIR}/${name}`, keyPath })

const CHIPS: Record<TabKey, Array<{ path: string; keyPath?: string[] }>> = {
  voice: [f('voice.json')],
  appearance: [{ path: UI_SETTINGS_PREFS_FILE, keyPath: ['terminal'] }, f('ui-chrome-prefs.json')],
  telemetry: [f('telemetry.json'), f('otel.json')],
  remote: [f('web-remote.json')],
  updates: [f('updater.json'), f('ops-retention.json')],
  startup: [{ path: APP_PREFS_FILE, keyPath: ['openToHomeOnLaunch'] }],
  storage: [],
}

/** Session Manager's own settings — one page, one tab per owning file. */
export function AppSettings() {
  const [tab, setTab] = useState<TabKey>('voice')
  return (
    <div className="flex flex-col h-full min-h-0" data-testid="app-settings">
      <div className="flex items-center px-4 pt-3">
        <ViewTabs options={TABS} active={tab} onChange={setTab} />
      </div>
      <Chips files={CHIPS[tab]} />
      <div className="flex-1 min-h-0 overflow-auto" data-testid={`app-settings-${tab}`}>
        {tab === 'voice' && <VoiceModal open={true} onClose={() => {}} variant="page" />}
        {tab === 'appearance' && <Appearance />}
        {tab === 'telemetry' && <SettingsTelemetry />}
        {tab === 'remote' && <SettingsRemote />}
        {tab === 'updates' && (
          <div className="p-4 max-w-3xl space-y-5">
            <SettingsUpdates />
            <SettingsOpsRetention />
          </div>
        )}
        {tab === 'startup' && <Startup />}
        {tab === 'storage' && <DataModel />}
      </div>
    </div>
  )
}
