// Light-weight 2D world renderer core: plain functions over a
// CanvasRenderingContext2D. No engine, no image assets, no React. Everything
// is derived from the agent type name; sprites and the ground tile are drawn
// once into cached offscreen canvases and blitted afterwards.

import { hashStr } from './projectColor'

export const MAX_DRAWN_PER_TYPE = 12
export const SPRITE_PX = 8
export const SPRITE_SCALE = 2
export const GROUND_TILE = 16
const ACTOR_STEP = 22
const LABEL_H = 16
const PAD = 6

export interface RosterEntry { agentType: string; count: number }
export interface WorldActor { agentType: string; x: number; y: number; phase: number }
export interface WorldGroup { agentType: string; count: number; x: number; y: number; w: number; h: number }
export interface WorldTheme { ground: string; groundAlt: string; label: string; roomLine?: string }
export interface RoomInput { key: string; label: string; roster: RosterEntry[] }
export interface WorldRoom { key: string; label: string; agents: number; x: number; y: number; w: number; h: number }
export interface SpriteSpec {
  palette: { body: string; accent: string; outline: string }
  /** 8 rows of 8 chars: '.' empty, 'b' body, 'a' accent, 'o' outline. */
  pattern: string[]
}
export interface DrawOpts {
  width: number
  height: number
  timeMs: number
  dpr: number
  theme?: WorldTheme
  cache?: SpriteCache
}

export const DEFAULT_THEME: WorldTheme = { ground: '#5d7a4a', groundAlt: '#557243', label: '#ffffff', roomLine: 'rgba(255, 255, 255, 0.55)' }

export const groupLabel = (agentType: string, count: number): string => `${agentType} ×${count}`

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))

/** `insetTop` reserves a strip at the top (an overlay bar) that no group or actor may enter. */
export function layoutGroups(roster: RosterEntry[], width: number, height: number, insetTop = 0): WorldGroup[] {
  const inset = Math.min(Math.max(0, insetTop), Math.max(0, height))
  const live = roster.filter((r) => r.count > 0)
  if (live.length === 0) return []
  const cols = Math.ceil(Math.sqrt(live.length))
  const rows = Math.ceil(live.length / cols)
  const cw = width / cols
  const ch = (height - inset) / rows
  return live.map((r, i) => ({
    agentType: r.agentType,
    count: r.count,
    x: (i % cols) * cw,
    y: inset + Math.floor(i / cols) * ch,
    w: cw,
    h: ch,
  }))
}

const ROOM_GAP = 8
const ROOM_TITLE_H = 18

export const roomLabel = (label: string, agents: number): string => `${label} · ${agents}`

/** Near-square grid of room boxes below `insetTop`, separated by ROOM_GAP. */
export function layoutRooms(rooms: RoomInput[], width: number, height: number, insetTop = 0): WorldRoom[] {
  if (rooms.length === 0) return []
  const W = Math.max(0, width)
  const H = Math.max(0, height)
  const inset = Math.min(Math.max(0, insetTop), H)
  const cols = Math.ceil(Math.sqrt(rooms.length))
  const rows = Math.ceil(rooms.length / cols)
  const cw = W / cols
  const ch = (H - inset) / rows
  const gx = Math.min(ROOM_GAP, cw / 4)
  const gy = Math.min(ROOM_GAP, ch / 4)
  return rooms.map((r, i) => ({
    key: r.key,
    label: r.label,
    agents: r.roster.reduce((n, e) => n + Math.max(0, e.count), 0),
    x: (i % cols) * cw + gx / 2,
    y: inset + Math.floor(i / cols) * ch + gy / 2,
    w: Math.max(0, cw - gx),
    h: Math.max(0, ch - gy),
  }))
}

/** Places each room's agents (grouped by agentType) inside its box, below the title row. */
export function layoutRoomActors(rooms: WorldRoom[], input: RoomInput[]): WorldActor[] {
  const byKey = new Map(input.map((r) => [r.key, r]))
  const out: WorldActor[] = []
  for (const room of rooms) {
    const src = byKey.get(room.key)
    if (!src) continue
    const title = Math.min(ROOM_TITLE_H, room.h)
    for (const a of layoutWorld(src.roster, room.w, room.h - title)) {
      out.push({
        agentType: a.agentType,
        x: clamp(room.x + a.x, room.x, room.x + room.w),
        y: clamp(room.y + title + a.y, room.y, room.y + room.h),
        phase: a.phase,
      })
    }
  }
  return out
}

