import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import type { ProjectPageMeta, ProjectVideoMeta } from '../../../../../../preload/api'
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
  pageCfgFromEntry,
  pageDefaults,
  pagePromptLines,
  pageTemplate,
  videoCfgFromEntry,
  videoDefaults,
  videoLengthFor,
  videoLengthsFor,
  videoPromptLines,
  videoTemplate,
} from '../composerTemplates'

// The design prototype is the source the templates are copied from (DESIGN_SPEC §3), so the
// "verbatim" criterion is checked against the prototype file itself, not a second hand copy.
const PROTOTYPE = readFileSync(
  new URL(
    '../../../../../../../session-manager-operations/design-mocks/project-home-v2/project-home-prototype.dc.html',
    import.meta.url,
  ),
  'utf8',
)
const SOURCE = readFileSync(new URL('../composerTemplates.ts', import.meta.url), 'utf8')

type Row = Record<string, unknown>

/**
 * The literal assigned by `const <name> = …;` in the prototype script, parsed without eval:
 * single-quoted strings become placeholders, keys get quoted, bare identifiers (the prototype's
 * colour/font constants) read as null, trailing commas go, then JSON.parse restores the strings.
 */
function prototypeConst(name: string): unknown {
  const head = `const ${name} = `
  const start = PROTOTYPE.indexOf(head)
  if (start < 0) throw new Error(`prototype has no const ${name}`)
  const rest = PROTOTYPE.slice(start + head.length)
  const literal = rest.slice(0, rest.search(/;\s*$/m))
  const strings: string[] = []
  const json = literal
    .replace(/'([^'\\]*)'/g, (_m, s: string) => `"@@${strings.push(s) - 1}"`)
    .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
    .replace(/:\s*(?!true\b|false\b|null\b)[A-Za-z_]\w*/g, ': null')
    .replace(/,(\s*[\]}])/g, '$1')
  return JSON.parse(json, (_key, value: unknown) =>
    typeof value === 'string' && /^@@\d+$/.test(value) ? strings[Number(value.slice(2))] : value,
  )
}
const protoRows = (name: string) => prototypeConst(name) as Row[]
const withoutProtoOnly = ({ lede: _lede, sample: _sample, ...rest }: Row) => rest

const pageMeta = (over: Partial<ProjectPageMeta> = {}): ProjectPageMeta => ({
  id: 'x',
  title: 'X',
  topic: '',
  createdAt: '2026-11-07T00:00:00.000Z',
  model: 'claude-opus-4-1',
  ...over,
})
const videoMeta = (over: Partial<ProjectVideoMeta> = {}): ProjectVideoMeta => ({
  id: 'v',
  title: 'V',
  kind: 'project-demo',
  style: 'Fun',
  lengthS: 30,
  createdAt: '2026-11-07T00:00:00.000Z',
  character: null,
  sources: [],
  report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: [], bytes: 0 },
  macroVersion: 1,
  seedVersion: 1,
  model: 'claude-opus-4-1',
  effort: 'high',
  ...over,
})

