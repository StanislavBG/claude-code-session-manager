import { useEffect, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ScopeSwitcher } from '../ui/ScopeSwitcher'
import { SaveBar } from '../ui/SaveBar'
import { MarkdownEditor } from '../ui/MarkdownEditor'
import { EmptyState } from '../ui/EmptyState'
import { ReferencedFilesPanel } from './ReferencedFilesPanel'
import { useConfig } from '../../state/config'
import { useSessions } from '../../state/sessions'
import { CLAUDE_MD_SCOPES, type Scope } from '../../lib/scopes'
import { PromptPresetsLibrary, ViewSwitcher } from './Library'
import { useHomeDir } from '../../lib/useHomeDir'

/** Rough token estimate: ~4 chars per token for English prose. */
function estimateTokens(text: string): number {
  return Math.round(text.length / 4)
}

export function SystemPrompt() {
  const home = useHomeDir()
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const cwd = activeTab?.cwd ?? null

  const [scope, setScope] = useState<Scope>('user')
  const [view, setView] = useState<'installed' | 'library'>('installed')

  const scopePaths = useMemo(() => {
    const out: Partial<Record<Scope, string>> = {}
    for (const s of CLAUDE_MD_SCOPES.scopes) {
      const p = CLAUDE_MD_SCOPES.resolve(s, home ?? '', cwd)
      if (p) out[s] = p
    }
    return out
  }, [home, cwd])

  const activePath = scopePaths[scope] ?? null

  const files = useConfig((s) => s.files)
  const loadText = useConfig((s) => s.loadText)
  const setDraft = useConfig((s) => s.setDraft)
  const saveText = useConfig((s) => s.saveText)
  const revert = useConfig((s) => s.revert)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  useEffect(() => {
    const paths = Object.values(scopePaths).filter(Boolean) as string[]
    paths.forEach((p) => {
      // Always re-read on mount so external edits made while the tab was closed
      // are picked up; keepDirty preserves any unsaved draft.
      loadText(p, true)
      watchFile(p)
    })
    return () => {
      paths.forEach((p) => unwatchFile(p))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scopePaths)])

  const [saveError, setSaveError] = useState<string | null>(null)

  if (!home) return <EmptyState title="loading…" />
  if (view === 'library') {
    return (
      <Panel toolbar={<ViewSwitcher active={view} onChange={setView} installedLabel="Editor" libraryLabel="Presets" />}>
        <PromptPresetsLibrary />
      </Panel>
    )
  }

  const file = activePath ? files[activePath] : null
  const scopeNeedsCwd = (s: Scope) => s !== 'user' && !cwd
  const tokens = file ? estimateTokens(file.draftRaw) : 0
  const chars = file?.draftRaw.length ?? 0

  return (
    <Panel
      toolbar={
        <>
          <ViewSwitcher active={view} onChange={setView} installedLabel="Editor" libraryLabel="Presets" />
          <span className="mx-2 text-fg-faint">·</span>
          <ScopeSwitcher
            scopes={CLAUDE_MD_SCOPES.scopes}
            active={scope}
            onChange={setScope}
            annotate={(s) => {
              if (scopeNeedsCwd(s)) return { exists: false }
              const p = scopePaths[s]
              if (!p) return null
              const f = files[p]
              return { exists: f?.exists ?? false, dirty: f?.dirty ?? false }
            }}
          />
          <span className="ml-3 text-fg-faint truncate">{activePath ?? '—'}</span>
          <div className="flex-1" />
          <span className="text-fg-faint">
            {chars.toLocaleString()} chars · ~{tokens.toLocaleString()} tokens
          </span>
        </>
      }
      footer={
        activePath && file ? (
          <SaveBar
            dirty={file.dirty}
            busy={file.busy}
            parseError={saveError}
            lastSavedAt={file.lastSavedAt}
            leading={file.exists ? null : <span>file will be created on save</span>}
            onSave={async () => {
              setSaveError(null)
              const res = await saveText(activePath)
              if (!res.ok) setSaveError(res.error ?? 'save failed')
            }}
            onRevert={() => {
              setSaveError(null)
              revert(activePath)
            }}
          />
        ) : null
      }
    >
      {scopeNeedsCwd(scope) ? (
        <EmptyState
          title="no active project"
          hint="open a tab in a project directory to edit project or local CLAUDE.md"
        />
      ) : activePath && file ? (
        <div className="h-full flex flex-col">
          <ReferencedFilesPanel activePath={activePath} />
          <div className="flex-1 min-h-0">
            <MarkdownEditor
              path={activePath}
              value={file.draftRaw}
              onChange={(v) => {
                setSaveError(null)
                setDraft(activePath, v)
              }}
            />
          </div>
        </div>
      ) : (
        <EmptyState title="resolving…" />
      )}
    </Panel>
  )
}
