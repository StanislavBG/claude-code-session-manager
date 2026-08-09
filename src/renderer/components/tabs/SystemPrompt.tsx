import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { ReferencedFilesPanel } from './ReferencedFilesPanel'
import { DocumentEditorPane } from './editor/DocumentEditorPane'
import { useConfig } from '../../state/config'
import { CLAUDE_MD_SCOPES } from '../../lib/scopes'
import { PromptPresetsLibrary, ViewSwitcher } from './Library'
import { useHomeDir } from '../../lib/useHomeDir'
import type { ImportRef } from '../../../preload/api'

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
 *
 * Layout (2026-08-08): the screen is a document set, not a single textarea.
 * `~/.claude/CLAUDE.md` and every file it `@`-imports are listed in a left rail
 * (`ReferencedFilesPanel`) and the selected one opens in the app's own document
 * view (`DocumentEditorPane` — the same Edit/Preview/Split + outline + word
 * count chrome the Editor tab uses), replacing the bare Monaco textarea plus
 * the stacked 16rem-tall read-only accordion peeks this screen used to have.
 * Imports are EDITABLE here, through the same dirty-tracked config store and
 * the same SaveBar as the root file: they are literally part of the prompt the
 * CLI loads, so making them read-only just meant a trip to another tab.
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

  // Which document of the set is on screen: null = the root CLAUDE.md itself,
  // otherwise one of its `@`-imports. The rail resets this to null whenever the
  // root file changes, so a selection can never outlive its own import chain.
  const [selectedRef, setSelectedRef] = useState<ImportRef | null>(null)
  const docPath = selectedRef?.path ?? activePath
  // A broken/missing import has nothing to save into — show it, refuse edits.
  const docReadOnly = !!selectedRef && (!selectedRef.ok || !selectedRef.exists)

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

  // The selected import gets the same treatment. Kept separate from the effect
  // above so the root file stays loaded + watched while an import is on screen
  // (its unsaved draft and any external change to it both survive the detour).
  useEffect(() => {
    if (!docPath || docPath === activePath) return
    loadText(docPath, true)
    watchFile(docPath)
    return () => { unwatchFile(docPath) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docPath, activePath])

  const [saveError, setSaveError] = useState<string | null>(null)
  // Clear a stale save error when the user moves to a different document.
  const selectDoc = useCallback((ref: ImportRef | null) => {
    setSaveError(null)
    setSelectedRef(ref)
  }, [])

  if (!home) return <EmptyState title="loading…" />
  if (view === 'library') {
    return (
      <Panel toolbar={<ViewSwitcher active={view} onChange={setView} installedLabel="Editor" libraryLabel="Presets" />}>
        <PromptPresetsLibrary />
      </Panel>
    )
  }

  const rootFile = activePath ? files[activePath] : null
  // The document actually on screen — the root file, or the selected import.
  const doc = docPath ? files[docPath] : null
  const docText = doc?.draftRaw ?? ''
  const tokens = estimateTokens(docText)
  const chars = docText.length
  const missing = docReadOnly

  const save = async () => {
    if (!docPath) return
    setSaveError(null)
    const res = await saveText(docPath)
    if (!res.ok) setSaveError(res.error ?? 'save failed')
  }

  return (
    <Panel
      toolbar={
        <>
          <ViewSwitcher active={view} onChange={setView} installedLabel="Editor" libraryLabel="Presets" />
          <span className="mx-2 text-fg-faint">·</span>
          <span className="text-fg-dim">User scope</span>
          <span className="ml-3 text-fg-faint truncate">{docPath ?? '—'}</span>
          <div className="flex-1" />
          <span className="text-fg-faint">
            {chars.toLocaleString()} chars · ~{tokens.toLocaleString()} tokens
          </span>
        </>
      }
      footer={
        docPath && doc && !missing ? (
          <SaveBar
            dirty={doc.dirty}
            busy={doc.busy}
            parseError={saveError}
            lastSavedAt={doc.lastSavedAt}
            leading={
              doc.exists ? (
                selectedRef ? <span>editing an imported file</span> : null
              ) : (
                <span>file will be created on save</span>
              )
            }
            onSave={save}
            onRevert={() => {
              setSaveError(null)
              revert(docPath)
            }}
          />
        ) : null
      }
    >
      {activePath && rootFile ? (
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
          <div className="flex-1 min-h-0 flex">
            <ReferencedFilesPanel
              activePath={activePath}
              selectedPath={docPath}
              onSelect={selectDoc}
            />
            <div className="flex-1 min-w-0 flex flex-col">
              {missing && (
                <div
                  data-testid="system-prompt-missing-note"
                  className="shrink-0 border-b border-line bg-bg-elev px-3 py-1.5 text-[11px] text-amber-400/90"
                >
                  This import does not resolve to a readable file — the CLI will skip it.
                </div>
              )}
              {docPath && (
                <div className="flex-1 min-h-0">
                  <DocumentEditorPane
                    // Remount per document so view mode / outline / cursor
                    // never carry over from the file the user just left.
                    key={docPath}
                    path={docPath}
                    value={docText}
                    readOnly={missing}
                    defaultMode="split"
                    onChange={(v) => {
                      setSaveError(null)
                      setDraft(docPath, v)
                    }}
                    onSave={() => { void save() }}
                  />
                </div>
              )}
            </div>
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