describe('template data — prototype lines 779–856, verbatim', () => {
  it('PAGE_TEMPLATES are the prototype PAGE_TPLS in order, without lede/sample', () => {
    expect(PAGE_TEMPLATES.map((t) => t.id)).toEqual(['overview', 'how', 'faq', 'start', 'recent', 'custom'])
    // Deliberate deviation: chips and covers are project-neutral (checked below), so they are not compared.
    const neutral = ({ chips: _chips, covers: _covers, ...rest }: Row) => rest
    expect(PAGE_TEMPLATES.map((t) => neutral({ ...t }))).toEqual(protoRows('PAGE_TPLS').map(withoutProtoOnly).map(neutral))
    for (const t of PAGE_TEMPLATES) {
      expect(t).not.toHaveProperty('lede')
      expect(t).not.toHaveProperty('sample')
    }
  })

  it('VIDEO_TEMPLATES are the prototype VIDEO_TPLS in order, then TikTok and Marketing', () => {
    expect(VIDEO_TEMPLATES.map((t) => t.id)).toEqual(['demo', 'feature', 'blog', 'whiteboard', 'custom', 'tiktok', 'marketing'])
    // One deliberate deviation: the Feature template names no default feature (a blank target blocks Generate).
    // Second deviation: chips are project-neutral (checked below), so they are not compared.
    // Third: `review` (Review first) is not in the prototype; every prototype template has it off.
    const noChips = ({ chips: _chips, review: _review, ...rest }: Row) => rest
    const proto = protoRows('VIDEO_TPLS').map((r) => (r.id === 'feature' ? { ...r, target: '' } : r))
    const fromProto = VIDEO_TEMPLATES.slice(0, proto.length)
    expect(fromProto.map((t) => noChips({ ...t }))).toEqual(proto.map(noChips))
    for (const t of fromProto) expect(t.review).toBe(false)
  })

  it('adds a TikTok and a Marketing template: 30 s, Character on, Review first on for TikTok only', () => {
    expect(videoTemplate('tiktok')).toMatchObject({ kind: 'TikTok', length: 30, mascot: true, review: true, target: '' })
    expect(videoTemplate('marketing')).toMatchObject({ kind: 'Marketing', length: 30, mascot: true, review: false, target: '' })
    for (const id of ['tiktok', 'marketing']) {
      const t = videoTemplate(id)
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.blurb.length).toBeGreaterThan(0)
      expect(t.scenes.length).toBeGreaterThan(0)
      expect(t.chips.length).toBeGreaterThan(0)
    }
  })

  it('option lists are the prototype AUDIENCES / LENGTHS / READS / KINDS / STYLES', () => {
    expect(AUDIENCES).toEqual(prototypeConst('AUDIENCES'))
    expect(PAGE_LENGTHS).toEqual(prototypeConst('LENGTHS'))
    expect(READ_SOURCES).toEqual([
      { id: 'docs', label: 'README & docs' },
      { id: 'tree', label: 'Source tree' },
      { id: 'git', label: 'Git log' },
    ])
    expect(READ_SOURCES).toEqual(prototypeConst('READS'))
    expect(VIDEO_KINDS).toEqual([...(prototypeConst('KINDS') as string[]), 'TikTok', 'Marketing'])
    expect(VIDEO_KINDS).toEqual(['Project demo', 'Blog post', 'Feature', 'TikTok', 'Marketing'])
    expect(VIDEO_STYLES.map(({ id, note, sample }) => ({ id, note, sample }))).toEqual(
      protoRows('STYLES').map(({ id, note, sample }) => ({ id, note, sample })),
    )
    const styleIds = VIDEO_STYLES.map((s) => s.id)
    for (const t of VIDEO_TEMPLATES) expect(styleIds).toContain(t.style)
  })

  it('an unknown template id falls back to the first template', () => {
    expect(pageTemplate('nope')).toBe(PAGE_TEMPLATES[0])
    expect(videoTemplate('nope')).toBe(VIDEO_TEMPLATES[0])
    expect(pageTemplate('faq').name).toBe('FAQ')
    expect(videoTemplate('blog').name).toBe('Blog post')
    expect(pageDefaults('nope')).toEqual(pageDefaults('overview'))
    expect(videoDefaults('nope')).toEqual(videoDefaults('demo'))
  })

  it('the module imports nothing but preload types (no React, bridge or store)', () => {
    expect(SOURCE.match(/^import .*$/gm)).toEqual([
      "import type { ProjectPageMeta, ProjectVideoMeta } from '../../../../../preload/api'",
    ])
    expect(SOURCE).not.toMatch(/\bwindow\b/)
  })
})

