// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useConfigDirWatch } from '../useConfigDirWatch'

let container: HTMLDivElement | null = null
let root: Root | null = null
let emit: (info: { path: string }) => void = () => {}
const watch = vi.fn()
const unwatch = vi.fn()
const unsubscribe = vi.fn()

function Probe({ paths, onChange, opts }: {
  paths: string[]
  onChange: (p: string) => void
  opts?: { depth?: 0 | 1 | 2 }
}) {
  useConfigDirWatch(paths, onChange, opts)
  return null
}

function mount(props: Parameters<typeof Probe>[0]) {
  container = document.createElement('div')
  root = createRoot(container)
  act(() => root!.render(<Probe {...props} />))
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = {
    config: {
      watch,
      unwatch,
      onChanged: (h: (info: { path: string }) => void) => {
        emit = h
        return unsubscribe
      },
    },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container = null
  watch.mockClear()
  unwatch.mockClear()
  unsubscribe.mockClear()
})

describe('useConfigDirWatch', () => {
  it('watches with opts on mount and unwatches with the same opts on unmount', () => {
    mount({ paths: ['/a/b'], onChange: vi.fn(), opts: { depth: 0 } })
    expect(watch).toHaveBeenCalledWith(['/a/b'], { depth: 0 })
    act(() => root!.unmount())
    root = null
    expect(unwatch).toHaveBeenCalledWith(['/a/b'], { depth: 0 })
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('calls onChange with the changed path for watched paths only', () => {
    const onChange = vi.fn()
    mount({ paths: ['/a/b/', '/c'], onChange })
    emit({ path: '/a/b' })
    expect(onChange).toHaveBeenCalledWith('/a/b')
    onChange.mockClear()
    emit({ path: '/other' })
    expect(onChange).not.toHaveBeenCalled()
  })
})
