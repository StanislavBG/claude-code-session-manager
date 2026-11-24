# Design vs. widget screenshot pairs

Written by [`../design-shots.e2e.ts`](../design-shots.e2e.ts) at 1280×800, DPR 1:

```sh
npm --prefix web/feedback-widget run e2e -- tests/design-shots.e2e.ts
```

- `design/<scene>.png`: the Claude Design prototype
  (`session-manager-operations/design-mocks/feedback-widget/Feedback Widget.dc.html`), rendered through
  the same `<dc-import>` pattern `Feedback Widget States.dc.html` uses, in the handoff's **default
  variant**: launcher `corner`, flow `annotate`, toolbar `dock`, success `receipt`. These PNGs are
  committed and are byte-identical from run to run. The spec serves a temp copy of the design folder
  over http, boots the dc runtime only after every web font has loaded, and shoots after a warm-up load.
  It needs network access to Google Fonts, unpkg (React and Babel for the dc runtime) and the
  prototype's demo-site images.
- `widget/<scene>.png`: the built widget (`src/index.ts`, bundled with esbuild) on a stand-in host
  page, for each scene the spec can reach on the real widget. It skips any other scene and names the
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
