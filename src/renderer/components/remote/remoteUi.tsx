import type { ReactNode } from 'react'
import { AlmanacIcon, type AlmanacIconName } from '../layout/AlmanacIcon'

/** Shared look of the Settings → Phone remote view and the Remote machines section. */

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-2.5">
      <span className="text-[11.5px] font-bold uppercase tracking-[0.8px] text-fg-faint">{children}</span>
      {right}
    </div>
  )
}

export function PillButton({
  kind = 'soft', icon, children, onClick, disabled, testId,
}: {
  kind?: 'soft' | 'ghost'
  icon?: AlmanacIconName
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors disabled:opacity-50 ${
        kind === 'soft'
          ? 'bg-bg-hi border border-line text-fg hover:bg-bg'
          : 'text-fg-dim hover:text-fg'
      }`}
    >
      {icon && <AlmanacIcon name={icon} size={15} />}
      {children}
    </button>
  )
}

export function RemoteCard({
  icon, title, subtitle, badge, action, testId,
}: {
  icon: AlmanacIconName
  title: ReactNode
  subtitle: ReactNode
  badge?: ReactNode
  action?: ReactNode
  testId?: string
}) {
  return (
    <div data-testid={testId} className="flex items-center gap-3.5 bg-bg-hi border border-line rounded-xl px-[18px] py-3.5">
      <span className="w-[34px] h-[34px] rounded-lg bg-bg border border-line grid place-items-center text-fg-dim shrink-0">
        <AlmanacIcon name={icon} size={17} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5 mb-0.5">
          <span className="text-sm font-semibold text-fg truncate">{title}</span>
          {badge}
        </div>
        <div className="font-mono text-[11.5px] text-fg-faint truncate">{subtitle}</div>
      </div>
      {action}
    </div>
  )
}

export function RevokeButton({
  onClick, disabled, testId, children = 'Revoke',
}: {
  onClick: () => void
  disabled?: boolean
  testId?: string
  children?: ReactNode
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 rounded-lg border border-line bg-bg text-accent px-3.5 py-1.5 text-[12.5px] font-semibold hover:bg-bg-hi disabled:opacity-50 transition-colors"
    >
      {children}
    </button>
  )
}

export function SasBanner({
  code, onConfirm, testId, codeTestId, confirmTestId,
}: {
  code: string
  onConfirm: () => void
  testId?: string
  codeTestId?: string
  confirmTestId?: string
}) {
  return (
    <div data-testid={testId} className="flex items-start gap-3.5 px-5 py-4 rounded-2xl border border-accent/40 bg-accent/[0.06]">
      <span className="w-[38px] h-[38px] rounded-[11px] shrink-0 grid place-items-center bg-bg-hi text-accent">
        <AlmanacIcon name="shield" size={20} />
      </span>
      <div className="flex-1 min-w-0 text-sm text-fg">
        <strong className="font-semibold">Verify E2E session.</strong> Compare this code with the browser — they must match.
        <div data-testid={codeTestId} className="my-2 text-3xl font-mono tracking-[0.3em] text-center text-accent select-all">{code}</div>
        <p className="text-[12.5px] text-fg-faint mb-3">
          If the codes match, confirm below. Mutating commands are blocked until confirmed.
        </p>
        <button
          data-testid={confirmTestId}
          onClick={onConfirm}
          className="rounded-lg bg-accent text-white px-4 py-2 text-[13px] font-semibold hover:opacity-90 transition-opacity"
        >
          Codes match — confirm
        </button>
      </div>
    </div>
  )
}

export function EmptyState({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="bg-bg-hi border border-line rounded-xl p-5 text-center text-[13.5px] text-fg-faint italic font-serif">
      {children}
    </div>
  )
}
