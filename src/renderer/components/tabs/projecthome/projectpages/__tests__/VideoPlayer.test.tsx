// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { VideoPlayer } from '../VideoPlayer'

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<VideoPlayer path="/p/v.html" mtimeMs={1} />))
  const iframe = container.querySelector('iframe') as HTMLIFrameElement
  const win = iframe.contentWindow as Window
  const post = vi.spyOn(win, 'postMessage').mockImplementation(() => {})
  return { el: container, iframe, win, post }
}

function sendState(source: Window | null, extra: Record<string, unknown> = {}) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        data: {
          smPlayer: 1, type: 'state', duration: 30, t: 5, playing: false, muted: true,
          scenes: [{ t: 0, label: 'a' }, { t: 10, label: 'b' }],
          ...extra,
        },
      }),
    )
  })
}

const sent = (post: { mock: { calls: unknown[][] } }) => post.mock.calls.map((c) => (c[0] as { cmd: string }).cmd)
const click = (el: Element, id: string) =>
  act(() => { (el.querySelector(`[data-testid="${id}"]`) as HTMLElement).click() })

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('VideoPlayer', () => {
  it('sandboxes the iframe and says hello on load', () => {
    const { el, iframe, post } = mount()
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    act(() => { iframe.dispatchEvent(new Event('load')) })
    expect(post.mock.calls[0][0]).toEqual({ smPlayer: 1, cmd: 'hello' })
    expect(el.querySelector('[data-testid="video-mute"]')!.textContent).toContain('Tap for sound')
  })

  it('sends play/pause, restart and mute/unmute commands', () => {
    const { el, win, post } = mount()
    click(el, 'video-play')
    sendState(win, { playing: true })
    click(el, 'video-play')
    click(el, 'video-restart')
    click(el, 'video-mute')
    sendState(win, { muted: false })
    click(el, 'video-mute')
    expect(sent(post)).toEqual(['play', 'pause', 'restart', 'unmute', 'mute'])
  })

  it('ignores state from a foreign source', () => {
    const { el } = mount()
    sendState(window, { scenes: [{ t: 1, label: 'x' }] })
    expect(el.querySelectorAll('[data-testid="video-scene-marker"]').length).toBe(0)
  })

  it('renders one marker per scene and seeks with t', () => {
    const { el, win, post } = mount()
    sendState(win)
    expect(el.querySelectorAll('[data-testid="video-scene-marker"]').length).toBe(2)
    const seek = el.querySelector('[data-testid="video-seek"]') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(seek, '12')
      seek.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(post.mock.calls.at(-1)![0]).toEqual({ smPlayer: 1, cmd: 'seek', t: 12 })
  })
})
