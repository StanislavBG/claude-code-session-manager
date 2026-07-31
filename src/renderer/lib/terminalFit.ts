/**
 * Guards xterm's FitAddon.fit() against zero-size containers — a panel
 * mid-drag, a collapsed dockview group, or a minimized window all report
 * 0x0 briefly, and calling fit() then throws inside xterm's internal
 * dimension math.
 */
export function canFit(width: number, height: number): boolean {
  return width > 0 && height > 0
}
