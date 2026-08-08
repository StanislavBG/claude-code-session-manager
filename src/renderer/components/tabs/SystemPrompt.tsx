import { memo, useEffect, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { SaveBar } from '../ui/SaveBar'
import { MarkdownEditor } from '../ui/MarkdownEditor'
import { EmptyState } from '../ui/EmptyState'
import { ReferencedFilesPanel } from './ReferencedFilesPanel'
import { useConfig } from '../../state/config'
import { CLAUDE_MD_SCOPES } from '../../lib/scopes'
import { PromptPresetsLibrary, ViewSwitcher } from './Library'
import { useHomeDir } from '../../lib/useHomeDir'

/**
 * System Prompt edits exactly ONE file: `~/.claude/CLAUDE.md`, the user-scope
 * instruction set the `claude` CLI loads into every session it starts on this
 * machine.
 *
 * It used to carry the three-way User/Project/Local ScopeSwitcher that
 * Settings and the other scoped editors carry, defaulting the scope off
 * `navFace`. That was wrong for this screen once it became HOME-only in the
 * sidebar (navGroups.ts): the Home face has no project context at all, so the
 * Project (`<cwd>/CLAUDE.md`) and Local (`<cwd>/CLAUDE.local.md`) tabs were
 * either disabled ("no active project") or — worse — silently editing whatever
 * unrelated project happened to own the active top tab while the user was
 * browsing a machine-wide screen. Those two files are contextual to a project
 * and are discovered by the CLI from the session's own cwd at invocation time;
 * they are not curated from Home. Nothing else changed — the file, the
 * `@`-import panel, the Presets library, and the save/revert path are the
 * same, there is just one scope now instead of three.
 */
const USER_SCOPE_NOTE = {
  title: 'User system prompt',
  body:
    'This is the real ~/.claude/CLAUDE.md on disk — the instructions the claude CLI loads into every session it starts on this machine, in every project. A project\'s own CLAUDE.md / CLAUDE.local.md are read from that project\'s directory when a session launches there; they are not edited here.',
}

/** Rough token estimate: ~4 chars per token for English prose. */
function estimateTokens(text: string): number {
  return Math.round(text.length / 4)
}

function SystemPromptComponent() {
  const home = useHomeDir()
  const [view, setView] = useState<'installed' | 'library'>('installed')

  // Single scope, single path. `home` is null only for the first tick before
  // useHomeDir resolves, which the loading EmptyState below covers.
  const activePath = useMemo(
    () => (home ? CLAUDE_MD_SCOPES.resolve('user', home, null) : null),
    [home],
  )

  const files = useConfig((s) => s.files)
  const loadText = useConfig((s) => s.loadText)
  const setDraft = useConfig((s) => s.setDraft)
  const saveText = useConfig((s) => s.saveText)
  const revert = useConfig((s) => s.revert)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  useEffect(() => {
    if (!activePath) return
    // Always re-read on mount so external edits made while the tab was closed
    // are picked up; keepDirty preserves any unsaved draft.
    loadText(activePath, true)
    watchFile(activePath)
    return () => { unwatchFile(activePath) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath])

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
  const tokens = file ? estimateTokens(file.draftRaw) : 0
  const chars = file?.draftRaw.length ?? 0

  return (
    <Panel
      toolbar={
        <>
          <ViewSwitcher active={view} onChange={setView} installedLabel="Editor" libraryLabel="Presets" />
          <span className="mx-2 text-fg-faint">·</span>
          <span className="text-fg-dim">User scope</span>
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
      {activePath && file ? (
        <div className="h-full flex flex-col">
          <div
            data-testid="system-prompt-scope-note"
            className="shrink-0 border-b border-line bg-bg-elev px-3 py-2 text-[11.5px] leading-snug"
          >
            <span className="font-semibold text-fg">{USER_SCOPE_NOTE.title}</span>
            <span className="mx-1.5 text-fg-faint">·</span>
            <span className="text-fg-dim">{USER_SCOPE_NOTE.body}</span>
            <span className="ml-1.5 font-mono text-fg-faint">{activePath}</span>
          </div>
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

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const SystemPrompt = memo(SystemPromptComponent)
