/**
 * Project Home's single-page view: a lone Generate
 * button until project-pages/home.html exists, then that one file in a
 * sandboxed iframe with a "generated <ago>" chip and a Regenerate button.
 *
 * `output`/`loaded` come from ProjectHome's single `useProjectPagesOutput`
 * call; `onGenerate` is ProjectHome's `useBuilderEpic().generate` wrapper.
 */
import { formatAgo } from '../../../../lib/formatTime'
import { AlmanacIcon } from '../../../layout/AlmanacIcon'
import { HtmlFrame } from './HtmlFrame'
import type { ProjectPagesOutput } from '../../../../lib/projectPages/useProjectPagesOutput'

const BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-bg-hi cursor-pointer hover:bg-accent-dark'

function GenerateButton({ label, onGenerate }: { label: string; onGenerate: () => void }) {
  return (
    <button type="button" onClick={onGenerate} className={BUTTON_CLASS}>
      <span className="inline-flex">
        <AlmanacIcon name="sparkle" size={14} />
      </span>
      {label}
    </button>
  )
}

export function ProjectPagesSection({
  output,
  loaded,
  onGenerate,
}: {
  output: ProjectPagesOutput | null
  loaded: boolean
  onGenerate: () => void
}) {
  if (!loaded) return null

  if (!output) {
    return (
      <div className="flex justify-center py-16">
        <GenerateButton label="Generate Project Home" onGenerate={onGenerate} />
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-2.5">
        <span className="font-mono text-[10.5px] text-fg-faint">generated {formatAgo(output.mtimeMs, Date.now())}</span>
        <GenerateButton label="Regenerate" onGenerate={onGenerate} />
      </div>
      <div
        className="overflow-hidden rounded-xl border border-line bg-bg-hi"
        style={{ height: 'calc(100vh - 200px)', minHeight: 520 }}
      >
        <HtmlFrame title="Project Home" html={output.html} />
      </div>
    </div>
  )
}
