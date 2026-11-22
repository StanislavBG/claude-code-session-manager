import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Toggle } from '../../ui/Toggle'
import { ConfigCard, ConfigDetailHeader } from '../../claudeConfig/ConfigLayout'
import { DocumentEditorPane } from '../editor/DocumentEditorPane'
import { revealInFileExplorer } from '../../../lib/revealInFileExplorer'
import { Z } from '../../../lib/zLayers'
import {
  joinSkillDoc,
  readSkillDescription,
  setSkillDescription,
  splitSkillDoc,
} from '../../../lib/skillFrontmatter'
import type { Scope } from '../../../lib/scopes'

/** The detail view's slice of a Skills list item. */
export interface SkillDetailItem {
  kind: 'skills' | 'commands'
  scope: Scope
  name: string
  /** Absolute path to the markdown file. */
  path: string
  /** Set for an item a plugin adds: the eyebrow names the plugin in place of the scope. */
  plugin?: string
  /** Skills only: `disable-model-invocation: true` in frontmatter. */
  disabled?: boolean
}

interface Props {
  item: SkillDetailItem
  /** Home dir — shortens the eyebrow path to `~/…`. */
  home: string
  /** The useConfig draft of `item.path` (whole file: frontmatter + body). */
  draft: string
  dirty: boolean
  busy: boolean
  lastSavedAt: number | null
  saveError: string | null
  /** Receives the whole new file text. */
  onDraftChange: (raw: string) => void
  onSave: () => void
  onRevert: () => void
  /** Plugin items (FROM PLUGINS): read-only editor, Description as text, no toggle or remove. */
  readOnly?: boolean
  /**
   * The skill's real enable switch — writes `disable-model-invocation` to its SKILL.md.
   * Omitted for commands and plugin items, which have no such mechanism.
   */
  onToggleEnabled?: (enabled: boolean) => void
  /** Moves the skill folder to trash. Omitted when the item cannot be removed here. */
  onRemove?: () => void
}