/** Group rects for a room's roster, in canvas coordinates (for per-type labels). */
function roomGroups(room: WorldRoom, roster: RosterEntry[] | undefined): WorldGroup[] {
  const title = Math.min(ROOM_TITLE_H, room.h)
  return layoutGroups(roster ?? [], room.w, room.h - title).map((g) => ({ ...g, x: g.x + room.x, y: g.y + room.y + title }))
}

export function layoutWorld(roster: RosterEntry[], width: number, height: number, insetTop = 0): WorldActor[] {
  const out: WorldActor[] = []
  for (const g of layoutGroups(roster, width, height, insetTop)) {
    const n = Math.min(g.count, MAX_DRAWN_PER_TYPE)
    const innerW = Math.max(0, g.w - PAD * 2)
    const perRow = Math.max(1, Math.min(4, Math.floor(innerW / ACTOR_STEP)))
    const used = Math.min(n, perRow)
    const rowW = (used - 1) * ACTOR_STEP
    const startX = g.x + g.w / 2 - rowW / 2
    const startY = g.y + LABEL_H + PAD + (SPRITE_PX * SPRITE_SCALE) / 2
    const seed = hashStr(g.agentType)
    for (let i = 0; i < n; i++) {
      out.push({
        agentType: g.agentType,
        x: clamp(startX + (i % perRow) * ACTOR_STEP, g.x, g.x + g.w),
        y: clamp(startY + Math.floor(i / perRow) * ACTOR_STEP, g.y, g.y + g.h),
        phase: ((seed + i * 977) % 1000) / 1000,
      })
    }
  }
  return out
}

