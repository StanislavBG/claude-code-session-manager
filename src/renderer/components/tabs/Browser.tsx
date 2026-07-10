/**
 * Browser — embedded dev browser tab (foundation stub).
 *
 * Draws its own chrome (no SectionFrame). Sub-tabs, address bar, webview
 * embed, and action bar arrive in later PRDs (399–413); this scaffold only
 * establishes the full-height Almanac-paper page shell.
 */
export function Browser() {
  return (
    <div className="h-full flex flex-col min-h-0 bg-bg">
      <div className="flex-1 flex items-center justify-center">
        <p className="font-serif text-[15px] text-fg-faint">
          Browser — embedded dev browser (foundation)
        </p>
      </div>
    </div>
  )
}
