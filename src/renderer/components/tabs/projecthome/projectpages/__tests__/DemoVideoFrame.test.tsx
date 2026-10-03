// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DemoVideoFrame } from '../DemoVideoFrame'
import { smfileUrl } from '../../../../../state/editor'

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

describe('DemoVideoFrame', () => {
  it('renders an iframe pointed at the smfile:// URL for the given path', () => {
    const el = mount(<DemoVideoFrame path="/home/user/project/demo.html" mtimeMs={1000} />)
    const iframe = el.querySelector('[data-testid="demo-video-frame"]') as HTMLIFrameElement
    expect(iframe).not.toBeNull()
    expect(iframe.getAttribute('src')).toBe(smfileUrl('/home/user/project/demo.html'))
  })

  it('sandboxes with allow-scripts only — no allow-same-origin, no allow-popups', () => {
    const el = mount(<DemoVideoFrame path="/home/user/project/demo.html" mtimeMs={1000} />)
    const iframe = el.querySelector('[data-testid="demo-video-frame"]') as HTMLIFrameElement
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('remounts the iframe when mtimeMs changes', () => {
    const el = mount(<DemoVideoFrame path="/home/user/project/demo.html" mtimeMs={1000} />)
    const first = el.querySelector('[data-testid="demo-video-frame"]') as HTMLIFrameElement

    act(() => root!.render(<DemoVideoFrame path="/home/user/project/demo.html" mtimeMs={2000} />))
    const second = el.querySelector('[data-testid="demo-video-frame"]') as HTMLIFrameElement

    expect(second).not.toBe(first)
  })
})
