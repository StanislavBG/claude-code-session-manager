/**
 * Scroll ONLY `container` so `target` comes into view inside it.
 *
 * WHY `Element.scrollIntoView` is banned in the renderer: it scrolls EVERY
 * scrollable ancestor of the target until the target is in the viewport —
 * including the app's outer layout frames, many of which are
 * `overflow: hidden`. Those frames can be scrolled programmatically but the
 * user has no scrollbar or wheel path to scroll them back, so a sub-menu
 * "jump to section" drags the whole page frame out of place and leaves it
 * stuck there. This helper computes the offset within one container and calls
 * `container.scrollBy` — nothing above `container` ever moves.
 *
 * - `block: 'start'` (default): target's top lands at the container's top,
 *   minus `offset` px (e.g. room for a sticky header).
 * - `block: 'nearest'`: scrolls only if the target sticks out above or below
 *   the container's visible box, by the minimal delta; no-op when visible.
 * - Horizontal scroll is never changed.
 * - No-op when `target` is not a descendant of `container`.
 */
export function scrollWithin(
  container: HTMLElement,
  target: HTMLElement,
  opts?: { block?: 'start' | 'nearest'; behavior?: ScrollBehavior; offset?: number },
): void {
  if (target === container || !container.contains(target)) return
  const block = opts?.block ?? 'start'
  const behavior: ScrollBehavior = opts?.behavior ?? 'auto'
  const offset = opts?.offset ?? 0
  const c = container.getBoundingClientRect()
  const t = target.getBoundingClientRect()

  let delta: number
  if (block === 'start') {
    delta = t.top - c.top - offset
  } else {
    const visibleTop = c.top + offset
    if (t.top < visibleTop) {
      delta = t.top - visibleTop
    } else if (t.bottom > c.bottom) {
      // Minimal delta to reveal the bottom, but never push the target's top
      // above the visible box (target taller than the container).
      delta = Math.min(t.bottom - c.bottom, t.top - visibleTop)
    } else {
      return
    }
  }
  if (delta === 0) return
  container.scrollBy({ top: delta, behavior })
}
