# design-mocks/

Design-source artifacts authored by design/dev skills during interactive sessions —
not app-owned state. **Not an OWNERS namespace**: no code path writes here, no
`assertOpsWrite` guard applies, plain file writes are fine.

**Retention: keep.** Nothing here is deleted on a schedule; each subfolder below is
either a closed historical record or a still-relevant template.

## Subfolders

| Folder | Status |
| --- | --- |
| `epics/` | **CLOSED 2026-07.** Design spec for the Epics surface. Referenced only by archived PRDs — no live code, doc, or skill points at it. Kept as history, not as an active spec. |
| `home/` | **CLOSED 2026-08.** Design spec for the Home/Project-Home surface. Same status as `epics/`: archived-PRD references only. |
| `project-pages-component-library/` | **Frozen port record**, superseded by [`../../web/project-pages/`](../../web/project-pages/). Its own README's "Not the shipped architecture" and "needs a superset synthesis step" sections describe a gap that has since been closed by that port — read them as history of the design phase, not as an open TODO. |
| `dom-specs/` | The DOM-spec authoring template (`TEMPLATE.html`). One spec has ever been produced from it (`scheduler-tab.html`, 2026-08-02). Keep — it's a live template for future tab specs, not dead weight, even though only one tab has used it so far. |

## Who writes here

Design/dev skills and humans working an Epic, on an ad hoc basis — there is no
recurring producer and no automated regeneration.