function shortPath(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

/** `⋯` actions: Reveal in File Explorer, and Remove skill when the item can be removed. */
function MoreMenu({ items }: { items: ReadonlyArray<{ label: string; testId: string; danger?: boolean; onSelect: () => void }> }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Close on Escape or a mousedown outside both the trigger and the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="skill-detail-more"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="h-9 w-9 inline-flex items-center justify-center rounded-[10px] bg-bg-hi border border-line text-fg-dim hover:text-fg hover:border-rule"
      >
        ⋯
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="More actions"
          data-testid="skill-detail-more-menu"
          className={`absolute ${Z.dialog} right-0 top-[42px] min-w-[200px] p-[5px] flex flex-col bg-bg-hi border border-line rounded-lg shadow-lg text-[13px] text-fg`}
        >
          {items.map((item) => (
            <button
              key={item.testId}
              type="button"
              role="menuitem"
              data-testid={item.testId}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className={`px-2.5 py-[7px] rounded-[5px] text-left whitespace-nowrap hover:bg-bg-elev ${item.danger ? 'text-red-400' : ''}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Skills detail (claude-config design, renders 13/09/01): eyebrow `SKILL · <SCOPE> · <path>`,
 * mono `/name`, Enabled switch + `⋯`; the DESCRIPTION card Claude reads to decide when to use
 * the skill; the body in the shared DocumentEditorPane (Document mode by default). The
 * frontmatter never enters the editor — a body edit rejoins it byte-for-byte.
 * `readOnly` (plugin items): the same layout with nothing editable.
 */
export function SkillDetail({
  item,
  home,
  draft,
  dirty,
  busy,
  lastSavedAt,
  saveError,
  onDraftChange,
  onSave,
  onRevert,
  readOnly = false,
  onToggleEnabled,
  onRemove,
}: Props) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const parts = useMemo(() => splitSkillDoc(draft), [draft])
  const description = useMemo(() => readSkillDescription(draft) ?? '', [draft])

  const kindLabel = item.kind === 'commands' ? 'COMMAND' : 'SKILL'
  const where = item.plugin ? `FROM ${item.plugin.toUpperCase()}` : item.scope.toUpperCase()
  const eyebrow = `${kindLabel} · ${where} · ${shortPath(item.path, home)}`

  const menuItems = [
    { label: 'Reveal in File Explorer', testId: 'skill-detail-reveal', onSelect: () => revealInFileExplorer(item.path) },
    ...(onRemove && !readOnly
      ? [{ label: 'Remove skill…', testId: 'skill-detail-remove', danger: true, onSelect: () => setConfirmRemove(true) }]
      : []),
  ]

  const actions = (
    <>
      {readOnly && (
        <span
          data-testid="skill-detail-readonly"
          className="text-xs font-semibold px-2 py-0.5 rounded-full bg-bg-elev border border-line text-fg-dim"
        >
          Read-only
        </span>
      )}
      {onToggleEnabled && !readOnly && (
        <span
          data-testid="skill-detail-enabled"
          className="flex items-center gap-2 text-[13px] text-fg-dim"
          title={dirty ? 'This skill has unsaved edits — save or revert before toggling' : undefined}
        >
          <Toggle checked={!item.disabled} disabled={dirty} onChange={(v) => onToggleEnabled(v)} />
          Enabled
        </span>
      )}
      <MoreMenu items={menuItems} />
    </>
  )

  return (
    <div data-testid="skill-detail" className="flex-1 min-h-0 flex flex-col">
      <ConfigDetailHeader eyebrow={eyebrow} title={`/${item.name}`} actions={actions} />
      {confirmRemove && onRemove && (
        <div
          data-testid="skill-detail-remove-confirm"
          role="alert"
          className="shrink-0 mx-9 mt-4 px-4 py-2.5 rounded-[10px] border border-red-400/40 bg-red-400/10 flex items-center gap-3 text-[13px] text-fg"
        >
          <span className="flex-1 min-w-0">
            Remove /{item.name}? The folder moves to trash; reinstall from the Library.
          </span>
          <button
            type="button"
            onClick={() => {
              setConfirmRemove(false)
              onRemove()
            }}
            className="font-semibold text-red-400 hover:text-red-300"
          >
            confirm
          </button>
          <button type="button" onClick={() => setConfirmRemove(false)} className="text-fg-faint hover:text-fg">
            cancel
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col gap-4 px-9 py-6">
        <ConfigCard label="DESCRIPTION" labelNote="CLAUDE READS THIS TO DECIDE WHEN TO USE IT">
          {readOnly ? (
            <span data-testid="skill-detail-description-text" className="text-fg-dim">
              {description || <span className="text-fg-faint">No description</span>}
            </span>
          ) : (
            <textarea
              data-testid="skill-detail-description"
              aria-label="Description"
              rows={2}
              value={description}
              // A description is one YAML line: Enter never inserts a break.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
              onChange={(e) => onDraftChange(setSkillDescription(draft, e.target.value.replace(/\r?\n/g, ' ')))}
              placeholder="What this does and when Claude should use it"
              className="w-full resize-none bg-transparent outline-none text-fg placeholder:text-fg-faint"
            />
          )}
        </ConfigCard>
        <div
          data-testid="skill-detail-editor"
          data-busy={busy ? 'true' : undefined}
          data-saved-at={lastSavedAt ?? undefined}
          className="flex-1 min-h-[420px] rounded-[14px] border border-line bg-bg-hi overflow-hidden"
        >
          <DocumentEditorPane
            path={item.path}
            value={parts.body}
            defaultMode="document"
            readOnly={readOnly}
            dirty={readOnly ? undefined : dirty}
            onChange={(body) => {
              if (!readOnly) onDraftChange(joinSkillDoc(parts.frontmatter, body))
            }}
            onSave={readOnly ? undefined : onSave}
            onRevert={readOnly ? undefined : onRevert}
          />
        </div>
        {saveError && (
          <div data-testid="skill-detail-save-error" role="alert" className="text-[13px] text-red-400">
            Could not save: {saveError}
          </div>
        )}
      </div>
    </div>
  )
}
