/**
 * ConfigLayout — presentational building blocks shared by every Claude config tab
 * (Home `~/.claude` and Project scopes): a 318px left column (file card, filter +
 * primary action, selectable rows) beside a flexible detail area (eyebrow header,
 * labelled cards, saved line).
 *
 * Design: session-manager-operations/design-mocks/claude-config/ (DESIGN_SPEC.md §2,
 * ConfigWorkbench.dc.html; renders 12/14/15; list column 318px of the 1592px main area).
 * Colors are app tokens only (no raw hex). No data loading here; callers own state.
 */
import type { ReactNode } from 'react'
import { AlmanacIcon } from '../layout/AlmanacIcon'

const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint'

export interface ConfigWorkbenchProps {
  /** Left column content (file card, toolbar, rows). */
  list: ReactNode
  /** Detail area content (header, cards, editor). */
  detail: ReactNode
}

export function ConfigWorkbench({ list, detail }: ConfigWorkbenchProps) {
  return (
    <div data-testid="config-workbench" className="flex flex-1 min-h-0 min-w-0">
      <div
        data-testid="config-workbench-list"
        className="w-[318px] shrink-0 bg-bg-elev border-r border-line px-4 py-[18px] flex flex-col gap-3 overflow-y-auto"
      >
        {list}
      </div>
      <div data-testid="config-workbench-detail" className="flex-1 min-w-0 min-h-0 flex flex-col overflow-y-auto">
        {detail}
      </div>
    </div>
  )
}

export interface ConfigFileCardProps {
  eyebrow: string
  /** Count or short status pill, e.g. `9`. */
  badge?: ReactNode
  path: string
  note?: ReactNode
  children?: ReactNode
}

export function ConfigFileCard({ eyebrow, badge, path, note, children }: ConfigFileCardProps) {
  return (
    <div data-testid="config-file-card" className="px-4 py-3.5 rounded-[14px] bg-bg-hi border border-line flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={`flex-1 min-w-0 truncate ${EYEBROW}`}>{eyebrow}</span>
        {badge !== undefined && (
          <span className="text-[11.5px] font-semibold px-2 py-0.5 rounded-full bg-sage/15 text-sage-dark">{badge}</span>
        )}
      </div>
      <span data-testid="config-file-card-path" className="font-mono text-[12.5px] text-fg break-all">{path}</span>
      {note !== undefined && <span className="text-xs text-fg-faint">{note}</span>}
      {children}
    </div>
  )
}

export interface ConfigListToolbarProps {
  filter: string
  onFilterChange: (value: string) => void
  placeholder: string
  primaryLabel: string
  onPrimary: () => void
  /** Optional extra control rendered between the filter and the primary button. */
  secondary?: ReactNode
}

export function ConfigListToolbar({ filter, onFilterChange, placeholder, primaryLabel, onPrimary, secondary }: ConfigListToolbarProps) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      <label className="flex-1 min-w-0 flex items-center gap-2 h-[38px] px-3 rounded-[10px] bg-bg-hi border border-line text-[13px] text-fg-faint focus-within:border-fg-faint">
        <AlmanacIcon name="search" size={15} className="shrink-0" />
        <input
          type="search"
          aria-label={placeholder}
          placeholder={placeholder}
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          className="flex-1 min-w-0 bg-transparent outline-none text-fg placeholder:text-fg-faint"
        />
      </label>
      {secondary}
      <button
        type="button"
        onClick={onPrimary}
        className="h-[38px] px-4 rounded-[10px] bg-accent text-bg-hi hover:bg-accent/90 text-[13.5px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {primaryLabel}
      </button>
    </div>
  )
}

export interface ConfigListRowProps {
  title: string
  meta?: ReactNode
  /** Right side of the title line — a model name, toggle, status chip. */
  trailing?: ReactNode
  selected: boolean
  /** Dimmed (e.g. disabled plugin). */
  muted?: boolean
  onSelect: () => void
}

export function ConfigListRow({ title, meta, trailing, selected, muted, onSelect }: ConfigListRowProps) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      data-testid="config-list-row"
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={`px-3 py-2.5 rounded-xl border cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        selected ? 'bg-bg-hi border-line shadow-sm' : 'border-transparent hover:bg-bg-hi/60'
      } ${muted ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`flex-1 min-w-0 truncate font-mono text-[13px] text-fg ${selected ? 'font-semibold' : 'font-medium'}`}>
          {title}
        </span>
        {trailing !== undefined && <span className="shrink-0 text-xs text-fg-faint">{trailing}</span>}
      </div>
      {meta !== undefined && <div className="mt-0.5 text-xs text-fg-faint truncate">{meta}</div>}
    </div>
  )
}

export interface ConfigDetailHeaderProps {
  eyebrow: string
  title: string
  pill?: ReactNode
  actions?: ReactNode
}

export function ConfigDetailHeader({ eyebrow, title, pill, actions }: ConfigDetailHeaderProps) {
  return (
    <div data-testid="config-detail-header" className="shrink-0 px-9 pt-6 pb-5 border-b border-line flex items-end gap-3 whitespace-nowrap">
      <div className="flex-1 min-w-0">
        <div className={`truncate ${EYEBROW}`}>{eyebrow}</div>
        <div className="mt-1.5 flex items-center gap-2.5 min-w-0">
          <span className="truncate font-mono text-[27px] font-semibold tracking-[-0.015em] text-fg">{title}</span>
          {pill !== undefined && (
            <span className="shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full bg-sage/15 text-sage-dark">{pill}</span>
          )}
        </div>
      </div>
      {actions !== undefined && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export interface ConfigCardProps {
  label: string
  /** Muted continuation of the label, e.g. `CLAUDE READS THIS TO PICK THE AGENT`. */
  labelNote?: string
  /** Right-aligned control on the label line, e.g. `Reveal`. */
  action?: ReactNode
  children: ReactNode
}

export function ConfigCard({ label, labelNote, action, children }: ConfigCardProps) {
  return (
    <section data-testid="config-card" className="px-[18px] py-3.5 rounded-[14px] bg-bg-hi border border-line">
      <div className="flex items-center gap-2">
        <span className={`flex-1 min-w-0 truncate ${EYEBROW}`}>
          {label}
          {labelNote && <span className="font-medium"> · {labelNote}</span>}
        </span>
        {action}
      </div>
      <div className="mt-1 text-[15px] leading-normal text-fg">{children}</div>
    </section>
  )
}

export function ConfigSavedLine({ text }: { text: string }) {
  return (
    <div data-testid="config-saved-line" role="status" className="flex items-center gap-2 text-[13px] text-fg-dim">
      <span aria-hidden className="w-[7px] h-[7px] rounded-full bg-sage" />
      {text}
    </div>
  )
}
