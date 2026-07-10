/**
 * Browser-chrome primitives shared by SubTabStrip + AddressBar. Ported from
 * `docs/design/browser-tab.design.jsx` `IconBtn`, swapping SMIcon for
 * AlmanacIcon and inline styles for ALMANAC-token Tailwind classes.
 */
import { AlmanacIcon, type AlmanacIconName } from '../../layout/AlmanacIcon'

export function IconBtn({
  name,
  title,
  onClick,
  active,
  disabled,
  size = 16,
}: {
  name: AlmanacIconName
  title: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  size?: number
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`grid h-8 w-8 place-items-center rounded-lg border ${
        active ? 'border-accent bg-accent-muted/40 text-accent' : 'border-transparent text-fg-dim'
      } ${disabled ? 'cursor-default text-rule' : 'cursor-pointer hover:text-fg'}`}
    >
      <AlmanacIcon name={name} size={size} />
    </button>
  )
}
