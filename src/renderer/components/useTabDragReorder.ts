import { useRef, useState, useEffect, useCallback } from 'react'

interface UseTabDragReorderOpts {
  tabCount: number
  onReorder: (fromIndex: number, toIndex: number) => void
  onActivate: (index: number) => void
}

interface UseTabDragReorderReturn {
  getTabDragProps: (index: number) => {
    onPointerDown: (e: React.PointerEvent) => void
    style: React.CSSProperties
    'data-drag-index': number
  }
  isDragging: boolean
  containerRef: React.RefObject<HTMLDivElement>
}

interface DragState {
  active: boolean
  fromIndex: number
  currentIndex: number
  startX: number
  deltaX: number
  tabRects: DOMRect[]
  pointerId: number
}

const DEAD_ZONE = 4
const EDGE_SCROLL_ZONE = 40
const EDGE_SCROLL_SPEED = 6

export function useTabDragReorder(opts: UseTabDragReorderOpts): UseTabDragReorderReturn {
  const { tabCount, onReorder, onActivate } = opts
  const containerRef = useRef<HTMLDivElement>(null!)
  const dragRef = useRef<DragState | null>(null)
  const scrollRafRef = useRef<number>(0)
  const renderRafRef = useRef<number>(0)

  const [isDragging, setIsDragging] = useState(false)
  const [, setTick] = useState(0)

  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate

  const getTabElements = useCallback((): HTMLElement[] => {
    if (!containerRef.current) return []
    return Array.from(
      containerRef.current.querySelectorAll<HTMLElement>('[data-drag-index]'),
    )
  }, [])

  const computeDropIndex = useCallback(
    (draggedCenterX: number, rects: DOMRect[], fromIndex: number): number => {
      // O(n) scan over tab midpoints
      for (let i = 0; i < rects.length; i++) {
        const mid = rects[i].left + rects[i].width / 2
        if (draggedCenterX < mid) {
          return i <= fromIndex ? i : i - 1
        }
      }
      return rects.length - 1
    },
    [],
  )

  const edgeScroll = useCallback(() => {
    const d = dragRef.current
    const container = containerRef.current
    if (!d?.active || !container) return

    const rect = container.getBoundingClientRect()
    const pointerX = d.startX + d.deltaX
    const distLeft = pointerX - rect.left
    const distRight = rect.right - pointerX

    if (distLeft < EDGE_SCROLL_ZONE) {
      container.scrollLeft -= EDGE_SCROLL_SPEED
    } else if (distRight < EDGE_SCROLL_ZONE) {
      container.scrollLeft += EDGE_SCROLL_SPEED
    }

    scrollRafRef.current = requestAnimationFrame(edgeScroll)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let renderPending = false

    const scheduleRender = () => {
      if (renderPending) return
      renderPending = true
      renderRafRef.current = requestAnimationFrame(() => {
        renderPending = false
        setTick((n) => n + 1)
      })
    }

    const onPointerMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return

      const deltaX = e.clientX - d.startX

      if (!d.active && Math.abs(deltaX) < DEAD_ZONE) return

      if (!d.active) {
        d.active = true
        d.tabRects = getTabElements().map((el) => el.getBoundingClientRect())
        setIsDragging(true)
        try {
          containerRef.current?.setPointerCapture(d.pointerId)
        } catch {
          // pointer may have already gone
        }
        scrollRafRef.current = requestAnimationFrame(edgeScroll)
      }

      d.deltaX = deltaX

      const draggedRect = d.tabRects[d.fromIndex]
      const draggedCenterX = draggedRect.left + draggedRect.width / 2 + deltaX
      d.currentIndex = computeDropIndex(draggedCenterX, d.tabRects, d.fromIndex)

      scheduleRender()
    }

    const onPointerUp = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      if (d.pointerId !== e.pointerId) return

      cancelAnimationFrame(scrollRafRef.current)
      cancelAnimationFrame(renderRafRef.current)
      try {
        container.releasePointerCapture(d.pointerId)
      } catch {
        // already released
      }

      if (d.active) {
        if (d.fromIndex !== d.currentIndex) {
          onReorder(d.fromIndex, d.currentIndex)
        } else {
          // Drag activated from minor pointer drift but tab didn't move —
          // treat as a click so tabs still activate when the hand is unsteady.
          onActivateRef.current(d.fromIndex)
        }
      } else {
        // Pure click — no pointer movement past the dead zone.
        onActivateRef.current(d.fromIndex)
      }

      dragRef.current = null
      setIsDragging(false)
      setTick((n) => n + 1)
    }

    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerup', onPointerUp)
    container.addEventListener('pointercancel', onPointerUp)

    return () => {
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('pointercancel', onPointerUp)
      cancelAnimationFrame(scrollRafRef.current)
      cancelAnimationFrame(renderRafRef.current)
    }
  }, [onReorder, getTabElements, computeDropIndex, edgeScroll])

  const onPointerDown = useCallback(
    (e: React.PointerEvent, index: number) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('button')) return

      dragRef.current = {
        active: false,
        fromIndex: index,
        currentIndex: index,
        startX: e.clientX,
        deltaX: 0,
        tabRects: [],
        pointerId: e.pointerId,
      }
    },
    [],
  )

  const getTabDragProps = useCallback(
    (index: number) => {
      const d = dragRef.current
      const style: React.CSSProperties = {}

      if (d?.active) {
        if (index === d.fromIndex) {
          style.transform = `translateX(${d.deltaX}px) scale(1.03)`
          style.zIndex = 10
          style.opacity = 0.85
          style.boxShadow = '0 2px 8px rgba(0,0,0,0.4)'
          style.position = 'relative'
          style.pointerEvents = 'none'
        } else {
          const from = d.fromIndex
          const to = d.currentIndex
          const tabWidth = d.tabRects[from]?.width ?? 0
          const shift = tabWidth + 4

          style.transition = 'transform 0.15s ease'
          if (from < to && index > from && index <= to) {
            style.transform = `translateX(-${shift}px)`
          } else if (from > to && index >= to && index < from) {
            style.transform = `translateX(${shift}px)`
          } else {
            style.transform = 'translateX(0)'
          }
        }
      }

      return {
        onPointerDown: (e: React.PointerEvent) => onPointerDown(e, index),
        style,
        'data-drag-index': index,
      }
    },
    [onPointerDown],
  )

  return { getTabDragProps, isDragging, containerRef }
}
