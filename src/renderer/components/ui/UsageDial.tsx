import type { UsageWindow } from '../../../preload/api'

interface Props {
  label: string
  window: UsageWindow | null
}

function arcColor(util: number): string {
  if (util >= 90) return '#f87171'
  if (util >= 70) return '#facc15'
  return '#34d399'
}

function formatResetsIn(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return '—'
  const diffMs = t.getTime() - Date.now()
  if (diffMs <= 0) return 'now'
  const h = Math.floor(diffMs / 3_600_000)
  const m = Math.floor((diffMs % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

const W = 200
const H = 108
const CX = W / 2
const CY = H - 6
const R = 88
const STROKE = 10

// Arc spans 180° from the left (angle π) to the right (angle 0).
function pointOnArc(angleRad: number): { x: number; y: number } {
  return {
    x: CX + R * Math.cos(angleRad),
    y: CY - R * Math.sin(angleRad),
  }
}

function arcPath(fromAngle: number, toAngle: number): string {
  const start = pointOnArc(fromAngle)
  const end = pointOnArc(toAngle)
  const largeArc = Math.abs(toAngle - fromAngle) > Math.PI ? 1 : 0
  // Sweep flag 0 to draw clockwise in SVG's y-flipped coordinate system,
  // matching the visual left-to-right fill.
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${R} ${R} 0 ${largeArc} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
}

export function UsageDial({ label, window: w }: Props) {
  if (!w) return null
  const pct = Math.max(0, Math.min(100, w.utilization))
  // Map 0%..100% onto angle π..0 (left to right along the top half).
  const filledAngle = Math.PI - (pct / 100) * Math.PI
  const fullPath = arcPath(Math.PI, 0)
  const filledPath = arcPath(Math.PI, filledAngle)
  const needle = pointOnArc(filledAngle)
  const color = arcColor(pct)

  return (
    <div className="border border-line rounded p-3 bg-bg-elev flex items-center gap-4">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="shrink-0"
        role="img"
        aria-label={`${label} ${pct.toFixed(0)} percent`}
      >
        <path
          d={fullPath}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth={STROKE}
          strokeLinecap="round"
          className="text-fg"
        />
        <path
          d={filledPath}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
          style={{ transition: 'd 600ms ease-out' }}
        />
        <line
          x1={CX}
          y1={CY}
          x2={needle.x}
          y2={needle.y}
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          style={{ transition: 'x2 600ms ease-out, y2 600ms ease-out' }}
        />
        <circle cx={CX} cy={CY} r="4" fill={color} />
        <text
          x={CX}
          y={CY - 30}
          textAnchor="middle"
          className="fill-current text-fg font-mono"
          style={{ fontSize: '22px' }}
        >
          {pct.toFixed(0)}%
        </text>
      </svg>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-fg-faint uppercase tracking-wider">{label}</div>
        <div className="text-xs text-fg-dim mt-1">resets in {formatResetsIn(w.resets_at)}</div>
      </div>
    </div>
  )
}
