/**
 * Project Home v2 Generate composer data: the page / video templates, option lists and the
 * prompt-line builders. Copied from the design prototype —
 * `session-manager-operations/design-mocks/project-home-v2/project-home-prototype.dc.html`
 * (template data lines 779–856, behaviour 1006–1043) — per its DESIGN_SPEC.md §2, §3 and §8.3,
 * minus the prototype-only `lede` / `sample` fields and the raw-hex style values.
 *
 * Pure: no React, no preload bridge, no store. The Generate composer, the empty state's template
 * cards and Regenerate all read from here, so the prompt lines a builder receives stay one shape.
 */
import type { ProjectPageMeta, ProjectVideoMeta } from '../../../../../preload/api'

export const AUDIENCES = ['Newcomers', 'Users', 'Contributors'] as const
export type Audience = (typeof AUDIENCES)[number]

export const PAGE_LENGTHS = ['Brief', 'Standard', 'In-depth'] as const
export type PageLength = (typeof PAGE_LENGTHS)[number]

/** `Read from` toggles. Prompt lines always list labels in this order, whatever the toggle order. */
export const READ_SOURCES = [
  { id: 'docs', label: 'README & docs' },
  { id: 'tree', label: 'Source tree' },
  { id: 'git', label: 'Git log' },
] as const
export type ReadSourceId = (typeof READ_SOURCES)[number]['id']

export const VIDEO_KINDS = ['Project demo', 'Blog post', 'Feature'] as const
export type VideoKind = (typeof VIDEO_KINDS)[number]

export type PageKind = 'Overview' | 'How it works' | 'FAQ' | 'Custom topic'
export type VideoStyleId = 'Auto' | 'Professional' | 'Fun' | 'Animated whiteboard' | 'Kinetic typography'
export type VideoLength = 30 | 60

export interface PageTemplate {
  readonly id: string
  readonly name: string
  readonly blurb: string
  readonly page: PageKind
  /** Default topic — present only on `Custom topic` templates. */
  readonly topic?: string
  readonly audience: Audience
  readonly length: PageLength
  readonly reads: readonly ReadSourceId[]
  /** `Will cover` chips. */
  readonly covers: readonly string[]
  /** Focus suggestions — `+ <chip>` appends via `addChip`. */
  readonly chips: readonly string[]
}

export interface VideoTemplate {
  readonly id: string
  readonly name: string
  readonly blurb: string
  readonly kind: VideoKind
  readonly target?: string
  readonly style: VideoStyleId
  readonly length: VideoLength
  readonly mascot: boolean
  /** `Scenes` chips. */
  readonly scenes: readonly string[]
  readonly chips: readonly string[]
}

export interface VideoStyle {
  readonly id: VideoStyleId
  readonly note: string
  readonly sample: string
  /** Swatch classes: one complete literal per style — Tailwind JIT only sees literals, never interpolate. */
  readonly className: string
}

/** One composer form's page settings. */
export interface PageCfg {
  audience: Audience
  length: PageLength
  reads: ReadSourceId[]
  focus: string
  topic: string
}

/** One composer form's video settings. */
export interface VideoCfg {
  kind: VideoKind
  target: string
  /** A `VIDEO_STYLES` id; a Regenerate pre-fill carries the entry's recorded `meta.style` as-is. */
  style: string
  length: VideoLength
  mascot: boolean
  focus: string
}

