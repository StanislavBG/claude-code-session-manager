import { describe, it, expect } from 'vitest'
import { stepsToPlaywright, stepsToMarkdown, stepsToPrdFixture, stepsToCanonical } from '../browserExport'
import type { RecordStep } from '../../../preload/api'

const submitSelector = 'a[data-testid="submit"]'

const STEPS: RecordStep[] = [
  { n: 1, verb: 'navigate', target: 'https://example.com' },
  { n: 2, verb: 'type', target: '#email', masked: true, variable: 'email' },
  { n: 3, verb: 'click', target: submitSelector },
  { n: 4, verb: 'wait-for', target: 'Welcome', kind: 'assert' },
]

describe('stepsToPlaywright', () => {
  it('emits page.goto/fill/click and substitutes parameterized values', () => {
    const spec = stepsToPlaywright(STEPS, { title: 'login flow', values: { email: 'a@b.com' } })
    expect(spec).toContain("import { test, expect } from '@playwright/test'")
    expect(spec).toContain('page.goto("https://example.com")')
    expect(spec).toContain('const email = "a@b.com";')
    expect(spec).toContain('page.fill("#email", email)')
    expect(spec).toContain(`page.click(${JSON.stringify(submitSelector)})`)
    expect(spec).toContain('getByText("Welcome").waitFor()')
    expect(spec).toContain('test("login flow"')
  })

  it('falls back to an empty literal for unparameterized type steps', () => {
    const spec = stepsToPlaywright([{ n: 1, verb: 'type', target: '#note' }])
    expect(spec).toContain('page.fill("#note", "")')
  })

  it('annotates a click with its captured coordinates without dropping the selector', () => {
    const spec = stepsToPlaywright([{ n: 1, verb: 'click', target: '#btn', x: 12, y: 34 }])
    expect(spec).toContain('page.click("#btn")')
    expect(spec).toContain('captured at (12, 34)')
  })

  it('leaves a coordinate-less click unannotated', () => {
    const spec = stepsToPlaywright([{ n: 1, verb: 'click', target: '#btn' }])
    expect(spec).toContain('page.click("#btn")')
    expect(spec).not.toContain('captured at')
  })

  it('emits dragAndDrop when both drag selectors are present', () => {
    const spec = stepsToPlaywright([
      { n: 1, verb: 'drag', target: '#src', endTarget: '#dst', x: 1, y: 2, endX: 3, endY: 4 },
    ])
    expect(spec).toContain('page.dragAndDrop("#src", "#dst")')
  })

  it('falls back to coordinate-based mouse moves when a drag selector is missing', () => {
    const spec = stepsToPlaywright([
      { n: 1, verb: 'drag', target: '', endTarget: '', x: 1, y: 2, endX: 3, endY: 4 },
    ])
    expect(spec).toContain('page.mouse.move(1, 2)')
    expect(spec).toContain('page.mouse.down()')
    expect(spec).toContain('page.mouse.move(3, 4)')
    expect(spec).toContain('page.mouse.up()')
  })
})

describe('stepsToMarkdown', () => {
  it('numbers steps with verb, target, and parameter markers', () => {
    const md = stepsToMarkdown(STEPS)
    expect(md).toContain('1. **Navigate to** `https://example.com`')
    expect(md).toContain('{{email}}')
    expect(md).toContain('4. **Wait for** `Welcome`')
  })

  it('includes the end target for a drag step', () => {
    const md = stepsToMarkdown([{ n: 1, verb: 'drag', target: '#src', endTarget: '#dst' }])
    expect(md).toContain('**Drag**')
    expect(md).toContain('`#src`')
    expect(md).toContain('`#dst`')
  })
})

describe('stepsToPrdFixture', () => {
  it('embeds a JSON fixture block and never references the scheduler queue', () => {
    const fixture = stepsToPrdFixture(STEPS)
    expect(fixture).toContain('```json')
    expect(fixture).toContain('"verb": "navigate"')
    expect(fixture.toLowerCase()).not.toContain('scheduled-plans')
  })
})

describe('stepsToCanonical', () => {
  it('contains the numbered Markdown steps and a json fence', () => {
    const canonical = stepsToCanonical(STEPS)
    expect(canonical).toContain('1. **Navigate to** `https://example.com`')
    expect(canonical).toContain('```json')
  })

  it('round-trips the steps array through the fenced JSON block', () => {
    const canonical = stepsToCanonical(STEPS)
    const start = canonical.indexOf('```json\n') + '```json\n'.length
    const end = canonical.indexOf('```', start)
    const parsed = JSON.parse(canonical.slice(start, end))
    expect(parsed).toEqual(STEPS)
  })
})
