# Design vs. widget screenshot pairs

Written by [`../design-shots.e2e.ts`](../design-shots.e2e.ts) at 1280×800, DPR 1. The spec has two
halves that run apart:

```sh
# widget half only: offline, part of the default e2e run and the gate
npm --prefix web/feedback-widget run e2e -- tests/design-shots.e2e.ts
# design half only: needs network (FW_SHOTS=design)
npm --prefix web/feedback-widget run shots:design
```

- `design/<scene>.png`: the Claude Design prototype
  (`session-manager-operations/design-mocks/feedback-widget/Feedback Widget.dc.html`), rendered through
  the same `<dc-import>` pattern `Feedback Widget States.dc.html` uses: every scene in the handoff's
  **default variant** (launcher `corner`, flow `annotate`, toolbar `dock`, success `receipt`), plus
  every non-default frame on the States board (see [Variant scenes](#variant-scenes)). These PNGs are
  committed and are byte-identical from run to run. The spec serves a temp copy of the design folder
  over http, boots the dc runtime only after every web font has loaded, and shoots after a warm-up load.
  It needs network access to Google Fonts, unpkg (React and Babel for the dc runtime) and the
  prototype's demo-site images, so only `shots:design` renders it; re-run it when the prototype changes.
- `widget/<scene>.png`: the built widget (`src/index.ts`, bundled with esbuild) on a stand-in host
  page whose `window.FeedbackConfig` carries the shot's variant, for each scene the spec can reach on
  the real widget. It skips any other scene and names the
  reason in the skip annotation. Not committed (see `.gitignore`); each run writes them fresh. When a
  UI PRD makes a scene reachable, it adds that scene's driver to `DRIVERS` in the spec.

Validators compare `widget/<scene>.png` with `design/<scene>.png`. Section numbers refer to the
handoff [`README.md`](../../../../session-manager-operations/design-mocks/feedback-widget/README.md).

| Scene id | What it shows | Handoff README section it checks |
| --- | --- | --- |
| `idle` | Host page at rest with only the corner launcher bubble, bottom-right | §5.1 Launcher |
| `launcher-hover` | Launcher hovered: the bubble expands into a "Feedback ⇧F" pill | §5.1 Launcher |
| `annotate-empty` | Just opened: capture frame, floating top-centre toolbar with Pin selected, hint chip, no marks yet | §5.2 Capture feedback, §5.3 Toolbar |
| `annotate` | Annotate mode with seeded marks (element, pin, drawing, arrow, label) on the page | §5.3 Toolbar, §5.4 Marks |
| `pick` | Element tool armed and hovering the first card's Book button (pick outline + selector tag) | §5.4 Marks (element pick) |
| `tools` | Every mark kind on the page, with the pin's comment popover open | §5.3 Toolbar, §5.5 Mark comment popover |
| `tools-pick` | Every mark kind, with the element picker hovering the Search button | §5.3 Toolbar, §5.4 Marks (element pick) |
| `describe` | Review: the corner panel card with type, title, details, the marks list and attachments, and Send | §5.6 Panel |
| `sending` | Panel while sending: progress bar at 64%, fields locked | §5.6 Panel (sending) |
| `error` | Send failed: the error message, draft kept, Send label becomes **Retry now** | §5.6 Panel (error), §2 State machine |
| `discard` | Discard guard dialog over the annotate state (Keep editing / Discard) | §5.8 Discard dialog |
| `sent` | Success `receipt`: the panel turns into a receipt with the ticket ID and what was sent | §5.7 Success variants |

## Variant scenes

Every frame of `Feedback Widget States.dc.html` that sets a non-default axis. The file name is
`<scene>--<axis>-<value>`; the axes not named keep the defaults above. `VARIANT_SHOTS` in the spec
is the source of this list. The widget driver lays marks out of the panel's way (left of the
`docked` side panel, right of the `note` card), so mark positions differ from the prototype's
seeded ones; compare chrome, placement and states, not mark coordinates.

| Shot id | Board option | What it shows | Handoff README section it checks |
| --- | --- | --- | --- |
| `idle--launcher-edge` | 1b Edge tab | Edge tab at rest on the right edge, vertically centred | §5.1 Launcher (edge) |
| `launcher-hover--launcher-edge` | 1b Edge tab | Edge tab hovered: slides out and shows ⇧F | §5.1 Launcher (edge) |
| `idle--launcher-mini` | 1c Mini pill | Paper-toned mini pill at rest, bottom-left | §5.1 Launcher (mini) |
| `launcher-hover--launcher-mini` | 1c Mini pill | Mini pill hovered: expands to "Feedback ⇧F" | §5.1 Launcher (mini) |
| `idle--launcher-hidden` | 1d Shortcut only | No launcher; the one-time coach toast ("Press ⇧F", Got it) | §5.1 Launcher (hidden, coach) |
| `annotate-empty--flow-docked` | 1f Side panel | Just opened: toolbar over the free area plus the side panel, empty | §5.2 Capture feedback, §5.6 Panel (docked) |
| `annotate--flow-docked` | 1f Side panel | Marks on the page, marks list filling in the side panel, title filled | §5.4 Marks, §5.6 Panel (docked) |
| `sent--flow-docked` | 1f Side panel | Receipt inside the side panel | §5.6 Panel (docked), §5.7 Success variants (receipt) |
| `pick--flow-note` | 1g Anchored note | Note flow opened, Element armed over the Book button, "mark the spot first" hint | §5.2 Capture feedback (note hint), §5.4 Marks (element pick) |
| `annotate--flow-note` | 1g Anchored note | The note open beside mark 1 (`#book`), extra marks with their own comments | §5.4 Marks, §5.6 Panel (note) |
| `sent--flow-note` | 1g Anchored note | Receipt where the note was | §5.6 Panel (note), §5.7 Success variants (receipt) |
| `tools-pick--toolbar-rail` | 1i Vertical rail | Rail toolbar on the left, every mark kind, picker hovering Search | §5.3 Toolbar (rail), §5.4 Marks (element pick) |
| `tools--toolbar-corner` | 1j Corner toolbar | Corner toolbar where the launcher was, pin popover open | §5.3 Toolbar (corner), §5.5 Mark comment popover |
| `sending--flow-docked` | 1k Sending | Side panel sending: progress bar, fields locked | §5.6 Panel (docked, sending) |
| `sent--success-toast` | 1m Toast | Widget closed; ink toast "Feedback sent" with Undo and countdown | §5.7 Success variants (toast) |
| `sent--success-fold` | 1n Fold into launcher | Launcher green with the "Sent FB-… — thank you" ping | §5.7 Success variants (fold) |
| `error--flow-docked` | 1o Server error | Side panel error banner, draft kept, **Retry now** | §5.6 Panel (docked, error), §2 State machine |

Board options 1a, 1e, 1h, 1l and 1p are all-default frames: the default table above covers them.
