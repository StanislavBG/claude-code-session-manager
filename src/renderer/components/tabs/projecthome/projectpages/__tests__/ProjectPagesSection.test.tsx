// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectPagesSection } from '../ProjectPagesSection'
import { useToast } from '../../../../../state/toast'
import type { Macro, MacroJobStatus } from '../../../../../../preload/api'

const HTML = '<!DOCTYPE html><html><body>HOME</body></html>'

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    config: { readText: vi.fn(async () => ({ exists: true, text: HTML, mtimeMs: 1, error: null, truncated: false })) },
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function macro(over: Partial<Macro> = {}): Macro {
  return {
    id: 'builtin-project-home',
    label: 'Project Home',
    agentName: 'project-home-builder',
    tag: 'project-home-builder',
    prompt: 'Generate it.',
    projects: ['*'],
    surface: 'project-home',
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

const HOME_MACRO = macro()
const DEMO_MACRO = macro({ id: 'builtin-demo-video', label: 'Demo Video', agentName: 'demo-video-builder' })
const MACROS = [HOME_MACRO, DEMO_MACRO]

const kEntry = (id: string, title: string, mtimeMs: number, meta = true): any => ({
  id,
  path: `/tmp/k/${id}/index.html`,
  mtimeMs,
  error: meta ? null : 'meta.json missing',
  meta: meta ? { id, title, topic: 't', createdAt: new Date(mtimeMs).toISOString(), model: 'm' } : null,
})
const vEntry = (id: string, title: string, mtimeMs: number, over: any = {}, meta = true): any => ({
  id,
  path: `/tmp/v/${id}/index.html`,
  mtimeMs,
  error: meta ? null : 'bad meta',
  meta: meta
    ? {
        id, title, kind: 'project-demo', style: 'Fun', lengthS: 30,
        createdAt: new Date(mtimeMs).toISOString(), character: null, sources: [],
        report: { lufs: -16.2, truePeakDb: -1, speechS: 20, readingGrade: 7.5, checks: [], bytes: 1 },
        macroVersion: 1, seedVersion: 1, model: 'm', effort: 'x', ...over,
      }
    : null,
})
const NEW_K = kEntry('b', 'Newer page', 2000)
const OLD_K = kEntry('a', 'Older page', 1000)
const NEW_V = vEntry('v2', 'Newer video', 2000)
const OLD_V = vEntry('v1', 'Older video', 1000, { kind: 'blog-post', lengthS: 60, report: { lufs: null, readingGrade: null, checks: [], bytes: 1 } })

function props(over: Record<string, unknown> = {}) {
  return { knowledge: [], videos: [], loaded: true, macros: MACROS, launching: null, onLaunch: () => {}, ...over } as any
}
const flush = () => act(async () => { await Promise.resolve() })
const switchTo = (el: HTMLElement, page: string) =>
  act(() => (el.querySelector(`[data-testid="project-home-page-switch"] [data-page="${page}"]`) as HTMLElement).click())
const macroBtn = (el: HTMLElement, id: string) =>
  el.querySelector(`[data-testid="project-home-macro"][data-macro-id="${id}"]`) as HTMLButtonElement

describe('ProjectPagesSection', () => {
  it('while loading shows the switch and a loading body, no empty state or page button', () => {
    const el = mount(<ProjectPagesSection {...props({ loaded: false })} />)
    expect(el.querySelector('[data-testid="project-home-page-switch"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="project-home-loading"]')?.textContent).toBe('Loading pages…')
    expect(el.querySelector('[data-testid="knowledge-page-empty"]')).toBeNull()
    expect(el.querySelector('[data-testid="video-page-empty"]')).toBeNull()
    expect(macroBtn(el, 'builtin-project-home')).toBeNull()
  })

  it('loaded with no entries shows each empty state', async () => {
    const el = mount(<ProjectPagesSection {...props()} />)
    expect(el.querySelector('[data-testid="knowledge-page-empty"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="project-home-loading"]')).toBeNull()
    await switchTo(el, 'videos')
    expect(el.querySelector('[data-testid="video-page-empty"]')).not.toBeNull()
  })

  it('loaded with entries shows knowledge-page-item and video-item', async () => {
    const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K], videos: [NEW_V] })} />)
    await flush()
    expect(el.querySelector('[data-testid="knowledge-page-item"]')).not.toBeNull()
    await switchTo(el, 'videos')
    expect(el.querySelector('[data-testid="video-item"]')).not.toBeNull()
  })

  it('error shows the message and Retry calls onRetry, with no empty state', () => {
    const onRetry = vi.fn()
    const el = mount(<ProjectPagesSection {...props({ error: 'boom', onRetry })} />)
    expect(el.querySelector('[data-testid="project-home-load-error"]')?.textContent).toContain('boom')
    expect(el.querySelector('[data-testid="knowledge-page-empty"]')).toBeNull()
    expect(el.querySelector('[data-testid="video-page-empty"]')).toBeNull()
    act(() => (el.querySelector('[data-testid="project-home-retry"]') as HTMLElement).click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('has a two-button page switch and no legacy view toggle', async () => {
    const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K], videos: [NEW_V] })} />)
    await flush()
    expect(el.querySelector('[data-testid="project-home-view"]')).toBeNull()
    const btns = Array.from(el.querySelectorAll('[data-testid="project-home-page-switch"] button'))
    expect(btns.map((b) => b.textContent)).toEqual(['Knowledge Pages', 'Video Pages'])
    expect(btns.map((b) => b.getAttribute('data-page'))).toEqual(['knowledge', 'videos'])
  })

  it('knowledge page lists entries in given (newest first) order and renders the selected in HtmlFrame', async () => {
    const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K, OLD_K] })} />)
    await flush()
    const items = Array.from(el.querySelectorAll('[data-testid="knowledge-page-item"]'))
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('Newer page'), expect.stringContaining('Older page')])
    expect(el.querySelector('iframe[title="Newer page"]')?.getAttribute('srcdoc')).toBe(HTML)
    act(() => (items[1] as HTMLElement).click())
    await flush()
    expect(el.querySelector('iframe[title="Older page"]')).not.toBeNull()
    // toolbar: only the project-home macro
    expect(macroBtn(el, 'builtin-project-home').textContent).toContain('Regenerate Project Home')
    expect(macroBtn(el, 'builtin-demo-video')).toBeNull()
  })

  it('keeps the selection when the list refreshes', async () => {
    const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K, OLD_K] })} />)
    await flush()
    act(() => (el.querySelectorAll('[data-testid="knowledge-page-item"]')[1] as HTMLElement).click())
    act(() => root!.render(<ProjectPagesSection {...props({ knowledge: [kEntry('c', 'Newest', 3000), NEW_K, OLD_K] })} />))
    await flush()
    expect(el.querySelector('iframe[title="Older page"]')).not.toBeNull()
  })

  it('video page lists videos with title, kind, length, created, LUFS and grade', async () => {
    const el = mount(<ProjectPagesSection {...props({ videos: [NEW_V, OLD_V] })} />)
    await switchTo(el, 'videos')
    const items = Array.from(el.querySelectorAll('[data-testid="video-item"]'))
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('Newer video')
    expect(items[0].textContent).toContain('project-demo')
    expect(items[0].textContent).toContain('30')
    expect(items[0].textContent).toContain('-16.2')
    expect(items[0].textContent).toContain('7.5')
    expect(items[1].textContent).toContain('Older video')
    expect(items[1].textContent).toContain('blog-post')
    expect(items[1].querySelector('[data-col="lufs"]')?.textContent).toBe('-')
    expect(items[1].querySelector('[data-col="grade"]')?.textContent).toBe('-')
    expect(el.querySelector('[data-testid="video-player-frame"]')).not.toBeNull()
    expect(macroBtn(el, 'builtin-demo-video')).not.toBeNull()
    expect(macroBtn(el, 'builtin-project-home')).toBeNull()
  })

  it('video entry with meta null shows its error line', async () => {
    const el = mount(<ProjectPagesSection {...props({ videos: [vEntry('bad', '', 5, {}, false)] })} />)
    await switchTo(el, 'videos')
    expect(el.querySelector('[data-testid="video-item"]')?.textContent).toContain('bad meta')
  })

  it('each page has its own empty state with its generate button', async () => {
    const onLaunch = vi.fn()
    const el = mount(<ProjectPagesSection {...props({ onLaunch })} />)
    expect(el.querySelector('iframe')).toBeNull()
    expect(macroBtn(el, 'builtin-project-home').textContent).toContain('Generate Project Home')
    expect(macroBtn(el, 'builtin-demo-video')).toBeNull()
    act(() => macroBtn(el, 'builtin-project-home').click())
    expect(onLaunch).toHaveBeenCalledWith(HOME_MACRO, undefined)
    await switchTo(el, 'videos')
    expect(macroBtn(el, 'builtin-demo-video').textContent).toContain('Generate Demo Video')
    expect(macroBtn(el, 'builtin-project-home')).toBeNull()
    expect(el.querySelector('[data-testid="project-home-demo-length"]')).not.toBeNull()
  })

  it('no extra-instructions input before anything exists; present once a page exists', async () => {
    const empty = mount(<ProjectPagesSection {...props()} />)
    expect(empty.querySelector('[data-testid="project-home-macro-extra"]')).toBeNull()
    act(() => root!.render(<ProjectPagesSection {...props({ knowledge: [NEW_K] })} />))
    await flush()
    expect(empty.querySelector('[data-testid="project-home-macro-extra"]')).not.toBeNull()
  })

  it('submits Regenerate with extra instructions, then clears the field', async () => {
    const onLaunch = vi.fn()
    const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K], onLaunch })} />)
    await flush()
    const input = el.querySelector('[data-testid="project-home-macro-extra"]') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, '  focus on the onboarding flow  ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => macroBtn(el, 'builtin-project-home').click())
    expect(onLaunch).toHaveBeenCalledWith(HOME_MACRO, 'focus on the onboarding flow')
    expect(input.value).toBe('')
  })

  describe('video toolbar selects', () => {
    const STYLE = '[data-testid="project-home-demo-style"]'
    const LENGTH = '[data-testid="project-home-demo-length"]'
    async function mountVideos(onLaunch = vi.fn(), over: Record<string, unknown> = {}) {
      const el = mount(<ProjectPagesSection {...props({ videos: [NEW_V], onLaunch, ...over })} />)
      await switchTo(el, 'videos')
      return el
    }
    function pick(select: HTMLSelectElement, value: string) {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(select, value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }

    it('style select options and "Video style: Fun"', async () => {
      const onLaunch = vi.fn()
      const el = await mountVideos(onLaunch)
      const select = el.querySelector(STYLE) as HTMLSelectElement
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
        'Auto', 'Professional', 'Fun', 'Animated whiteboard', 'Kinetic typography',
      ])
      pick(select, 'Fun')
      act(() => macroBtn(el, 'builtin-demo-video').click())
      expect(onLaunch).toHaveBeenCalledWith(DEMO_MACRO, 'Video style: Fun')
    })

    it('length select defaults to 30 and sends "Video length: 60" for 1 minute', async () => {
      const onLaunch = vi.fn()
      const el = await mountVideos(onLaunch)
      const select = el.querySelector(LENGTH) as HTMLSelectElement
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['30 seconds', '1 minute'])
      expect(select.value).toBe('30')
      pick(select, '60')
      act(() => macroBtn(el, 'builtin-demo-video').click())
      expect(onLaunch).toHaveBeenCalledWith(DEMO_MACRO, 'Video length: 60')
    })

    it('orders style, length, then extra text', async () => {
      const onLaunch = vi.fn()
      const el = await mountVideos(onLaunch)
      pick(el.querySelector(STYLE) as HTMLSelectElement, 'Animated whiteboard')
      pick(el.querySelector(LENGTH) as HTMLSelectElement, '60')
      const input = el.querySelector('[data-testid="project-home-macro-extra"]') as HTMLInputElement
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(input, 'shorter')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => macroBtn(el, 'builtin-demo-video').click())
      expect(onLaunch).toHaveBeenCalledWith(DEMO_MACRO, 'Video style: Animated whiteboard\nVideo length: 60\nshorter')
    })

    it('kind select and target input send "Video kind" / "Video target" lines', async () => {
      const onLaunch = vi.fn()
      const el = await mountVideos(onLaunch)
      const kind = el.querySelector('[data-testid="project-home-demo-kind"]') as HTMLSelectElement
      expect(Array.from(kind.options).map((o) => o.textContent)).toEqual(['Project demo', 'Blog post', 'Feature'])
      pick(kind, 'Blog post')
      const input = el.querySelector('[data-testid="project-home-demo-target"]') as HTMLInputElement
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(input, 'blog/post.md')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => macroBtn(el, 'builtin-demo-video').click())
      expect(onLaunch).toHaveBeenCalledWith(DEMO_MACRO, 'Video kind: Blog post\nVideo target: blog/post.md')
    })

    it('leaves args unchanged with Auto / 30', async () => {
      const onLaunch = vi.fn()
      const el = await mountVideos(onLaunch)
      act(() => macroBtn(el, 'builtin-demo-video').click())
      expect(onLaunch).toHaveBeenCalledWith(DEMO_MACRO, undefined)
    })

    it('disables selects while launching or building', async () => {
      const el = await mountVideos(vi.fn(), { launching: 'builtin-demo-video' })
      expect((el.querySelector(STYLE) as HTMLSelectElement).disabled).toBe(true)
      expect((el.querySelector(LENGTH) as HTMLSelectElement).disabled).toBe(true)
      for (const state of ['queued', 'running']) {
        const e2 = await mountVideos(vi.fn(), {
          jobStatus: { 'builtin-demo-video': { state, status: state, startedAt: null, finishedAt: null, epicId: null, reason: null } },
        })
        expect((e2.querySelector(LENGTH) as HTMLSelectElement).disabled).toBe(true)
      }
    })
  })

  describe('knowledge page select', () => {
    const KIND = '[data-testid="project-home-page-kind"]'
    const TOPIC = '[data-testid="project-home-page-topic"]'
    const setSel = (select: HTMLSelectElement, value: string) => {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(select, value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    it('lists the four kinds; Overview sends nothing', () => {
      const onLaunch = vi.fn()
      const el = mount(<ProjectPagesSection {...props({ onLaunch })} />)
      const select = el.querySelector(KIND) as HTMLSelectElement
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Overview', 'How it works', 'FAQ', 'Custom topic'])
      expect(el.querySelector(TOPIC)).toBeNull()
      act(() => macroBtn(el, 'builtin-project-home').click())
      expect(onLaunch).toHaveBeenCalledWith(HOME_MACRO, undefined)
    })
    it('sends "Page: How it works"', () => {
      const onLaunch = vi.fn()
      const el = mount(<ProjectPagesSection {...props({ onLaunch })} />)
      setSel(el.querySelector(KIND) as HTMLSelectElement, 'How it works')
      act(() => macroBtn(el, 'builtin-project-home').click())
      expect(onLaunch).toHaveBeenCalledWith(HOME_MACRO, 'Page: How it works')
    })
    it('Custom topic shows a topic input and sends "Page: Custom topic: <text>"', () => {
      const onLaunch = vi.fn()
      const el = mount(<ProjectPagesSection {...props({ onLaunch })} />)
      setSel(el.querySelector(KIND) as HTMLSelectElement, 'Custom topic')
      const input = el.querySelector(TOPIC) as HTMLInputElement
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(input, ' billing ')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => macroBtn(el, 'builtin-project-home').click())
      expect(onLaunch).toHaveBeenCalledWith(HOME_MACRO, 'Page: Custom topic: billing')
    })
  })

  describe('hot-key strip', () => {
    const STRIP = '[data-testid="project-home-hotkeys"]'
    const KEY = '[data-testid="project-home-hotkey"]'
    const REVIEW = macro({ id: 'review-md', label: 'Review MD network', surface: 'project-home' })
    const WITH_INPUTS = macro({
      id: 'with-inputs',
      label: 'Ask',
      prompt: 'Do {{topic}}',
      inputs: [{ name: 'topic', label: 'Topic', required: false }],
    } as Partial<Macro>)
    const keyBtn = (el: HTMLElement, id: string) =>
      el.querySelector(`${KEY}[data-macro-id="${id}"]`) as HTMLButtonElement

    it('is absent with only the builtins', () => {
      const el = mount(<ProjectPagesSection {...props()} />)
      expect(el.querySelector(STRIP)).toBeNull()
    })

    it('never lists the builtins, on both pages', async () => {
      const el = mount(<ProjectPagesSection {...props({ macros: [...MACROS, REVIEW], videos: [NEW_V] })} />)
      const ids = () => Array.from(el.querySelectorAll(KEY)).map((b) => b.getAttribute('data-macro-id'))
      expect(ids()).toEqual(['review-md'])
      await switchTo(el, 'videos')
      expect(ids()).toEqual(['review-md'])
    })

    it('a no-input macro calls onLaunch once', () => {
      const onLaunch = vi.fn()
      const el = mount(<ProjectPagesSection {...props({ macros: [...MACROS, REVIEW], onLaunch })} />)
      act(() => keyBtn(el, 'review-md').click())
      expect(onLaunch).toHaveBeenCalledTimes(1)
      expect(onLaunch).toHaveBeenCalledWith(REVIEW)
    })

    it('an input macro opens the form; submit passes values, cancel does not launch', () => {
      const onLaunch = vi.fn()
      const el = mount(<ProjectPagesSection {...props({ macros: [...MACROS, WITH_INPUTS], onLaunch })} />)
      act(() => keyBtn(el, 'with-inputs').click())
      expect(onLaunch).not.toHaveBeenCalled()
      expect(el.querySelector('[data-testid="macro-inputs-form"]')).not.toBeNull()
      act(() => (el.querySelector('[data-testid="macro-inputs-cancel"]') as HTMLElement).click())
      expect(el.querySelector('[data-testid="macro-inputs-form"]')).toBeNull()
      expect(onLaunch).not.toHaveBeenCalled()
      act(() => keyBtn(el, 'with-inputs').click())
      const input = el.querySelector('[data-testid="macro-input-topic"]') as HTMLInputElement
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(input, 'cats')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => (el.querySelector('[data-testid="macro-inputs-start"]') as HTMLElement).click())
      expect(onLaunch).toHaveBeenCalledTimes(1)
      expect(onLaunch).toHaveBeenCalledWith(WITH_INPUTS, undefined, { topic: 'cats' })
    })

    it('disables while launching and shows Starting…', () => {
      const el = mount(<ProjectPagesSection {...props({ macros: [...MACROS, REVIEW], launching: 'review-md' })} />)
      expect(keyBtn(el, 'review-md').disabled).toBe(true)
      expect(keyBtn(el, 'review-md').textContent).toContain('Starting…')
    })
  })

  it('disables the macro button while launching', () => {
    const el = mount(<ProjectPagesSection {...props({ launching: 'builtin-project-home' })} />)
    expect(macroBtn(el, 'builtin-project-home').disabled).toBe(true)
    expect(macroBtn(el, 'builtin-project-home').textContent).toContain('Starting…')
  })

  describe('job status', () => {
    const st = (over: Partial<MacroJobStatus>): MacroJobStatus => ({
      macroId: 'builtin-demo-video', epicId: 'epic-1', slug: 's', state: 'queued', status: 'queued',
      reason: null, startedAt: null, finishedAt: null, ...over,
    })
    const render = async (s: MacroJobStatus, onOpenSession = vi.fn()) => {
      const el = mount(<ProjectPagesSection {...props({ jobStatus: { [s.macroId]: s }, onOpenSession })} />)
      await switchTo(el, 'videos')
      return el
    }
    const line = (el: HTMLElement) => el.querySelector('[data-testid="project-home-job-status"]') as HTMLElement

    it('queued: label, disabled button, Open session', async () => {
      const onOpen = vi.fn()
      const el = await render(st({ state: 'queued' }), onOpen)
      expect(line(el).textContent).toBe('Queued')
      expect(macroBtn(el, 'builtin-demo-video').disabled).toBe(true)
      expect(macroBtn(el, 'builtin-demo-video').textContent).toContain('Building…')
      act(() => (el.querySelector('[data-testid="project-home-job-session"]') as HTMLButtonElement).click())
      expect(onOpen).toHaveBeenCalledWith('epic-1')
    })
    it('running: Building… started ago', async () => {
      const el = await render(st({ state: 'running', startedAt: new Date(Date.now() - 120_000).toISOString() }))
      expect(line(el).textContent).toBe('Building… started 2m ago')
    })
    it('done: button enabled', async () => {
      const el = await render(st({ state: 'done', finishedAt: new Date(Date.now() - 60_000).toISOString() }))
      expect(line(el).textContent).toBe('Done 1m ago')
      expect(macroBtn(el, 'builtin-demo-video').disabled).toBe(false)
    })
    it('failed: reason with role=alert, no session link without epicId', async () => {
      const el = await render(st({ state: 'failed', reason: 'timed out after 30m', epicId: null }))
      expect(line(el).textContent).toBe('Failed: timed out after 30m')
      expect(line(el).getAttribute('role')).toBe('alert')
      expect(el.querySelector('[data-testid="project-home-job-session"]')).toBeNull()
    })
  })

  describe('rename and delete', () => {
    const rename = vi.fn()
    const del = vi.fn()
    beforeEach(() => {
      rename.mockReset().mockResolvedValue({ ok: true, title: 'x' })
      del.mockReset().mockResolvedValue({ ok: true })
      ;(window as any).api.projectPages = { rename, delete: del }
      useToast.setState({ toasts: [], history: [], unreadCount: 0 })
    })
    const mountK = async () => {
      const el = mount(<ProjectPagesSection {...props({ cwd: '/proj', knowledge: [NEW_K, OLD_K] })} />)
      await flush()
      return el
    }
    const row = (el: HTMLElement, i: number) => el.querySelectorAll('li')[i] as HTMLElement
    const tid = (r: HTMLElement, id: string) => r.querySelector(`[data-testid="${id}"]`) as HTMLElement
    const typeTitle = (input: HTMLInputElement, v: string) => {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(input, v)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const enter = (input: HTMLInputElement) =>
      act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await Promise.resolve()
      })

    it('Enter saves the inline title edit via projectPages.rename', async () => {
      const el = await mountK()
      act(() => tid(row(el, 1), 'entry-rename').click())
      const input = tid(row(el, 1), 'entry-rename-input') as HTMLInputElement
      expect(input.value).toBe('Older page')
      typeTitle(input, '  Renamed  ')
      await enter(input)
      expect(rename).toHaveBeenCalledWith('/proj', 'knowledge', 'a', 'Renamed')
      expect(tid(row(el, 1), 'entry-rename-input')).toBeNull()
    })

    it('Delete asks to confirm, then calls projectPages.delete', async () => {
      const el = await mountK()
      act(() => tid(row(el, 0), 'entry-delete').click())
      expect(del).not.toHaveBeenCalled()
      await act(async () => {
        tid(row(el, 0), 'entry-delete-confirm').click()
        await Promise.resolve()
      })
      expect(del).toHaveBeenCalledWith('/proj', 'knowledge', 'b')
    })

    it('cancel leaves the entry alone', async () => {
      const el = await mountK()
      act(() => tid(row(el, 0), 'entry-delete').click())
      act(() => tid(row(el, 0), 'entry-delete-cancel').click())
      expect(del).not.toHaveBeenCalled()
      expect(tid(row(el, 0), 'entry-delete')).not.toBeNull()
    })

    it('failures surface as an error toast', async () => {
      rename.mockRejectedValue(new Error('meta.json invalid'))
      del.mockRejectedValue(new Error('entry not found'))
      const el = await mountK()
      act(() => tid(row(el, 0), 'entry-rename').click())
      const input = tid(row(el, 0), 'entry-rename-input') as HTMLInputElement
      typeTitle(input, 'New')
      await enter(input)
      act(() => tid(row(el, 1), 'entry-delete').click())
      await act(async () => {
        tid(row(el, 1), 'entry-delete-confirm').click()
        await Promise.resolve()
      })
      const msgs = useToast.getState().toasts.map((t) => [t.kind, t.message])
      expect(msgs).toEqual([
        ['error', 'Rename failed: meta.json invalid'],
        ['error', 'Delete failed: entry not found'],
      ])
    })

    it('shows no actions without a cwd', async () => {
      const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K] })} />)
      await flush()
      expect(el.querySelector('[data-testid="entry-rename"]')).toBeNull()
    })
  })
})
