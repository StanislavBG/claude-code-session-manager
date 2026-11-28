// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const state = { focused: true, visible: true }
vi.mock('../../../../lib/panelFocus', () => ({ usePanelFocus: () => state.focused }))
vi.mock('../../../../lib/useDocumentVisible', () => ({ useDocumentVisible: () => state.visible }))
const drawWorld = vi.fn()
vi.mock('../../../../lib/worldScene', () => ({
  DEFAULT_THEME: { ground: '#000', groundAlt: '#111', label: '#fff' },
  createSpriteCache: vi.fn(() => ({})),
  drawWorld: (...a: unknown[]) => drawWorld(...a),
  layoutRooms: (r: unknown[]) => r.map(() => ({})),
  layoutRoomActors: () => [],
}))

import { WorldView } from '../WorldView'

const rooms = [
  { cwd: '/p/a', label: 'a', roster: [{ agentType: 'dev-lead', count: 1, owners: ['x'] }] },
  { cwd: '/p/b', label: 'b', roster: [] },
]
const idle = [{ cwd: '/p/a', label: 'a', roster: [] }]
let container: HTMLDivElement
let root: Root | null = null
function render(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return {
    getByTestId: (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement,
    unmount: () => act(() => { root!.unmount(); root = null }),
  }
}
function cleanup() {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
}
let cbs: Array<(t: number) => void>
let raf: ReturnType<typeof vi.fn>
let caf: ReturnType<typeof vi.fn>

beforeEach(() => {
  state.focused = true
  state.visible = true
  drawWorld.mockClear()
  cbs = []
  raf = vi.fn((cb: (t: number) => void) => (cbs.push(cb), cbs.length))
  caf = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 300 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 200 })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform() {} } as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('requestAnimationFrame', raf)
  vi.stubGlobal('cancelAnimationFrame', caf)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { cb: () => void; constructor(cb: () => void) { this.cb = cb } observe() { this.cb() } disconnect() {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WorldView', () => {
  it('renders the canvas', () => {
    const { getByTestId } = render(<WorldView rooms={rooms} />)
    expect(getByTestId('world-canvas').tagName).toBe('CANVAS')
    expect(getByTestId('world-canvas').getAttribute('data-room-count')).toBe('2')
  })
  it('schedules no rAF for an all-idle rooms', () => {
    render(<WorldView rooms={idle} />)
    expect(raf).not.toHaveBeenCalled()
  })
  it('schedules no rAF when unfocused', () => {
    state.focused = false
    render(<WorldView rooms={rooms} />)
    expect(raf).not.toHaveBeenCalled()
  })
  it('schedules no rAF when document hidden', () => {
    state.visible = false
    render(<WorldView rooms={rooms} />)
    expect(raf).not.toHaveBeenCalled()
  })
  it('schedules rAF when all conditions hold and cancels on unmount', () => {
    const { unmount } = render(<WorldView rooms={rooms} />)
    expect(raf).toHaveBeenCalled()
    unmount()
    expect(caf).toHaveBeenCalled()
  })
  it('throttles a callback 20 ms after the previous frame', () => {
    render(<WorldView rooms={rooms} />)
    drawWorld.mockClear()
    const last = () => cbs[cbs.length - 1]
    act(() => last()(1000))
    expect(drawWorld).toHaveBeenCalledTimes(1)
    act(() => last()(1020))
    expect(drawWorld).toHaveBeenCalledTimes(1)
    act(() => last()(1100))
    expect(drawWorld).toHaveBeenCalledTimes(2)
  })
})
