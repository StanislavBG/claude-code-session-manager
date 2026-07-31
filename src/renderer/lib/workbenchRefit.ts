/**
 * Fired on window whenever dockview reports a geometry change for a live
 * terminal panel, or the RecordingStatus banner's layout shift resizes the
 * workbench — either can change a terminal's pixel size without the browser
 * window itself resizing. Terminal.tsx listens for it to refit; Workbench.tsx
 * dispatches it.
 */
export const WORKBENCH_REFIT_EVENT = 'sm:workbench-refit'
