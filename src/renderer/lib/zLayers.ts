/**
 * zLayers.ts — the single source of truth for the app's overlay stacking order.
 *
 * Session Manager is deliberately a ONE-LAYER app: almost everything is a full
 * page in the panel registry, and the handful of things that float above it are
 * enumerated here. That list is short enough to reason about globally, and this
 * module is what keeps it that way — the ordering is identical on every
 * platform because it is pure CSS with no `process.platform` / `navigator`
 * branch anywhere in the chain (Electron's BrowserWindow is created with the
 * native frame on both macOS and Linux; there is no titleBarStyle, no
 * frame:false, no vibrancy, and no per-OS chrome).
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * The ladder had drifted into four disconnected islands — the 50s, the 200s,
 * the 300s and the 400s — invented independently by the Editor, the FileTree
 * and the Tour. Two documented invariants were factually false as a result:
 *
 *   • RecordingStatus sat in the 60s with a comment claiming it "paints over
 *     any overlay" — but the Editor's dialogs were in the 400s, so the red
 *     privacy banner was HIDDEN behind a Save-As dialog while the mic was
 *     live. CLAUDE.md calls that banner a privacy invariant.
 *   • Toast sat in the 50s with a comment claiming it clears dialogs — but any
 *     error raised from an Editor dialog or a FileTree context menu rendered
 *     underneath it, silently. CLAUDE.md calls Toast the user-facing error
 *     channel.
 *
 * (Those historical values are spelled out in prose rather than as class
 * literals on purpose: Tailwind scans this file, and writing them in bracket
 * syntax would emit dead utilities for rungs that no longer exist.)
 *
 * Both are fixed by the ordering below, and `zLayers.test.ts` fails the build
 * if a raw z-index literal is reintroduced outside this file.
 *
 * ── Values are CLASS STRINGS, not numbers ─────────────────────────────────
 * Tailwind's JIT scans source text for candidate class names, so `z-[900]` has
 * to appear as a literal somewhere it scans (tailwind.config content includes
 * `src/renderer/**\/*.ts`, i.e. this file). A computed ``z-[${n}]`` would
 * produce no CSS at all and the element would silently fall back to `auto` —
 * exactly the class of bug this module exists to prevent. Never interpolate.
 *
 * ── Scope ─────────────────────────────────────────────────────────────────
 * Only the GLOBAL overlay stack belongs here. Local `z-10`/`z-20` used inside
 * a pane (sticky list headers, the active tab's border overlap, terminal
 * corner buttons) are relative to their own stacking context, never race with
 * these, and are deliberately left alone.
 */

export const Z = {
  /** Modal dialogs, the command palette, tooltips, dropdown menus, and other
   *  ordinary "on top of the page" surfaces. The default for anything new. */
  dialog: 'z-50',

  /** Guided-tour spotlight. Above dialogs because it may point AT one. */
  tour: 'z-[500]',

  /** Right-click context menus. Above dialogs (and the tour) because a menu
   *  is opened FROM whatever is already on screen and must clear it. */
  contextMenu: 'z-[600]',

  /** The invisible click-catcher a context menu lays down to detect
   *  click-outside. Must sit directly BELOW its own menu and above everything
   *  the menu covers. */
  contextMenuScrim: 'z-[590]',

  /** A dialog opened from a context menu (rename, delete-confirm, Save As).
   *  Above the menu that launched it. */
  contextMenuDialog: 'z-[700]',

  /** Toasts — the user-facing error channel (CLAUDE.md). Must clear every
   *  surface above, or an error raised from a dialog is invisible. */
  toast: 'z-[900]',

  /** The recording banner — privacy invariant (CLAUDE.md). Nothing may ever
   *  paint over it, so it is the last rung and must stay the highest value in
   *  this table. */
  recording: 'z-[1000]',
} as const

export type ZLayer = keyof typeof Z

/** Numeric value behind each rung — for tests and for the rare inline style
 *  (e.g. a popover positioned with a computed `style` object) that cannot use
 *  a class. Kept next to the class strings so the two can't drift. */
export const Z_VALUE: Record<ZLayer, number> = {
  dialog: 50,
  tour: 500,
  contextMenuScrim: 590,
  contextMenu: 600,
  contextMenuDialog: 700,
  toast: 900,
  recording: 1000,
}
