// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectPagesSection } from '../ProjectPagesSection'

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

describe('ProjectPagesSection', () => {
  it('renders nothing while loaded is false', () => {
    const el = mount(<ProjectPagesSection output={null} loaded={false} onGenerate={() => {}} />)
    expect(el.textContent).toBe('')
  })

  it('shows the empty state with one Generate button when there is no home.html', () => {
    const onGenerate = vi.fn()
    const el = mount(<ProjectPagesSection output={null} loaded onGenerate={onGenerate} />)
    expect(el.textContent).not.toContain('No Project Home yet')
    expect(el.textContent).not.toContain('No home page has been generated')
    expect(el.querySelector('iframe')).toBeNull()
    const buttons = Array.from(el.querySelectorAll('button'))
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toContain('Generate Project Home')
    act(() => buttons[0].click())
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('renders home.html in a sandboxed iframe with a generated chip and a Regenerate button', () => {
    const onGenerate = vi.fn()
    const html = '<!DOCTYPE html><html><body>HOME</body></html>'
    const el = mount(
      <ProjectPagesSection output={{ html, mtimeMs: Date.now() - 3 * 60_000 }} loaded onGenerate={onGenerate} />,
    )
    const iframe = el.querySelector('iframe') as HTMLIFrameElement
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(iframe.getAttribute('srcdoc')).toBe(html)
    expect(el.textContent).toContain('generated 3m ago')
    expect(el.textContent).not.toContain('Shipped default')
    expect(el.textContent).not.toContain('No home page has been generated')
    expect(el.querySelectorAll('iframe')).toHaveLength(1)
    const buttons = Array.from(el.querySelectorAll('button'))
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toContain('Regenerate')
    act(() => buttons[0].click())
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })
})
