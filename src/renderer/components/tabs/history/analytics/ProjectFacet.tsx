import { projectColorFor } from '../../../../lib/projectColor'
import { projectNameFromCwd } from '../../scheduler/sched-primitives'

export interface FacetChipData {
  projectDir: string
  value: number
}

interface Props {
  chips: FacetChipData[]
  keep: Set<string> | null
  onToggle: (projectDir: string) => void
  onIsolate: (projectDir: string) => void
  onShowAll: () => void
}

export function ProjectFacet({ chips, keep, onToggle, onIsolate, onShowAll }: Props) {
  const allShown = keep === null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        onClick={onShowAll}
        className={`px-2 py-1 rounded text-[11px] border ${allShown ? 'bg-accent text-white border-accent' : 'border-line text-fg-faint hover:text-fg hover:bg-bg-hi'}`}
      >
        show all ({chips.length})
      </button>
      {chips.map((chip) => {
        const active = allShown || keep!.has(chip.projectDir)
        return (
          <button
            key={chip.projectDir}
            onClick={(e) => (e.shiftKey ? onIsolate(chip.projectDir) : onToggle(chip.projectDir))}
            title={chip.projectDir}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] border ${active ? 'border-line text-fg-dim bg-bg-elev' : 'border-line text-fg-faint opacity-40 hover:opacity-70'}`}
          >
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: projectColorFor(chip.projectDir) }} />
            {projectNameFromCwd(chip.projectDir) ?? chip.projectDir}
          </button>
        )
      })}
    </div>
  )
}
