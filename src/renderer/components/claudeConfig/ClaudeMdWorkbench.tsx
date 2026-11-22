/**
 * ClaudeMdWorkbench — the CLAUDE.md tab of both Claude config pages (Home `~/.claude` and
 * Project), built on ConfigLayout. Design: design-mocks/claude-config renders 10 (Home) and
 * 06 (Project), DESIGN_SPEC.md §2-3, copy in ConfigWorkbench.dc.html.
 *
 * Left column: a file card (Home: FILE + ITS IMPORTS; Project: INSTRUCTIONS FILE) — one radio
 * row per root file the host offers (Home: ~/.claude/CLAUDE.md; Project: CLAUDE.md and
 * CLAUDE.local.md), then every file the selected root `@`-imports (resolved by main's
 * `config:parse-imports`), each named relative to the root's folder with its line count, plus
 * a ~N tokens estimate (chars/4) for the whole set — then the load order (Home: EVERY SESSION
 * LOADS; Project: A SESSION HERE LOADS). Detail: ConfigDetailHeader (actions behind one `⋯`
 * menu) + the shared DocumentEditorPane (Document mode), reading and saving through the config
 * store (loadText / saveText, mtime-checked). The pane's own status bar is the only footer:
 * this component passes it dirty / isNew / onSave / onRevert. A root file that does not exist
 * yet keeps the full editor chrome with the empty-state prompt inside the document.
 *
 * The design's `Draft it with /init` button is omitted (DESIGN_SPEC §5.1).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ConfigWorkbench, ConfigDetailHeader } from './ConfigLayout'
import { DocumentEditorPane } from '../tabs/editor/DocumentEditorPane'
import { EmptyState } from '../ui/EmptyState'
import { shortenHome } from '../ui/SourceChip'
import { useConfig } from '../../state/config'
import { toast } from '../../state/toast'
import { useConfigSearchFocus } from '../../state/configSearchFocus'
import { basename } from '../../lib/basename'
import { dirname, segments } from '../../lib/pathSep'
import { Z } from '../../lib/zLayers'
import { estimateTokens } from '../../lib/estimateTokens'
import type { ConfigWriteAccess, ImportRef } from '../../../preload/api'

const EYEBROW = 'text-[10.5px] font-semibold uppercase tracking-[0.1em] text-fg-faint'
const CONFLICT_HINT = 'changed on disk since it was loaded. Revert reloads it'
/** A burst of external writes to the root file collapses into one re-parse. */
const REPARSE_DEBOUNCE_MS = 300

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function countLines(text: string): number {
  if (!text) return 0
  return text.replace(/\n$/, '').split('\n').length
}

/**
 * `path` relative to the folder `dir` (`rules/git.md`, `../shared/x.md`), '/'-joined.
 * Falls back to `path` itself when the two share no root (another drive).
 */
export function relativeTo(path: string, dir: string): string {
  const a = segments(path)
  const b = segments(dir)
  if (!a.length || !b.length || a[0] !== b[0]) return path
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return [...Array<string>(b.length - i).fill('..'), ...a.slice(i)].join('/')
}

export interface ClaudeMdRoot {
  path: string
  /** Row subtitle, e.g. `Project · shared via git`. */
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
  /**
   * Contents of the detail header's `⋯` menu (Insert preset…); the function form learns
   * whether an import is on screen. Omit for no menu.
   */
  moreMenu?: ReactNode | ((state: { importSelected: boolean }) => ReactNode)
  /** Prefix for the missing / read-only import notes' test ids. */
  testIdPrefix?: string
}

/**
 * The root file's flattened `@`-import chain, re-parsed when its saved disk text changes.
 * `ready` turns true once a parse of `activePath` has settled (so an empty list is final).
 */
