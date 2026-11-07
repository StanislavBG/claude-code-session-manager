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
    expect(PAGE_TEMPLATES).toEqual(protoRows('PAGE_TPLS').map(withoutProtoOnly))
    for (const t of PAGE_TEMPLATES) {
      expect(t).not.toHaveProperty('lede')
      expect(t).not.toHaveProperty('sample')
    }
  })

  it('VIDEO_TEMPLATES are the prototype VIDEO_TPLS in order', () => {
    expect(VIDEO_TEMPLATES.map((t) => t.id)).toEqual(['demo', 'feature', 'blog', 'whiteboard', 'custom'])
    expect(VIDEO_TEMPLATES).toEqual(protoRows('VIDEO_TPLS'))
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
    expect(VIDEO_KINDS).toEqual(prototypeConst('KINDS'))
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
      focus: '',
    })
    expect(videoDefaults('feature')).toEqual({
      kind: 'Feature',
      target: 'Scheduler / PRD queue',
      style: 'Kinetic typography',
      length: 30,
      mascot: false,
      focus: '',
    })
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
    expect(videoPromptLines(videoDefaults('feature'))).toEqual([
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
  it('maps the kind slug to its display name and template, keeping style, with an empty target', () => {
    expect(videoCfgFromEntry(videoMeta({ kind: 'project-demo', style: 'Fun', lengthS: 30, character: 'otter' }))).toEqual({
      tplId: 'demo',
      cfg: { kind: 'Project demo', target: '', style: 'Fun', length: 30, mascot: true, focus: '' },
    })
    expect(videoCfgFromEntry(videoMeta({ kind: 'blog-post', style: 'Professional', lengthS: 60 }))).toEqual({
      tplId: 'blog',
      cfg: { kind: 'Blog post', target: '', style: 'Professional', length: 60, mascot: false, focus: '' },
    })
    expect(videoCfgFromEntry(videoMeta({ kind: 'feature', style: 'Kinetic typography' }))).toEqual({
      tplId: 'feature',
      cfg: { kind: 'Feature', target: '', style: 'Kinetic typography', length: 30, mascot: false, focus: '' },
    })
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

  it('is true for the fixed pages and for every video', () => {
    expect(canGenerate('page', 'overview', pageDefaults('overview'))).toBe(true)
    expect(canGenerate('page', 'faq', { ...pageDefaults('faq'), reads: [] })).toBe(true)
    for (const t of VIDEO_TEMPLATES) expect(canGenerate('video', t.id, videoDefaults(t.id))).toBe(true)
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
