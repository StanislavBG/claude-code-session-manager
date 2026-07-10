/**
 * In-tab browser sub-tab strip — browser tabs live INSIDE the Browser
 * workspace tab, not as top-level LeftNav destinations. Ported from
 * `docs/design/browser-tab.design.jsx` `SubTabStrip`.
 */
import { AlmanacIcon } from '../../layout/AlmanacIcon'
import { useBrowserState, type BrowserTab } from '../../../state/browser'

export function SubTabStrip() {
  const tabs = useBrowserState((s) => s.tabs)
  const activeTabId = useBrowserState((s) => s.activeTabId)
  const setActive = useBrowserState((s) => s.setActive)
  const closeTab = useBrowserState((s) => s.closeTab)
  const openTab = useBrowserState((s) => s.openTab)

  return (
    <div className="flex flex-shrink-0 items-end gap-0.5 border-b border-line bg-bg-elev px-3 pt-1.5">
      {tabs.map((t) => (
        <SubTab
          key={t.id}
          tab={t}
          active={t.id === activeTabId}
          onSelect={() => setActive(t.id)}
          onClose={() => closeTab(t.id)}
        />
      ))}
      <button
        type="button"
        title="New tab"
        onClick={() => openTab()}
        className="px-2.5 py-2 text-fg-faint hover:text-fg-dim"
      >
        <AlmanacIcon name="plus" size={14} />
      </button>
    </div>
  )
}

function SubTab({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: BrowserTab
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  return (
    <div
      onClick={onSelect}
      className={`relative top-px flex max-w-[220px] cursor-pointer items-center gap-2 rounded-t-lg border border-b-0 px-3 pb-[9px] pt-2 ${
        active ? 'border-line bg-bg' : 'border-transparent bg-transparent'
      }`}
    >
      <span
        className="h-[13px] w-[13px] flex-shrink-0 rounded-[3px]"
        style={{ background: tab.color }}
      />
      <span
        className={`overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[12.5px] ${
          active ? 'font-semibold text-fg' : 'font-medium text-fg-dim'
        }`}
      >
        {tab.title}
      </span>
      <button
        type="button"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="inline-flex text-fg-faint opacity-60 hover:opacity-100"
      >
        <AlmanacIcon name="x" size={12} />
      </button>
    </div>
  )
}
