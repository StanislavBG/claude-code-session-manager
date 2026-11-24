// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, afterEach, vi } from 'vitest'
import type { PromptSessionEvent } from '../../../state/promptSessions'

const reveal = vi.fn()
vi.mock('../../../lib/revealInFileExplorer', () => ({ revealInFileExplorer: (p: string) => reveal(p) }))

import { ArtifactReadyCard } from '../ArtifactReadyCard'

/** The 'artifact-ready' notice card (lib/epic/artifactNotice.cjs posts the event). */

let root: Root | null = null
let container: HTMLDivElement | null = null

function mount(node: ReturnType<typeof createElement>): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  reveal.mockReset()
})

function event(overrides: Partial<PromptSessionEvent>): PromptSessionEvent {
  return {
    id: 'pevt-1',
    promptSessionId: 'epic-1',
    kind: 'response',
    causedByEventId: null,
    at: '2026-11-24T10:00:00.000Z',
    text: 'Artifact ready: Tour',
    notice: 'artifact-ready',
    artifacts: [{ title: 'Tour', kind: 'video', path: 'artifacts/epic-1/tour.mp4', size: 2048 }],
    ...overrides,
  } as PromptSessionEvent
}

describe('ArtifactReadyCard', () => {
  it('renders one row with title, kind and size, and no "+N more"', () => {
    const el = mount(createElement(ArtifactReadyCard, { event: event({}), cwd: '/p' }))
    expect(el.querySelector('[data-testid="artifact-ready-card"]')).not.toBeNull()
    const rows = el.querySelectorAll('[data-testid="artifact-ready-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Tour')
    expect(rows[0].textContent).toContain('video')
    expect(rows[0].textContent).toContain('2.0 KB')
    expect(el.textContent).not.toMatch(/more/)
  })

  it('renders several rows plus "+N more" from moreCount', () => {
    const el = mount(createElement(ArtifactReadyCard, {
      event: event({
        text: '3 artifacts ready',
        artifacts: [
          { title: 'A', kind: 'image', path: 'a.png', size: 10 },
          { title: 'B', kind: 'doc', path: 'b.md', size: 20 },
          { title: 'C', kind: 'other', path: 'c.bin', size: 30 },
        ],
        moreCount: 4,
      }),
      cwd: '/p',
    }))
    expect(el.querySelectorAll('[data-testid="artifact-ready-row"]')).toHaveLength(3)
    expect(el.querySelector('[data-testid="artifact-ready-more"]')?.textContent).toContain('+4 more')
  })

  it('clicking a row reveals <cwd>/<path> in the File Explorer', () => {
    const el = mount(createElement(ArtifactReadyCard, { event: event({}), cwd: '/home/me/proj' }))
    const row = el.querySelector('[data-testid="artifact-ready-row"]') as HTMLElement
    act(() => row.click())
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal).toHaveBeenCalledWith('/home/me/proj/artifacts/epic-1/tour.mp4')
  })
})