describe('VIDEO_STYLES swatch classes (DESIGN_SPEC §2)', () => {
  it('are the five fixed token class sets', () => {
    expect(Object.fromEntries(VIDEO_STYLES.map((s) => [s.id, s.className]))).toEqual({
      Auto: 'bg-bg-elev text-fg',
      Professional: 'bg-fg text-bg font-serif',
      Fun: 'bg-butter text-fg font-extrabold',
      'Animated whiteboard': 'bg-bg-hi text-fg-dim font-serif italic',
      'Kinetic typography': 'bg-accent text-bg-hi font-extrabold uppercase tracking-tight',
    })
  })

  it('are complete string literals in the module source, never interpolated (Tailwind JIT)', () => {
    for (const s of VIDEO_STYLES) expect(SOURCE).toContain(`className: '${s.className}'`)
    expect(SOURCE).not.toMatch(/className:\s*`/)
  })
})

describe('pageDefaults / videoDefaults', () => {
  it('copy the template defaults with an empty focus', () => {
    expect(pageDefaults('how')).toEqual({
      audience: 'Contributors',
      length: 'In-depth',
      reads: ['docs', 'tree'],
      focus: '',
      topic: '',
    })
    expect(pageDefaults('start').topic).toBe('Getting started: install, first run, key commands')
    expect(videoDefaults('demo')).toEqual({
      kind: 'Project demo',
      target: '',
      style: 'Auto',
      length: 30,
      mascot: true,
      review: false,
      focus: '',
    })
    expect(videoDefaults('feature')).toEqual({
      kind: 'Feature',
      target: '',
      style: 'Kinetic typography',
      length: 30,
      mascot: false,
      review: false,
      focus: '',
    })
    expect(videoDefaults('tiktok')).toMatchObject({ kind: 'TikTok', length: 30, mascot: true, review: true })
    expect(videoDefaults('marketing')).toMatchObject({ kind: 'Marketing', length: 30, mascot: true, review: false })
  })

  it('turn Character on when the project has a persona, and leave it at the template default otherwise', () => {
    expect(videoDefaults('feature', { hasPersona: true }).mascot).toBe(true)
    expect(videoDefaults('blog', { hasPersona: true }).mascot).toBe(true)
    expect(videoDefaults('feature', { hasPersona: false }).mascot).toBe(false)
    expect(videoDefaults('feature', {}).mascot).toBe(false)
    expect(videoDefaults('demo', { hasPersona: false }).mascot).toBe(true)
  })

  it('15 s is a TikTok-only length', () => {
    expect(videoLengthsFor('TikTok')).toEqual([15, 30, 60])
    for (const k of ['Project demo', 'Blog post', 'Feature', 'Marketing'] as const) expect(videoLengthsFor(k)).toEqual([30, 60])
    expect(videoLengthFor('TikTok', 15)).toBe(15)
    expect(videoLengthFor('Marketing', 15)).toBe(30)
    expect(videoLengthFor('Project demo', 15)).toBe(30)
    expect(videoLengthFor('Feature', 60)).toBe(60)
  })

  it('hand back a fresh reads array, never the template’s own', () => {
    const cfg = pageDefaults('overview')
    cfg.reads.pop()
    expect(pageTemplate('overview').reads).toEqual(['docs', 'tree', 'git'])
    expect(pageDefaults('overview').reads).toEqual(['docs', 'tree', 'git'])
  })
})

describe('pagePromptLines', () => {
  it('returns exactly the four lines for the overview defaults', () => {
    expect(pagePromptLines('overview', pageDefaults('overview'))).toEqual([
      'Page: Overview',
      'Audience: Newcomers',
      'Length: Standard',
      'Read from: README & docs, Source tree, Git log',
    ])
  })

  it('names the fixed pages', () => {
    expect(pagePromptLines('how', pageDefaults('how'))).toEqual([
      'Page: How it works',
      'Audience: Contributors',
      'Length: In-depth',
      'Read from: README & docs, Source tree',
    ])
    expect(pagePromptLines('faq', pageDefaults('faq'))[0]).toBe('Page: FAQ')
  })

  it('emits "Page: Custom topic: <topic>" for custom-topic templates', () => {
    expect(pagePromptLines('start', pageDefaults('start'))[0]).toBe(
      'Page: Custom topic: Getting started: install, first run, key commands',
    )
    expect(pagePromptLines('custom', { ...pageDefaults('custom'), topic: ' A glossary of terms ' })[0]).toBe(
      'Page: Custom topic: A glossary of terms',
    )
    // The footer preview shows the prototype's placeholder while the topic is still blank.
    expect(pagePromptLines('custom', pageDefaults('custom'))[0]).toBe('Page: Custom topic: …')
  })

  it('lists Read from labels in fixed order, or "nothing selected"', () => {
    expect(pagePromptLines('recent', pageDefaults('recent'))[3]).toBe('Read from: README & docs, Git log')
    expect(pagePromptLines('overview', { ...pageDefaults('overview'), reads: ['git', 'tree', 'docs'] })[3]).toBe(
      'Read from: README & docs, Source tree, Git log',
    )
    expect(pagePromptLines('overview', { ...pageDefaults('overview'), reads: [] })[3]).toBe(
      'Read from: nothing selected',
    )
  })

  it('appends the trimmed focus last, only when non-empty', () => {
    const lines = pagePromptLines('overview', { ...pageDefaults('overview'), focus: '  Lead with the scheduler \n' })
    expect(lines).toHaveLength(5)
    expect(lines[4]).toBe('Lead with the scheduler')
    expect(pagePromptLines('overview', { ...pageDefaults('overview'), focus: ' \n ' })).toHaveLength(4)
  })
})

describe('videoPromptLines', () => {
  it('never names a target for a Project demo', () => {
    const demo = ['Video kind: Project demo', 'Video style: Auto', 'Video length: 30', 'Character: on']
    expect(videoPromptLines(videoDefaults('demo'))).toEqual(demo)
    expect(videoPromptLines({ ...videoDefaults('demo'), target: 'Scheduler' })).toEqual(demo)
  })

  it('names a non-empty target for the other kinds', () => {
    expect(videoPromptLines({ ...videoDefaults('feature'), target: 'Scheduler / PRD queue' })).toEqual([
      'Video kind: Feature',
      'Video target: Scheduler / PRD queue',
      'Video style: Kinetic typography',
      'Video length: 30',
      'Character: off',
    ])
    const blog = ['Video kind: Blog post', 'Video style: Professional', 'Video length: 60', 'Character: off']
    expect(videoPromptLines(videoDefaults('blog'))).toEqual(blog)
    expect(videoPromptLines({ ...videoDefaults('blog'), target: '   ' })).toEqual(blog)
  })

  it('adds a Voice line right after Video style when a voice is picked, and none for Default', () => {
    expect(videoPromptLines({ ...videoDefaults('demo'), voice: 'am_michael' })).toEqual([
      'Video kind: Project demo',
      'Video style: Auto',
      'Voice: am_michael',
      'Video length: 30',
      'Character: on',
    ])
    const plain = videoPromptLines(videoDefaults('demo'))
    expect(videoPromptLines({ ...videoDefaults('demo'), voice: '' })).toEqual(plain)
    expect(videoPromptLines({ ...videoDefaults('demo'), voice: '  ' })).toEqual(plain)
    expect(plain.some((l) => l.startsWith('Voice:'))).toBe(false)
  })

  it('appends the trimmed focus last, only when non-empty', () => {
    expect(videoPromptLines({ ...videoDefaults('whiteboard'), focus: ' Slow, calm pace ' })).toEqual([
      'Video kind: Project demo',
      'Video style: Animated whiteboard',
      'Video length: 60',
      'Character: on',
      'Slow, calm pace',
    ])
    expect(videoPromptLines({ ...videoDefaults('whiteboard'), focus: '  ' })).toHaveLength(4)
  })

  it('names TikTok / Marketing kinds and an optional target, and never emits a Review line', () => {
    expect(videoPromptLines(videoDefaults('tiktok'))).toEqual([
      'Video kind: TikTok',
      'Video style: Fun',
      'Video length: 30',
      'Character: on',
    ])
    expect(videoPromptLines({ ...videoDefaults('tiktok'), length: 15, target: 'docs/series.md' })).toEqual([
      'Video kind: TikTok',
      'Video target: docs/series.md',
      'Video style: Fun',
      'Video length: 15',
      'Character: on',
    ])
    expect(videoPromptLines({ ...videoDefaults('marketing'), target: 'https://example.com' })[1]).toBe(
      'Video target: https://example.com',
    )
    for (const t of VIDEO_TEMPLATES) {
      for (const review of [true, false]) {
        expect(videoPromptLines({ ...videoDefaults(t.id), review }).some((l) => /^review\b/i.test(l))).toBe(false)
      }
    }
  })
})

describe('pageCfgFromEntry', () => {
  it('maps overview / how-it-works / faq to their templates with that template’s defaults', () => {
    expect(pageCfgFromEntry('overview', pageMeta({ topic: 'ignored' }))).toEqual({
      tplId: 'overview',
      cfg: pageDefaults('overview'),
    })
    expect(pageCfgFromEntry('how-it-works', pageMeta())).toEqual({ tplId: 'how', cfg: pageDefaults('how') })
    expect(pageCfgFromEntry('faq', null)).toEqual({ tplId: 'faq', cfg: pageDefaults('faq') })
  })

  it('maps any other id to Custom topic with topic = meta.topic', () => {
    expect(pageCfgFromEntry('getting-started-1x2y', pageMeta({ topic: 'Getting started: install' }))).toEqual({
      tplId: 'custom',
      cfg: { ...pageDefaults('custom'), topic: 'Getting started: install' },
    })
    expect(pageCfgFromEntry('how', pageMeta({ topic: 'How' })).tplId).toBe('custom')
    expect(pageCfgFromEntry('constructor', pageMeta({ topic: 'Constructors' })).tplId).toBe('custom')
    expect(pageCfgFromEntry('orphan', null)).toEqual({ tplId: 'custom', cfg: { ...pageDefaults('custom'), topic: '' } })
  })
})

describe('videoCfgFromEntry', () => {
  it('maps the kind slug to its display name and template, keeping style, with an empty target when none was recorded', () => {
    expect(videoCfgFromEntry(videoMeta({ kind: 'project-demo', style: 'Fun', lengthS: 30, character: 'otter' }))).toEqual({
      tplId: 'demo',
      cfg: { kind: 'Project demo', target: '', style: 'Fun', length: 30, mascot: true, review: false, focus: '' },
    })
    expect(videoCfgFromEntry(videoMeta({ kind: 'blog-post', style: 'Professional', lengthS: 60 }))).toEqual({
      tplId: 'blog',
      cfg: { kind: 'Blog post', target: '', style: 'Professional', length: 60, mascot: false, review: false, focus: '' },
    })
    expect(videoCfgFromEntry(videoMeta({ kind: 'feature', style: 'Kinetic typography' }))).toEqual({
      tplId: 'feature',
      cfg: { kind: 'Feature', target: '', style: 'Kinetic typography', length: 30, mascot: false, review: false, focus: '' },
    })
  })

  it('pre-fills the trimmed meta.target, so a Blog post that recorded one can generate', () => {
    const withTarget = videoCfgFromEntry(videoMeta({ kind: 'blog-post', target: '  content/writing/post.md ' }))
    expect(withTarget.cfg.target).toBe('content/writing/post.md')
    expect(canGenerate('video', withTarget.tplId, withTarget.cfg)).toBe(true)
    const without = videoCfgFromEntry(videoMeta({ kind: 'blog-post' }))
    expect(without.cfg.target).toBe('')
    expect(canGenerate('video', without.tplId, without.cfg)).toBe(false)
    expect(videoCfgFromEntry(videoMeta({ kind: 'feature', target: 'Scheduler' })).cfg.target).toBe('Scheduler')
  })

  it('is 60 seconds only when lengthS > 30', () => {
    expect(videoCfgFromEntry(videoMeta({ lengthS: 31 })).cfg.length).toBe(60)
    expect(videoCfgFromEntry(videoMeta({ lengthS: 30 })).cfg.length).toBe(30)
    expect(videoCfgFromEntry(videoMeta({ lengthS: 12 })).cfg.length).toBe(30)
  })

  it('turns Character on for any non-null meta.character', () => {
    expect(videoCfgFromEntry(videoMeta({ character: '' })).cfg.mascot).toBe(true)
    expect(videoCfgFromEntry(videoMeta({ character: null })).cfg.mascot).toBe(false)
  })

  it('maps tiktok and marketing to their templates, with Review first at the template default', () => {
    expect(videoCfgFromEntry(videoMeta({ kind: 'tiktok', lengthS: 15, character: 'Pip' }))).toEqual({
      tplId: 'tiktok',
      cfg: { kind: 'TikTok', target: '', style: 'Fun', length: 15, mascot: true, review: true, focus: '' },
    })
    expect(videoCfgFromEntry(videoMeta({ kind: 'tiktok', lengthS: 28 })).cfg.length).toBe(30)
    expect(videoCfgFromEntry(videoMeta({ kind: 'marketing', lengthS: 12, target: 'https://x.dev' }))).toMatchObject({
      tplId: 'marketing',
      cfg: { kind: 'Marketing', target: 'https://x.dev', length: 30, review: false },
    })
  })

  it('reads an unrecognised kind as a Project demo', () => {
    const kind = 'trailer' as unknown as ProjectVideoMeta['kind']
    expect(videoCfgFromEntry(videoMeta({ kind }))).toMatchObject({ tplId: 'demo', cfg: { kind: 'Project demo' } })
  })
})

describe('canGenerate', () => {
  it('is false for a custom-topic page with a blank topic', () => {
    expect(canGenerate('page', 'custom', pageDefaults('custom'))).toBe(false)
    expect(canGenerate('page', 'custom', { ...pageDefaults('custom'), topic: '   ' })).toBe(false)
    expect(canGenerate('page', 'start', { ...pageDefaults('start'), topic: '' })).toBe(false)
    expect(canGenerate('page', 'custom', { ...pageDefaults('custom'), topic: 'Glossary' })).toBe(true)
    expect(canGenerate('page', 'start', pageDefaults('start'))).toBe(true)
  })

  it('is true for the fixed pages', () => {
    expect(canGenerate('page', 'overview', pageDefaults('overview'))).toBe(true)
    expect(canGenerate('page', 'faq', { ...pageDefaults('faq'), reads: [] })).toBe(true)
  })

  it('is false for a Blog post or Feature video with a blank target; a Project demo always generates', () => {
    expect(canGenerate('video', 'blog', videoDefaults('blog'))).toBe(false)
    expect(canGenerate('video', 'feature', { ...videoDefaults('feature'), target: '' })).toBe(false)
    expect(canGenerate('video', 'blog', { ...videoDefaults('blog'), target: 'x' })).toBe(true)
    expect(canGenerate('video', 'feature', { ...videoDefaults('feature'), target: 'x' })).toBe(true)
    for (const id of ['demo', 'whiteboard', 'custom']) expect(canGenerate('video', id, videoDefaults(id))).toBe(true)
    expect(canGenerate('video', 'demo', { ...videoDefaults('demo'), kind: 'Blog post', target: '  ' })).toBe(false)
    expect(VIDEO_TEMPLATES.find((t) => t.id === 'feature')?.target).toBe('')
  })

  it('is true for TikTok and Marketing with or without a target', () => {
    for (const id of ['tiktok', 'marketing']) {
      expect(canGenerate('video', id, videoDefaults(id))).toBe(true)
      expect(canGenerate('video', id, { ...videoDefaults(id), target: '   ' })).toBe(true)
      expect(canGenerate('video', id, { ...videoDefaults(id), target: 'x' })).toBe(true)
    }
    expect(canGenerate('video', 'demo', { ...videoDefaults('demo'), kind: 'TikTok', target: '' })).toBe(true)
  })
})

describe('addChip', () => {
  it('is the chip itself on an empty focus', () => {
    expect(addChip('', 'Keep it upbeat')).toBe('Keep it upbeat')
    expect(addChip('  ', 'Keep it upbeat')).toBe('Keep it upbeat')
  })

  it('joins with ". " after dropping one trailing . or ;', () => {
    expect(addChip('Lead with the scheduler', 'Say it runs locally')).toBe('Lead with the scheduler. Say it runs locally')
    expect(addChip(' Lead with the scheduler. ', 'Say it runs locally')).toBe(
      'Lead with the scheduler. Say it runs locally',
    )
    expect(addChip('No jargon;', 'Show a real PRD')).toBe('No jargon. Show a real PRD')
  })
})

describe('template chips and covers are project-neutral', () => {
  // Templates show in every project, so no suggestion may name a Session Manager feature.
  const BANNED = [
    'scheduler', 'prd', 'queue', 'main process', 'renderer', 'claude cli', 'web remote', 'dormant',
    'telemetry', '--simple', 'field manual', 'agent tools', 'install line', 'page build',
  ]
  it('no chip, cover, scene, topic or target names a Session Manager feature', () => {
    const texts: string[] = []
    for (const t of PAGE_TEMPLATES) texts.push(...t.chips, ...t.covers, t.topic ?? '')
    for (const t of VIDEO_TEMPLATES) texts.push(...t.chips, ...t.scenes, t.target ?? '')
    const hits = texts.flatMap((s) => BANNED.filter((b) => s.toLowerCase().includes(b)).map((b) => `${b} in "${s}"`))
    expect(hits).toEqual([])
  })
})
