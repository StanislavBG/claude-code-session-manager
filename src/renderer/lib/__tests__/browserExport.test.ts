import { describe, it, expect } from 'vitest'
import { stepsToPlaywright, stepsToMarkdown, stepsToPrdFixture } from '../browserExport'
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
})

describe('stepsToMarkdown', () => {
  it('numbers steps with verb, target, and parameter markers', () => {
    const md = stepsToMarkdown(STEPS)
    expect(md).toContain('1. **Navigate to** `https://example.com`')
    expect(md).toContain('{{email}}')
    expect(md).toContain('4. **Wait for** `Welcome`')
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
