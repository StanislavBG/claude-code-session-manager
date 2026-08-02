// Epics — epic-scoped workspace. Replaces the global chat + right rail:
// the queue lives on the left, and the agent conversation, PRDs and runs are
// all contextual to the selected Epic. Loads after shared.jsx / almanac.jsx.
//
// Synced from claude.ai/design project 0ca33cd3-c2fa-4644-b728-bde42292abbd,
// variants/epics.jsx, 2026-08-01. The Turn renderer itself moved out to a
// sibling file — see epic-thread-mock.jsx (variants/epic-thread.jsx) for the
// 8-situation router (ask/perm/plan/diff/error/stream/note/summary) that
// replaced this file's old single `Turn` function. Bulk synthetic test data
// (variants/epics-data.jsx, ~136 generated Epics for at-scale UI testing)
// is NOT mirrored here — it's a mock-only stress-test fixture with no real
// app analogue.

const EP = window.ALMANAC;

const E_STATUS = {
  running:   { label: 'running',   fg: '#8a4a1e', bg: '#f4dfc8', dot: '#b85c34' },
  queued:    { label: 'queued',    fg: '#6b5c40', bg: '#ece0c6', dot: '#a89670' },
  needs:     { label: 'needs you', fg: '#8a2f2f', bg: '#f2d8d0', dot: '#a3441f' },
  completed: { label: 'completed', fg: '#4a5730', bg: '#e3e6cf', dot: '#6f7d52' },
  draft:     { label: 'draft',     fg: '#6b5c40', bg: 'transparent', dot: '#c0b291' },
};
const E_KINDS = ['Feature', 'Bug', 'Discussion'];
const E_KIND_TINT = { Feature: '#6f7d52', Bug: '#a3441f', Discussion: '#8a7a60' };

// ── left: the queue — built for hundreds of Epics ───────────────────
const E_GROUPS = {
  status: { label: 'status', order: ['running', 'needs', 'queued', 'draft', 'completed'], of: e => e.status, name: k => E_STATUS[k].label, dot: k => E_STATUS[k].dot },
  tag:    { label: 'tag',    order: E_KINDS, of: e => e.kind, name: k => k, dot: k => E_KIND_TINT[k] },
  age:    { label: 'recency', order: ['Today', 'This week', 'This month', 'Older'], dot: () => EP.rule, name: k => k,
            of: e => e.sortAge < 24 ? 'Today' : e.sortAge < 168 ? 'This week' : e.sortAge < 720 ? 'This month' : 'Older' },
};
const E_SORTS = { recent: ['last activity', (a, b) => a.sortAge - b.sortAge], turns: ['turns', (a, b) => b.turns - a.turns], tokens: ['tokens', (a, b) => b.tools - a.tools], title: ['title', (a, b) => a.title.localeCompare(b.title)] };
const PAGE = 18;

// QueueRow now carries a hover/selected-only overflow menu (RowMenu) with:
//   Rename title · Edit goal / first prompt (opens inline RowEditor)
//   Pin/Unpin · Mark completed / Reopen · Duplicate as new Epic
//   Resume in terminal · Copy Epic ID · Delete Epic (danger)
// RowEditor replaces the row in place: title input + goal textarea,
// ⌘↵ save / esc cancel, Save disabled until dirty + title non-empty.
// EpicQueue's onSelect/onPin signature grew onPatch(id, {title?, goal?}),
// onDup(id), onDelete(id) to drive the new menu actions — see this repo's
// implementation notes in DESIGN_SPEC.md for what's real vs still mocked.

// ── composer, scoped to the Epic ─────────────────────────────────────
// Composer gained a `quote`/`onClearQuote` pair: TUser's hover "Quote"
// button seeds a reply-context strip above the textarea (accent left
// border, dismissible), threaded through onQuote from the Turn router.

// ── page ─────────────────────────────────────────────────────────────
// EpicsPage composes EpicQueue + (NewEpic | EpicDetail), same shape as
// before. EpicDetail's Turn rendering now delegates entirely to the
// `Turn` router exported by epic-thread-mock.jsx.
