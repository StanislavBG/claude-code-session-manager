import { describe, it, expect, vi, afterEach } from 'vitest'
import { useLayout } from '../../state/layout'
import { revealInFileExplorer, parseRevealHint, relativeSegments } from '../revealInFileExplorer'

const realOpenPanel = useLayout.getState().openPanel

afterEach(() => {
  useLayout.setState({ openPanel: realOpenPanel, panelTabHint: null })
})

describe('revealInFileExplorer', () => {
  it("calls the layout store's openPanel('projects', 'reveal:' + absPath)", () => {
    const openPanel = vi.fn()
    useLayout.setState({ openPanel })
    revealInFileExplorer('/home/u/.claude/skills/foo/SKILL.md')
    expect(openPanel).toHaveBeenCalledTimes(1)
    expect(openPanel).toHaveBeenCalledWith('projects', 'reveal:/home/u/.claude/skills/foo/SKILL.md')
  })

  it('focuses the File Explorer page and leaves the reveal hint for it', () => {
    revealInFileExplorer('/tmp/a.txt')
    const s = useLayout.getState()
    expect(s.focusedPanelId).toBe('projects')
    expect(s.panelTabHint).toEqual({ id: 'projects', tab: 'reveal:/tmp/a.txt' })
  })
})

describe('parseRevealHint', () => {
  it('returns the path of a reveal hint and null for any other hint', () => {
    expect(parseRevealHint('reveal:/home/u/x.md')).toBe('/home/u/x.md')
    expect(parseRevealHint('reveal:')).toBeNull()
    expect(parseRevealHint('skills')).toBeNull()
  })
})

describe('relativeSegments', () => {
  it('splits a path inside the root into the segments below it', () => {
    expect(relativeSegments('/home/u/.claude/skills', '/home/u')).toEqual(['.claude', 'skills'])
    expect(relativeSegments('/home/u/a/', '/home/u/')).toEqual(['a'])
    expect(relativeSegments('/etc/hosts', '/')).toEqual(['etc', 'hosts'])
  })

  it('is [] for the root itself and null outside it', () => {
    expect(relativeSegments('/home/u', '/home/u/')).toEqual([])
    expect(relativeSegments('/home/user2/x', '/home/u')).toBeNull()
    expect(relativeSegments('/etc/hosts', '/home/u')).toBeNull()
    expect(relativeSegments('relative/x', '/home/u')).toBeNull()
  })

  it("resolves '.' and '..' before deciding containment", () => {
    expect(relativeSegments('/home/u/./a/../b', '/home/u')).toEqual(['b'])
    expect(relativeSegments('/home/u/../other/x', '/home/u')).toBeNull()
  })

  it('handles Windows separators and drive letters', () => {
    expect(relativeSegments('C:\\Users\\me\\.claude\\x.md', 'C:\\Users\\me')).toEqual(['.claude', 'x.md'])
    expect(relativeSegments('C:/Users/me/proj', 'C:\\Users\\me')).toEqual(['proj'])
    expect(relativeSegments('D:\\x', 'C:\\Users\\me')).toBeNull()
  })
})
