import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Z } from '../../../../lib/zLayers'
import {
  AUDIENCES,
  PAGE_LENGTHS,
  PAGE_TEMPLATES,
  READ_SOURCES,
  VIDEO_KINDS,
  VIDEO_STYLES,
  VIDEO_TEMPLATES,
  addChip,
  canGenerate,
  pageDefaults,
  pagePromptLines,
  pageTemplate,
  videoDefaults,
  videoPromptLines,
  videoTemplate,
  type PageCfg,
  type ReadSourceId,
  type VideoCfg,
  type VideoLength,
} from './composerTemplates'

/** What Regenerate rebuilds: the entry plus its pre-fill (`pageCfgFromEntry` / `videoCfgFromEntry`). */
export interface ComposerRegen {
  entryId: string
  title: string
  tplId: string
  cfg: PageCfg | VideoCfg
}

export interface GenerateComposerProps {
  kind: 'page' | 'video'
  /** Regenerate mode: config only, no template list; `onGenerate` also gets `regen.entryId`. */
  regen?: ComposerRegen
  /** Generate mode's starting template (default: the kind's first template). */
  initialTplId?: string
  onClose: () => void
  /** The builder's prompt lines. The caller launches, appends `Replace entry: <id>`, and closes. */
  onGenerate: (lines: string[], replaceEntryId?: string) => void
}

type Form = { kind: 'page'; tplId: string; cfg: PageCfg } | { kind: 'video'; tplId: string; cfg: VideoCfg }

interface TemplateRow {
  id: string
  name: string
  blurb: string
  preset: string
}

const PAGE_ROWS: readonly TemplateRow[] = PAGE_TEMPLATES.map((t) => ({
  id: t.id,
  name: t.name,
  blurb: t.blurb,
  preset: `${t.audience.toLowerCase()} · ${t.length.toLowerCase()}`,
}))

const VIDEO_ROWS: readonly TemplateRow[] = VIDEO_TEMPLATES.map((t) => ({
  id: t.id,
  name: t.name,
  blurb: t.blurb,
  preset: `${t.kind.toLowerCase()} · ${t.length}s · ${t.style.toLowerCase()}`,
}))

const VIDEO_LENGTHS: readonly VideoLength[] = [30, 60]

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const INPUT =
  'h-[38px] px-3 border border-rule-structural rounded-lg bg-bg-hi text-[13.5px] text-fg placeholder:text-fg-faint outline-none focus:border-accent'

const isPageCfg = (cfg: PageCfg | VideoCfg): cfg is PageCfg => 'audience' in cfg

/** A template with every setting at its defaults — what picking a template resets to. */
function templateForm(kind: Form['kind'], tplId: string): Form {
  if (kind === 'page') {
    const id = pageTemplate(tplId).id
    return { kind, tplId: id, cfg: pageDefaults(id) }
  }
  const id = videoTemplate(tplId).id
  return { kind, tplId: id, cfg: videoDefaults(id) }
}

function initialForm(kind: Form['kind'], regen: ComposerRegen | undefined, initialTplId: string | undefined): Form {
  const first = (kind === 'page' ? PAGE_TEMPLATES : VIDEO_TEMPLATES)[0].id
  const form = templateForm(kind, regen?.tplId ?? initialTplId ?? first)
  if (!regen) return form
  if (form.kind === 'page' && isPageCfg(regen.cfg)) return { ...form, cfg: { ...regen.cfg, reads: [...regen.cfg.reads] } }
  if (form.kind === 'video' && !isPageCfg(regen.cfg)) return { ...form, cfg: { ...regen.cfg } }
  return form
}

function withFocus(form: Form, focus: string): Form {
  return form.kind === 'page' ? { ...form, cfg: { ...form.cfg, focus } } : { ...form, cfg: { ...form.cfg, focus } }
}

