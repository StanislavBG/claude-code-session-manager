import { memo } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { MemoryExplorer } from './memory/explorer/MemoryExplorer'

/**
 * Memory — the redesigned Explorer. Scope (workspace or one subagent) persists
 * under `sm.memoryTab.scope` inside the Explorer shell.
 */
function MemoryComponent() {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  if (!home) return <EmptyState title="loading…" />
  return <MemoryExplorer cwd={activeTab?.cwd ?? null} />
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const Memory = memo(MemoryComponent)
