import { memo, useEffect, useMemo, useState } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { ViewTabs } from '../ui/ViewTabs'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { encodeWorkspace } from '../../lib/encodeWorkspace'
import { SubagentMemoryView } from './memory/SubagentMemoryView'
import { MemoryStoreView } from './memory/MemoryStoreView'

type MemoryScope = 'workspace' | 'subagent'

const SCOPE_OPTIONS = [
  { key: 'workspace' as const, label: 'Workspace' },
  { key: 'subagent' as const, label: 'Subagent' },
]
const SCOPE_LS_KEY = 'sm.memoryTab.scope'

/**
 * Memory — single home for both memory stores, split by scope:
 *   • Workspace — cwd-keyed .md memories (~/.claude/projects/<cwd>/memory/)
 *   • Subagent  — agentId-keyed JSON entries (the old "Agent Memory" tool)
 *
 * Consolidates two former nav destinations (Memory + Agent Memory) that were
 * the same list+detail CRUD over different keys. One surface, scope toggle.
 */
function MemoryComponent() {
  const [scope, setScope] = useState<MemoryScope>(() =>
    localStorage.getItem(SCOPE_LS_KEY) === 'subagent' ? 'subagent' : 'workspace',
  )
  useEffect(() => {
    localStorage.setItem(SCOPE_LS_KEY, scope)
  }, [scope])

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-line">
        <ViewTabs options={SCOPE_OPTIONS} active={scope} onChange={setScope} />
        <span className="text-[11px] text-fg-faint">
          {scope === 'workspace' ? 'memories scoped to the active project' : 'long-term memory per subagent'}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        {scope === 'workspace' ? <WorkspaceMemoryView /> : <SubagentMemoryView />}
      </div>
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const Memory = memo(MemoryComponent)

function WorkspaceMemoryView() {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null
  const workspace = useMemo(() => encodeWorkspace(cwd), [cwd])
  const target = useMemo(() => ({ workspace, cwd: cwd ?? undefined }), [workspace, cwd])

  if (!home) return <EmptyState title="loading…" />

  return (
    <MemoryStoreView
      target={target}
      cwd={cwd}
      enableNatural
      enableClusters
      toolbarExtra={
        <>
          <span className="text-fg-faint">Workspace</span>
          <span className="font-mono text-fg-dim truncate max-w-[24rem]" title={workspace}>{workspace}</span>
        </>
      }
    />
  )
}
