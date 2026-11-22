/**
 * ClaudeMdWorkbench — the CLAUDE.md tab of both Claude config pages (Home `~/.claude` and
 * Project), built on ConfigLayout. Design: design-mocks/claude-config renders 10 (Home) and
 * 06 (Project), DESIGN_SPEC.md §2-3, copy in ConfigWorkbench.dc.html.
 *
 * Left column: a FILE + ITS IMPORTS card — one radio row per root file the host offers
 * (Home: ~/.claude/CLAUDE.md; Project: CLAUDE.md and CLAUDE.local.md), then every file the
 * selected root `@`-imports (resolved by main's `config:parse-imports`), each with its line
 * count, plus a ~N tokens estimate (chars/4) for the whole set — then the EVERY SESSION LOADS
 * order. Detail: ConfigDetailHeader + the shared DocumentEditorPane (Document mode), reading
 * and saving through the config store (loadText / saveText, mtime-checked), with the SaveBar
 * beneath it. A root file that does not exist yet shows the designed empty state.
 *
 * The design's `Draft it with /init` button is omitted: the app has no action that runs /init.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ConfigWorkbench, ConfigDetailHeader } from './ConfigLayout'
import { DocumentEditorPane } from '../tabs/editor/DocumentEditorPane'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { shortenHome } from '../ui/SourceChip'
import { useConfig } from '../../state/config'
import { toast } from '../../state/toast'
import { basename } from '../../lib/basename'
import { estimateTokens } from '../../lib/estimateTokens'
import type { ImportRef } from '../../../preload/api'

const EYEBROW = 'text-[10.5px] font-semibold uppercase tracking-[0.1em] text-fg-faint'
const CONFLICT_HINT = 'changed on disk since it was loaded. Revert reloads it'
/** A burst of external writes to the root file collapses into one re-parse. */
const REPARSE_DEBOUNCE_MS = 300

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function countLines(text: string): number {
  if (!text) return 0
  return text.replace(/\n$/, '').split('\n').length
}

export interface ClaudeMdRoot {
  path: string
  /** Row subtitle, e.g. `Project · in git`. */
  label: string
  /** Header eyebrow continuation, e.g. `PROJECT INSTRUCTIONS`. */
  eyebrow: string
}

export interface ClaudeMdWorkbenchProps {
  home: string
  scope: 'user' | 'project'
  /** The root files this page edits, in row order. */
  roots: ReadonlyArray<ClaudeMdRoot>
  activeRoot: string
  /** A different root row was picked. Omit when there is only one root. */
  onSelectRoot?: (path: string) => void
  /** Empty-state copy for a root file that does not exist yet. */
  empty: { title: string; body: string }
  /** Optional explanatory note under the header. */
  note?: ReactNode
  /** Extra header actions (Insert preset, SourceChip…); the function form learns whether an import is on screen. */
  headerActions?: ReactNode | ((state: { importSelected: boolean }) => ReactNode)
  /** Prefix for the missing / read-only import notes' test ids. */
  testIdPrefix?: string
}

/** The root file's flattened `@`-import chain, re-parsed when its saved disk text changes. */
function useImports(activePath: string): ImportRef[] {
  const [found, setFound] = useState<{ path: string; imports: ImportRef[] } | null>(null)
  const generationRef = useRef(0)
  const parsedPathRef = useRef<string | null>(null)
  const diskRaw = useConfig((s) => s.files[activePath]?.diskRaw)

  useEffect(() => {
    generationRef.current += 1
    // Wait for the store's first read of the root: parsing before it would be cancelled by the
    // load's own diskRaw change and re-run only after the debounce.
    if (diskRaw === undefined) return
    const immediate = parsedPathRef.current !== activePath
    parsedPathRef.current = activePath
    let cancelled = false
    const run = () => {
      generationRef.current += 1
      const generation = generationRef.current
      Promise.resolve()
        .then(() => window.api.config.parseImports(activePath))
        .then((res) => {
          if (cancelled || generationRef.current !== generation) return
          if (res.ok) setFound({ path: activePath, imports: res.imports })
          else {
            setFound({ path: activePath, imports: [] })
            toast.error(res.error || 'failed to parse @-imports')
          }
        })
        .catch((e: unknown) => {
          if (cancelled || generationRef.current !== generation) return
          setFound({ path: activePath, imports: [] })
          toast.error(`Couldn't list the @-imports of ${activePath}: ${errText(e)}`)
        })
    }
    const timer = immediate ? null : setTimeout(run, REPARSE_DEBOUNCE_MS)
    if (immediate) run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [activePath, diskRaw])

  return useMemo(() => (found && found.path === activePath ? found.imports : []), [found, activePath])
}

/** Disk text of files that are listed but not open in the store (other roots, imports) — for line counts. */
function usePeekTexts(paths: ReadonlyArray<string>): Record<string, { exists: boolean; text: string }> {
  const [peek, setPeek] = useState<Record<string, { exists: boolean; text: string }>>({})
  const key = paths.join('\n')
  useEffect(() => {
    let live = true
    for (const p of paths) {
      Promise.resolve()
        .then(() => window.api.config.readText(p))
        .then((r) => {
          if (live) setPeek((m) => ({ ...m, [p]: { exists: !!r.exists, text: r.text ?? '' } }))
        })
        .catch(() => {
          if (live) setPeek((m) => ({ ...m, [p]: { exists: false, text: '' } }))
        })
    }
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return peek
}

function RadioDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`w-4 h-4 shrink-0 mt-0.5 rounded-full box-border ${on ? 'border-[5px] border-fg' : 'border-[1.5px] border-fg-faint'}`}
    />
  )
}

