// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GenerateComposer, type GenerateComposerProps } from '../GenerateComposer'
import { pageDefaults, type VideoCfg } from '../composerTemplates'
import { Z } from '../../../../../lib/zLayers'

type OnGenerate = GenerateComposerProps['onGenerate']

const COMPOSER = '[data-testid="project-home-composer"]'

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

// The composer portals into document.body, so every query reads the whole document.
function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`no element matches ${sel}`)
  return el
}
const click = (el: HTMLElement) => act(() => el.click())
const lines = () => $('[data-testid="composer-lines"]').textContent
const eyebrow = () => $('[data-testid="composer-eyebrow"]').textContent
const focusBox = () => $<HTMLTextAreaElement>('[data-testid="composer-focus"]')
const topic = () => $<HTMLInputElement>('[data-testid="composer-topic"]')
const target = () => $<HTMLInputElement>('[data-testid="composer-target"]')
const generate = () => $<HTMLButtonElement>('[data-testid="composer-generate"]')
const template = (id: string) => $(`[data-testid="composer-template"][data-tpl="${id}"]`)
const pickedTemplate = () => $('[data-testid="composer-template"][aria-pressed="true"]').dataset.tpl
const option = (group: string, label: string) => {
  const btn = Array.from(document.querySelectorAll<HTMLElement>(`[role="group"][aria-label="${group}"] button`)).find(
    (b) => b.textContent === label,
  )
  if (!btn) throw new Error(`no "${label}" option in ${group}`)
  return btn
}
const picked = (group: string) => $(`[role="group"][aria-label="${group}"] [aria-pressed="true"]`).textContent
const readsOn = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-read][aria-pressed="true"]')).map((b) => b.dataset.read)
const style = (id: string) => $(`[data-testid="composer-style"][data-style="${id}"]`)
const pickedStyle = () => $('[data-testid="composer-style"][aria-pressed="true"]').dataset.style
const character = () => $('[data-testid="composer-character"]')
const chip = (label: string) => $(`[data-testid="composer-chip"][data-chip="${label}"]`)

/** React tracks input values itself — set through the native setter, then fire `input`. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setValue.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A caller that unmounts the composer on close and can reopen it — close paths assert on the DOM. */
function Host({ kind }: { kind: 'page' | 'video' }) {
  const [open, setOpen] = useState(true)
  if (!open) {
    return (
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
        reopen
      </button>
    )
  }
  return <GenerateComposer kind={kind} onClose={() => setOpen(false)} onGenerate={() => {}} />
}