/** Keep Tab / Shift+Tab inside the panel (it is aria-modal): wrap at either end. */
function trapTab(e: KeyboardEvent, panel: HTMLElement | null) {
  const items = panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : []
  if (!panel || items.length === 0) return
  const active = document.activeElement
  const inside = panel.contains(active) && active !== panel
  if (e.shiftKey && (!inside || active === items[0])) {
    e.preventDefault()
    items[items.length - 1].focus()
  } else if (!e.shiftKey && (!panel.contains(active) || active === items[items.length - 1])) {
    e.preventDefault()
    items[0].focus()
  }
}

/**
 * Project Home v2 Generate composer (DESIGN_SPEC §3; prototype lines 603–764, 1227–1259).
 * Generate mode = START FROM template list + config, where picking a template resets every setting
 * to that template's defaults; Regenerate mode = config only, pre-filled from the entry.
 *
 * It only composes: the primary button hands the composerTemplates.ts prompt lines (plus the entry
 * id when regenerating) to `onGenerate`, and the caller launches. Props are read once — mount one
 * composer per open. A local overlay on `Z.dialog` rather than `ui/Modal`, which has no
 * 1040×710 panel; it keeps Modal's Escape, backdrop-click and focus behaviour.
 */
export function GenerateComposer({ kind, regen, initialTplId, onClose, onGenerate }: GenerateComposerProps) {
  const [form, setForm] = useState<Form>(() => initialForm(kind, regen, initialTplId))
  const panelRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  // A press that starts inside the panel and is released over the overlay (selecting text)
  // fires its click on the overlay; it must not close the composer.
  const pressStartedInPanel = useRef(false)
  const titleId = useId()

  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    const previous = document.activeElement
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.stopPropagation()
        onCloseRef.current()
      } else if (e.key === 'Tab') {
        trapTab(e, panelRef.current)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  const pick = (id: string) => setForm((f) => templateForm(f.kind, id))
  const setPage = (patch: Partial<PageCfg>) =>
    setForm((f) => (f.kind === 'page' ? { ...f, cfg: { ...f.cfg, ...patch } } : f))
  const setVideo = (patch: Partial<VideoCfg>) =>
    setForm((f) => (f.kind === 'video' ? { ...f, cfg: { ...f.cfg, ...patch } } : f))
  const toggleRead = (id: ReadSourceId) =>
    setForm((f) => {
      if (f.kind !== 'page') return f
      const reads = f.cfg.reads.includes(id) ? f.cfg.reads.filter((r) => r !== id) : [...f.cfg.reads, id]
      return { ...f, cfg: { ...f.cfg, reads } }
    })
  const toggleMascot = () =>
    setForm((f) => (f.kind === 'video' ? { ...f, cfg: { ...f.cfg, mascot: !f.cfg.mascot } } : f))
  const setFocus = (focus: string) => setForm((f) => withFocus(f, focus))
  const appendChip = (chip: string) => setForm((f) => withFocus(f, addChip(f.cfg.focus, chip)))

  const isPage = form.kind === 'page'
  const tpl = form.kind === 'page' ? pageTemplate(form.tplId) : videoTemplate(form.tplId)
  const covers = 'covers' in tpl ? tpl.covers : tpl.scenes
  const needsTopic = 'page' in tpl && tpl.page === 'Custom topic'
  const lines = form.kind === 'page' ? pagePromptLines(form.tplId, form.cfg) : videoPromptLines(form.cfg)
  const promptLine = lines.join(' · ')
  const ready = canGenerate(form.kind, form.tplId, form.cfg)

  const generate = () => {
    if (!ready) return
    if (regen) onGenerate(lines, regen.entryId)
    else onGenerate(lines)
  }

  const onOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    pressStartedInPanel.current = e.target !== e.currentTarget
  }
  const onOverlayClick = (e: MouseEvent<HTMLDivElement>) => {
    const startedInPanel = pressStartedInPanel.current
    pressStartedInPanel.current = false
    if (e.target === e.currentTarget && !startedInPanel) onClose()
  }

  const node = (
    <div
      data-testid="project-home-composer"
      className={`fixed inset-0 ${Z.dialog} flex items-center justify-center p-7 bg-fg/45`}
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="project-home-composer-panel"
        className="w-[min(1040px,100%)] h-[min(710px,100%)] flex flex-col overflow-hidden bg-bg text-fg border border-rule-structural rounded-[14px] shadow-2xl outline-none"
      >
        <header className="flex-none flex items-center gap-3.5 px-5 py-4 border-b border-rule-structural">
          <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
            <h2
              id={titleId}
              data-testid="composer-title"
              className="font-serif text-[23px] font-semibold leading-[1.15] text-fg break-words"
            >
              {regen ? `Regenerate “${regen.title}”` : isPage ? 'Generate page' : 'Generate video'}
            </h2>
            <p className="text-[12.5px] text-fg-faint">
              {regen
                ? 'Same settings as last time — change anything before it rebuilds.'
                : 'Pick a starting point — every setting below is pre-filled from it and yours to change.'}
            </p>
          </div>
          <button
            type="button"
            data-testid="composer-close"
            aria-label="Close"
            onClick={onClose}
            className="flex-none w-8 h-8 flex items-center justify-center border border-rule-structural rounded-lg bg-bg-hi text-fg-dim hover:text-fg"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="flex-1 min-h-0 flex">
          {!regen && (
            <div className="flex-none w-[292px] min-h-0 overflow-auto px-3 py-3.5 flex flex-col gap-1 bg-bg-elev border-r border-rule-structural">
              <span className="px-2 pt-0.5 pb-1.5 font-mono text-[10.5px] tracking-[.12em] text-fg-faint">START FROM</span>
              {(isPage ? PAGE_ROWS : VIDEO_ROWS).map((t) => {
                const on = t.id === form.tplId
                return (
                  <button
                    key={t.id}
                    type="button"
                    data-testid="composer-template"
                    data-tpl={t.id}
                    aria-pressed={on}
                    onClick={() => pick(t.id)}
                    className={`flex flex-col gap-[3px] px-3 py-2.5 rounded-[9px] border text-left ${
                      on ? 'border-accent bg-bg-hi' : 'border-transparent hover:border-rule-structural'
                    }`}
                  >
                    <span className="text-[13.5px] font-semibold text-fg">{t.name}</span>
                    <span className="text-xs leading-[1.4] text-fg-faint">{t.blurb}</span>
                    <span className="mt-0.5 font-mono text-[10px] text-fg-faint">{t.preset}</span>
                  </button>
                )
              })}
            </div>
          )}

          <div className="flex-1 min-w-0 overflow-auto px-7 pt-[22px] pb-7">
            <div className="max-w-[660px] flex flex-col gap-[22px]">
              <div className="flex flex-col gap-[7px]">
                <span data-testid="composer-eyebrow" className="font-mono text-[10.5px] tracking-[.12em] text-accent-dark">
                  {regen ? `REBUILDING · ${regen.entryId}` : `TEMPLATE · ${tpl.name.toUpperCase()}`}
                </span>
                <span className="font-serif text-[22px] font-semibold leading-[1.15] text-fg">{tpl.name}</span>
                <span className="text-[13px] leading-normal text-fg-faint">{tpl.blurb}</span>
                <div className="flex flex-wrap items-center gap-1.5 mt-[3px]">
                  <span className="text-xs text-fg-faint">{isPage ? 'Will cover' : 'Scenes'}</span>
                  {covers.map((c) => (
                    <span key={c} className="font-mono text-[10.5px] px-2 py-[3px] rounded-[5px] bg-rule-inner text-fg-dim">
                      {c}
                    </span>
                  ))}
                </div>
              </div>

              {form.kind === 'page' && (
                <>
                  {needsTopic && (
                    <label className="flex flex-col gap-[7px]">
                      <FieldLabel note="required" required>
                        Topic
                      </FieldLabel>
                      <input
                        data-testid="composer-topic"
                        value={form.cfg.topic}
                        onChange={(e) => setPage({ topic: e.target.value })}
                        placeholder="e.g. The security model"
                        className={INPUT}
                      />
                    </label>
                  )}
                  <div className="flex flex-wrap gap-7">
                    <Segmented label="Written for" options={AUDIENCES} value={form.cfg.audience} onPick={(audience) => setPage({ audience })} />
                    <Segmented label="Length" options={PAGE_LENGTHS} value={form.cfg.length} onPick={(length) => setPage({ length })} />
                  </div>
                  <div className="flex flex-col gap-[7px]">
                    <FieldLabel>Read from</FieldLabel>
                    <div className="flex flex-wrap gap-2">
                      {READ_SOURCES.map((r) => {
                        const on = form.cfg.reads.includes(r.id)
                        return (
                          <button
                            key={r.id}
                            type="button"
                            data-read={r.id}
                            aria-pressed={on}
                            onClick={() => toggleRead(r.id)}
                            className={`inline-flex items-center gap-[7px] h-8 px-3 rounded-2xl border text-[12.5px] font-medium ${
                              on ? 'bg-fg text-bg border-fg' : 'bg-bg-hi text-fg-dim border-rule-structural hover:border-fg-faint'
                            }`}
                          >
                            <span aria-hidden="true" className="font-mono text-[11px]">
                              {on ? '✓' : '+'}
                            </span>
                            {r.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}

              {form.kind === 'video' && (
                <>
                  <Segmented label="Kind" options={VIDEO_KINDS} value={form.cfg.kind} onPick={(k) => setVideo({ kind: k })} />
                  {form.cfg.kind !== 'Project demo' && (
                    <label className="flex flex-col gap-[7px]">
                      <FieldLabel note="optional" testId="composer-target-label">
                        {form.cfg.kind === 'Feature' ? 'Feature' : 'Post'}
                      </FieldLabel>
                      <input
                        data-testid="composer-target"
                        value={form.cfg.target}
                        onChange={(e) => setVideo({ target: e.target.value })}
                        placeholder={form.cfg.kind === 'Feature' ? 'Feature name, e.g. Scheduler / PRD queue' : 'Post path or URL'}
                        className={INPUT}
                      />
                    </label>
                  )}
                  <div className="flex flex-col gap-2">
                    <FieldLabel>Style</FieldLabel>
                    <div role="group" aria-label="Style" className="grid grid-cols-5 gap-2.5">
                      {VIDEO_STYLES.map((s) => {
                        const on = s.id === form.cfg.style
                        return (
                          <button
                            key={s.id}
                            type="button"
                            data-testid="composer-style"
                            data-style={s.id}
                            aria-pressed={on}
                            onClick={() => setVideo({ style: s.id })}
                            className="flex flex-col gap-[5px] min-w-0 text-left"
                          >
                            <span
                              className={`flex w-full aspect-[16/10] items-center justify-center rounded-lg border border-rule-structural text-lg ${s.className} ${
                                on ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''
                              }`}
                            >
                              {s.sample}
                            </span>
                            <span className={`text-xs leading-tight text-fg ${on ? 'font-bold' : 'font-medium'}`}>{s.id}</span>
                            <span className="text-[11px] leading-[1.3] text-fg-faint">{s.note}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-7">
                    <Segmented
                      label="Length"
                      options={VIDEO_LENGTHS}
                      value={form.cfg.length}
                      onPick={(length) => setVideo({ length })}
                      format={(s) => (s === 60 ? '1 minute' : '30 seconds')}
                    />
                    <div className="flex flex-col gap-[7px]">
                      <FieldLabel>Character</FieldLabel>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={form.cfg.mascot}
                        data-testid="composer-character"
                        onClick={toggleMascot}
                        className="flex items-center gap-2.5 h-9 text-[12.5px] text-fg"
                      >
                        <span
                          aria-hidden="true"
                          className={`relative w-9 h-5 rounded-[10px] transition-colors ${form.cfg.mascot ? 'bg-sage-dark' : 'bg-rule-structural'}`}
                        >
                          <span
                            className={`absolute top-0.5 w-4 h-4 rounded-full bg-bg-hi shadow transition-all ${form.cfg.mascot ? 'left-[18px]' : 'left-0.5'}`}
                          />
                        </span>
                        Use the project’s mascot
                      </button>
                    </div>
                  </div>
                </>
              )}

              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-2">
                  <FieldLabel note="optional">Focus</FieldLabel>
                  <textarea
                    data-testid="composer-focus"
                    rows={3}
                    value={form.cfg.focus}
                    onChange={(e) => setFocus(e.target.value)}
                    placeholder={
                      isPage
                        ? 'Anything to emphasize or avoid? e.g. lead with the scheduler'
                        : 'What should the video focus on? e.g. end on the install line'
                    }
                    className="w-full px-3 py-2.5 border border-rule-structural rounded-lg bg-bg-hi text-[13.5px] leading-normal text-fg placeholder:text-fg-faint resize-y outline-none focus:border-accent"
                  />
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {tpl.chips.map((c) => (
                    <button
                      key={c}
                      type="button"
                      data-testid="composer-chip"
                      data-chip={c}
                      onClick={() => appendChip(c)}
                      className="h-7 px-2.5 border border-rule-structural rounded-[14px] bg-transparent text-fg-dim text-xs hover:bg-bg-elev"
                    >
                      + {c}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer className="flex-none flex flex-wrap items-center gap-3 px-5 py-3 border-t border-rule-structural bg-bg-elev">
          <div className="flex-1 min-w-[220px] flex flex-col gap-0.5">
            <span data-testid="composer-agent" className="text-[11px] text-fg-faint">
              Sent to {isPage ? 'project-home-builder' : 'demo-video-builder'} as
            </span>
            <span data-testid="composer-lines" title={promptLine} className="font-mono text-[11px] text-fg truncate">
              {promptLine}
            </span>
          </div>
          <button
            type="button"
            data-testid="composer-cancel"
            onClick={onClose}
            className="h-9 px-3.5 border border-rule-structural rounded-lg bg-bg-hi text-fg text-[13px] font-semibold hover:border-fg-faint"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="composer-generate"
            disabled={!ready}
            onClick={generate}
            className="inline-flex items-center gap-[7px] h-9 px-4 rounded-lg bg-accent text-bg-hi text-[13px] font-semibold enabled:hover:bg-accent-dark disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M12 4v6M12 14v6M4 12h6M14 12h6" />
            </svg>
            {regen ? 'Regenerate' : isPage ? 'Generate page' : 'Generate video'}
          </button>
        </footer>
      </div>
    </div>
  )

  return createPortal(node, document.body)
}

function FieldLabel({
  children,
  note,
  required = false,
  testId,
}: {
  children: ReactNode
  note?: string
  required?: boolean
  testId?: string
}) {
  return (
    <span data-testid={testId} className="text-[12.5px] font-semibold text-fg">
      {children}
      {note && <span className={`font-normal ${required ? 'text-accent-dark' : 'text-fg-faint'}`}> · {note}</span>}
    </span>
  )
}

/** One segmented control: a labelled group of pressed/unpressed buttons. */
function Segmented<T extends string | number>({
  label,
  options,
  value,
  onPick,
  format = String,
}: {
  label: string
  options: readonly T[]
  value: T
  onPick: (value: T) => void
  format?: (value: T) => string
}) {
  return (
    <div className="flex flex-col gap-[7px]">
      <FieldLabel>{label}</FieldLabel>
      <div role="group" aria-label={label} className="flex w-fit gap-0.5 p-[3px] rounded-[9px] bg-rule-inner">
        {options.map((o) => {
          const on = o === value
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(o)}
              className={`h-[30px] px-[13px] rounded-[7px] text-[12.5px] whitespace-nowrap ${
                on ? 'bg-bg-hi text-fg font-semibold shadow-sm' : 'text-fg-faint font-medium hover:text-fg'
              }`}
            >
              {format(o)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