interface FileRowProps {
  name: string
  trailing: ReactNode
  meta: string
  selected: boolean
  testId: string
  title: string
  onSelect: () => void
}

function FileRow({ name, trailing, meta, selected, testId, title, onSelect }: FileRowProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-current={selected}
      data-testid={testId}
      title={title}
      onClick={onSelect}
      className={`w-full text-left flex gap-[11px] p-2.5 rounded-[10px] border focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        selected ? 'bg-bg border-line' : 'border-transparent hover:bg-bg/60'
      }`}
    >
      <RadioDot on={selected} />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className={`flex-1 min-w-0 truncate font-mono text-[13px] ${selected ? 'font-semibold text-fg' : 'font-medium text-fg-dim'}`}>
            {name}
          </span>
          <span className="shrink-0 text-[11px] text-fg-faint">{trailing}</span>
        </span>
        <span className="block text-xs text-fg-faint truncate">{meta}</span>
      </span>
    </button>
  )
}

function SessionLoads({ scope }: { scope: 'user' | 'project' }) {
  const steps =
    scope === 'user'
      ? [
          { path: '~/.claude/CLAUDE.md', note: 'this file · every project', here: true },
          { path: '<project>/CLAUDE.md', note: 'per project · in its Claude config', here: false },
          { path: '<project>/CLAUDE.local.md', note: 'per project · that machine only', here: false },
        ]
      : [
          { path: '~/.claude/CLAUDE.md', note: 'global · edited in Home', here: false },
          { path: '<project>/CLAUDE.md', note: 'project · in git · edited here', here: true },
          { path: '<project>/CLAUDE.local.md', note: 'local · this machine · edited here', here: true },
        ]
  return (
    <div data-testid="claude-md-session-loads" className="flex flex-col px-1">
      <span className={`${EYEBROW} mb-3`}>EVERY SESSION LOADS</span>
      {steps.map((s, i) => (
        <div key={s.path} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className={`w-2.5 h-2.5 mt-1 rounded-full box-border ${s.here ? 'border-2 border-accent' : 'border-[1.5px] border-fg-faint'}`} />
            {i < steps.length - 1 && <span className="w-px flex-1 bg-line my-[3px]" />}
          </div>
          <div className={i < steps.length - 1 ? 'pb-3.5' : ''}>
            <div className={`font-mono text-[12.5px] ${s.here ? 'font-semibold text-fg' : 'text-fg-dim'}`}>{s.path}</div>
            <div className="text-xs text-fg-faint whitespace-nowrap">{s.note}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function ClaudeMdWorkbench({
  home,
  scope,
  roots,
  activeRoot,
  onSelectRoot,
  empty,
  note,
  headerActions,
  testIdPrefix = 'claude-md',
}: ClaudeMdWorkbenchProps) {
  const files = useConfig((s) => s.files)
  const loadText = useConfig((s) => s.loadText)
  const setDraft = useConfig((s) => s.setDraft)
  const saveText = useConfig((s) => s.saveText)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  const imports = useImports(activeRoot)
  // Which document is on screen: null = the active root itself, otherwise one of its imports.
  const [selected, setSelected] = useState<{ root: string; ref: ImportRef } | null>(null)
  const selectedRef = selected && selected.root === activeRoot ? selected.ref : null
  const docPath = selectedRef?.path ?? activeRoot

  // A root the user chose to start typing into while it does not exist yet.
  const [typingIn, setTypingIn] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Imports outside the write boundary are viewable but config:write-text would refuse them.
  const [unwritable, setUnwritable] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const p = selectedRef?.path
    if (!p || !selectedRef.ok || !selectedRef.exists) return
    let live = true
    Promise.resolve()
      .then(() => window.api.config.canWrite(p))
      .then((ok) => { if (live) setUnwritable((m) => ({ ...m, [p]: ok === false })) })
      .catch(() => {})
    return () => { live = false }
  }, [selectedRef])

  useEffect(() => {
    // Re-read on every open so edits made elsewhere show up; keepDirty keeps an unsaved draft.
    loadText(activeRoot, true).catch((e: unknown) => toast.error(`Couldn't read ${activeRoot}: ${errText(e)}`))
    watchFile(activeRoot)
    return () => { unwatchFile(activeRoot) }
  }, [activeRoot, loadText, watchFile, unwatchFile])

  // The selected import gets the same treatment; the root stays loaded + watched meanwhile.
  useEffect(() => {
    if (docPath === activeRoot) return
    loadText(docPath, true).catch((e: unknown) => toast.error(`Couldn't read ${docPath}: ${errText(e)}`))
    watchFile(docPath)
    return () => { unwatchFile(docPath) }
  }, [docPath, activeRoot, loadText, watchFile, unwatchFile])

  const otherRoots = useMemo(() => roots.map((r) => r.path).filter((p) => p !== activeRoot), [roots, activeRoot])
  const importPaths = useMemo(() => imports.filter((i) => i.ok && i.exists).map((i) => i.path), [imports])
  const peekPaths = useMemo(() => [...otherRoots, ...importPaths], [otherRoots, importPaths])
  const peek = usePeekTexts(peekPaths)

  const selectImport = useCallback((ref: ImportRef | null) => {
    setSaveError(null)
    setSelected(ref ? { root: activeRoot, ref } : null)
  }, [activeRoot])

  const selectRoot = useCallback((path: string) => {
    setSaveError(null)
    setSelected(null)
    if (path !== activeRoot) onSelectRoot?.(path)
  }, [activeRoot, onSelectRoot])

  const save = useCallback(async () => {
    setSaveError(null)
    // No `force`: saveText refuses with 'conflict' when the disk copy is newer than the draft's base.
    const res = await saveText(docPath)
    if (!res.ok) setSaveError(res.error === 'conflict' ? CONFLICT_HINT : res.error ?? 'save failed')
  }, [docPath, saveText])

  // Revert re-reads the file, so after a conflict the draft is rebased on what is on disk now.
  const revert = useCallback(() => {
    setSaveError(null)
    loadText(docPath).catch((e: unknown) => toast.error(`Couldn't read ${docPath}: ${errText(e)}`))
  }, [docPath, loadText])

  const textOf = (p: string): { exists: boolean; text: string } | null => {
    const f = files[p]
    if (f) return { exists: f.exists, text: f.draftRaw }
    return peek[p] ?? null
  }

  const rootFile = files[activeRoot]
  if (!rootFile) return <EmptyState title="loading…" />

  const doc = files[docPath]
  const docText = doc?.draftRaw ?? ''
  const outsideBoundary = !!selectedRef && unwritable[selectedRef.path] === true
  const importMissing = !!selectedRef && (!selectedRef.ok || !selectedRef.exists)
  const readOnly = importMissing || outsideBoundary
  const rootMissing = !selectedRef && !rootFile.exists
  const showEmpty = rootMissing && docText === '' && typingIn !== activeRoot

  const totalTokens =
    estimateTokens(rootFile.draftRaw) +
    importPaths.reduce((n, p) => n + estimateTokens(textOf(p)?.text ?? ''), 0)

  const activeMeta = roots.find((r) => r.path === activeRoot)
  const eyebrow = selectedRef
    ? `${shortenHome(selectedRef.path, home)} · IMPORTED BY ${basename(activeRoot)}`
    : `${shortenHome(activeRoot, home)} · ${activeMeta?.eyebrow ?? ''}`

  const list = (
    <>
      <div data-testid="claude-md-file-card" role="radiogroup" aria-label="Instruction files" className="px-3.5 pt-3.5 pb-3 rounded-[14px] bg-bg-hi border border-line flex flex-col gap-1.5">
        <div className="flex items-center px-0.5 pb-1">
          <span className={`flex-1 ${EYEBROW}`}>FILE + ITS IMPORTS</span>
          <span className="text-[11.5px] text-fg-faint">~{totalTokens.toLocaleString()} tokens</span>
        </div>
        {roots.map((r) => {
          const isActive = r.path === activeRoot
          const info = textOf(r.path)
          const trailing = info == null ? '' : info.exists ? `${countLines(info.text)} lines` : 'missing'
          return (
            <FileRow
              key={r.path}
              name={basename(r.path)}
              trailing={trailing}
              meta={r.label}
              title={r.path}
              selected={isActive && !selectedRef}
              testId={isActive ? 'referenced-file-root' : 'claude-md-root-row'}
              onSelect={() => selectRoot(r.path)}
            />
          )
        })}
        {imports.length > 0 && (
          <div data-testid="referenced-files-rail" className="flex flex-col gap-1.5">
            {imports.map((ref) => {
              const missing = !ref.ok || !ref.exists
              return (
                <FileRow
                  key={ref.path}
                  name={basename(ref.path)}
                  trailing={
                    missing ? (
                      <span data-testid="referenced-file-missing" className="text-amber-400/90">missing</span>
                    ) : (
                      `${countLines(textOf(ref.path)?.text ?? '')} lines`
                    )
                  }
                  meta="Imported · editable here"
                  title={ref.path}
                  selected={selectedRef?.path === ref.path}
                  testId="referenced-file-row"
                  onSelect={() => selectImport(ref)}
                />
              )
            })}
          </div>
        )}
      </div>
      <SessionLoads scope={scope} />
    </>
  )

  const detail = (
    <>
      <ConfigDetailHeader
        eyebrow={eyebrow}
        title={basename(docPath)}
        pill={selectedRef ? undefined : rootMissing ? 'Not created' : 'Loaded in every session'}
        actions={typeof headerActions === 'function' ? headerActions({ importSelected: !!selectedRef }) : headerActions}
      />
      <div className="flex-1 min-h-0 flex flex-col px-9 py-5 gap-3">
        {note}
        {doc?.loadError && (
          <div role="alert" className="shrink-0 text-[11px] text-red-400">{doc.loadError}</div>
        )}
        {importMissing && (
          <div data-testid={`${testIdPrefix}-missing-note`} className="shrink-0 text-[11px] text-amber-400/90">
            This import does not resolve to a readable file — the CLI will skip it.
          </div>
        )}
        {outsideBoundary && selectedRef && (
          <div data-testid={`${testIdPrefix}-readonly-note`} className="shrink-0 text-[11px] text-amber-400/90">
            Read-only: <span className="font-mono">{selectedRef.path}</span> is outside the folders Session Manager may write to.
          </div>
        )}
        <div className="flex-1 min-h-[320px] flex flex-col rounded-[14px] border border-line bg-bg-hi overflow-hidden">
          {showEmpty ? (
            <div data-testid="claude-md-empty" className="flex-1 flex items-start justify-center px-10 py-16">
              <div className="max-w-[560px] flex flex-col gap-3">
                <p className="font-serif text-[28px] leading-tight text-fg-dim">{empty.title}</p>
                <p className="text-sm leading-relaxed text-fg-dim">{empty.body}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setTypingIn(activeRoot)}
                    className="h-9 px-4 rounded-[10px] border border-line bg-bg text-[13.5px] font-semibold text-fg hover:bg-bg-elev focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    Just start typing
                  </button>
                </div>
              </div>
            </div>
          ) : (
            doc && (
              <div className="flex-1 min-h-0">
                <DocumentEditorPane
                  // Remount per document so view mode / outline never carry over.
                  key={docPath}
                  path={docPath}
                  value={docText}
                  readOnly={readOnly}
                  defaultMode="document"
                  onChange={(v) => {
                    setSaveError(null)
                    setDraft(docPath, v)
                  }}
                  onSave={() => { void save() }}
                />
              </div>
            )
          )}
          {doc && !readOnly && (
            <div className="shrink-0 border-t border-line">
              <SaveBar
                dirty={doc.dirty}
                busy={doc.busy}
                parseError={saveError}
                lastSavedAt={doc.lastSavedAt}
                leading={
                  <span>
                    {docText.length.toLocaleString()} chars · ~{estimateTokens(docText).toLocaleString()} tokens
                    {!doc.exists && ' · file will be created on save'}
                    {doc.exists && selectedRef && ' · editing an imported file'}
                  </span>
                }
                onSave={() => { void save() }}
                onRevert={revert}
              />
            </div>
          )}
        </div>
      </div>
    </>
  )

  return <ConfigWorkbench list={list} detail={detail} />
}
