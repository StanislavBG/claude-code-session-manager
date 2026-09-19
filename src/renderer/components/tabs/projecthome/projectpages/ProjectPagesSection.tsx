/**
 * Project Home's single-page view: an honest empty state with one Generate
 * button until project-pages/home.html exists, then that one file in a
 * sandboxed iframe with a "generated <ago>" chip and a Regenerate button.
 *
 * `output`/`loaded` come from ProjectHome's single `useProjectPagesOutput`
 * call; `onGenerate` is ProjectHome's `useBuilderEpic().generate` wrapper.
 */
import { formatAgo } from '../../../../lib/formatTime'
import { AlmanacIcon } from '../../../layout/AlmanacIcon'
import { EmptyState } from '../../../ui/EmptyState'
import { PhBlock, PhCard } from '../ph-primitives'
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
      <PhBlock kicker="home" title="Project Home" note="No home page has been generated for this project yet.">
        <EmptyState
          title="No Project Home yet"
          hint={
            <div className="mt-3">
              <GenerateButton label="Generate Project Home" onGenerate={onGenerate} />
            </div>
          }
        />
      </PhBlock>
    )
  }

  return (
    <PhBlock
      kicker="home"
      title="Project Home"
      right={
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[10.5px] text-fg-faint">generated {formatAgo(output.mtimeMs, Date.now())}</span>
          <GenerateButton label="Regenerate" onGenerate={onGenerate} />
        </div>
      }
    >
      <PhCard className="overflow-hidden" style={{ height: 'calc(100vh - 260px)', minHeight: 520 }}>
        <HtmlFrame title="Project Home" html={output.html} />
      </PhCard>
    </PhBlock>
  )
}
