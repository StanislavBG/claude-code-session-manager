/**
 * First-run guided tour content.
 *
 * Kept in a JSX-free module (not inside TourOverlay.tsx) so tests — unit AND
 * Playwright — can import the step list without pulling React in. The overlay
 * re-exports `TOUR_STEPS` for the components that already imported it there.
 *
 * The copy here is the app's ONLY narrated explanation of its own domain
 * model, so it must track CLAUDE.md's TAB → operations-root → SESSION (Epic)
 * → PRD hierarchy. When a step's sentence stops being true — a tab stops
 * being a project, sessions stop being minted from the sidebar, the footer
 * stops carrying a weekly pill — that step is a bug, not stale flavour text.
 *
 * Targets are `data-testid` selectors. A step whose target is absent at the
 * moment it runs degrades to a centred, spotlight-less tooltip (TourOverlay
 * handles this) — deliberate for the PROJECT-face-only rows, since the tour
 * auto-opens on a fresh install where no project tab exists yet.
 */

export type TourPosition = 'center' | 'top' | 'bottom' | 'left' | 'right'

export interface TourStep {
  id: string
  title: string
  body: string
  /** CSS selector — typically `[data-testid="…"]`. Omit for centered intro. */
  target?: string
  position: TourPosition
  /**
   * True when `target` only renders on the PROJECT nav face, i.e. after a
   * project tab is open. On the first-run pass (Home face, no tabs) these
   * steps intentionally render centered. Consumed by tests so a genuinely
   * missing testid is still a failure while this fallback is not.
   */
  projectFaceOnly?: boolean
}

/**
 * Ordered tour steps. Each step's `target` MUST exist somewhere in the
 * renderer (guarded by `lib/__tests__/tourSteps.test.ts`) OR the step must
 * declare `position: 'center'` and omit `target`.
 */
export const TOUR_STEPS: ReadonlyArray<TourStep> = [
  {
    id: 'welcome',
    title: 'Welcome to Session Manager',
    body: 'A 60-second tour of how this app is laid out: projects at the top, sessions inside them, PRDs underneath. Re-run it any time from ⌘K / Ctrl+K → "Restart guided tour".',
    position: 'center',
  },
  {
    id: 'tabs',
    title: 'Home, and one tab per project',
    body: 'The top bar is navigation only. The Home pill is this machine — every project, usage, history. Each tab after it is one open project, identified by its folder. Drag to reorder.',
    target: '[data-testid="tour-tabbar"]',
    position: 'bottom',
  },
  {
    id: 'leftnav',
    title: 'The sidebar follows the tab',
    body: 'On Home it shows machine-wide screens — Dashboard, History, Settings, Skills, Agent Library, Tag Library. On a project tab it swaps to that project: Project Home, Sessions, Scheduler, Memory.',
    target: '[data-testid="tour-leftnav"]',
    position: 'right',
  },
  {
    id: 'new-session',
    title: 'Open / Start Project',
    body: 'Pick a folder and it becomes a project — that path is its identity. Picking one that is already open just activates its tab: extra work inside a project is more sessions, never more tabs.',
    target: '[data-testid="tour-new-session"]',
    position: 'right',
  },
  {
    id: 'sessions',
    title: 'Sessions are the unit of work',
    body: 'One session = one small goal, and one Claude session behind it. Pick an Agent (who is working) and a Mission (what it is for), write the goal, then press Approve & start — nothing is spent before that. Chat and Terminal are two views of the same session, not two sessions.',
    target: '[data-testid="tour-sessions"]',
    position: 'right',
    projectFaceOnly: true,
  },
  {
    id: 'scheduler',
    title: 'Scheduler runs what your sessions wrote',
    body: 'A session decomposes its goal into numbered PRD files under the project\'s session-manager-operations/scheduler/. The Scheduler queues each as a claude -p job, pauses on rate-limit and resumes at your next window reset. It is per-project — there is no machine-wide queue view.',
    target: '[data-testid="tour-scheduler"]',
    position: 'right',
    projectFaceOnly: true,
  },
  {
    id: 'voice',
    title: 'Push-to-talk dictation',
    body: 'Hold Ctrl+Shift+Space (Cmd+Option+V on macOS) to dictate, or click the mic. The hotkey, mode and input device live in Voice on the Home sidebar.',
    target: '[data-testid="mic-button"]',
    position: 'right',
  },
  {
    id: 'mainpane-actions',
    title: 'Command palette',
    body: 'Press ⌘K / Ctrl+K to jump to any screen, restart a session, broadcast a prompt to every tab, attach a watcher command, or force a scheduler tick.',
    position: 'center',
  },
  {
    id: 'statusbar',
    title: 'Status bar',
    body: 'Connection, your session (5h) and weekly (7d) usage, the active project and its branch, live to-dos, and the app version. Click either usage pill for the full meters on Home.',
    target: '[data-testid="tour-statusbar"]',
    position: 'top',
  },
]
