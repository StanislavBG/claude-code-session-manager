import { useEffect, useState } from 'react'
import { useAppPreview, ensureAppPreviewSubscription } from '../../state/appPreview'
import { toast } from '../../state/toast'
import type { AppPreviewScript } from '../../../preload/api'

/**
 * Epic header "Run preview" control (app preview plan). Runs one of the
 * project's package.json scripts only after the user picks and confirms it,
 * opens the running URL in the SYSTEM browser (no webview — prod never loads
 * remote URLs), and stops it. Failure / unexpected-stop toasts come from the
 * appPreview store; this component only toasts its own call errors.
 */

const BTN =
  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-semibold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
const SECONDARY = `${BTN} bg-bg-hi text-fg-dim border-line hover:text-fg`

interface Picker {
  dir: string
  inWorktree: boolean
  scripts: AppPreviewScript[]
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function EpicAppPreview({ epicId, cwd }: { epicId: string; cwd: string }) {
  const preview = useAppPreview((s) => s.byEpic[epicId])
  const upsert = useAppPreview((s) => s.upsert)
  const [picker, setPicker] = useState<Picker | null>(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    ensureAppPreviewSubscription()
  }, [])

  const status = preview?.status
  const live = status === 'starting' || status === 'running'

  async function onRunPreview() {
    setBusy(true)
    try {
      const res = await window.api.appPreview.scripts({ cwd, epicId })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      const names = res.scripts.map((s) => s.name)
      setSelected(res.suggested && names.includes(res.suggested) ? res.suggested : (names[0] ?? ''))
      setPicker({ dir: res.dir, inWorktree: res.inWorktree, scripts: res.scripts })
    } catch (err: unknown) {
      toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  async function onConfirm() {
    const script = selected
    setPicker(null)
    setBusy(true)
    try {
      const res = await window.api.appPreview.start({ cwd, epicId, script })
      if (res.ok) upsert(res.state)
      else toast.error(res.error)
    } catch (err: unknown) {
      toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  async function onOpen(url: string) {
    try {
      await window.api.shell.open({ as: 'external', url })
    } catch (err: unknown) {
      toast.error(errMsg(err))
    }
  }

  async function onStop() {
    try {
      await window.api.appPreview.stop({ epicId })
    } catch (err: unknown) {
      toast.error(errMsg(err))
    }
  }

  const stopBtn = (
    <button type="button" onClick={onStop} data-testid="epic-preview-stop" className={SECONDARY}>
      Stop preview
    </button>
  )

  if (live && preview) {
    return (
      <div className="inline-flex items-center gap-1.5" data-testid="epic-preview">
        {status === 'starting' ? (
          <button type="button" disabled data-testid="epic-preview-starting" className={SECONDARY}>
            Starting preview…
          </button>
        ) : (
          <button
            type="button"
            onClick={() => preview.url && onOpen(preview.url)}
            disabled={!preview.url}
            title={preview.url ?? undefined}
            data-testid="epic-preview-open"
            className={SECONDARY}
          >
            Open preview
          </button>
        )}
        {stopBtn}
      </div>
    )
  }

  if (picker) {
    const command = picker.scripts.find((s) => s.name === selected)?.command ?? ''
    return (
      <div className="inline-flex items-center gap-1.5 text-[11.5px] text-fg-dim" data-testid="epic-preview-picker">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          data-testid="epic-preview-script"
          className="rounded-md border border-line bg-bg-hi px-1.5 py-1 text-[11.5px] text-fg"
        >
          {picker.scripts.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        <code title={command} data-testid="epic-preview-command" className="max-w-[16rem] truncate font-mono text-[11px]">
          {command}
        </code>
        <span title={picker.dir} className="max-w-[12rem] truncate">
          in {picker.dir}
          {!picker.inWorktree && <span className="text-delta-bad"> (not an isolated worktree)</span>}
        </span>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!selected}
          data-testid="epic-preview-confirm"
          className={`${BTN} bg-accent text-white border-accent hover:bg-accent/90`}
        >
          Run
        </button>
        <button type="button" onClick={() => setPicker(null)} data-testid="epic-preview-cancel" className={SECONDARY}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onRunPreview}
      disabled={busy}
      title="Run one of this project's package.json scripts and open it in your browser"
      data-testid="epic-preview-run"
      className={SECONDARY}
    >
      Run preview
    </button>
  )
}
