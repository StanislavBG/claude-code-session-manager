// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MdLastReview, isReviewDue, localDate, pickValidationPath, driftCheckInstructions, type MdReviewState } from '../MdLastReview'
import type { Macro, MdReviewRecord } from '../../../../../../preload/api'

const REVIEW: Macro = {
  id: 'builtin-review-md-network',
  label: 'Review MD network',
  agentName: 'architect',
  tag: 'discussion',
  prompt: 'Review. Scope: {{scope}}. Mode: {{mode}}.',
  projects: ['*'],
  surface: 'project-home',
  builtin: true,
  createdAt: '',
  updatedAt: '',
  inputs: [
    { name: 'scope', label: 'Scope', default: 'the whole project', required: true },
    { name: 'mode', label: 'Mode', options: ['Full review', 'Drift check'], default: 'Full review', required: true },
  ],
}

const RECORD_PATH = 'session-manager-operations/reviews/docs/2026-11-15-md-network.md'

/** parseReviewRecord's output for the family-frame record (src/main/lib/__tests__/mdReviewRecord.test.cjs), trimmed. */
const FAMILY_FRAME: MdReviewRecord = {
  date: '2026-11-15',
  mode: 'Full review (audit ran 2026-11-12; approved 2026-11-15)',
  modeKind: 'Full review',
  scope: 'the whole project',
  session: null,
  baseCommit: 'bab11306fe9757cbdc1d7a40862d63c0bc30829d',
  owner: 'Bilko',
  map: 'CLAUDE.md',
  driftCheckCommand: 'node script/drift-check.cjs --root . --exclude session-manager-operations/',
  findingsCounts: { 'broken-link': 0, 'missing-path': 0, 'over-line-limit': 0, 'no-contents-list': 0 },
  censusSummary: '83 files, 4570 lines, 75.9% of files (63) and 61.0% of lines (2786) machine-written',
  verdicts: [
    { doc: 'CLAUDE.md', verdict: 'KEEP-OWNER', owner: 'map' },
    { doc: 'services/mail-intake/README.md', verdict: 'SHRINK-TO-POINTER', owner: 'docs/household-email.md' },
    { doc: 'design_guidelines.md', verdict: 'DELETE', owner: 'facts now in .claude/rules/client.md and client/src/index.css' },
  ],
  decisions: ['The human approved the restructure on 2026-11-15.', 'replit.md is a pointer, not deleted, because Replit Agent reads it by convention.'],
  followUpPrds: ['vendor-drift-check-script', 'md-operations-doc', 'replit-drop-postgres-module'],
  nextReviewDue: '2027-02-15',
  nextReviewNote: '2027-02-15, or sooner after a major model release.',
}

const ready = (record: MdReviewRecord | null, validation: Record<string, string[]> = {}): MdReviewState => ({
  status: 'ready',
  result: { ok: true, record, recordPath: record ? RECORD_PATH : null, validation },
})

let container: HTMLDivElement | null = null
let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
})

type Props = React.ComponentProps<typeof MdLastReview>
function render(over: Partial<Props> = {}) {
  const props: Props = {
    state: ready(FAMILY_FRAME),
    validationPath: null,
    macro: REVIEW,
    scope: 'the whole project',
    launching: null,
    onLaunch: vi.fn(),
    onOpen: vi.fn(),
    ...over,
  }
  if (!root) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => root!.render(<MdLastReview {...props} />))
  return props
}
const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

