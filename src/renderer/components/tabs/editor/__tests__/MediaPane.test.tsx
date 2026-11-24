// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { MediaPane, isPlayableMedia, mediaKindOf } from '../MediaPane'
import { useToast } from '../../../../state/toast'
import { smfileUrl } from '../../../../state/editor'

let host: HTMLDivElement | null = null
let root: Root | null = null

function render(props: { path: string; name: string; size?: number }) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(MediaPane, props)))
  return host
}

beforeEach(() => {
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

describe('mediaKindOf / isPlayableMedia', () => {
  it('classifies video and audio extensions, case-insensitively', () => {
    for (const e of ['mp4', 'webm', 'mov', 'm4v', 'MP4']) expect(mediaKindOf(`/a/b.${e}`)).toBe('video')
    for (const e of ['mp3', 'wav', 'm4a', 'ogg', 'opus']) expect(mediaKindOf(`/a/b.${e}`)).toBe('audio')
    expect(mediaKindOf('/a/b.png')).toBeNull()
    expect(isPlayableMedia('/a/b.txt')).toBe(false)
    expect(isPlayableMedia('/a/clip.mov')).toBe(true)
  })
})

describe('MediaPane', () => {
  it('renders a <video controls> over smfile:// with name and size', () => {
    const path = '/home/u/My Clips/demo.mp4'
    const el = render({ path, name: 'demo.mp4', size: 2048 })
    const pane = el.querySelector('[data-testid="media-pane"]')!
    expect(pane).toBeTruthy()
    const video = pane.querySelector('video')!
    expect(video).toBeTruthy()
    expect(video.hasAttribute('controls')).toBe(true)
    expect(video.getAttribute('src')).toBe(smfileUrl(path))
    expect(pane.querySelector('audio')).toBeNull()
    expect(pane.textContent).toContain('demo.mp4')
    expect(pane.textContent).toContain('2.0 KB')
  })

  it('renders an <audio controls> for audio files', () => {
    const path = '/home/u/voice.opus'
    const el = render({ path, name: 'voice.opus', size: 512 })
    const pane = el.querySelector('[data-testid="media-pane"]')!
    const audio = pane.querySelector('audio')!
    expect(audio).toBeTruthy()
    expect(audio.hasAttribute('controls')).toBe(true)
    expect(audio.getAttribute('src')).toBe(smfileUrl(path))
    expect(pane.querySelector('video')).toBeNull()
    expect(pane.textContent).toContain('voice.opus')
  })

  it('on a load error shows an inline message and raises an error toast', () => {
    const el = render({ path: '/home/u/broken.webm', name: 'broken.webm' })
    const video = el.querySelector('video')!
    act(() => { video.dispatchEvent(new Event('error')) })
    const pane = el.querySelector('[data-testid="media-pane"]')!
    expect(pane).toBeTruthy()
    const msg = pane.querySelector('[data-testid="media-pane-error"]')
    expect(msg).toBeTruthy()
    expect(msg!.textContent).toMatch(/broken\.webm/)
    const toasts = useToast.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('error')
    expect(toasts[0].message).toMatch(/broken\.webm/)
  })
})
