// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { FILE_LINK_ATTR, linkifyFilePaths, resolveFileLinkTarget, extractFilePaths } from '../chatFileLinks'

function mount(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  return container
}

describe('linkifyFilePaths', () => {
  it('wraps a bare file-path mention in a span carrying the file-link attribute', () => {
    const container = mount('<p>see docs/README.md for details</p>')
    linkifyFilePaths(container)

    const span = container.querySelector(`[${FILE_LINK_ATTR}]`)
    expect(span).not.toBeNull()
    expect(span?.getAttribute(FILE_LINK_ATTR)).toBe('docs/README.md')
    expect(span?.textContent).toBe('docs/README.md')
    expect(container.textContent).toBe('see docs/README.md for details')
  })

  it('preserves a trailing :line:col suffix in the wrapped token', () => {
    const container = mount('<p>error at src/foo.ts:42:8 in the build</p>')
    linkifyFilePaths(container)

    const span = container.querySelector(`[${FILE_LINK_ATTR}]`)
    expect(span?.getAttribute(FILE_LINK_ATTR)).toBe('src/foo.ts:42:8')
  })

  it('does not double-wrap a path-like token already inside a real <a>', () => {
    const container = mount('<p><a href="foo.ts">src/foo.ts</a></p>')
    linkifyFilePaths(container)

    expect(container.querySelector(`[${FILE_LINK_ATTR}]`)).toBeNull()
    expect(container.querySelector('a')?.textContent).toBe('src/foo.ts')
  })

  it('does not wrap a path-like token inside a <code> span', () => {
    const container = mount('<p>run <code>src/foo.ts</code> to see</p>')
    linkifyFilePaths(container)

    expect(container.querySelector(`[${FILE_LINK_ATTR}]`)).toBeNull()
  })

  it('does not wrap a path-like token inside a <pre> block', () => {
    const container = mount('<pre>src/foo.ts:42:8</pre>')
    linkifyFilePaths(container)

    expect(container.querySelector(`[${FILE_LINK_ATTR}]`)).toBeNull()
  })

  it('leaves plain text with no path-like token untouched', () => {
    const container = mount('<p>just a normal sentence, no paths here</p>')
    const before = container.innerHTML
    linkifyFilePaths(container)

    expect(container.innerHTML).toBe(before)
  })

  it('does not wrap an ellipsis-prefixed ALL_CAPS constant name as a file-path chip', () => {
    const container = mount('<p>quoting ...TOOL_PROJECTS from the other repo</p>')
    const before = container.innerHTML
    linkifyFilePaths(container)

    expect(container.querySelector(`[${FILE_LINK_ATTR}]`)).toBeNull()
    expect(container.innerHTML).toBe(before)
  })
})

describe('resolveFileLinkTarget', () => {
  it('resolves a relative path against cwd', () => {
    expect(resolveFileLinkTarget('src/foo.ts', '/home/user/project')).toEqual({
      absPath: '/home/user/project/src/foo.ts',
      line: undefined,
      col: undefined,
    })
  })

  it('parses trailing :line:col and strips it from the resolved path', () => {
    expect(resolveFileLinkTarget('src/foo.ts:42:8', '/home/user/project')).toEqual({
      absPath: '/home/user/project/src/foo.ts',
      line: 42,
      col: 8,
    })
  })

  it('leaves an already-absolute path unchanged', () => {
    expect(resolveFileLinkTarget('/etc/hosts', '/home/user/project')).toEqual({
      absPath: '/etc/hosts',
      line: undefined,
      col: undefined,
    })
  })

  it('resolves a path-traversal token lexically (validation happens downstream)', () => {
    expect(resolveFileLinkTarget('../../../../etc/passwd', '/home/user/project')).toEqual({
      absPath: '/home/user/project/../../../../etc/passwd',
      line: undefined,
      col: undefined,
    })
  })
})

describe('extractFilePaths', () => {
  it('returns unique file-path mentions, deduping repeats', () => {
    const text = 'pasted /tmp/session-manager-clipboard/clipboard-1.png then /tmp/session-manager-clipboard/clipboard-1.png again'
    expect(extractFilePaths(text)).toEqual(['/tmp/session-manager-clipboard/clipboard-1.png'])
  })

  it('returns each distinct path once, in first-seen order', () => {
    const text = 'see /tmp/a.png and also /tmp/b.png'
    expect(extractFilePaths(text)).toEqual(['/tmp/a.png', '/tmp/b.png'])
  })

  it('caps at 3 distinct paths', () => {
    const text = '/tmp/a.png /tmp/b.png /tmp/c.png /tmp/d.png'
    expect(extractFilePaths(text)).toEqual(['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'])
  })

  it('returns an empty array when the text has no path-like tokens', () => {
    expect(extractFilePaths('just a normal sentence')).toEqual([])
  })

  it('does not treat an ellipsis-prefixed ALL_CAPS constant name as a file path', () => {
    expect(extractFilePaths('quoting ...TOOL_PROJECTS from the other repo')).toEqual([])
  })

  it('does not treat a bare ALL_CAPS constant name as a file path', () => {
    expect(extractFilePaths('the TOOL_PROJECTS constant')).toEqual([])
  })

  it('matches a real filename with a plausible extension and no path separator', () => {
    expect(extractFilePaths('see projectsRegistry.ts for the list')).toEqual(['projectsRegistry.ts'])
  })

  it('matches a path with a line number, capturing the suffix', () => {
    expect(extractFilePaths('error in src/config/tools.ts:174 during build')).toEqual(['src/config/tools.ts:174'])
  })

  it('matches a bare .tsx filename with no path separator', () => {
    expect(extractFilePaths('open SessionManagerPage.tsx to edit')).toEqual(['SessionManagerPage.tsx'])
  })

  it('rejects a short ALL-CAPS-with-underscore "extension" even under the length cap', () => {
    // "AB_CD" is only 5 chars — this exercises the all-caps/underscore check
    // independently of the length cutoff, which alone wouldn't reject it.
    expect(extractFilePaths('the constant foo.AB_CD is not a file')).toEqual([])
  })
})
