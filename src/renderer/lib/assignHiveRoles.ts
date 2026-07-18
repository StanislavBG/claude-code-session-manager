/**
 * assignHiveRoles — pure tab-assignment logic for a Hive launch.
 *
 * A hive role is dispatched via the Orchestrator's per-tab sub-task mechanism
 * (one role per running tab, its resolved prompt written to that tab's PTY),
 * so launching needs at least as many running tabs as the recipe has roles.
 * Extracted out of hive-primitives.tsx's LaunchView so the gating/assignment
 * logic is unit-testable without a DOM.
 */

export interface HiveRolePick {
  tabId: string
  label: string
  presetId: string | null
  prompt: string
}

export type AssignHiveRolesResult =
  | { ok: true; picks: HiveRolePick[] }
  | { ok: false; error: string }

export function assignHiveRolesToRunningTabs(
  roles: { label: string; prompt: string }[],
  runningTabs: { id: string; label: string; presetId: string | null }[],
): AssignHiveRolesResult {
  if (runningTabs.length === 0) {
    return {
      ok: false,
      error: 'Launch needs at least one running tab to dispatch roles to — open a terminal session first.',
    }
  }
  if (runningTabs.length < roles.length) {
    const short = roles.length - runningTabs.length
    return {
      ok: false,
      error: `This recipe has ${roles.length} agents but only ${runningTabs.length} running tab${runningTabs.length !== 1 ? 's are' : ' is'} open. Open ${short} more tab${short !== 1 ? 's' : ''}, or pick a smaller recipe.`,
    }
  }
  const picks = roles.map((role, i) => {
    const tab = runningTabs[i]
    return { tabId: tab.id, label: `${tab.label} · ${role.label}`, presetId: tab.presetId, prompt: role.prompt }
  })
  return { ok: true, picks }
}
