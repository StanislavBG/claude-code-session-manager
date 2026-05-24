import { Panel } from '../ui/Panel'
import { EmptyState } from '../ui/EmptyState'
import { useActiveTab } from '../../lib/useActiveTab'
import { useLiveTab } from '../../state/live'

/**
 * Tasks tab — live view of TodoWrite state from the active session transcript.
 */
export function Tasks() {
  const activeTab = useActiveTab()
  const live = useLiveTab(activeTab)

  if (!activeTab) {
    return (
      <Panel>
        <EmptyState
          title="no active session"
          hint="open a terminal tab and run claude to see tasks"
        />
      </Panel>
    )
  }

  const todos = live?.todos ?? []
  const counts = {
    completed: todos.filter((t) => t.status === 'completed').length,
    in_progress: todos.filter((t) => t.status === 'in_progress').length,
    pending: todos.filter((t) => t.status === 'pending').length,
  }

  return (
    <Panel
      toolbar={
        <>
          <span className="text-fg-faint">session {activeTab.claudeSessionId.slice(0, 8)}</span>
          <div className="flex-1" />
          <span className="text-fg-faint">
            <span className="text-green-400">{counts.completed}</span> done ·{' '}
            <span className="text-accent">{counts.in_progress}</span> active ·{' '}
            <span className="text-fg-dim">{counts.pending}</span> pending
          </span>
        </>
      }
    >
      {todos.length === 0 ? (
        <EmptyState
          title="no todos yet"
          hint="todos appear when claude calls TodoWrite"
        />
      ) : (
        <ul className="p-4 space-y-1 max-w-3xl">
          {todos.map((t, i) => (
            <li
              key={i}
              className={`flex items-start gap-3 py-1.5 px-2 rounded text-xs ${
                t.status === 'in_progress' ? 'bg-bg-elev' : ''
              }`}
            >
              <StatusGlyph status={t.status} />
              <span
                className={`flex-1 ${
                  t.status === 'completed'
                    ? 'text-fg-faint line-through'
                    : t.status === 'in_progress'
                      ? 'text-fg'
                      : 'text-fg-dim'
                }`}
              >
                {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function StatusGlyph({ status }: { status: string }) {
  if (status === 'completed')
    return <span className="text-green-400 w-4 shrink-0">✓</span>
  if (status === 'in_progress')
    return (
      <span className="text-accent w-4 shrink-0">
        <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
      </span>
    )
  return <span className="text-fg-faint w-4 shrink-0">○</span>
}
