import { describe, expect, it, vi } from 'vitest'

// definePaperTheme guards itself with a module-level flag, so each case loads a
// fresh copy of the module — otherwise the first case's definition would leak
// into the next and mask a missing guard (or a missing definition).
async function freshModule() {
  vi.resetModules()
  return import('../monacoPaperTheme')
}

const fakeMonaco = () => ({ editor: { defineTheme: vi.fn() } })

describe('monacoPaperTheme', () => {
  it('defines sm-paper once, on the light vs base, with the paper palette', async () => {
    const { definePaperTheme, PAPER_THEME } = await freshModule()
    const monaco = fakeMonaco()

    definePaperTheme(monaco)

    expect(PAPER_THEME).toBe('sm-paper')
    expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(1)
    const [name, data] = monaco.editor.defineTheme.mock.calls[0]
    expect(name).toBe('sm-paper')
    expect(data.base).toBe('vs')
    // The palette moved verbatim out of CodeEditorPane — pinned so a shared
    // edit can't silently restyle the File Explorer editor.
    expect(data).toEqual({
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#f6efe1',
        'editor.foreground': '#2a221a',
        'editorLineNumber.foreground': '#b8a98a',
        'editorLineNumber.activeForeground': '#7a6a4f',
        'editor.lineHighlightBackground': '#efe6d3',
        'editor.selectionBackground': '#e0d3b8',
        'editorCursor.foreground': '#b85c34',
        'editorIndentGuide.background1': '#e6dcc4',
        'editor.findMatchHighlightBackground': '#e8d7a8',
      },
    })
  })

  it('does not redefine on a second call', async () => {
    const { definePaperTheme } = await freshModule()
    const monaco = fakeMonaco()

    definePaperTheme(monaco)
    definePaperTheme(monaco)

    expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(1)
  })
})