export function spriteSpec(agentType: string): SpriteSpec {
  if (agentType === 'unknown') {
    return {
      palette: { body: 'hsl(0, 0%, 60%)', accent: 'hsl(0, 0%, 75%)', outline: 'hsl(0, 0%, 25%)' },
      pattern: ['..oooo..', '.obbbbo.', '.obaabo.', '.obbbbo.', '..obbo..', '.obbbbo.', '.ob..bo.', '.oo..oo.'],
    }
  }
  const h = hashStr(agentType)
  const hue = h % 360
  const palette = {
    body: `hsl(${hue}, 55%, 55%)`,
    accent: `hsl(${(hue + 150) % 360}, 65%, 70%)`,
    outline: `hsl(${hue}, 45%, 22%)`,
  }
  // Second, differently-seeded hash feeds the pixel pattern (left half, mirrored).
  let bits = hashStr(`${agentType}#shape`) ^ Math.imul(h, 2654435761)
  const pattern: string[] = []
  for (let row = 0; row < SPRITE_PX; row++) {
    let half = ''
    for (let col = 0; col < SPRITE_PX / 2; col++) {
      bits = (Math.imul(bits, 1103515245) + 12345) >>> 0
      const r = (bits >>> 16) & 7
      half += r < 4 ? 'b' : r < 5 ? 'a' : r < 6 ? 'o' : '.'
    }
    pattern.push(half + [...half].reverse().join(''))
  }
  return { palette, pattern }
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas
type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

export interface SpriteCache {
  sprite(agentType: string, dpr: number): AnyCanvas
  ground(theme: WorldTheme, dpr: number): AnyCanvas
}

export function createSpriteCache(): SpriteCache {
  const sprites = new Map<string, AnyCanvas>()
  const grounds = new Map<string, AnyCanvas>()
  return {
    sprite(agentType, dpr) {
      const key = `${agentType}@${dpr}`
      let c = sprites.get(key)
      if (!c) {
        const px = SPRITE_SCALE * dpr
        c = makeCanvas(SPRITE_PX * px, SPRITE_PX * px)
        const g = c.getContext('2d') as AnyCtx | null
        if (g) {
          const spec = spriteSpec(agentType)
          const colors: Record<string, string> = {
            b: spec.palette.body,
            a: spec.palette.accent,
            o: spec.palette.outline,
          }
          spec.pattern.forEach((row, y) => {
            for (let x = 0; x < row.length; x++) {
              const col = colors[row[x]]
              if (!col) continue
              g.fillStyle = col
              g.fillRect(x * px, y * px, px, px)
            }
          })
        }
        sprites.set(key, c)
      }
      return c
    },
    ground(theme, dpr) {
      const key = `${theme.ground}|${theme.groundAlt}@${dpr}`
      let c = grounds.get(key)
      if (!c) {
        const size = GROUND_TILE * dpr
        c = makeCanvas(size * 2, size * 2)
        const g = c.getContext('2d') as AnyCtx | null
        if (g) {
          g.fillStyle = theme.ground
          g.fillRect(0, 0, size * 2, size * 2)
          g.fillStyle = theme.groundAlt
          g.fillRect(0, 0, size, size)
          g.fillRect(size, size, size, size)
        }
        grounds.set(key, c)
      }
      return c
    },
  }
}

const defaultCache = createSpriteCache()

export function drawWorld(
  ctx: CanvasRenderingContext2D,
  actors: WorldActor[],
  groups: WorldGroup[],
  opts: DrawOpts,
  rooms?: WorldRoom[],
  roomInput?: RoomInput[],
): void {
  const { width, height, timeMs, dpr } = opts
  const theme = opts.theme ?? DEFAULT_THEME
  const cache = opts.cache ?? defaultCache
  const tile = cache.ground(theme, dpr)
  const span = GROUND_TILE * 2
  for (let y = 0; y < height; y += span) {
    for (let x = 0; x < width; x += span) {
      ctx.drawImage(tile as CanvasImageSource, x, y, span, span)
    }
  }
  ctx.fillStyle = theme.label
  ctx.textBaseline = 'middle'
  ctx.font = '12px sans-serif'
  if (rooms) {
    const byKey = new Map((roomInput ?? []).map((r) => [r.key, r]))
    for (const r of rooms) {
      ctx.strokeStyle = theme.roomLine ?? DEFAULT_THEME.roomLine ?? theme.label
      ctx.lineWidth = 1
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') ctx.roundRect(r.x, r.y, r.w, r.h, 6)
      else ctx.rect(r.x, r.y, r.w, r.h)
      ctx.stroke()
      ctx.fillStyle = theme.label
      ctx.textAlign = 'left'
      ctx.fillText(roomLabel(r.label, r.agents), r.x + PAD, r.y + ROOM_TITLE_H / 2 + 1)
      ctx.textAlign = 'center'
      if (r.agents === 0) {
        ctx.fillText('idle', r.x + r.w / 2, r.y + r.h / 2)
        continue
      }
      for (const g of roomGroups(r, byKey.get(r.key)?.roster)) {
        ctx.fillText(groupLabel(g.agentType, g.count), g.x + g.w / 2, g.y + LABEL_H / 2 + 2)
      }
    }
    const size = SPRITE_PX * SPRITE_SCALE
    for (const a of actors) {
      const bob = Math.round(Math.sin(timeMs / 400 + a.phase * Math.PI * 2))
      ctx.drawImage(cache.sprite(a.agentType, dpr) as CanvasImageSource, Math.round(a.x - size / 2), Math.round(a.y - size / 2 + bob), size, size)
    }
    return
  }
  if (actors.length === 0 && groups.length === 0) {
    ctx.textAlign = 'center'
    ctx.fillText('No one is out adventuring', width / 2, height / 2)
    return
  }
  const size = SPRITE_PX * SPRITE_SCALE
  for (const a of actors) {
    const bob = Math.round(Math.sin(timeMs / 400 + a.phase * Math.PI * 2))
    ctx.drawImage(cache.sprite(a.agentType, dpr) as CanvasImageSource, Math.round(a.x - size / 2), Math.round(a.y - size / 2 + bob), size, size)
  }
  ctx.textAlign = 'center'
  ctx.fillStyle = theme.label
  for (const g of groups) {
    ctx.fillText(groupLabel(g.agentType, g.count), g.x + g.w / 2, g.y + LABEL_H / 2 + 2)
  }
}