describe('GenerateComposer — Generate mode', () => {
  it('opens on the first template in a Z.dialog modal; picking a page template resets every setting', () => {
    mount(<GenerateComposer kind="page" onClose={vi.fn()} onGenerate={vi.fn<OnGenerate>()} />)
    const overlay = $(COMPOSER)
    expect(overlay.className.split(/\s+/)).toContain(Z.dialog)
    expect($('[role="dialog"]').getAttribute('aria-modal')).toBe('true')
    expect($('[data-testid="composer-title"]').textContent).toBe('Generate page')
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="composer-template"]')).map((t) => t.dataset.tpl),
    ).toEqual(['overview', 'how', 'faq', 'start', 'recent', 'custom'])
    expect(pickedTemplate()).toBe('overview')
    expect(eyebrow()).toBe('TEMPLATE · OVERVIEW')
    expect($('[data-testid="composer-agent"]').textContent).toBe('Sent to project-home-builder as')
    expect(document.querySelector('[data-testid="composer-topic"]')).toBeNull()

    click(option('Written for', 'Contributors'))
    click(option('Length', 'In-depth'))
    click($('[data-read="git"]'))
    type(focusBox(), 'Skip the history')
    expect(lines()).toBe(
      'Page: Overview · Audience: Contributors · Length: In-depth · Read from: README & docs, Source tree · Skip the history',
    )

    click(template('faq'))
    expect(pickedTemplate()).toBe('faq')
    expect(eyebrow()).toBe('TEMPLATE · FAQ')
    expect(picked('Written for')).toBe('Newcomers')
    expect(picked('Length')).toBe('Brief')
    expect(readsOn()).toEqual(['docs'])
    expect(focusBox().value).toBe('')
    expect(lines()).toBe('Page: FAQ · Audience: Newcomers · Length: Brief · Read from: README & docs')
  })

  it('picking a video template resets kind, target, style, length and Character', () => {
    mount(<GenerateComposer kind="video" onClose={vi.fn()} onGenerate={vi.fn<OnGenerate>()} />)
    expect($('[data-testid="composer-title"]').textContent).toBe('Generate video')
    expect(pickedTemplate()).toBe('demo')
    expect($('[data-testid="composer-agent"]').textContent).toBe('Sent to demo-video-builder as')
    expect(document.querySelector('[data-testid="composer-target"]')).toBeNull()

    click(option('Kind', 'Feature'))
    type(target(), 'Scheduler')
    click(style('Fun'))
    click(character())
    expect(lines()).toBe('Video kind: Feature · Video target: Scheduler · Video style: Fun · Video length: 30 · Character: off')

    click(template('whiteboard'))
    expect(eyebrow()).toBe('TEMPLATE · WHITEBOARD EXPLAINER')
    expect(picked('Kind')).toBe('Project demo')
    expect(document.querySelector('[data-testid="composer-target"]')).toBeNull()
    expect(pickedStyle()).toBe('Animated whiteboard')
    expect(picked('Length')).toBe('1 minute')
    expect(character().getAttribute('aria-checked')).toBe('true')
    expect(lines()).toBe('Video kind: Project demo · Video style: Animated whiteboard · Video length: 60 · Character: on')

    click(option('Kind', 'Feature'))
    expect(target().value).toBe('')
  })

  it('keeps Generate disabled until a Custom topic page has a topic', () => {
    const onGenerate = vi.fn<OnGenerate>()
    mount(<GenerateComposer kind="page" initialTplId="custom" onClose={vi.fn()} onGenerate={onGenerate} />)
    expect(pickedTemplate()).toBe('custom')
    expect(generate().disabled).toBe(true)
    expect(lines()).toBe('Page: Custom topic: … · Audience: Users · Length: Standard · Read from: README & docs, Source tree, Git log')
    click(generate())
    expect(onGenerate).not.toHaveBeenCalled()

    type(topic(), '   ')
    expect(generate().disabled).toBe(true)
    type(topic(), 'The security model')
    expect(generate().disabled).toBe(false)
    expect(lines()).toBe(
      'Page: Custom topic: The security model · Audience: Users · Length: Standard · Read from: README & docs, Source tree, Git log',
    )

    // A template that is not a Custom topic has no Topic field and never blocks.
    click(template('overview'))
    expect(document.querySelector('[data-testid="composer-topic"]')).toBeNull()
    expect(generate().disabled).toBe(false)
  })

  it('a focus chip appends to the focus text', () => {
    mount(<GenerateComposer kind="page" onClose={vi.fn()} onGenerate={vi.fn<OnGenerate>()} />)
    expect(Array.from(document.querySelectorAll('[data-testid="composer-chip"]')).map((c) => c.textContent)).toEqual([
      '+ Lead with the scheduler',
      '+ Keep install to one line',
      '+ Say it runs locally',
    ])
    click(chip('Lead with the scheduler'))
    expect(focusBox().value).toBe('Lead with the scheduler')
    type(focusBox(), 'Lead with the scheduler first.')
    click(chip('Say it runs locally'))
    expect(focusBox().value).toBe('Lead with the scheduler first. Say it runs locally')
    expect(lines()?.endsWith(' · Lead with the scheduler first. Say it runs locally')).toBe(true)
  })

  it('passes the exact page lines to onGenerate, with no entry to replace', () => {
    const onGenerate = vi.fn<OnGenerate>()
    mount(<GenerateComposer kind="page" onClose={vi.fn()} onGenerate={onGenerate} />)
    click(option('Written for', 'Users'))
    click($('[data-read="tree"]'))
    type(focusBox(), '  Lead with the scheduler  ')
    expect(generate().textContent).toBe('Generate page')
    click(generate())
    expect(onGenerate.mock.calls).toEqual([
      [['Page: Overview', 'Audience: Users', 'Length: Standard', 'Read from: README & docs, Git log', 'Lead with the scheduler']],
    ])
  })

  it('passes the exact video lines to onGenerate; Project demo hides and drops the target', () => {
    const onGenerate = vi.fn<OnGenerate>()
    mount(<GenerateComposer kind="video" initialTplId="feature" onClose={vi.fn()} onGenerate={onGenerate} />)
    expect(target().value).toBe('Scheduler / PRD queue')
    expect($('[data-testid="composer-target-label"]').textContent).toBe('Feature · optional')
    type(target(), 'Scheduler')
    click(style('Fun'))
    click(option('Length', '1 minute'))
    click(character())
    type(focusBox(), 'Show a real PRD')
    expect(generate().textContent).toBe('Generate video')
    click(generate())
    expect(onGenerate.mock.calls).toEqual([
      [['Video kind: Feature', 'Video target: Scheduler', 'Video style: Fun', 'Video length: 60', 'Character: on', 'Show a real PRD']],
    ])

    click(option('Kind', 'Blog post'))
    expect($('[data-testid="composer-target-label"]').textContent).toBe('Post · optional')
    click(option('Kind', 'Project demo'))
    expect(document.querySelector('[data-testid="composer-target"]')).toBeNull()
    expect(lines()).toBe('Video kind: Project demo · Video style: Fun · Video length: 60 · Character: on · Show a real PRD')
  })
})

