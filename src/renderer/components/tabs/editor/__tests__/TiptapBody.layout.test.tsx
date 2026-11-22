// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach } from 'vitest'
import { TiptapBody } from '../TiptapBody'

/**
 * Document mode lays the page out like the design (DocEditor pgPad / pgMax):
 * a centred column 720px wide with 28/36px padding inline, 760px with 48/64px
 * in full screen — and list bullets and numbers in the accent.
 */

if (!(Range.prototype as any).getClientRects) {
  ;(Range.prototype as any).getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })
  ;(Range.prototype as any).getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
}
if (!(document as any).elementFromPoint) (document as any).elementFromPoint = () => null

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount(value: string, fullScreen?: boolean) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(TiptapBody, { value, onChange: () => {}, fullScreen })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return host
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement
const classes = (el: HTMLElement) => el.className.split(/\s+/)

describe('TiptapBody page layout', () => {
  it('inline: centred 720px column with 28px 36px page padding', async () => {
    const el = await mount('# Title\n\nbody')
    expect(classes(q(el, 'tiptap-column'))).toEqual(expect.arrayContaining(['mx-auto', 'max-w-[720px]']))
    expect(classes(q(el, 'tiptap-page'))).toEqual(expect.arrayContaining(['py-7', 'px-9']))
    expect(q(el, 'tiptap-column').contains(q(el, 'tiptap-editor'))).toBe(true)
  })

  it('full screen: centred 760px column with 48px 64px page padding', async () => {
    const el = await mount('# Title\n\nbody', true)
    expect(classes(q(el, 'tiptap-column'))).toEqual(expect.arrayContaining(['mx-auto', 'max-w-[760px]']))
    expect(classes(q(el, 'tiptap-column'))).not.toContain('max-w-[720px]')
    expect(classes(q(el, 'tiptap-page'))).toEqual(expect.arrayContaining(['py-12', 'px-16']))
  })

  it('bullet and numbered list markers use the accent', async () => {
    const el = await mount('- one\n- two\n\n1. first\n2. second\n')
    const ul = el.querySelector('[data-testid="tiptap-editor"] ul') as HTMLElement
    const ol = el.querySelector('[data-testid="tiptap-editor"] ol') as HTMLElement
    expect(ul).not.toBeNull()
    expect(ol).not.toBeNull()
    expect(classes(ul)).toContain('marker:text-accent')
    expect(classes(ol)).toContain('marker:text-accent')
  })
})
