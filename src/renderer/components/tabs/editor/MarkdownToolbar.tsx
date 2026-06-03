/**
 * MarkdownToolbar — a lightweight formatting strip over the Monaco buffer for
 * markdown files (the Google-Docs toolbar feel, but it edits markdown source).
 *
 * It drives the live editor instance handed up from CodeEditorPane: wrap actions
 * (bold/italic/code) surround the selection; line actions (heading/list/quote)
 * prefix the current line. Uses Monaco's executeEdits so edits land in the undo
 * stack and fire onChange normally.
 */

import type { editor } from 'monaco-editor'

interface Props {
  getEditor: () => editor.IStandaloneCodeEditor | null
}

type Btn =
  | { kind: 'wrap'; label: string; title: string; before: string; after: string }
  | { kind: 'prefix'; label: string; title: string; prefix: string }
  | { kind: 'link'; label: string; title: string }

const BTNS: Btn[] = [
  { kind: 'prefix', label: 'H1', title: 'Heading 1', prefix: '# ' },
  { kind: 'prefix', label: 'H2', title: 'Heading 2', prefix: '## ' },
  { kind: 'prefix', label: 'H3', title: 'Heading 3', prefix: '### ' },
  { kind: 'wrap', label: 'B', title: 'Bold', before: '**', after: '**' },
  { kind: 'wrap', label: 'I', title: 'Italic', before: '_', after: '_' },
  { kind: 'wrap', label: '<>', title: 'Inline code', before: '`', after: '`' },
  { kind: 'prefix', label: '• List', title: 'Bullet list', prefix: '- ' },
  { kind: 'prefix', label: '1. List', title: 'Numbered list', prefix: '1. ' },
  { kind: 'prefix', label: '" Quote', title: 'Blockquote', prefix: '> ' },
  { kind: 'link', label: 'Link', title: 'Insert link' },
]

export function MarkdownToolbar({ getEditor }: Props) {
  const apply = (b: Btn) => {
    const ed = getEditor()
    if (!ed) return
    const model = ed.getModel()
    const sel = ed.getSelection()
    if (!model || !sel) return

    if (b.kind === 'wrap') {
      const text = model.getValueInRange(sel)
      ed.executeEdits('md-toolbar', [{ range: sel, text: `${b.before}${text || 'text'}${b.after}`, forceMoveMarkers: true }])
    } else if (b.kind === 'prefix') {
      const startLine = sel.startLineNumber
      const endLine = sel.endLineNumber
      const edits = []
      for (let ln = startLine; ln <= endLine; ln++) {
        edits.push({
          range: { startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: 1 },
          text: b.prefix,
          forceMoveMarkers: true,
        })
      }
      ed.executeEdits('md-toolbar', edits)
    } else {
      const text = model.getValueInRange(sel) || 'text'
      ed.executeEdits('md-toolbar', [{ range: sel, text: `[${text}](url)`, forceMoveMarkers: true }])
    }
    ed.focus()
  }

  return (
    <div className="flex items-center gap-0.5 px-2 h-7 shrink-0 border-b border-line bg-bg-elev">
      {BTNS.map((b) => (
        <button
          key={b.label}
          onClick={() => apply(b)}
          title={b.title}
          className="px-1.5 py-0.5 text-[10px] text-fg-dim hover:text-fg hover:bg-bg-hi rounded font-medium"
        >
          {b.label}
        </button>
      ))}
    </div>
  )
}
