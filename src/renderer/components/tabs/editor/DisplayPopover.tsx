/**
 * DisplayPopover — "Display" button in the EditorView header, replacing the
 * old inline strip of tiny pref buttons (font zoom / wrap / minimap / theme /
 * autosave). Backed entirely by `useEditorPrefs` — a global, persisted store,
 * so no props are needed beyond the button/popover's own open state.
 */

import { useState } from 'react'
import { Z } from '../../../lib/zLayers'
import { useEditorPrefs } from '../../../state/editorPrefs'

export function DisplayPopover() {
  const [open, setOpen] = useState(false)
  const prefs = useEditorPrefs()

  return (
    <div className="relative inline-block mr-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`px-2 py-0.5 text-[10px] border border-line rounded ${open ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`}
        title="Display preferences"
      >
        Display
      </button>

      {open && (
        <>
          <div className={`fixed inset-0 ${Z.contextMenuScrim}`} onMouseDown={() => setOpen(false)} />
          <div className={`absolute right-0 top-full mt-1 ${Z.contextMenu} w-60 rounded-lg border border-line bg-bg-elev shadow-xl text-xs p-2 space-y-1.5`}>
            <Row label="Text size">
              <div className="flex items-center rounded border border-line overflow-hidden">
                <button onClick={() => prefs.bumpFontSize(-1)} className="px-1.5 py-0.5 text-[11px] text-fg-faint hover:text-fg" title="Zoom out">A−</button>
                <span className="px-2 text-[10px] text-fg-dim">{prefs.fontSize}</span>
                <button onClick={() => prefs.bumpFontSize(1)} className="px-1.5 py-0.5 text-[11px] text-fg-faint hover:text-fg" title="Zoom in">A+</button>
              </div>
            </Row>
            <Row label="Word wrap">
              <Toggle on={prefs.wordWrap} onClick={prefs.toggleWordWrap} />
            </Row>
            <Row label="Minimap">
              <Toggle on={prefs.minimap} onClick={prefs.toggleMinimap} />
            </Row>
            <Row label="Theme">
              <button
                onClick={() => prefs.setTheme(prefs.theme === 'dark' ? 'paper' : 'dark')}
                className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line rounded"
                title="Toggle editor theme"
              >
                {prefs.theme === 'dark' ? 'Dark' : 'Paper'}
              </button>
            </Row>
            <Row label="Autosave">
              <Toggle on={prefs.autosave} onClick={prefs.toggleAutosave} />
            </Row>
            <Row label="Wide measure">
              <Toggle on={prefs.wideMeasure} onClick={prefs.toggleWideMeasure} />
            </Row>
          </div>
        </>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-fg-faint">{label}</span>
      {children}
    </div>
  )
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 text-[10px] rounded border border-line ${on ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`}
    >
      {on ? 'On' : 'Off'}
    </button>
  )
}
