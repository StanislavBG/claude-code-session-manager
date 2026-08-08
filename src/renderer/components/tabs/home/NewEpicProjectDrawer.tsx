/**
 * NewEpicProjectDrawer — Home Screen A's "New epic" project picker
 * (variants/home-a.jsx's newEpic ADrawer), rebuilt on the real
 * HomeSessionDrawer primitive PRD 967 landed rather than a second dialog.
 * Lists known projects as a radio list (real HomeProjectRow[] — same data
 * Home's ProjectsCard renders, see Home.tsx's useHomeProjectRows). Confirming
 * activates-or-opens that project's SessionTab and hands off to the Epics
 * workspace; there is no cross-component signal to auto-open NewEpicCard
 * today, so the footer copy says "Continue in <project> → Epics" rather than
 * implying it opens the New Epic form directly.
 */
import { useEffect, useState } from 'react'
import { HomeSessionDrawer } from './HomeSessionDrawer'
import type { HomeProjectRow } from '../../../lib/homeProjectRows'

export function NewEpicProjectDrawer({
  open,
  onClose,
  projects,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  projects: HomeProjectRow[]
  onConfirm: (cwd: string) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (open) setSelected(projects[0]?.cwd ?? null)
  }, [open, projects])

  const selectedRow = projects.find((p) => p.cwd === selected) ?? null

  return (
    <HomeSessionDrawer
      open={open}
      onClose={onClose}
      title="New session"
      sub="Pick a project to start it in"
      keyVals={[]}
      footer={
        <>
          <button
            onClick={onClose}
            className="text-[12px] font-semibold px-[13px] py-[7px] rounded-lg border border-line bg-bg text-fg-dim hover:bg-bg-elev"
          >
            Cancel
          </button>
          <button
            onClick={() => { if (selected) { onConfirm(selected); onClose() } }}
            disabled={!selected}
            className="text-[12px] font-semibold px-[13px] py-[7px] rounded-lg bg-accent text-bg-hi hover:bg-accent-dark disabled:opacity-50"
          >
            {selectedRow ? `Continue in ${selectedRow.name} → Epics` : 'Continue'}
          </button>
        </>
      }
    >
      {projects.length === 0 ? (
        <div className="text-[13px] text-fg-faint py-2">No known projects yet.</div>
      ) : (
        <div role="radiogroup" aria-label="Project" className="grid gap-1.5">
          {projects.map((p) => (
            <label
              key={p.encoded}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer ${
                selected === p.cwd ? 'border-accent bg-accent/10' : 'border-line bg-bg hover:bg-bg-elev/60'
              }`}
            >
              <input
                type="radio"
                name="new-epic-project"
                value={p.cwd}
                checked={selected === p.cwd}
                onChange={() => setSelected(p.cwd)}
                className="accent-accent"
              />
              <span className="min-w-0 flex-1 text-[13px] text-fg truncate" title={p.cwd}>{p.name}</span>
            </label>
          ))}
        </div>
      )}
    </HomeSessionDrawer>
  )
}