/** One sentence per config:can-write refusal reason. */
function readOnlyReason(reason: ConfigWriteAccess['reason'], rootName: string): string {
  switch (reason) {
    case 'sensitive':
      return 'Read-only: Session Manager never writes credential, SSH or autostart files.'
    case 'ops-root':
      return 'Read-only: this file is inside session-manager-operations/, which only its owning writer may change.'
    case 'outside-boundary':
      return 'Read-only: this file is outside your home folder and the projects open in Session Manager.'
    case 'not-imported':
      return `Read-only: this file is no longer imported by ${rootName}.`
    case 'permission':
    default:
      return 'Read-only: your system does not allow writing this file.'
  }
}

function useImports(activePath: string): { imports: ImportRef[]; ready: boolean } {
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

  return useMemo(
    () => (found && found.path === activePath ? { imports: found.imports, ready: true } : { imports: [], ready: false }),
    [found, activePath],
  )
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

interface LoadStep { path: string; note: string; here: boolean }

function SessionLoads({ scope, steps }: { scope: 'user' | 'project'; steps: ReadonlyArray<LoadStep> }) {
  return (
    <div data-testid="claude-md-session-loads" className="flex flex-col px-1">
      <span className={`${EYEBROW} mb-3`}>{scope === 'user' ? 'EVERY SESSION LOADS' : 'A SESSION HERE LOADS'}</span>
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

/** The detail header's `⋯` button; its popover holds whatever the host passes (Insert preset…). */
function DetailMoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Escape or a mousedown outside the trigger + popover closes it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
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
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        data-testid="claude-md-more"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="h-9 w-9 inline-flex items-center justify-center rounded-[10px] bg-bg-hi border border-line text-fg-dim hover:text-fg hover:border-rule focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        ⋯
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="More actions"
          data-testid="claude-md-more-menu"
          className={`absolute ${Z.dialog} right-0 top-[42px] min-w-[200px] p-[5px] flex flex-col gap-1 bg-bg-hi border border-line rounded-lg shadow-lg text-[13px] text-fg`}
        >
          {children}
        </div>
      )}
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
  moreMenu,
  testIdPrefix = 'claude-md',
}: ClaudeMdWorkbenchProps) {
  const files = useConfig((s) => s.files)
  const loadText = useConfig((s) => s.loadText)
  const setDraft = useConfig((s) => s.setDraft)
  const saveText = useConfig((s) => s.saveText)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  const { imports, ready: importsReady } = useImports(activeRoot)
  // Which document is on screen: null = the active root itself, otherwise one of its imports.
  const [selected, setSelected] = useState<{ root: string; ref: ImportRef } | null>(null)
  const selectedRef = selected && selected.root === activeRoot ? selected.ref : null
  const docPath = selectedRef?.path ?? activeRoot

  // A root the user chose to start typing into while it does not exist yet.
  const [typingIn, setTypingIn] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Main's write decision for the active root and each resolvable import (keyed by path), asked
  // with the same `importedBy` the save will send. Unknown (not asked yet / probe failed) renders
  // editable; main still refuses a bad write.
  const [access, setAccess] = useState<Record<string, ConfigWriteAccess>>({})
  useEffect(() => {
    let live = true
    const probes: Array<[string, Promise<ConfigWriteAccess>]> = [
      [activeRoot, Promise.resolve().then(() => window.api.config.canWrite(activeRoot))],
      ...imports
        .filter((ref) => ref.ok && ref.exists)
        .map((ref): [string, Promise<ConfigWriteAccess>] => [
          ref.path,
          Promise.resolve().then(() => window.api.config.canWrite(ref.path, { importedBy: activeRoot })),
        ]),
    ]
    for (const [p, probe] of probes) {
      probe
        .then((res) => { if (live && res && typeof res.ok === 'boolean') setAccess((m) => ({ ...m, [p]: res })) })
        .catch(() => {})
    }
    return () => { live = false }
  }, [imports, activeRoot])

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

  // A "Search all config" pick for this tab: `claude-md:<root>` opens that root file;
  // `claude-md:<root>><import>` switches to that root (via onSelectRoot) and, once its
  // imports are parsed, opens the import. A miss (unknown root or import) keeps the current
  // document. Either way the request is consumed.
  const focusTab = useConfigSearchFocus((st) => st.tab)
  const focusId = useConfigSearchFocus((st) => st.id)
  const clearFocus = useConfigSearchFocus((st) => st.clear)
  useEffect(() => {
    if (focusTab !== 'claude-md' || !focusId) return
    const rest = focusId.startsWith('claude-md:') ? focusId.slice('claude-md:'.length) : ''
    const sep = rest.indexOf('>')
    const root = sep === -1 ? rest : rest.slice(0, sep)
    const importPath = sep === -1 ? null : rest.slice(sep + 1)
    if (!roots.some((r) => r.path === root) || (root !== activeRoot && !onSelectRoot)) {
      clearFocus()
      return
    }
    if (importPath === null) {
      selectRoot(root)
      clearFocus()
      return
    }
    // Switch roots first; this effect re-runs once the new root's imports are parsed.
    if (root !== activeRoot) { onSelectRoot?.(root); return }
    if (!importsReady) return
    const ref = imports.find((i) => i.path === importPath)
    if (ref) selectImport(ref)
    clearFocus()
  }, [focusTab, focusId, roots, activeRoot, onSelectRoot, importsReady, imports, selectRoot, selectImport, clearFocus])

  const save = useCallback(async () => {
    setSaveError(null)
    // No `force`: saveText refuses with 'conflict' when the disk copy is newer than the draft's base.
    const res = await saveText(docPath, selectedRef ? { importedBy: activeRoot } : undefined)
    if (!res.ok) setSaveError(res.error === 'conflict' ? CONFLICT_HINT : res.error ?? 'save failed')
  }, [docPath, selectedRef, activeRoot, saveText])

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
  const importMissing = !!selectedRef && (!selectedRef.ok || !selectedRef.exists)
  const docAccess = importMissing ? undefined : access[docPath]
  const refused = docAccess?.ok === false
  const readOnly = importMissing || refused
  const rootMissing = !selectedRef && !rootFile.exists
  const showEmpty = rootMissing && docText === '' && typingIn !== activeRoot

  const totalTokens =
    estimateTokens(rootFile.draftRaw) +
    importPaths.reduce((n, p) => n + estimateTokens(textOf(p)?.text ?? ''), 0)

  const rootDir = dirname(activeRoot)
  const rootStatus = (p: string): 'missing' | 'present' | 'unknown' => {
    const info = textOf(p)
    return info == null ? 'unknown' : info.exists ? 'present' : 'missing'
  }
  const loadSteps: LoadStep[] =
    scope === 'user'
      ? [
          { path: '~/.claude/CLAUDE.md', note: 'this file · every project', here: true },
          { path: '<project>/CLAUDE.md', note: 'per project · in its Claude config', here: false },
          { path: '<project>/CLAUDE.local.md', note: 'per project · that machine only', here: false },
        ]
      : [
          { path: '~/.claude/CLAUDE.md', note: 'global · edited in Home', here: false },
          ...roots.map((r) => {
            const here = r.path === activeRoot
            const missing = rootStatus(r.path) === 'missing'
            const note = here ? (missing ? 'this file · not created' : 'this file') : missing ? 'not created' : 'edited here'
            return { path: basename(r.path), note, here }
          }),
        ]

  const activeMeta = roots.find((r) => r.path === activeRoot)
  const eyebrow = selectedRef
    ? `${shortenHome(selectedRef.path, home)} · IMPORTED BY ${basename(activeRoot)}`
    : `${shortenHome(activeRoot, home)} · ${activeMeta?.eyebrow ?? ''}`

  const list = (
    <>
      <div data-testid="claude-md-file-card" role="radiogroup" aria-label="Instruction files" className="px-3.5 pt-3.5 pb-3 rounded-[14px] bg-bg-hi border border-line flex flex-col gap-1.5">
        <div className="flex items-center px-0.5 pb-1">
          <span className={`flex-1 ${EYEBROW}`}>{scope === 'user' ? 'FILE + ITS IMPORTS' : 'INSTRUCTIONS FILE'}</span>
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
                  name={relativeTo(ref.path, rootDir)}
                  trailing={
                    missing ? (
                      <span data-testid="referenced-file-missing" className="text-amber-400/90">missing</span>
                    ) : (
                      `${countLines(textOf(ref.path)?.text ?? '')} lines`
                    )
                  }
                  meta={missing || access[ref.path]?.ok === false ? 'Imported · read-only' : 'Imported · editable here'}
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
      <SessionLoads scope={scope} steps={loadSteps} />
    </>
  )

  const menuContent = typeof moreMenu === 'function' ? moreMenu({ importSelected: !!selectedRef }) : moreMenu
  const emptyPrompt = (
    <div data-testid="claude-md-empty" className="flex justify-center px-10 py-12">
      <div className="w-full max-w-[640px] flex flex-col gap-3.5">
        <p className="font-serif text-[30px] leading-tight text-fg-faint">
          {empty.title}
          <span aria-hidden className="inline-block w-0.5 h-7 ml-1 align-[-5px] bg-accent" />
        </p>
        <p className="max-w-[520px] text-[15px] leading-relaxed text-fg-dim">{empty.body}</p>
        <div className="mt-1.5 flex gap-2.5">
          <button
            type="button"
            onClick={() => setTypingIn(activeRoot)}
            className="h-[38px] px-4 rounded-[9px] border border-line bg-bg text-sm font-medium text-fg hover:bg-bg-elev focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Just start typing
          </button>
        </div>
      </div>
    </div>
  )

  const detail = (
    <>
      <ConfigDetailHeader
        eyebrow={eyebrow}
        title={basename(docPath)}
        pill={selectedRef ? undefined : rootMissing ? 'Not created' : 'Loaded in every session'}
        actions={menuContent == null || menuContent === false ? undefined : <DetailMoreMenu>{menuContent}</DetailMoreMenu>}
      />
      <div className="flex-1 min-h-0 flex flex-col px-9 py-5 gap-3">
        {doc?.loadError && (
          <div role="alert" className="shrink-0 text-[11px] text-red-400">{doc.loadError}</div>
        )}
        {saveError && (
          <div role="alert" data-testid={`${testIdPrefix}-save-error`} className="shrink-0 text-[11px] text-red-400">
            {basename(docPath)} {saveError}
          </div>
        )}
        {importMissing && (
          <div data-testid={`${testIdPrefix}-missing-note`} className="shrink-0 text-[11px] text-amber-400/90">
            This import does not resolve to a readable file — the CLI will skip it.
          </div>
        )}
        {refused && (
          <div data-testid={`${testIdPrefix}-readonly-note`} className="shrink-0 text-[11px] text-amber-400/90">
            {readOnlyReason(docAccess?.reason, basename(activeRoot))}
          </div>
        )}
        <div className="flex-1 min-h-[320px] flex flex-col rounded-[14px] border border-line bg-bg-hi overflow-hidden">
          {doc && (
            <div className="flex-1 min-h-0">
              <DocumentEditorPane
                // Remount per document so view mode / outline never carry over.
                key={docPath}
                path={docPath}
                value={docText}
                readOnly={readOnly}
                defaultMode="document"
                dirty={readOnly ? undefined : doc.dirty}
                isNew={!readOnly && !doc.exists}
                emptyState={showEmpty ? emptyPrompt : undefined}
                onChange={(v) => {
                  setSaveError(null)
                  setDraft(docPath, v)
                }}
                onSave={readOnly ? undefined : () => { void save() }}
                onRevert={readOnly ? undefined : revert}
              />
            </div>
          )}
        </div>
      </div>
    </>
  )

  return <ConfigWorkbench list={list} detail={detail} />
}