export const PAGE_TEMPLATES: readonly PageTemplate[] = [
  {
    id: 'overview',
    name: 'Overview',
    blurb: 'What it is, who it’s for, key features, how to run it.',
    page: 'Overview',
    audience: 'Newcomers',
    length: 'Standard',
    reads: ['docs', 'tree', 'git'],
    covers: ['What it is', 'Who it’s for', 'Key features', 'Structure', 'How to run it', 'Key commands'],
    chips: ['Lead with the scheduler', 'Keep install to one line', 'Say it runs locally'],
  },
  {
    id: 'how',
    name: 'How it works',
    blurb: 'Architecture and the main flows end to end, tied to real modules.',
    page: 'How it works',
    audience: 'Contributors',
    length: 'In-depth',
    reads: ['docs', 'tree'],
    covers: ['The pieces', 'Main process', 'Renderer', 'Agent tools', 'One flow, end to end'],
    chips: ['Trace one page build end to end', 'Explain dormant tabs', 'Include the web remote'],
  },
  {
    id: 'faq',
    name: 'FAQ',
    blurb: 'The questions a newcomer really asks, each answer sourced.',
    page: 'FAQ',
    audience: 'Newcomers',
    length: 'Brief',
    reads: ['docs'],
    covers: ['Getting started', 'Privacy & telemetry', 'Everyday use', 'Troubleshooting'],
    chips: ['Cover Windows setup', 'Eight questions max', 'Include the telemetry opt-out'],
  },
  {
    id: 'start',
    name: 'Getting started',
    blurb: 'Install, first run and the commands you’ll use daily.',
    page: 'Custom topic',
    topic: 'Getting started: install, first run, key commands',
    audience: 'Newcomers',
    length: 'Brief',
    reads: ['docs', 'tree'],
    covers: ['Install', 'First run', 'Key commands', 'Where next'],
    chips: ['Assume a fresh machine', 'Show --simple mode', 'Link the Field Manual'],
  },
  {
    id: 'recent',
    name: 'What’s new',
    blurb: 'Recent direction from the last 30 commits, grouped by theme.',
    page: 'Custom topic',
    topic: 'What’s new: recent changes grouped by theme',
    audience: 'Users',
    length: 'Brief',
    reads: ['git', 'docs'],
    covers: ['Highlights', 'New', 'Fixed', 'Next'],
    chips: ['Only user-facing changes', 'Group by area', 'Skip refactors'],
  },
  {
    id: 'custom',
    name: 'Custom topic',
    blurb: 'Name any topic — the builder writes a page about exactly that.',
    page: 'Custom topic',
    topic: '',
    audience: 'Users',
    length: 'Standard',
    reads: ['docs', 'tree', 'git'],
    covers: ['Shaped by your topic'],
    chips: ['A glossary of terms', 'Compare with the plain claude CLI', 'The security model'],
  },
]

export const VIDEO_TEMPLATES: readonly VideoTemplate[] = [
  {
    id: 'demo',
    name: 'Project demo',
    blurb: 'A short tour of what the project does and why it exists.',
    kind: 'Project demo',
    style: 'Auto',
    length: 30,
    mascot: true,
    scenes: ['The problem', 'What it is', 'Three key features', 'Try it'],
    chips: ['End on the install line', 'Feature the scheduler', 'Keep it upbeat'],
  },
  {
    id: 'feature',
    name: 'Feature spotlight',
    blurb: 'One feature, shown step by step.',
    kind: 'Feature',
    target: 'Scheduler / PRD queue',
    style: 'Kinetic typography',
    length: 30,
    mascot: false,
    scenes: ['Why it exists', 'How it works', 'Try it'],
    chips: ['Show a real PRD', 'Mention the queue-health linter', 'No jargon'],
  },
  {
    id: 'blog',
    name: 'Blog post',
    blurb: 'Turn a post or release note into a short narrated video.',
    kind: 'Blog post',
    target: '',
    style: 'Professional',
    length: 60,
    mascot: false,
    scenes: ['The headline', 'Key points', 'The takeaway'],
    chips: ['Quote the post’s title', 'Three points max', 'Point to the post at the end'],
  },
  {
    id: 'whiteboard',
    name: 'Whiteboard explainer',
    blurb: 'How it works, drawn out like a whiteboard session.',
    kind: 'Project demo',
    style: 'Animated whiteboard',
    length: 60,
    mascot: true,
    scenes: ['The pieces', 'How they connect', 'One request, end to end', 'Recap'],
    chips: ['Draw the main process and renderer', 'Trace one message', 'Slow, calm pace'],
  },
  {
    id: 'custom',
    name: 'Custom',
    blurb: 'Your own brief — every setting is yours to pick.',
    kind: 'Project demo',
    style: 'Auto',
    length: 30,
    mascot: false,
    scenes: ['Shaped by your brief'],
    chips: ['For a conference talk', 'Focus on privacy', 'No mascot, all type'],
  },
]

/** The five `Style` swatches (prototype STYLES, lines 840–846) as app tokens — DESIGN_SPEC §2. */
export const VIDEO_STYLES: readonly VideoStyle[] = [
  { id: 'Auto', note: 'Builder decides', sample: 'Auto', className: 'bg-bg-elev text-fg' },
  { id: 'Professional', note: 'Clean and calm', sample: 'Aa', className: 'bg-fg text-bg font-serif' },
  { id: 'Fun', note: 'Bright, playful', sample: 'Hey!', className: 'bg-butter text-fg font-extrabold' },
  {
    id: 'Animated whiteboard',
    note: 'Hand-drawn diagrams',
    sample: 'a → b',
    className: 'bg-bg-hi text-fg-dim font-serif italic',
  },
  {
    id: 'Kinetic typography',
    note: 'Type in motion',
    sample: 'Go',
    className: 'bg-accent text-bg-hi font-extrabold uppercase tracking-tight',
  },
]

/** Page template by id; an unknown id falls back to the first template (prototype `PT`). */
export function pageTemplate(id: string): PageTemplate {
  return PAGE_TEMPLATES.find((t) => t.id === id) ?? PAGE_TEMPLATES[0]
}

