// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectPagesSection } from '../ProjectPagesSection'
import type { Macro } from '../../../../../../preload/api'

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

describe('ProjectPagesSection', () => {
  it('renders nothing while loaded is false', () => {
    const el = mount(
      <ProjectPagesSection
        output={null}
        demoVideo={null}
        loaded={false}
        macros={MACROS}
        launching={null}
        onLaunch={() => {}}
      />,
    )
    expect(el.textContent).toBe('')
  })

  it('shows the empty state with one button per macro when nothing is generated', () => {
    const onLaunch = vi.fn()
    const el = mount(
      <ProjectPagesSection
        output={null}
        demoVideo={null}
        loaded
        macros={MACROS}
        launching={null}
        onLaunch={onLaunch}
      />,
    )
    expect(el.querySelector('iframe')).toBeNull()
    expect(el.querySelector('[data-testid="project-home-view"]')).toBeNull()
    const buttons = Array.from(el.querySelectorAll('[data-testid="project-home-macro"]'))
    expect(buttons).toHaveLength(2)
    expect(buttons[0].textContent).toContain('Generate Project Home')
    expect(buttons[1].textContent).toContain('Generate Demo Video')
    act(() => (buttons[0] as HTMLButtonElement).click())
    expect(onLaunch).toHaveBeenCalledWith(HOME_MACRO, undefined)
  })

  it('shows Regenerate + home.html when only the overview exists, with no view switch', () => {
    const onLaunch = vi.fn()
    const html = '<!DOCTYPE html><html><body>HOME</body></html>'
    const el = mount(
      <ProjectPagesSection
        output={{ html, mtimeMs: Date.now() - 3 * 60_000 }}
        demoVideo={null}
        loaded
        macros={MACROS}
        launching={null}
        onLaunch={onLaunch}
      />,
    )
    expect(el.querySelector('[data-testid="project-home-view"]')).toBeNull()
    const iframe = el.querySelector('iframe') as HTMLIFrameElement
    expect(iframe.getAttribute('srcdoc')).toBe(html)
    expect(el.querySelector('[data-testid="demo-video-frame"]')).toBeNull()
    expect(el.textContent).toContain('generated 3m ago')
    const buttons = Array.from(el.querySelectorAll('[data-testid="project-home-macro"]'))
    expect(buttons[0].textContent).toContain('Regenerate Project Home')
    expect(buttons[1].textContent).toContain('Generate Demo Video')
    act(() => (buttons[1] as HTMLButtonElement).click())
    expect(onLaunch).toHaveBeenCalledWith(DEMO_MACRO, undefined)
  })

  it('shows the demo video (not overview) when only a demo video exists', () => {
    const el = mount(
      <ProjectPagesSection
        output={null}
        demoVideo={{ path: '/tmp/demo/index.html', mtimeMs: Date.now() - 60_000 }}
        loaded
        macros={MACROS}
        launching={null}
        onLaunch={() => {}}
      />,
    )
    expect(el.querySelector('[data-testid="demo-video-frame"]')).not.toBeNull()
    expect(el.textContent).toContain('generated 1m ago')
    const buttons = Array.from(el.querySelectorAll('[data-testid="project-home-macro"]'))
    expect(buttons[0].textContent).toContain('Generate Project Home')
    expect(buttons[1].textContent).toContain('Regenerate Demo Video')
  })

  it('switches between overview and demo video via the view switch when both exist', () => {
    const html = '<!DOCTYPE html><html><body>HOME</body></html>'
    const el = mount(
      <ProjectPagesSection
        output={{ html, mtimeMs: Date.now() }}
        demoVideo={{ path: '/tmp/demo/index.html', mtimeMs: Date.now() }}
        loaded
        macros={MACROS}
        launching={null}
        onLaunch={() => {}}
      />,
    )
    expect(el.querySelector('iframe[title="Project Home"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="demo-video-frame"]')).toBeNull()

    const switchEl = el.querySelector('[data-testid="project-home-view"]') as HTMLElement
    const [overviewBtn, demoBtn] = Array.from(switchEl.querySelectorAll('button'))
    expect(overviewBtn.textContent).toBe('Overview')
    expect(demoBtn.textContent).toBe('Demo video')

    act(() => demoBtn.click())
    expect(el.querySelector('[data-testid="demo-video-frame"]')).not.toBeNull()
    expect(el.querySelector('iframe[title="Project Home"]')).toBeNull()

    act(() => overviewBtn.click())
    expect(el.querySelector('iframe[title="Project Home"]')).not.toBeNull()
  })

  it('does not show the extra-instructions input on first-generation (no artifact yet)', () => {
    const el = mount(
      <ProjectPagesSection
        output={null}
        demoVideo={null}
        loaded
        macros={MACROS}
        launching={null}
        onLaunch={() => {}}
      />,
    )
    expect(el.querySelector('[data-testid="project-home-macro-extra"]')).toBeNull()
  })

  it('submits Regenerate with an empty extra-instructions field exactly as before', () => {
    const onLaunch = vi.fn()
    const html = '<!DOCTYPE html><html><body>HOME</body></html>'
    const el = mount(
      <ProjectPagesSection
        output={{ html, mtimeMs: Date.now() }}
        demoVideo={null}
        loaded
        macros={MACROS}
        launching={null}
        onLaunch={onLaunch}
      />,
    )
    const input = el.querySelector('[data-testid="project-home-macro-extra"][data-macro-id="builtin-project-home"]')
    expect(input).not.toBeNull()
    const button = el.querySelector(
      '[data-testid="project-home-macro"][data-macro-id="builtin-project-home"]',
    ) as HTMLButtonElement
    act(() => button.click())
    expect(onLaunch).toHaveBeenCalledWith(HOME_MACRO, undefined)
  })

  it('submits Regenerate with extra instructions, then clears the field', () => {
    const onLaunch = vi.fn()
    const html = '<!DOCTYPE html><html><body>HOME</body></html>'
    const el = mount(
      <ProjectPagesSection
        output={{ html, mtimeMs: Date.now() }}
        demoVideo={null}
        loaded
        macros={MACROS}
        launching={null}
        onLaunch={onLaunch}
      />,
    )
    const input = el.querySelector(
      '[data-testid="project-home-macro-extra"][data-macro-id="builtin-project-home"]',
    ) as HTMLInputElement
    const button = el.querySelector(
      '[data-testid="project-home-macro"][data-macro-id="builtin-project-home"]',
    ) as HTMLButtonElement

    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, '  focus on the onboarding flow  ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => button.click())
    expect(onLaunch).toHaveBeenCalledWith(HOME_MACRO, 'focus on the onboarding flow')
    expect(input.value).toBe('')
  })

  it('disables the extra-instructions input while launching, matching the button', () => {
    const el = mount(
      <ProjectPagesSection
        output={{ html: '<!DOCTYPE html><html><body>HOME</body></html>', mtimeMs: Date.now() }}
        demoVideo={null}
        loaded
        macros={MACROS}
        launching="builtin-project-home"
        onLaunch={() => {}}
      />,
    )
    const input = el.querySelector(
      '[data-testid="project-home-macro-extra"][data-macro-id="builtin-project-home"]',
    ) as HTMLInputElement
    expect(input.disabled).toBe(true)
  })

  describe('demo video style picker', () => {
    const HTML = '<!DOCTYPE html><html><body>HOME</body></html>'
    const STYLE = '[data-testid="project-home-demo-style"]'

    function mountPopulated(onLaunch = vi.fn(), launching: string | null = null) {
      return mount(
        <ProjectPagesSection
          output={{ html: HTML, mtimeMs: Date.now() }}
          demoVideo={{ path: '/tmp/demo/index.html', mtimeMs: Date.now() }}
          loaded
          macros={MACROS}
          launching={launching}
          onLaunch={onLaunch}
        />,
      )
    }

    function pick(select: HTMLSelectElement, value: string) {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(select, value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }

    function demoButton(el: HTMLElement) {
      return el.querySelector(
        '[data-testid="project-home-macro"][data-macro-id="builtin-demo-video"]',
      ) as HTMLButtonElement
    }

    it('renders the select only for the demo-video macro in the empty state', () => {
      const el = mount(
        <ProjectPagesSection output={null} demoVideo={null} loaded macros={MACROS} launching={null} onLaunch={() => {}} />,
      )
      const selects = el.querySelectorAll(STYLE)
      expect(selects).toHaveLength(1)
      const select = selects[0] as HTMLSelectElement
      expect(select.getAttribute('aria-label')).toBe('Video style')
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
        'Auto',
        'Professional',
        'Fun',
        'Animated whiteboard',
        'Kinetic typography',
      ])
      expect(select.value).toBe('Auto')
    })

    it('renders the select only for the demo-video macro in the populated state', () => {
      const el = mountPopulated()
      expect(el.querySelectorAll(STYLE)).toHaveLength(1)
    })

    it('passes "Video style: Fun" when extra is empty', () => {
      const onLaunch = vi.fn()
      const el = mountPopulated(onLaunch)
      pick(el.querySelector(STYLE) as HTMLSelectElement, 'Fun')
      act(() => demoButton(el).click())
      expect(onLaunch).toHaveBeenCalledWith(DEMO_MACRO, 'Video style: Fun')
    })

    it('appends trimmed extra text after the style line', () => {
      const onLaunch = vi.fn()
      const el = mountPopulated(onLaunch)
      pick(el.querySelector(STYLE) as HTMLSelectElement, 'Animated whiteboard')
      const input = el.querySelector(
        '[data-testid="project-home-macro-extra"][data-macro-id="builtin-demo-video"]',
      ) as HTMLInputElement
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(input, '  shorter ')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => demoButton(el).click())
      expect(onLaunch).toHaveBeenCalledWith(DEMO_MACRO, 'Video style: Animated whiteboard\nshorter')
    })

    it('leaves args unchanged with Auto', () => {
      const onLaunch = vi.fn()
      const el = mountPopulated(onLaunch)
      act(() => demoButton(el).click())
      expect(onLaunch).toHaveBeenCalledWith(DEMO_MACRO, undefined)
    })

    it('disables the select while launching', () => {
      const el = mountPopulated(vi.fn(), 'builtin-demo-video')
      expect((el.querySelector(STYLE) as HTMLSelectElement).disabled).toBe(true)
    })
  })

  it('disables every macro button while launching', () => {
    const el = mount(
      <ProjectPagesSection
        output={null}
        demoVideo={null}
        loaded
        macros={MACROS}
        launching="builtin-project-home"
        onLaunch={() => {}}
      />,
    )
    const buttons = Array.from(el.querySelectorAll('[data-testid="project-home-macro"]')) as HTMLButtonElement[]
    expect(buttons.every((b) => b.disabled)).toBe(true)
    expect(buttons[0].textContent).toContain('Starting…')
  })
})
