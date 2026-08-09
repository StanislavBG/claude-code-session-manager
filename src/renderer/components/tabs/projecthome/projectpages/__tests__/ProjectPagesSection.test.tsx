// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
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
    const el = mount(<ProjectPagesSection output={null} loaded={false} />)
    expect(el.textContent).toBe('')
  })

  it('renders the empty state when output is null and loaded is true', () => {
    const el = mount(<ProjectPagesSection output={null} loaded />)
    expect(el.textContent).toContain('No Project Pages yet')
    expect(el.textContent).toContain('Generate My Project Home')
    // No second generate action lives in this section — only ProjectHome's own.
    expect(Array.from(el.querySelectorAll('button')).some((b) => /generate/i.test(b.textContent ?? ''))).toBe(false)
  })

  it('renders the iframe display with the marketing html as srcDoc by default when output is present', () => {
    const el = mount(
      <ProjectPagesSection
        output={{
          home: '<!DOCTYPE html><html><body>HOME</body></html>',
          marketing: '<!DOCTYPE html><html><body>MARKETING</body></html>',
          feature: '<!DOCTYPE html><html><body>FEATURE</body></html>',
          architecture: '<!DOCTYPE html><html><body>ARCHITECTURE</body></html>',
          generatedAt: '2026-08-02T00:00:00.000Z',
          isDefault: false,
        }}
        loaded
      />,
    )
    const iframe = el.querySelector('iframe') as HTMLIFrameElement
    expect(iframe).toBeTruthy()
    expect(iframe.getAttribute('srcdoc')).toContain('MARKETING')
    expect(el.textContent).toContain('Full screen')
    expect(el.textContent).toContain('About these templates')
    const fullscreenBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Full screen') as HTMLButtonElement
    act(() => fullscreenBtn.click())
    expect(el.textContent).toContain('Exit full screen')
  })

  it('Brief tab is selectable and renders the brief html as srcDoc when present', () => {
    const el = mount(
      <ProjectPagesSection
        output={{
          home: '<!DOCTYPE html><html><body>HOME</body></html>',
          marketing: '<!DOCTYPE html><html><body>MARKETING</body></html>',
          feature: '<!DOCTYPE html><html><body>FEATURE</body></html>',
          architecture: '<!DOCTYPE html><html><body>ARCHITECTURE</body></html>',
          brief: '<!DOCTYPE html><html><body>BRIEF</body></html>',
          generatedAt: '2026-08-02T00:00:00.000Z',
          isDefault: false,
        }}
        loaded
      />,
    )
    const briefTab = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Brief') as HTMLButtonElement
    expect(briefTab).toBeTruthy()
    act(() => briefTab.click())
    const iframe = el.querySelector('iframe') as HTMLIFrameElement
    expect(iframe.getAttribute('srcdoc')).toContain('BRIEF')
  })

  it('Brief tab shows a fallback empty state (not a crash) when output predates the brief lens', () => {
    const el = mount(
      <ProjectPagesSection
        output={{
          home: '<!DOCTYPE html><html><body>HOME</body></html>',
          marketing: '<!DOCTYPE html><html><body>MARKETING</body></html>',
          feature: '<!DOCTYPE html><html><body>FEATURE</body></html>',
          architecture: '<!DOCTYPE html><html><body>ARCHITECTURE</body></html>',
          generatedAt: '2026-08-02T00:00:00.000Z',
          isDefault: false,
        }}
        loaded
      />,
    )
    const briefTab = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Brief') as HTMLButtonElement
    act(() => briefTab.click())
    expect(el.querySelector('iframe')).toBeNull()
    expect(el.textContent).toContain('Brief page not generated yet')
  })

  it('offers a tab for all FIVE generated templates, plus the explainer', () => {
    const el = mount(
      <ProjectPagesSection
        output={{
          home: '<!DOCTYPE html><html><body>HOME</body></html>',
          marketing: '<!DOCTYPE html><html><body>MARKETING</body></html>',
          feature: '<!DOCTYPE html><html><body>FEATURE</body></html>',
          architecture: '<!DOCTYPE html><html><body>ARCHITECTURE</body></html>',
          brief: '<!DOCTYPE html><html><body>BRIEF</body></html>',
          generatedAt: '2026-08-02T00:00:00.000Z',
          isDefault: false,
        }}
        loaded
      />,
    )
    const labels = Array.from(el.querySelectorAll('button')).map((b) => b.textContent)
    for (const lens of ['Home', 'Marketing', 'Feature', 'Architecture', 'Brief', 'About these templates']) {
      expect(labels).toContain(lens)
    }
  })

  it('Home is a real lens tab — same html as the primary document above, and it says so', () => {
    const el = mount(
      <ProjectPagesSection
        output={{
          home: '<!DOCTYPE html><html><body>HOME</body></html>',
          marketing: '<!DOCTYPE html><html><body>MARKETING</body></html>',
          feature: '<!DOCTYPE html><html><body>FEATURE</body></html>',
          architecture: '<!DOCTYPE html><html><body>ARCHITECTURE</body></html>',
          brief: '<!DOCTYPE html><html><body>BRIEF</body></html>',
          generatedAt: '2026-08-02T00:00:00.000Z',
          isDefault: false,
        }}
        loaded
      />,
    )
    const homeTab = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Home') as HTMLButtonElement
    act(() => homeTab.click())
    expect((el.querySelector('iframe') as HTMLIFrameElement).getAttribute('srcdoc')).toContain('HOME')
    // The duplication with the block above is stated, not hidden.
    expect(el.textContent).toContain('primary document')
  })

  it('Home renders even for the shipped default, where every other lens is missing', () => {
    const el = mount(
      <ProjectPagesSection
        output={{
          home: '<!DOCTYPE html><html><body>SHIPPED DEFAULT</body></html>',
          generatedAt: null,
          isDefault: true,
        }}
        loaded
      />,
    )
    const homeTab = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Home') as HTMLButtonElement
    act(() => homeTab.click())
    expect((el.querySelector('iframe') as HTMLIFrameElement).getAttribute('srcdoc')).toContain('SHIPPED DEFAULT')
  })

  it('shows the "About these templates" explainer without depending on output', () => {
    const el = mount(<ProjectPagesSection output={null} loaded />)
    const libraryTab = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'About these templates') as HTMLButtonElement
    act(() => libraryTab.click())
    expect(el.textContent).toContain('Component library (shared across every project)')
  })

  it('a non-home lens is missing for the shipped default and points at the primary generate action instead of showing a second button', () => {
    const el = mount(
      <ProjectPagesSection
        output={{
          home: '<!DOCTYPE html><html><body>SHIPPED DEFAULT</body></html>',
          generatedAt: null,
          isDefault: true,
        }}
        loaded
      />,
    )
    expect(el.querySelector('iframe')).toBeNull()
    expect(el.textContent).toContain('Marketing page not generated yet')
    expect(el.textContent).toContain('Generate My Project Home')
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent === 'Marketing')).toBe(true)
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent === 'Regenerate')).toBe(false)
  })
})
