/**
 * TiptapBody — WYSIWYG pane for the Editor scene's markdown Wysiwyg view mode.
 *
 * Architecture: Tiptap (ProseMirror) over tiptap-markdown for round-trip
 * serialization. StarterKit covers all common marks; Link adds URL handling.
 *
 * Chosen over Lexical (immature markdown round-trip), Milkdown (similar tech
 * but smaller community), and Slate (no first-class markdown serializer).
 *
 * IMPORTANT: Tiptap never sees the YAML frontmatter block. We split it off
 * in splitFrontmatter(), hand only the body to Tiptap, and rejoin on every
 * onChange emit. If we passed the full file, `---` would render as an <hr>.
 *
 * Known serialization diffs vs raw source (from tiptap-markdown / prosemirror-markdown):
 * - List markers normalized to `-` (source may use `*`)
 * - Headings normalized to ATX (`#`) style
 * - Bold = `**`, italic = `*`
 * - Trailing spaces stripped; the source body's trailing newlines are kept (bodyMarkdown)
 * - CLAUDE.md `@path` import lines are written back verbatim (ImportLine)
 * These are acceptable for user-edited notes. For surgical edits (PRDs, agent
 * files) the user should switch to Source mode.
 *
 * Cursor position is NOT restored across full component unmounts (remounts when
 * activePath changes). Tiptap has no stable cursor-restore primitive for this.
 */

import { useEffect, useRef, useState } from 'react'
import { Z } from '../../../lib/zLayers'
import { useEditor, useEditorState, EditorContent, Extension, Node as TiptapNode, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { Markdown, type MarkdownStorage } from 'tiptap-markdown'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { splitFrontmatter, joinFrontmatter, type SplitDoc } from '../../../lib/markdownDoc'
import { blockKey } from './changedLines'

interface Props {
  value: string
  onChange: (v: string) => void
  /** Markdown blocks to highlight (honey tint + left rule) — matched to top-level nodes by text. */
  markedBlocks?: string[]
}

// --- Changed-block marks ---

const markedKey = new PluginKey('sm-marked-blocks')
// Literal class string (Tailwind JIT).
const MARKED_CLASS = 'bg-honey/10 border-l-[3px] border-honey pl-2 -ml-[11px] rounded-r'

/** Node decorations on every top-level node whose text matches one of `getKeys()`. */
function markedBlocksExtension(getKeys: () => Set<string>) {
  return Extension.create({
    name: 'smMarkedBlocks',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: markedKey,
          props: {
            decorations(state) {
              const keys = getKeys()
              if (keys.size === 0) return DecorationSet.empty
              const decos: Decoration[] = []
              state.doc.forEach((node, offset) => {
                const k = blockKey(node.textContent, false)
                if (k && keys.has(k)) {
                  decos.push(Decoration.node(offset, offset + node.nodeSize, {
                    class: MARKED_CLASS,
                    'data-changed': 'true',
                  }))
                }
              })
              return DecorationSet.create(state.doc, decos)
            },
          },
        }),
      ]
    },
  })
}

// --- CLAUDE.md `@path` import lines ---
//
// Claude Code reads any source line matching ^@\S+ as an import. Plain
// markdown folds consecutive such lines into one paragraph (and escapes `~`
// on save), so each gets its own atom block. The raw line is kept verbatim
// and written back unescaped; `blankBefore`/`blankAfter` record whether a
// blank line sat next to it in the source so tight runs stay tight.

/** markdown-it instances that already carry the rule (tiptap-markdown calls setup on every parse). */
const importRuleInstalled = new WeakSet<object>()
const IMPORT_LINE_RE = /^@\S+/

interface MdBlockState {
  src: string
  bMarks: number[]
  eMarks: number[]
  tShift: number[]
  line: number
  push: (type: string, tag: string, nesting: number) => { meta: unknown; map: [number, number] | null }
}
interface MdIt {
  block: { ruler: { before: (anchor: string, name: string, fn: (s: MdBlockState, start: number, end: number, silent: boolean) => boolean, opts?: { alt: string[] }) => void } }
  renderer: { rules: Record<string, (tokens: { meta: unknown }[], idx: number) => string> }
}
interface ImportMeta { path: string; blankBefore: boolean; blankAfter: boolean }

const escAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function installImportRule(md: MdIt) {
  if (importRuleInstalled.has(md)) return
  importRuleInstalled.add(md)
  md.block.ruler.before('lheading', 'sm_import', (state, startLine, _endLine, silent) => {
    const contentStart = state.bMarks[startLine] + state.tShift[startLine]
    // The physical source line — not markdown-it's view of it, which strips
    // blockquote markers. Only a line starting at column 0 is an import.
    const lineStart = state.src.lastIndexOf('\n', contentStart - 1) + 1
    if (contentStart !== lineStart) return false
    const raw = state.src.slice(lineStart, state.eMarks[startLine]).replace(/\r$/, '')
    if (!IMPORT_LINE_RE.test(raw)) return false
    if (silent) return true
    const prevStart = lineStart === 0 ? -1 : state.src.lastIndexOf('\n', lineStart - 2) + 1
    const prevLine = prevStart < 0 ? '' : state.src.slice(prevStart, lineStart - 1)
    const nextNl = state.src.indexOf('\n', state.eMarks[startLine])
    const nextEnd = nextNl < 0 ? -1 : state.src.indexOf('\n', nextNl + 1)
    const nextLine = nextNl < 0 ? '' : state.src.slice(nextNl + 1, nextEnd < 0 ? undefined : nextEnd)
    const token = state.push('sm_import', 'div', 0)
    token.map = [startLine, startLine + 1]
    token.meta = {
      path: raw.slice(1),
      blankBefore: prevLine.trim() === '',
      blankAfter: nextLine.trim() === '',
    } satisfies ImportMeta
    state.line = startLine + 1
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.renderer.rules.sm_import = (tokens, idx) => {
    const m = tokens[idx].meta as ImportMeta
    return `<div data-sm-import="${escAttr(m.path)}" data-blank-before="${m.blankBefore}" data-blank-after="${m.blankAfter}"></div>`
  }
}

interface MdSerializerState {
  write: (s?: string) => void
  ensureNewLine: () => void
  flushClose: (size?: number) => void
  closeBlock: (node: PMNode) => void
}

export const ImportLine = TiptapNode.create({
  name: 'smImportLine',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      path: { default: '' },
      blankBefore: { default: true },
      blankAfter: { default: true },
    }
  },
  parseHTML() {
    return [{
      tag: 'div[data-sm-import]',
      getAttrs: (el) => {
        const e = el as HTMLElement
        return {
          path: e.getAttribute('data-sm-import') ?? '',
          blankBefore: e.getAttribute('data-blank-before') !== 'false',
          blankAfter: e.getAttribute('data-blank-after') !== 'false',
        }
      },
    }]
  },
  renderHTML({ node }) {
    return [
      'div',
      {
        'data-sm-import': node.attrs.path,
        'data-blank-before': String(node.attrs.blankBefore),
        'data-blank-after': String(node.attrs.blankAfter),
        class: 'flex gap-2 mt-2 text-[12.5px] leading-relaxed',
      },
      ['span', { 'data-sm-import-marker': '', class: 'min-w-[16px] shrink-0 font-mono font-semibold text-accent' }, '@'],
      ['span', { 'data-sm-import-path': '', class: 'min-w-0 font-mono text-fg break-all' }, node.attrs.path],
    ]
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: MdSerializerState, node: PMNode, parent: PMNode, index: number) {
          // A tight neighbour above: one newline, not the default blank line.
          if (index > 0 && !node.attrs.blankBefore) state.flushClose(1)
          state.write(`@${node.attrs.path}`)
          if (index + 1 < parent.childCount && !node.attrs.blankAfter) state.ensureNewLine()
          else state.closeBlock(node)
        },
        parse: {
          setup(md: MdIt) { installImportRule(md) },
        },
      },
    }
  },
})

// --- Toolbar button ---

