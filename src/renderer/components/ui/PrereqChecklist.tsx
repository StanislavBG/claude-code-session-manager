import { useCallback, useEffect, useState } from 'react'
import type { PrereqItem } from '../../../preload/api'
import { useToast } from '../../state/toast'
import { Z } from '../../lib/zLayers'

/**
 * Boot-time Setup checklist. Renders nothing while every prerequisite is ok
 * (or once dismissed this session); the dismissal is component state, so it
 * reappears on the next boot while anything is still missing.
 */
export function PrereqChecklist() {
  const [items, setItems] = useState<PrereqItem[]>([])
  const [dismissed, setDismissed] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    return window.api.app
      .prereqs()
      .then((r) => setItems(r))
      .catch((e) => {
        useToast.getState().show('error', `Setup check failed: ${e instanceof Error ? e.message : String(e)}`)
      })
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const install = useCallback((id: string) => {
    setBusyId(id)
    window.api.app
      .prereqsRunFix(id)
      .then((r) => {
        if (!r.ok) useToast.getState().show('error', r.error)
      })
      .catch((e) => {
        useToast.getState().show('error', `Install failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      .finally(() => setBusyId(null))
  }, [])

  const copy = useCallback((command: string) => {
    navigator.clipboard?.writeText(command).catch((e) => {
      useToast.getState().show('error', `Copy failed: ${e instanceof Error ? e.message : String(e)}`)
    })
  }, [])

  if (dismissed || items.length === 0 || items.every((i) => i.ok)) return null

  return (
    <div
      data-testid="prereq-checklist"
      className={`fixed bottom-4 right-4 ${Z.dialog} w-[28rem] max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-auto rounded border border-line bg-bg-elev text-fg shadow-lg p-3 text-xs`}
    >
      <div className="font-medium mb-2 text-sm">Setup checklist</div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} data-testid={`prereq-row-${item.id}`}>
            <div className="flex items-center gap-2">
              <span className={item.ok ? 'text-sage-dark' : 'text-accent'} aria-hidden="true">
                {item.ok ? '✓' : '⚠'}
              </span>
              <span className="font-medium">{item.label}</span>
              {item.ok && item.version && <span className="text-fg-faint">{item.version}</span>}
            </div>
            {!item.ok && (
              <div className="ml-5 mt-1 space-y-1">
                {item.detail && <div className="text-fg-dim">{item.detail}</div>}
                {item.fix && (
                  <>
                    <code
                      className="block font-mono bg-bg-hi border border-line rounded px-2 py-1 break-all cursor-pointer select-all"
                      title="Click to copy"
                      onClick={() => copy(item.fix!.command)}
                    >
                      {item.fix.command}
                    </code>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => install(item.id)}
                        className="rounded border border-accent px-2 py-0.5 text-accent hover:bg-accent hover:text-bg-hi disabled:opacity-50"
                      >
                        Install
                      </button>
                      {item.fix.url && (
                        <a href={item.fix.url} target="_blank" rel="noreferrer" className="underline text-fg-dim hover:text-fg">
                          How to
                        </a>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2 mt-3">
        <button type="button" onClick={() => void load()} className="underline text-fg-dim hover:text-fg">
          Re-check
        </button>
        <button type="button" onClick={() => setDismissed(true)} className="underline text-fg-dim hover:text-fg">
          Dismiss for this session
        </button>
      </div>
    </div>
  )
}
