import { useMemo, useRef, useState } from 'react'
import { MarkdownEditor } from '../../ui/MarkdownEditor'
import { SaveBar } from '../../ui/SaveBar'
import { renderChatMarkdown } from '../../../lib/renderChatMarkdown'
import { revealInFileExplorer } from '../../../lib/revealInFileExplorer'
import {
  joinSkillDoc,
  readSkillDescription,
  setSkillDescription,
  splitSkillDoc,
} from '../../../lib/skillFrontmatter'
import type { Scope } from '../../../lib/scopes'

/** The detail view's slice of a Skills list item. */
export interface SkillDetailItem {
  kind: 'skills' | 'commands'
  scope: Scope
  name: string
  /** Absolute path to the editable markdown file. */
  path: string
}

interface Props {
  item: SkillDetailItem
  /** Home dir — shortens the FILE path to `~/…`. */
  home: string
  /** The useConfig draft of `item.path` (whole file: frontmatter + body). */
  draft: string
  dirty: boolean
  busy: boolean
  lastSavedAt: number | null
  saveError: string | null
  /** Receives the whole new file text. */
  onDraftChange: (raw: string) => void
  onSave: () => void
  onRevert: () => void
}

type View = 'source' | 'preview'

const BADGE =
  'h-4 inline-flex items-center px-1.5 bg-bg-elev border border-line rounded-[3px] text-[10px] tracking-[0.04em] text-fg-dim'
const FIELD_LABEL = 'text-[11px] font-semibold tracking-[0.06em] uppercase text-fg-faint'

/** Light preview pane: serif headings, bg-bg-elev code blocks (3a §3). */
const PREVIEW_CLASS = [
  'prose-chat max-w-[720px] px-[26px] py-4 text-[14px] leading-[1.6] text-fg',
  '[&_h1]:font-serif [&_h2]:font-serif [&_h3]:font-serif [&_h4]:font-serif',
  '[&_h1]:text-[24px] [&_h2]:text-[20px] [&_h3]:text-[18px] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold',
  '[&_h1]:mb-1.5 [&_h2]:mb-1.5 [&_h3]:mb-1.5 [&_p]:mb-3.5 [&_ul]:mb-3.5 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:pl-5 [&_ol]:list-decimal',
  '[&_pre]:!bg-bg-elev [&_code]:!bg-bg-elev',
].join(' ')

function shortPath(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

/** Skills detail pane (3a): header, DESCRIPTION / FILE fields, body-only editor or preview, save bar. */
export function SkillDetail({
  item,
  home,
  draft,
  dirty,
  busy,
  lastSavedAt,
  saveError,
  onDraftChange,
  onSave,
  onRevert,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>('source')
  const parts = useMemo(() => splitSkillDoc(draft), [draft])
  const description = useMemo(() => readSkillDescription(draft) ?? '', [draft])
  const previewHtml = useMemo(
    () => (view === 'preview' ? renderChatMarkdown(parts.body) : ''),
    [view, parts.body],
  )

  const segment = (v: View, label: string) => {
    const on = view === v
    return (
      <button
        type="button"
        data-testid={`skill-view-${v}`}
        aria-pressed={on}
        onClick={() => setView(v)}
        className={`h-6 inline-flex items-center px-[11px] rounded-[5px] text-xs ${
          on ? 'bg-bg-hi shadow-sm font-semibold text-fg' : 'text-fg-faint hover:text-fg'
        }`}
      >
        {label}
      </button>
    )
  }

  return (
    <div ref={rootRef} data-testid="skill-detail" className="h-full min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 flex flex-col px-[22px] pt-4">
        <div className="flex items-center gap-2.5">
          <span data-testid="skill-detail-name" className="min-w-0 truncate font-mono text-[18px] font-semibold text-fg">
            /{item.name}
          </span>
          <span data-testid="skill-detail-kind" className={BADGE}>
            {item.kind === 'commands' ? 'COMMAND' : 'SKILL'}
          </span>
          <span data-testid="skill-detail-scope" className={BADGE}>
            {item.scope.toUpperCase()}
          </span>
          <div
            role="group"
            aria-label="View"
            className="ml-auto flex gap-0.5 p-0.5 bg-bg-elev border border-line rounded-[7px]"
          >
            {segment('source', 'Source')}
            {segment('preview', 'Preview')}
          </div>
        </div>

        <div className="grid grid-cols-[84px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2.5 mt-3.5">
          <label htmlFor={`skill-desc-${item.path}`} className={FIELD_LABEL}>
            Description
          </label>
          <input
            id={`skill-desc-${item.path}`}
            data-testid="skill-detail-description"
            type="text"
            value={description}
            onChange={(e) => onDraftChange(setSkillDescription(draft, e.target.value))}
            placeholder="What this does and when Claude should use it"
            className="px-2.5 py-[7px] bg-bg-hi border border-line rounded-md text-[13px] leading-[1.45] text-fg outline-none focus:border-accent"
          />
          <span className={FIELD_LABEL}>File</span>
          <div className="min-w-0 flex items-baseline gap-3 text-xs">
            <span data-testid="skill-detail-path" title={item.path} className="min-w-0 truncate font-mono text-[11.5px] text-fg-dim">
              {shortPath(item.path, home)}
            </span>
            <button
              type="button"
              data-testid="skill-detail-reveal"
              onClick={() => revealInFileExplorer(item.path)}
              className="shrink-0 font-medium text-accent hover:underline"
            >
              Reveal in File Explorer
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 mt-3.5 border border-line border-b-0 rounded-t-[7px] bg-bg-hi overflow-hidden">
          {view === 'source' ? (
            <MarkdownEditor
              path={item.path}
              theme="paper"
              value={parts.body}
              onChange={(body) => onDraftChange(joinSkillDoc(parts.frontmatter, body))}
            />
          ) : (
            <div className="h-full overflow-auto">
              <div
                data-testid="skill-preview"
                className={PREVIEW_CLASS}
                // renderChatMarkdown sanitizes with DOMPurify — the same path chat turns render through.
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </div>
          )}
        </div>
      </div>
      <div className="shrink-0 border-t border-line bg-bg-elev">
        <SaveBar
          dirty={dirty}
          busy={busy}
          parseError={saveError}
          lastSavedAt={lastSavedAt}
          onSave={onSave}
          onRevert={onRevert}
          cleanLabel="Saved — matches the file on disk"
          shortcutHint
          scopeRef={rootRef}
        />
      </div>
    </div>
  )
}
