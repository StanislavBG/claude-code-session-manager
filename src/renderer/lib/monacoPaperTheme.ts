/**
 * The app's light "paper" Monaco theme (`sm-paper`), shared by every editor
 * that shows it: CodeEditorPane's paper preference and MarkdownEditor's
 * `theme="paper"`.
 *
 * Monaco registers themes on its one window-wide instance, so the definition is
 * guarded by a module-level flag: the first call registers it, every later call
 * is a no-op. Call it before `setTheme(PAPER_THEME)` — from `beforeMount`, or
 * `onMount` before the theme is applied.
 */
import type { editor } from 'monaco-editor'

export const PAPER_THEME = 'sm-paper'

/** The slice of the Monaco namespace a theme definition needs. The real
 *  `monaco` handed to BeforeMount / OnMount satisfies it structurally. */
export interface MonacoThemeHost {
  editor: Pick<typeof editor, 'defineTheme'>
}

const PAPER_THEME_DATA: editor.IStandaloneThemeData = {
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
}

let paperDefined = false

export function definePaperTheme(monaco: MonacoThemeHost): void {
  if (paperDefined) return
  monaco.editor.defineTheme(PAPER_THEME, PAPER_THEME_DATA)
  paperDefined = true
}
