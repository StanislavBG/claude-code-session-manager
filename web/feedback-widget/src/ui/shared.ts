// Layout + stylesheet helpers shared by the widget's UI pieces. One copy, so the hint chip
// (CaptureChrome) and the toolbar (Toolbar) centre on the same free area, and every piece
// adopts its constructed stylesheet the same way (strict CSP, DESIGN_SPEC.md "Decided changes" 3).

import type { Flow } from './machine';

/** Width the docked panel column takes out of the free area (panel 380 + 32 gutter, §5.3). */
export const PANEL_COLUMN = 412;

export type PanelSide = 'left' | 'right';

export interface FreeArea {
  x0: number;
  x1: number;
}

/** §5.3 free area: the whole viewport, except flow `docked` excludes the panel column. */
export function freeArea(viewport: number, flow: Flow, panelSide: PanelSide = 'right'): FreeArea {
  if (flow !== 'docked') return { x0: 0, x1: viewport };
  return panelSide === 'right'
    ? { x0: 0, x1: viewport - PANEL_COLUMN }
    : { x0: PANEL_COLUMN, x1: viewport };
}

type AdoptingRoot = (ShadowRoot | Document) & { adoptedStyleSheets?: CSSStyleSheet[] };

/**
 * Adopts each of `sheets` on the root node (shadow root or document) of `root`, once each.
 * Null sheets (no constructable-stylesheet support) and roots without adoptedStyleSheets are
 * skipped.
 */
export function adoptInto(
  root: Node | null | undefined,
  sheets: CSSStyleSheet | null | readonly (CSSStyleSheet | null)[],
): void {
  const target = root?.getRootNode() as AdoptingRoot | undefined;
  if (!target || !('adoptedStyleSheets' in target) || !Array.isArray(target.adoptedStyleSheets)) return;
  const list = Array.isArray(sheets) ? sheets : [sheets];
  const current = target.adoptedStyleSheets;
  const add = list.filter((s, i): s is CSSStyleSheet => !!s && !current.includes(s) && list.indexOf(s) === i);
  if (add.length === 0) return;
  try {
    target.adoptedStyleSheets = [...current, ...add];
  } catch {
    // Sheet from another document/realm — the host mounts it instead.
  }
}
