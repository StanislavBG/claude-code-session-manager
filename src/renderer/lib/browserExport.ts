/**
 * Pure step-transform functions for the Recorder's export destinations
 * (PRD 410). No fs/Electron access — the RecorderPanel calls these and
 * writes the result via `window.api.config.writeText` (atomic write).
 */
import type { RecordStep } from '../../preload/api'

function toIdent(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1')
  return cleaned || 'value'
}

function jsStr(v: string): string {
  return JSON.stringify(v)
}

function playwrightLineFor(step: RecordStep): string {
  switch (step.verb) {
    case 'navigate':
      return `await page.goto(${jsStr(step.target)})`
    case 'click':
      return `await page.click(${jsStr(step.target)})`
    case 'type': {
      // Typed values are never captured by the engine (privacy invariant) —
      // a parameterized step substitutes the named const; an unparameterized
      // one fills an empty literal for the user to fill in.
      const value = step.variable ? toIdent(step.variable) : jsStr('')
      return `await page.fill(${jsStr(step.target)}, ${value})`
    }
    case 'select':
      return `await page.selectOption(${jsStr(step.target)}, ${jsStr(step.value ?? '')})`
    case 'wait-for':
      if (/^https?:\/\//i.test(step.target)) {
        return `await expect(page).toHaveURL(${jsStr(step.target)})`
      }
      return `await page.getByText(${jsStr(step.target)}).waitFor()`
    default:
      return `// unsupported step verb: ${String(step.verb)}`
  }
}

export function stepsToPlaywright(
  steps: RecordStep[],
  opts: { title?: string; values?: Record<string, string> } = {},
): string {
  const title = opts.title ?? 'Recorded flow'
  const values = opts.values ?? {}
  const variables = [...new Set(steps.filter((s) => s.variable).map((s) => s.variable as string))]
  const constLines = variables.map((v) => `const ${toIdent(v)} = ${jsStr(values[v] ?? '')};`)
  const consts = constLines.length ? `\n${constLines.join('\n')}\n` : ''
  const body = steps.map((s) => `  ${playwrightLineFor(s)}`).join('\n')
  return (
    "import { test, expect } from '@playwright/test'\n" +
    `${consts}\n` +
    `test(${jsStr(title)}, async ({ page }) => {\n${body}\n})\n`
  )
}

function verbLabel(verb: RecordStep['verb']): string {
  switch (verb) {
    case 'navigate':
      return 'Navigate to'
    case 'click':
      return 'Click'
    case 'type':
      return 'Type into'
    case 'select':
      return 'Select in'
    case 'wait-for':
      return 'Wait for'
    default:
      return verb
  }
}

function expectedFor(step: RecordStep): string | null {
  if (step.verb === 'wait-for') return `"${step.target}" is visible`
  if (step.verb === 'navigate') return `page loads ${step.target}`
  return null
}

// Wraps `text` in a Markdown inline code span, widening the backtick fence
// (``` `` ``` etc.) when `text` itself contains a run of backticks so the
// span can't be broken out of.
function codeSpan(text: string): string {
  const longestRun = (text.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(longestRun + 1)
  const pad = longestRun > 0 ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

export function stepsToMarkdown(steps: RecordStep[]): string {
  const lines = steps.map((s, i) => {
    const n = s.n ?? i + 1
    const expected = expectedFor(s)
    const varSuffix = s.variable ? ` (${codeSpan(`{{${s.variable}}}`)})` : ''
    return `${n}. **${verbLabel(s.verb)}** ${codeSpan(s.target)}${varSuffix}${expected ? ` — _expect: ${expected}_` : ''}`
  })
  return `# Recorded steps\n\n${lines.join('\n')}\n`
}

// NOT auto-queued — this only produces a fixture block for a human to paste
// into a PRD body by hand. Never writes into the scheduler's PRD queue dir.
export function stepsToPrdFixture(steps: RecordStep[]): string {
  return (
    '<!-- Recorded browser fixture — paste into a PRD body manually.\n' +
    '     This file is NOT auto-queued to the scheduler. -->\n\n' +
    '## Recorded steps fixture\n\n' +
    '```json\n' +
    `${JSON.stringify(steps, null, 2)}\n` +
    '```\n'
  )
}
