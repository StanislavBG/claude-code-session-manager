import { useCallback, useEffect, useState } from 'react'
import { useToast } from '../../state/toast'

type OpsRetention = Awaited<ReturnType<typeof window.api.opsRetention.get>>
type OpsRetentionPreview = Awaited<ReturnType<typeof window.api.opsRetention.preview>>

type FieldKey = 'maxAgeDays' | 'runsArchiveDays' | 'auditLogMonths' | 'reservedMarkersKeep'

// Mirrors opsRetentionSettings.cjs BOUNDS — main re-clamps, this keeps the input honest.
const FIELDS: { key: FieldKey; label: string; unit: string; min: number; max: number }[] = [
  { key: 'maxAgeDays', label: 'Run logs: keep for', unit: 'days', min: 3, max: 3650 },
  { key: 'runsArchiveDays', label: 'Runs archive: keep for', unit: 'days', min: 1, max: 3650 },
  { key: 'auditLogMonths', label: 'Audit log: keep for', unit: 'months', min: 1, max: 120 },
  { key: 'reservedMarkersKeep', label: 'Reserved markers: keep', unit: 'markers', min: 1, max: 100000 },
]

const INPUT = 'w-24 px-2 py-1 rounded border border-line bg-transparent text-xs text-fg'

function valueOf(s: OpsRetention, key: FieldKey): number {
  return key === 'maxAgeDays' ? s.runLogs.maxAgeDays : s[key]
}

function patchOf(key: FieldKey, n: number) {
  return key === 'maxAgeDays' ? { runLogs: { maxAgeDays: n } } : { [key]: n }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

function describe(label: string, bytes: number, files: number): string {
  return `${label}: ${formatBytes(bytes)} in ${files.toLocaleString('en-US')} files`
}

/** Ops data retention section of Settings → Session Manager; consumes window.api.opsRetention. */
export function SettingsOpsRetention() {
  const show = useToast((s) => s.show)
  const [settings, setSettings] = useState<OpsRetention | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<OpsRetentionPreview | null>(null)

  const fail = useCallback(
    (e: unknown) => show('error', e instanceof Error ? e.message : String(e)),
    [show],
  )

  const loadPreview = useCallback(async () => {
    try {
      setPreview(await window.api.opsRetention.preview())
    } catch (e) {
      fail(e)
    }
  }, [fail])

  useEffect(() => {
    let alive = true
    window.api.opsRetention
      .get()
      .then((s) => {
        if (alive) setSettings(s)
      })
      .catch((e) => {
        if (alive) fail(e)
      })
    void loadPreview()
    return () => {
      alive = false
    }
  }, [fail, loadPreview])

  const save = async (f: (typeof FIELDS)[number]) => {
    if (!settings) return
    const raw = drafts[f.key]
    if (raw === undefined) return
    const parsed = Number(raw)
    setDrafts((d) => {
      const { [f.key]: _drop, ...rest } = d
      return rest
    })
    if (raw.trim() === '' || !Number.isFinite(parsed)) return
    const n = Math.min(f.max, Math.max(f.min, Math.round(parsed)))
    if (n === valueOf(settings, f.key)) return
    try {
      setSettings(await window.api.opsRetention.set(patchOf(f.key, n)))
      await loadPreview()
    } catch (e) {
      fail(e)
    }
  }

  const total = preview
    ? preview.runLogs.bytes + preview.runsArchive.bytes + preview.tmp.bytes
    : 0
  const totalFiles = preview
    ? preview.runLogs.files + preview.runsArchive.entries + preview.tmp.files
    : 0

  return (
    <section data-testid="settings-ops-retention" className="border border-line rounded p-3 space-y-3">
      <div className="space-y-1">
        <span className="text-fg text-xs font-medium">Ops data retention</span>
        <p className="text-fg-faint text-[11px]">
          How long the daily sweep keeps scheduler and audit data. Machine-wide.
        </p>
      </div>

      {settings && (
        <div className="space-y-2">
          {FIELDS.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-xs text-fg-dim">
              <span className="w-48">{f.label}</span>
              <input
                type="number"
                data-testid={`ops-retention-${f.key}`}
                className={INPUT}
                min={f.min}
                max={f.max}
                value={drafts[f.key] ?? String(valueOf(settings, f.key))}
                onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                onBlur={() => void save(f)}
              />
              <span className="text-fg-faint">{f.unit}</span>
            </label>
          ))}
          <p className="text-fg-dim text-xs">Archived transcripts: kept forever</p>
        </div>
      )}

      {preview && (
        <div data-testid="ops-retention-preview" className="space-y-1 text-xs text-fg-dim">
          <div className="text-fg">Current policy would free {formatBytes(total)} in {totalFiles.toLocaleString('en-US')} files</div>
          <div>{describe('Run logs', preview.runLogs.bytes, preview.runLogs.files)}</div>
          <div>{describe('Runs archive', preview.runsArchive.bytes, preview.runsArchive.entries)}</div>
          <div>{describe('Stale temp files', preview.tmp.bytes, preview.tmp.files)}</div>
          <p className="text-fg-faint text-[11px]">
            Nothing is deleted until the daily sweep runs.
          </p>
        </div>
      )}
    </section>
  )
}
