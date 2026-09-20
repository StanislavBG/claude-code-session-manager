import type { NavKey } from '../../../lib/navKey'

// ─── First-run guide ─────────────────────────────────────────────────────────

const GUIDE_STEPS: Array<{ title: string; body: string }> = [
  {
    title: 'Start a session',
    body: "In Sessions, pick an Agent and a Mission, describe the outcome you want, then Approve & start. Its thread writes the PRD files into that session's own folder.",
  },
  {
    title: 'Queue what it wrote',
    body: 'The PRDs tab lists every file the session produced. Queue one, or the whole session, and they appear here.',
  },
  {
    title: 'Leave it alone',
    body: 'Jobs start themselves inside your window, pause on rate-limit, and resume at the reset. History records how each ended.',
  },
]

const GUIDE_GLOSSARY: Array<{ term: string; def: string }> = [
  { term: 'Session', def: 'One goal, one Claude session, and the folder of PRDs written to reach it.' },
  { term: 'PRD', def: 'One markdown file = one job. Authored by the session.' },
  { term: '5-hour window', def: 'Your Claude billing window, on a rolling clock.' },
  { term: 'Session pool', def: '5 slots shared with terminal and session chats.' },
]

/**
 * Shown instead of the job table when this scope has zero PRDs anywhere —
 * not a filtered-to-empty view. Nothing here writes a PRD: that happens in
 * a session, so the only real action is "go create one." A "New PRD" button
 * would offer a capability this screen doesn't have. Copy uses "session",
 * the user-facing name for an Epic (see CLAUDE.md's domain model).
 */
export function FirstRunGuide({ navigate }: { navigate?: (k: NavKey) => void }) {
  return (
    <div className="overflow-y-auto h-full">
      <div className="px-9 py-6 max-w-[900px] mx-auto">
        <div className="bg-bg-hi border border-line rounded-2xl px-9 py-8">
          <h2 className="m-0 font-serif text-[25px] font-semibold text-fg">
            Nothing to run yet — the scheduler needs a session.
          </h2>
          <p className="mt-2 mb-6 text-[14.5px] text-fg-dim leading-relaxed max-w-[580px]">
            You don't write PRDs here. A session breaks its goal into numbered PRD files, and this
            page runs them in order. Two steps, once.
          </p>

          <div className="grid grid-cols-3 gap-3.5">
            {GUIDE_STEPS.map((step, i) => {
              const isNow = i === 0
              return (
                <div
                  key={step.title}
                  className={`bg-bg border rounded-xl px-4 py-4 flex flex-col gap-2 ${
                    isNow ? 'border-accent shadow-[0_0_0_3px_rgba(184,92,52,.09)]' : 'border-line'
                  }`}
                >
                  <span
                    className={`w-6 h-6 rounded-full grid place-items-center font-mono text-[12px] font-semibold ${
                      isNow ? 'bg-accent text-white' : 'bg-bg-elev text-fg-dim'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <h3 className="m-0 text-[15px] font-semibold text-fg">{step.title}</h3>
                  <p className="m-0 text-[13.5px] text-fg-dim leading-relaxed">{step.body}</p>
                  {isNow && (
                    <button
                      type="button"
                      onClick={() => navigate?.('terminal')}
                      className="self-start bg-accent text-white rounded-lg px-3.5 py-1.5 text-[13px] font-semibold mt-1"
                    >
                      Go to Sessions →
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <dl className="flex mt-[22px] pt-4 border-t border-line gap-5 flex-wrap">
            {GUIDE_GLOSSARY.map(({ term, def }) => (
              <div key={term} className="flex-1 min-w-[150px]">
                <dt className="text-[13.5px] font-semibold text-fg mb-0.5">{term}</dt>
                <dd className="m-0 text-[12.5px] text-fg-faint leading-relaxed">{def}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  )
}