describe('MdLastReview', () => {
  it('renders the family-frame record in full', () => {
    render({ today: '2026-11-15' })
    expect(q('md-last-review-path')!.textContent).toBe(RECORD_PATH)
    expect(q('md-last-review-date')!.textContent).toBe('2026-11-15')
    expect(q('md-last-review-mode')!.textContent).toBe('Full review (audit ran 2026-11-12; approved 2026-11-15)')
    expect(q('md-last-review-scope')!.textContent).toBe('the whole project')
    const base = q('md-last-review-base')!
    expect(base.textContent).toBe('bab11306')
    expect(base.getAttribute('title')).toBe('bab11306fe9757cbdc1d7a40862d63c0bc30829d')
    expect(q('md-last-review-map')!.textContent).toBe('CLAUDE.md')
    expect(q('md-last-review-findings')!.textContent).toBe('broken-link 0 · missing-path 0 · over-line-limit 0 · no-contents-list 0')
    expect(q('md-last-review-census')!.textContent).toMatch(/^83 files, 4570 lines/)
    const rows = Array.from(container!.querySelectorAll('[data-testid="md-last-review-verdict"]'))
    expect(rows).toHaveLength(3)
    expect(Array.from(rows[1].querySelectorAll('td')).map((td) => td.textContent)).toEqual([
      'services/mail-intake/README.md', 'SHRINK-TO-POINTER', 'docs/household-email.md',
    ])
    expect(q('md-last-review-decisions')!.querySelectorAll('li')).toHaveLength(2)
    expect(Array.from(q('md-last-review-followups')!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(FAMILY_FRAME.followUpPrds)
    expect(q('md-last-review-next')!.textContent).toBe('2027-02-15, or sooner after a major model release.')
    expect(q('md-last-review-due')).toBeNull()
    expect(q('md-last-review-open-validation')).toBeNull()
  })

  it('with no record says none exists yet and that Run review writes one', () => {
    render({ state: ready(null) })
    expect(q('md-last-review-none')!.textContent).toBe('No review record exists yet. Run review writes one when the review finishes.')
    expect(q('md-last-review-open')).toBeNull()
  })

  it('shows an error inline', () => {
    render({ state: { status: 'error', error: 'boom' } })
    expect(q('md-last-review-error')!.textContent).toContain('boom')
  })

  it('Open record and Open validation record open their paths', () => {
    const props = render({ validationPath: 'session-manager-operations/reviews/validation/epic-a/v.md' })
    act(() => q('md-last-review-open')!.click())
    act(() => q('md-last-review-open-validation')!.click())
    expect((props.onOpen as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [RECORD_PATH],
      ['session-manager-operations/reviews/validation/epic-a/v.md'],
    ])
  })

  it('is not due on or before the due date, due the day after (fixed clock)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2027, 1, 15, 23, 30))
    render()
    expect(q('md-last-review-due')).toBeNull()
    vi.setSystemTime(new Date(2027, 1, 16, 0, 5))
    act(() => root!.unmount())
    root = null
    render()
    expect(q('md-last-review-due')!.textContent).toContain('Review due')
    expect(q('md-last-review-drift-check')).not.toBeNull()
  })

  it('Run drift check launches the macro in Drift check mode naming the record and its command', () => {
    const props = render({ today: '2027-03-01' })
    act(() => q('md-last-review-drift-check')!.click())
    expect(props.onLaunch).toHaveBeenCalledWith(REVIEW, driftCheckInstructions(RECORD_PATH, FAMILY_FRAME.driftCheckCommand), {
      scope: 'the whole project',
      mode: 'Drift check',
    })
    const extra = (props.onLaunch as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(extra).toContain(RECORD_PATH)
    expect(extra).toContain('node script/drift-check.cjs --root . --exclude session-manager-operations/')
  })

  it('hides Run drift check when the macro has no Drift check mode', () => {
    const noDrift = { ...REVIEW, inputs: [REVIEW.inputs![0], { name: 'mode', label: 'Mode', options: ['Full review'], required: true }] }
    render({ macro: noDrift, today: '2027-03-01' })
    expect(q('md-last-review-due')).not.toBeNull()
    expect(q('md-last-review-drift-check')).toBeNull()
  })
})

describe('helpers', () => {
  it('isReviewDue compares local YYYY-MM-DD dates', () => {
    expect(isReviewDue('2027-02-15', '2027-02-15')).toBe(false)
    expect(isReviewDue('2027-02-15', '2027-02-16')).toBe(true)
    expect(isReviewDue(null, '2027-02-16')).toBe(false)
    expect(localDate(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('pickValidationPath uses the Session line, else exactly one earlier review session with files', () => {
    const review = (id: string, createdAt: string) => ({ id, createdAt: new Date(createdAt).toISOString(), source: { macroId: 'builtin-review-md-network' } })
    const v = { 'epic-a': ['x/a1.md', 'x/a2.md'], 'epic-b': ['x/b.md'], 'epic-c': [] }
    expect(pickValidationPath({ ...FAMILY_FRAME, session: 'epic-a' }, v, [])).toBe('x/a2.md')
    expect(pickValidationPath({ ...FAMILY_FRAME, session: 'epic-z' }, v, [])).toBe(null)
    // One review session with files on/before the record date.
    expect(pickValidationPath(FAMILY_FRAME, v, [review('epic-b', '2026-11-14T10:00'), review('epic-c', '2026-11-14T10:00')])).toBe('x/b.md')
    // A later one does not count; a non-review one does not count.
    expect(pickValidationPath(FAMILY_FRAME, v, [
      review('epic-b', '2026-11-14T10:00'),
      review('epic-a', '2026-11-16T10:00'),
      { id: 'epic-a', createdAt: '2026-11-01T00:00:00Z', source: {} },
    ])).toBe('x/b.md')
    // Two candidates: ambiguous.
    expect(pickValidationPath(FAMILY_FRAME, v, [review('epic-b', '2026-11-14T10:00'), review('epic-a', '2026-11-15T09:00')])).toBe(null)
    expect(pickValidationPath(null, v, [])).toBe(null)
  })
})
