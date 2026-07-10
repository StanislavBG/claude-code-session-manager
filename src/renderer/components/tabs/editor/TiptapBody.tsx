/**
 * TiptapBody — WYSIWYG markdown editor for the Doc Editor.
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
 * - Trailing spaces stripped; exactly one trailing newline
 * These are acceptable for user-edited notes. For surgical edits (PRDs, agent
 * files) the user should switch to Source mode.
 *
 * Cursor position is NOT restored across full component unmounts (remounts when
 * activePath changes). Tiptap has no stable cursor-restore primitive for this.
 */

import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { Markdown } from 'tiptap-markdown'
import { splitFrontmatter, joinFrontmatter, type SplitDoc } from '../../lib/markdownDoc'

interface Props {
  value: string
  onChange: (v: string) => void
}

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
      className={`px-1.5 py-0.5 rounded text-xs font-mono leading-none transition-colors ${
        active
          ? 'bg-accent text-bg font-semibold'
          : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
      }`}
    >
      {children}
    </button>
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
        <div className="absolute top-full left-0 z-50 mt-1 min-w-[280px] max-w-[500px] bg-bg-elev border border-line rounded shadow-lg p-2 overflow-x-auto">
          <pre className="text-[10px] text-fg-dim font-mono whitespace-pre leading-relaxed">
            {frontmatter}
          </pre>
        </div>
      )}
    </div>
  )
}

// --- Main component ---

export function TiptapBody({ value, onChange }: Props) {
  // Split frontmatter once on mount; capture it for the lifetime of this
  // component instance (keyed by path in DocEditor, so remount = new path).
  const splitRef = useRef<SplitDoc>(splitFrontmatter(value))
  // Track whether this is an internal update (Tiptap → onChange) to avoid
  // re-setting content from outside while the user is typing.
  const suppressExternalRef = useRef(false)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ autolink: true, openOnClick: false }),
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: splitRef.current.body,
    onUpdate: ({ editor: ed }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (ed.storage as any).markdown.getMarkdown() as string
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentBody = (editor.storage as any).markdown.getMarkdown() as string
    if (newSplit.body !== currentBody) {
      splitRef.current = newSplit
      editor.commands.setContent(newSplit.body)
    }
  }, [value, editor])

  if (!editor) return null

  const isActive = (name: string, attrs?: Record<string, unknown>) =>
    editor.isActive(name, attrs)

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
    <div className="flex flex-col h-full overflow-hidden">
      {/* Floating toolbar */}
      <div className="shrink-0 border-b border-line bg-bg-elev px-2 flex items-center gap-1 h-8 overflow-x-auto">
        <ToolbarBtn active={isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold (Ctrl+B)">
          <strong>B</strong>
        </ToolbarBtn>
        <ToolbarBtn active={isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic (Ctrl+I)">
          <em>I</em>
        </ToolbarBtn>
        <div className="w-px h-4 bg-line mx-0.5 shrink-0" />
        <ToolbarBtn active={isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="Heading 1">
          H1
        </ToolbarBtn>
        <ToolbarBtn active={isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">
          H2
        </ToolbarBtn>
        <ToolbarBtn active={isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3">
          H3
        </ToolbarBtn>
        <div className="w-px h-4 bg-line mx-0.5 shrink-0" />
        <ToolbarBtn active={isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
          &#8226;&#8212;
        </ToolbarBtn>
        <ToolbarBtn active={isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">
          1.
        </ToolbarBtn>
        <div className="w-px h-4 bg-line mx-0.5 shrink-0" />
        <ToolbarBtn active={isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} title="Inline code">
          `c`
        </ToolbarBtn>
        <ToolbarBtn active={isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="Code block">
          {'</>'}
        </ToolbarBtn>
        <ToolbarBtn active={isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Blockquote">
          ❝
        </ToolbarBtn>
        <ToolbarBtn active={isActive('link')} onClick={promptLink} title="Link">
          🔗
        </ToolbarBtn>
        <div className="flex-1" />
        <FrontmatterChip frontmatter={splitRef.current.frontmatter} />
      </div>

      {/* Editor content */}
      <EditorContent editor={editor} className="flex-1 overflow-y-auto" />
    </div>
  )
}
