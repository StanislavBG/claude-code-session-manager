/**
 * Contextual side-panel scaffolding shared by Capture/Recorder/Observe
 * panels (403/407/409/411). Ported from `docs/design/browser-tab.design.jsx`
 * `PanelShell` + `SectionLabel` — single source of truth so later PRDs don't
 * re-implement the shell per panel.
 */
import type { ReactNode } from 'react'
import { AlmanacIcon, type AlmanacIconName } from '../../layout/AlmanacIcon'

export function PanelShell({
  title,
  icon,
  onClose,
  children,
  foot,
}: {
  title: string
  icon: AlmanacIconName
  onClose: () => void
  children: ReactNode
  foot?: ReactNode
}) {
  return (
    <aside
      data-testid="browser-panel"
      className="flex w-[344px] flex-shrink-0 flex-col border-l border-line bg-bg-elev font-sans"
    >
      <div className="flex items-center gap-2.5 border-b border-rule px-4 py-3.5">
        <span className="inline-flex text-accent">
          <AlmanacIcon name={icon} size={16} />
        </span>
        <span className="font-serif text-base font-semibold text-fg">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex text-fg-faint hover:text-fg"
        >
          <AlmanacIcon name="x" size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-4 py-3.5">{children}</div>
      {foot && <div className="border-t border-rule px-4 py-3">{foot}</div>}
    </aside>
  )
}

export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mb-2 text-[10.5px] font-bold uppercase tracking-wide text-fg-faint ${className}`}>
      {children}
    </div>
  )
}
