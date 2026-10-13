import { memo } from 'react'
import type { KeyboardEvent } from 'react'
import { slugFromTitle } from './model'

interface Props {
  mode: 'edit' | 'new' | 'none'
  name: string | null
  title: string
  onTitle: (t: string) => void
  body: string
  onBody: (b: string) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  dirty: boolean
}

function MemoryEditorPaneImpl({ mode, name, title, onTitle, body, onBody, onSave, onCancel, saving, dirty }: Props) {
  if (mode === 'none') {
    return (
      <div data-testid="mx-editor-none" className="flex-1 flex flex-col items-center justify-center text-center gap-1.5 p-10">
        <div className="font-serif text-[18px] text-fg">No memory selected</div>
        <div className="text-[13px] text-fg-dim">Pick one from the list, or press /.</div>
      </div>
    )
  }

  const saveDisabled = saving || (mode === 'edit' && !dirty)

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (!saveDisabled) onSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div data-testid="mx-editor" className="flex-1 min-h-0 flex flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 px-[22px] pt-3.5 pb-3 border-b border-rule-structural">
        <h2 className="flex-1 min-w-0 truncate font-mono text-[15px] font-medium text-fg">
          {mode === 'new' ? 'New memory' : `Editing ${name ?? ''}`}
        </h2>
        <button
          type="button"
          data-testid="mx-editor-cancel"
          onClick={onCancel}
          className="h-7 px-3 rounded-[5px] border border-rule-structural bg-bg text-xs font-medium text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="mx-editor-save"
          disabled={saveDisabled}
          onClick={onSave}
          className="h-7 px-3.5 rounded-[5px] bg-accent text-white text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Save
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col gap-2.5 px-[22px] py-4">
        {mode === 'new' && (
          <div className="flex flex-col gap-1">
            <label htmlFor="mx-editor-name" className="text-[11px] tracking-[.06em] font-semibold text-fg-faint">
              NAME
            </label>
            <input
              id="mx-editor-name"
              data-testid="mx-editor-name"
              value={title}
              onChange={(e) => onTitle(e.target.value)}
              placeholder="e.g. deploy freeze fridays"
              className="h-8 px-2.5 rounded-[5px] border border-rule bg-bg-hi font-mono text-[13px] font-normal text-fg outline-none"
            />
            {title.trim() !== '' && (
              <div className="font-mono text-[11px] text-fg-faint">→ {slugFromTitle(title)}.md</div>
            )}
          </div>
        )}
        <textarea
          data-testid="mx-editor-body"
          value={body}
          onChange={(e) => onBody(e.target.value)}
          spellCheck={false}
          className="flex-1 min-h-0 w-full resize-none px-3.5 py-3 rounded-md border border-rule bg-bg-hi font-mono text-[13px] leading-[1.7] text-fg outline-none"
        />
        <div className="flex items-center gap-2 text-[11.5px] text-fg-faint">
          <span>
            {`Markdown. Frontmatter is ${mode === 'new' ? 'added' : 'kept'} on save. Saving marks the memory verified.`}
          </span>
          {dirty && mode === 'edit' && <span className="text-accent font-semibold">unsaved</span>}
        </div>
      </div>
    </div>
  )
}

export const MemoryEditorPane = memo(MemoryEditorPaneImpl)