describe('GenerateComposer — Regenerate mode', () => {
  it('shows config only, pre-filled from the entry, and passes the entry id', () => {
    const onGenerate = vi.fn<OnGenerate>()
    const regen = {
      entryId: 'security-model',
      title: 'The security model',
      tplId: 'custom',
      cfg: { ...pageDefaults('custom'), topic: 'The security model' },
    }
    mount(<GenerateComposer kind="page" regen={regen} onClose={vi.fn()} onGenerate={onGenerate} />)
    expect($('[data-testid="composer-title"]').textContent).toBe('Regenerate “The security model”')
    expect(document.querySelectorAll('[data-testid="composer-template"]')).toHaveLength(0)
    expect(eyebrow()).toBe('REBUILDING · security-model')
    expect(topic().value).toBe('The security model')
    expect(generate().textContent).toBe('Regenerate')

    click(option('Length', 'Brief'))
    click(generate())
    expect(onGenerate.mock.calls).toEqual([
      [
        [
          'Page: Custom topic: The security model',
          'Audience: Users',
          'Length: Brief',
          'Read from: README & docs, Source tree, Git log',
        ],
        'security-model',
      ],
    ])
  })

  it('pre-fills a video from its recorded settings and passes the entry id', () => {
    const onGenerate = vi.fn<OnGenerate>()
    const cfg: VideoCfg = { kind: 'Project demo', target: '', style: 'Fun', length: 60, mascot: false, focus: '' }
    mount(
      <GenerateComposer
        kind="video"
        regen={{ entryId: 'project-demo', title: 'Project demo', tplId: 'demo', cfg }}
        onClose={vi.fn()}
        onGenerate={onGenerate}
      />,
    )
    expect(pickedStyle()).toBe('Fun')
    expect(picked('Length')).toBe('1 minute')
    expect(character().getAttribute('aria-checked')).toBe('false')
    click(generate())
    expect(onGenerate.mock.calls).toEqual([
      [['Video kind: Project demo', 'Video style: Fun', 'Video length: 60', 'Character: off'], 'project-demo'],
    ])
  })
})

describe('GenerateComposer — closing', () => {
  it('closes on Escape, an overlay click, Cancel and the × button; clicks inside the panel do not', () => {
    mount(<Host kind="page" />)
    const reopen = () => click($('[data-testid="reopen"]'))

    click($('[data-testid="composer-eyebrow"]'))
    click($('[role="dialog"]'))
    click(option('Length', 'Brief'))
    expect(document.querySelector(COMPOSER)).not.toBeNull()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector(COMPOSER)).toBeNull()

    reopen()
    // A press that starts in the panel (selecting focus text) and is released over the overlay
    // must not close it — the browser fires that click on the overlay.
    act(() => {
      focusBox().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      $(COMPOSER).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.querySelector(COMPOSER)).not.toBeNull()
    act(() => {
      $(COMPOSER).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      $(COMPOSER).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.querySelector(COMPOSER)).toBeNull()

    reopen()
    click($('[data-testid="composer-cancel"]'))
    expect(document.querySelector(COMPOSER)).toBeNull()

    reopen()
    click($('[data-testid="composer-close"]'))
    expect(document.querySelector(COMPOSER)).toBeNull()
  })
})
