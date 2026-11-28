import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePanelFocus } from '../../../lib/panelFocus'
import { useDocumentVisible } from '../../../lib/useDocumentVisible'
import type { GuildRoom } from '../../../lib/guildRooms'
import {
  DEFAULT_THEME,
  createSpriteCache,
  drawWorld,
  layoutRoomActors,
  layoutRooms,
  type RoomInput,
  type WorldTheme,
} from '../../../lib/worldScene'

const FRAME_MS = 1000 / 12

function readTheme(el: HTMLElement | null): WorldTheme {
  if (!el || typeof getComputedStyle !== 'function') return DEFAULT_THEME
  const cs = getComputedStyle(el)
  const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    ground: pick('--world-ground', DEFAULT_THEME.ground),
    groundAlt: pick('--world-ground-alt', DEFAULT_THEME.groundAlt),
    label: pick('--world-label', DEFAULT_THEME.label),
    roomLine: pick('--world-room-line', DEFAULT_THEME.roomLine ?? DEFAULT_THEME.label),
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

export function WorldView({ rooms, insetTop = 0 }: { rooms: GuildRoom[]; insetTop?: number }) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cacheRef = useRef<ReturnType<typeof createSpriteCache> | null>(null)
  if (cacheRef.current === null) cacheRef.current = createSpriteCache()
  const themeRef = useRef<WorldTheme>(DEFAULT_THEME)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [themeTick, setThemeTick] = useState(0)
  const focused = usePanelFocus('overview')
  const visible = useDocumentVisible()
  const [reduced, setReduced] = useState(prefersReducedMotion)

  const roomInput = useMemo<RoomInput[]>(
    () => rooms.map((r, i) => ({ key: r.cwd ?? `other:${i}`, label: r.label, roster: r.roster })),
    [rooms],
  )
  const boxes = useMemo(() => layoutRooms(roomInput, size.w, size.h, insetTop), [roomInput, size.w, size.h, insetTop])
  const actors = useMemo(() => layoutRoomActors(boxes, roomInput), [boxes, roomInput])
  const hasAgent = rooms.some((r) => r.roster.length > 0)
  const animate = focused && visible && hasAgent && !reduced

  const draw = useCallback(
    (timeMs: number) => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx || size.w === 0 || size.h === 0) return
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawWorld(ctx, actors, [], {
        width: size.w,
        height: size.h,
        timeMs,
        dpr,
        theme: themeRef.current,
        cache: cacheRef.current ?? undefined,
      }, boxes.length > 0 ? boxes : undefined, roomInput)
    },
    [actors, boxes, roomInput, size.w, size.h],
  )

  // Reduced-motion preference.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  // Theme colours: read once, re-read when <html> class changes.
  useEffect(() => {
    themeRef.current = readTheme(wrapRef.current)
    if (typeof MutationObserver === 'undefined') return
    const mo = new MutationObserver(() => {
      themeRef.current = readTheme(wrapRef.current)
      setThemeTick((t) => t + 1)
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])

  // Resize the backing store; one redraw per resize via size state.
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }))
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // Animation loop (<= 12 fps) or one static frame.
  useEffect(() => {
    if (!animate) {
      draw(0)
      return
    }
    let raf = 0
    let last = -Infinity
    const tick = (now: number) => {
      if (now - last >= FRAME_MS) {
        last = now
        draw(now)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [animate, draw, themeTick])

  return (
    <div ref={wrapRef} className="h-full w-full">
      <canvas ref={canvasRef} data-testid="world-canvas" data-inset-top={insetTop} data-room-count={rooms.length} className="block h-full w-full" />
    </div>
  )
}
