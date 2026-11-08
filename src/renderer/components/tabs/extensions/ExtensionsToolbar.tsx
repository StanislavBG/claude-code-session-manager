/**
 * ExtensionsToolbar — the toolbar band shared by Home ▸ Extensions' three tabs
 * (Skills, MCP Servers, Plugins) in the 3a design. Spec:
 * `session-manager-operations/design-mocks/extensions-3a/DESIGN_SPEC.md` §2.
 *
 * Left to right: a real filter field, a counts summary, any secondary controls
 * the tab passes as `children` (MCP's outlined `Check all`), then exactly ONE
 * right-aligned accent primary whose chevron opens a menu.
 *
 * The primary always opens its menu — even with a single item — so its label
 * stays the generic verb (`+ New`, `+ Add server`, `+ Add plugin`) and the
 * concrete flows are the menu items.
 *
 * The menu is anchored to the band (`relative`), not to a wrapper, so the
 * primary itself stays a direct flex child carrying `ml-auto`; the anchor
 * offsets mirror the prototype (6px under a 28px trigger centered in the 44px
 * band, flush with the band's 12px right padding).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Z } from '../../../lib/zLayers'

export interface ExtensionsToolbarMenuItem {
  label: string
  testId: string
  onSelect: () => void
}

export interface ExtensionsToolbarProps {
  filter: string
  onFilterChange: (value: string) => void
  placeholder: string
  summary: ReactNode
  children?: ReactNode
  primary: {
    label: string
    testId: string
    items: ReadonlyArray<ExtensionsToolbarMenuItem>
  }
}

export function ExtensionsToolbar({
  filter,
  onFilterChange,
  placeholder,
  summary,
  children,
  primary,
}: ExtensionsToolbarProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Close on Escape or a mousedown outside both the trigger and the menu. The
  // trigger is excluded so its own click can toggle the menu shut; the menu is
  // excluded so the click that follows a mousedown on an item still lands.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div
      data-testid="extensions-toolbar"
      className="relative shrink-0 h-11 flex items-center gap-3 px-3 bg-bg-elev border-b border-line text-xs"
    >
      <div className="relative shrink-0">
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute left-[9px] top-1/2 -translate-y-1/2 text-fg-faint/80"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="text"
          data-testid="extensions-toolbar-filter"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck={false}
          className="w-[276px] h-7 pl-[29px] pr-[9px] bg-bg-hi border border-line rounded-md text-xs text-fg placeholder:text-fg-faint/80 focus:outline-none focus:border-fg-faint"
        />
      </div>

      <span data-testid="extensions-toolbar-summary" className="min-w-0 truncate text-fg-faint">
        {summary}
      </span>

      {children}

      <button
        ref={triggerRef}
        type="button"
        data-testid={primary.testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="ml-auto shrink-0 h-7 inline-flex items-center gap-1.5 pl-3 pr-2.5 rounded-md bg-accent text-bg-hi text-[12.5px] font-semibold shadow-sm hover:bg-accent/90"
      >
        {primary.label}
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={primary.label}
          data-testid={`${primary.testId}-menu`}
          className={`absolute ${Z.dialog} right-3 top-[42px] min-w-[210px] p-[5px] flex flex-col bg-bg-hi border border-line rounded-lg shadow-lg text-[12.5px] text-fg`}
        >
          {primary.items.map((item) => (
            <button
              key={item.testId}
              type="button"
              role="menuitem"
              data-testid={item.testId}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className="px-2.5 py-[7px] rounded-[5px] text-left whitespace-nowrap hover:bg-bg-elev"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