/** Video template by id; an unknown id falls back to the first template (prototype `VT`). */
export function videoTemplate(id: string): VideoTemplate {
  return VIDEO_TEMPLATES.find((t) => t.id === id) ?? VIDEO_TEMPLATES[0]
}

/** A fresh page form for a template — picking a template resets every setting to these. */
export function pageDefaults(tplId: string): PageCfg {
  const t = pageTemplate(tplId)
  return { audience: t.audience, length: t.length, reads: [...t.reads], focus: '', topic: t.topic ?? '' }
}

/** A fresh video form for a template. */
export function videoDefaults(tplId: string): VideoCfg {
  const t = videoTemplate(tplId)
  return { kind: t.kind, target: t.target ?? '', style: t.style, length: t.length, mascot: t.mascot, focus: '' }
}

/** The page builder's prompt lines (joined with `\n` as the macro's extraInstructions). */
export function pagePromptLines(tplId: string, cfg: PageCfg): string[] {
  const t = pageTemplate(tplId)
  const reads = READ_SOURCES.filter((r) => cfg.reads.includes(r.id)).map((r) => r.label)
  const lines = [
    // `…` is the prototype's stand-in while the topic is blank (canGenerate blocks sending it).
    t.page === 'Custom topic' ? `Page: Custom topic: ${cfg.topic.trim() || '…'}` : `Page: ${t.page}`,
    `Audience: ${cfg.audience}`,
    `Length: ${cfg.length}`,
    `Read from: ${reads.join(', ') || 'nothing selected'}`,
  ]
  const focus = cfg.focus.trim()
  if (focus) lines.push(focus)
  return lines
}

/** The video builder's prompt lines; a target is named only for a non-demo kind. */
export function videoPromptLines(cfg: VideoCfg): string[] {
  const lines = [`Video kind: ${cfg.kind}`]
  const target = cfg.target.trim()
  if (cfg.kind !== 'Project demo' && target) lines.push(`Video target: ${target}`)
  lines.push(`Video style: ${cfg.style}`, `Video length: ${cfg.length}`, `Character: ${cfg.mascot ? 'on' : 'off'}`)
  const focus = cfg.focus.trim()
  if (focus) lines.push(focus)
  return lines
}

/** Template behind an existing knowledge-page id (switch, not an object lookup: `constructor` is a valid id). */
function pageTemplateIdFor(entryId: string): string {
  switch (entryId) {
    case 'overview':
      return 'overview'
    case 'how-it-works':
      return 'how'
    case 'faq':
      return 'faq'
    default:
      return 'custom'
  }
}

/** Template + display kind behind a recorded video kind slug. */
function videoKindFor(slug: string): { tplId: string; kind: VideoKind } {
  switch (slug) {
    case 'blog-post':
      return { tplId: 'blog', kind: 'Blog post' }
    case 'feature':
      return { tplId: 'feature', kind: 'Feature' }
    default: // 'project-demo', and any kind this build does not know
      return { tplId: 'demo', kind: 'Project demo' }
  }
}

/**
 * Regenerate pre-fill for a knowledge page. Pages record no audience / length / read-from, so the
 * form is the mapped template's defaults; any id but overview / how-it-works / faq is a Custom
 * topic carrying `meta.topic` (DESIGN_SPEC §8.3).
 */
export function pageCfgFromEntry(id: string, meta: ProjectPageMeta | null): { tplId: string; cfg: PageCfg } {
  const tplId = pageTemplateIdFor(id)
  const cfg = pageDefaults(tplId)
  return { tplId, cfg: tplId === 'custom' ? { ...cfg, topic: meta?.topic ?? '' } : cfg }
}

/** Regenerate pre-fill for a video: kind / style / length / Character from `meta`, target empty. */
export function videoCfgFromEntry(meta: ProjectVideoMeta): { tplId: string; cfg: VideoCfg } {
  const { tplId, kind } = videoKindFor(meta.kind)
  return {
    tplId,
    cfg: {
      kind,
      target: '',
      style: meta.style,
      length: meta.lengthS > 30 ? 60 : 30,
      mascot: meta.character !== null,
      focus: '',
    },
  }
}

/** Whether the composer's primary button is enabled: only a Custom topic page without a topic is blocked. */
export function canGenerate(kind: 'page' | 'video', tplId: string, cfg: PageCfg | VideoCfg): boolean {
  if (kind === 'video') return true
  if (pageTemplate(tplId).page !== 'Custom topic') return true
  return 'topic' in cfg && cfg.topic.trim() !== ''
}

/** Focus text after `+ <chip>`: `a. b` joining, one trailing `.` or `;` dropped (prototype `addChip`). */
export function addChip(focus: string, chip: string): string {
  const f = focus.trim()
  return f ? `${f.replace(/[.;]$/, '')}. ${chip}` : chip
}
