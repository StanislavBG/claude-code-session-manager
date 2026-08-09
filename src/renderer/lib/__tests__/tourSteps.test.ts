/**
 * Guards the first-run tour's content against UI drift.
 *
 * The e2e (`tests/e2e/tour-overlay-targets.spec.ts`) walks the tour in a real
 * window, but it can only see the targets that exist on the face it launched
 * on — the PROJECT-face rows are invisible there by design. This test is the
 * cheap, always-run half: every declared `data-testid` target must exist
 * somewhere in the renderer source, and the copy must not describe UI we've
 * since removed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TOUR_STEPS } from '../tourSteps'

const RENDERER_ROOT = join(__dirname, '..', '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry) && !full.endsWith('tourSteps.ts')) {
      out.push(full)
    }
  }
  return out
}

const ALL_SOURCE = sourceFiles(RENDERER_ROOT)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

describe('TOUR_STEPS', () => {
  it('has unique step ids', () => {
    const ids = TOUR_STEPS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('only uses data-testid selectors, and every one exists in the renderer', () => {
    for (const step of TOUR_STEPS) {
      if (!step.target) {
        // A targetless step must render centered — any other position would
        // silently resolve to centered anyway, which hides the mistake.
        expect(step.position, `step ${step.id}`).toBe('center')
        continue
      }
      const m = /^\[data-testid="([^"]+)"\]$/.exec(step.target)
      expect(m, `step ${step.id} target must be a [data-testid="…"] selector`).not.toBeNull()
      const testid = m![1]
      expect(
        ALL_SOURCE.includes(`"${testid}"`) || ALL_SOURCE.includes(`'${testid}'`),
        `step ${step.id} targets data-testid="${testid}", which no renderer component renders`,
      ).toBe(true)
    }
  })

  it('does not describe UI that no longer exists', () => {
    const body = TOUR_STEPS.map((s) => `${s.title} ${s.body}`).join('\n')
    // The tab strip is navigation only (one tab per PROJECT) — it has no
    // "+ new" button and a tab is not a session any more.
    expect(body).not.toMatch(/\+ ?new (tab|session)/i)
    // Voice's default hotkey is a chord; it was never plain F1 after PRD F1 v2.
    expect(body).not.toMatch(/\bF1 by default\b/)
    // "Epic" is the code name; every user-facing surface says "session".
    expect(body).not.toMatch(/\bEpics?\b/)
    // The footer carries no model pill (that moved to Agent Library).
    expect(body).not.toMatch(/restart-app/)
  })

  it('covers the domain model a new user has to learn', () => {
    const ids = TOUR_STEPS.map((s) => s.id)
    for (const required of ['tabs', 'leftnav', 'new-session', 'sessions', 'scheduler', 'statusbar']) {
      expect(ids).toContain(required)
    }
    // Sessions must be introduced before the scheduler that runs their PRDs.
    expect(ids.indexOf('sessions')).toBeLessThan(ids.indexOf('scheduler'))
  })
})
