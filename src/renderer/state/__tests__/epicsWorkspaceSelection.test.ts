/**
 * Locks the invariant the user stated: ONE top-tab selection is always
 * mandatory, and navigating the left-nav must never drop it.
 *
 * "Show the Epics workspace" used to be encoded as `activeTabId === null`, so
 * navigating to Epics deselected the active tab. Display intent now lives in
 * its own layout flag, and nothing in the nav path writes activeTabId.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useLayout } from '../layout'
import { useSessions } from '../sessions'

function makeTab(id: string, cwd: string) {
  return {
    id,
    sessionId: id,
    label: cwd.split('/').pop() ?? cwd,
    cwd,
    pid: null,
    status: 'dormant' as const,
    exitCode: null,
    startupCommand: null,
    presetId: 'sm-dangerous',
    generation: 0,
  }
}

// Mirrors App.tsx's navigate(): display intent only, never a selection write.
function navigate(k: string) {
  useLayout.getState().setEpicsWorkspaceOpen(k === 'terminal')
  useLayout.getState().openPanel(k)
}

describe('left-nav navigation never drops the top-tab selection', () => {
  beforeEach(() => {
    useSessions.setState({
      tabs: [makeTab('tab-a', '/home/u/Projects/alpha')],
      activeTabId: 'tab-a',
    })
    useLayout.getState().setEpicsWorkspaceOpen(false)
  })

  it('keeps the selection when navigating to Epics', () => {
    navigate('terminal')
    expect(useSessions.getState().activeTabId).toBe('tab-a')
    expect(useLayout.getState().epicsWorkspaceOpen).toBe(true)
  })

  it('keeps the selection across a full sweep of nav destinations', () => {
    for (const k of ['terminal', 'scheduler', 'history', 'settings', 'memory', 'terminal', 'overview']) {
      navigate(k)
      expect(useSessions.getState().activeTabId).toBe('tab-a')
    }
  })

  it('closes the workspace when navigating anywhere other than Epics', () => {
    navigate('terminal')
    expect(useLayout.getState().epicsWorkspaceOpen).toBe(true)
    navigate('scheduler')
    expect(useLayout.getState().epicsWorkspaceOpen).toBe(false)
    expect(useSessions.getState().activeTabId).toBe('tab-a')
  })

  it('selecting a tab lifts the workspace overlay without clearing selection', () => {
    navigate('terminal')
    // What TabBar's onActivate does.
    useSessions.getState().setActive('tab-a')
    useLayout.getState().setEpicsWorkspaceOpen(false)
    expect(useSessions.getState().activeTabId).toBe('tab-a')
    expect(useLayout.getState().epicsWorkspaceOpen).toBe(false)
  })
})