function ToolbarBtn({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        // Prevent editor blur on toolbar click.
        e.preventDefault()
        onClick()
      }}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`shrink-0 whitespace-nowrap px-1.5 py-0.5 rounded text-xs leading-none transition-colors ${
        active
          ? 'bg-accent text-bg font-semibold'
          : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
      }`}
    >
      {children}
    </button>
  )
}

// --- Block style menu ---

type BlockStyle = 'paragraph' | 1 | 2 | 3

const STYLES: { key: BlockStyle; label: string }[] = [
  { key: 'paragraph', label: 'Normal text' },
  { key: 1, label: 'Heading 1' },
  { key: 2, label: 'Heading 2' },
  { key: 3, label: 'Heading 3' },
]

function StyleMenu({ current, onPick }: { current: BlockStyle; onPick: (s: BlockStyle) => void }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const label = STYLES.find((s) => s.key === current)?.label ?? 'Normal text'
  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        data-testid="doc-style-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Text style"
        onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o) }}
        className="flex items-center gap-2 h-6 px-2 rounded border border-line text-[11px] font-medium text-fg hover:bg-bg-hi"
      >
        {label}
        <span aria-hidden className="text-[9px] text-fg-faint">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          data-testid="doc-style-menu-list"
          className={`absolute top-full left-0 ${Z.dialog} mt-1 min-w-[140px] bg-bg-elev border border-line rounded shadow-lg py-1`}
        >
          {STYLES.map((s) => (
            <button
              type="button"
              role="menuitem"
              key={String(s.key)}
              aria-checked={s.key === current}
              onMouseDown={(e) => { e.preventDefault(); setOpen(false); onPick(s.key) }}
              className={`block w-full text-left px-3 py-1 text-[12px] hover:bg-bg-hi ${s.key === current ? 'text-fg font-medium' : 'text-fg-dim'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Document toolbar (design: DocEditor `isDoc`) ---
// Normal text ▾ | B I </> | • List 1. List Quote Link

function DocToolbar({ editor, frontmatter }: { editor: Editor; frontmatter: string }) {
  // Tiptap v3 does not re-render on transactions; subscribe to just what the toolbar shows.
  const st = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      block: (ed.isActive('heading', { level: 1 }) ? 1
        : ed.isActive('heading', { level: 2 }) ? 2
        : ed.isActive('heading', { level: 3 }) ? 3
        : 'paragraph') as BlockStyle,
      bold: ed.isActive('bold'),
      italic: ed.isActive('italic'),
      code: ed.isActive('code'),
      bulletList: ed.isActive('bulletList'),
      orderedList: ed.isActive('orderedList'),
      blockquote: ed.isActive('blockquote'),
      link: ed.isActive('link'),
    }),
  })

  const setStyle = (s: BlockStyle) => {
    const chain = editor.chain().focus()
    if (s === 'paragraph') chain.setParagraph().run()
    else chain.setHeading({ level: s }).run()
  }

  const promptLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('Enter URL', prev ?? 'https://')
    if (url === null) return
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    }
  }

  return (
    <div className="shrink-0 border-b border-line bg-bg-elev px-2 flex items-center gap-1 h-9">
      <div data-testid="doc-toolbar" className="flex items-center gap-1 min-w-0 overflow-x-auto">
        <StyleMenu current={st.block} onPick={setStyle} />
        <div className="w-px h-4 bg-line mx-0.5 shrink-0" />
        <ToolbarBtn active={st.bold} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold (Ctrl+B)">
          <strong>B</strong>
        </ToolbarBtn>
        <ToolbarBtn active={st.italic} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic (Ctrl+I)">
          <em>I</em>
        </ToolbarBtn>
        <ToolbarBtn active={st.code} onClick={() => editor.chain().focus().toggleCode().run()} title="Inline code">
          {'</>'}
        </ToolbarBtn>
        <div className="w-px h-4 bg-line mx-0.5 shrink-0" />
        <ToolbarBtn active={st.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
          • List
        </ToolbarBtn>
        <ToolbarBtn active={st.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">
          1. List
        </ToolbarBtn>
        <ToolbarBtn active={st.blockquote} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Blockquote">
          Quote
        </ToolbarBtn>
        <ToolbarBtn active={st.link} onClick={promptLink} title="Link">
          Link
        </ToolbarBtn>
      </div>
      <div className="flex-1" />
      <FrontmatterChip frontmatter={frontmatter} />
    </div>
  )
}

// --- Frontmatter chip ---

function FrontmatterChip({ frontmatter }: { frontmatter: string }) {
  const [open, setOpen] = useState(false)
  if (!frontmatter) return null
  const lineCount = frontmatter.split('\n').length - 1 // exclude trailing newline

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[10px] text-fg-faint border border-line rounded px-2 py-0.5 hover:text-fg-dim transition-colors"
        title="Frontmatter (read-only)"
      >
        📋 frontmatter ({lineCount} lines) {open ? '▲' : '▼'}
      </button>
      {open && (
        <div className={`absolute top-full left-0 ${Z.dialog} mt-1 min-w-[280px] max-w-[500px] bg-bg-elev border border-line rounded shadow-lg p-2 overflow-x-auto`}>
          <pre className="text-[10px] text-fg-dim font-mono whitespace-pre leading-relaxed">
            {frontmatter}
          </pre>
        </div>
      )}
    </div>
  )
}

// --- Main component ---

/**
 * The editor's markdown, ending the way the source body ended. tiptap-markdown
 * trims every trailing newline; a CLAUDE.md that ends in one must still end in
 * one after a save that changed nothing at the end.
 */
function bodyMarkdown(ed: Editor, sourceBody: string): string {
  const md = (ed.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown()
  if (!md) return md
  const tail = /(\r?\n)*$/.exec(sourceBody)?.[0] ?? ''
  return md.replace(/\n*$/, '') + tail
}

export function TiptapBody({ value, onChange, markedBlocks }: Props) {
  // Split frontmatter once on mount; capture it for the lifetime of this
  // component instance (keyed by path in EditorView, so remount = new path).
  const splitRef = useRef<SplitDoc>(splitFrontmatter(value))
  // Track whether this is an internal update (Tiptap → onChange) to avoid
  // re-setting content from outside while the user is typing.
  const suppressExternalRef = useRef(false)
  const markedKeysRef = useRef<Set<string>>(new Set())
  markedKeysRef.current = new Set((markedBlocks ?? []).map((b) => blockKey(b, true)).filter(Boolean))

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ autolink: true, openOnClick: false }),
      Markdown.configure({ html: false, tightLists: true }),
      ImportLine,
      markedBlocksExtension(() => markedKeysRef.current),
    ],
    content: splitRef.current.body,
    onUpdate: ({ editor: ed }) => {
      const body = bodyMarkdown(ed, splitRef.current.body)
      suppressExternalRef.current = true
      onChange(joinFrontmatter(splitRef.current, body))
      // Allow external updates again on next tick.
      requestAnimationFrame(() => { suppressExternalRef.current = false })
    },
    editorProps: {
      attributes: {
        class: 'tiptap-content flex-1 outline-none max-w-none p-4 leading-relaxed',
        'data-testid': 'tiptap-editor',
      },
    },
  })

  // Sync external value changes (e.g. when opening a different doc with same path).
  useEffect(() => {
    if (!editor || suppressExternalRef.current) return
    const newSplit = splitFrontmatter(value)
    // Only re-load if the body actually changed from outside.
    const currentBody = bodyMarkdown(editor, newSplit.body)
    if (newSplit.body !== currentBody) {
      splitRef.current = newSplit
      editor.commands.setContent(newSplit.body)
    }
  }, [value, editor])

  // Re-run the decorations prop when the marked set changes (no doc change).
  const markedSig = markedBlocks?.join('\u0000') ?? ''
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta(markedKey, markedSig))
  }, [markedSig, editor])

  if (!editor) return null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <DocToolbar editor={editor} frontmatter={splitRef.current.frontmatter} />

      {/* Editor content */}
      <EditorContent editor={editor} className="flex-1 overflow-y-auto" />
    </div>
  )
}
