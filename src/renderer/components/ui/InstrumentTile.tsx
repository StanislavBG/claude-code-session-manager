import type { NavKey } from '../LeftNav'
import { StatusDot } from './StatusDot'

interface Props {
  label: string
  value: string | number
  subFact?: string
  linkTo?: NavKey
  attention?: boolean
  onNavigate?: (k: NavKey) => void
}

export function InstrumentTile({ label, value, subFact, linkTo, attention, onNavigate }: Props) {
  const canNavigate = !!(linkTo && onNavigate)
  const handleClick = canNavigate ? () => onNavigate!(linkTo!) : undefined
  const titleAttr = canNavigate ? `open ${label}` : 'opens in N/A — wire MainPane.tsx'
  const Component = canNavigate ? 'button' : 'div'

  return (
    <Component
      type={canNavigate ? 'button' : undefined}
      onClick={handleClick}
      title={titleAttr}
      className={`text-left border border-line rounded p-3 bg-bg-elev w-full block ${
        canNavigate ? 'hover:border-fg-faint hover:bg-bg-hi transition-colors cursor-pointer' : 'cursor-default'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] text-fg-faint uppercase tracking-wider">{label}</div>
        {attention && <StatusDot kind="warn" title="needs attention" />}
      </div>
      <div className="text-xl font-mono text-fg tabular-nums leading-none">{value}</div>
      {subFact && <div className="text-[10px] text-fg-faint mt-1.5 truncate">{subFact}</div>}
    </Component>
  )
}
