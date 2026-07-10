/**
 * Pure transforms behind the four capture modes (PRD 404): filter → prune →
 * summarize → chunk for `agent`, plus the html/a11y/selector formatters.
 * These run over plain JSON node trees (no live Electron view) so they're
 * unit-testable — the executeJavaScript serialization step that produces
 * these trees lives in browserCapture.cjs but is not itself covered here.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  filterTree,
  summarizeTree,
  chunkText,
  estimateTokens,
  buildAgentCapture,
  formatHtmlCapture,
  formatSelectorChain,
  formatA11yTree,
} = require('../../src/main/browserCapture.cjs') as {
  filterTree: (node: unknown) => unknown
  summarizeTree: (node: unknown) => string
  chunkText: (text: string, budgetBytes: number) => string[]
  estimateTokens: (text: string) => number
  buildAgentCapture: (node: unknown, budgetBytes?: number) => { text: string; meta: { chunks: number; tokens: number } }
  formatHtmlCapture: (nodes: Array<{ selector: string; outerHTML: string }>) => string
  formatSelectorChain: (info: { css?: string; xpath?: string; role?: string; name?: string; testId?: string }) => string
  formatA11yTree: (node: unknown) => string
}

const proPlanFixture = require('../fixtures/browser-capture/pro-plan.json')

describe('filterTree', () => {
  it('drops script tags', () => {
    const filtered = filterTree(proPlanFixture) as { children: Array<{ tag: string }> }
    expect(filtered.children.some((c) => c.tag === 'script')).toBe(false)
  })

  it('drops elements hidden via display:none', () => {
    const filtered = filterTree(proPlanFixture) as { children: Array<{ tag: string }> }
    expect(filtered.children.some((c) => c.tag === 'div')).toBe(false)
  })

  it('keeps semantic/interactive elements', () => {
    const filtered = filterTree(proPlanFixture) as { children: Array<{ tag: string }> }
    const tags = filtered.children.map((c) => c.tag)
    expect(tags).toEqual(['h3', 'p', 'ul', 'button'])
  })

  it('drops aria-hidden elements', () => {
    const node = { tag: 'div', attrs: { 'aria-hidden': 'true' }, style: {}, children: [] }
    expect(filterTree(node)).toBeNull()
  })
})

describe('summarizeTree', () => {
  it('produces the region/heading/text/list/button pseudo-markup', () => {
    const filtered = filterTree(proPlanFixture)
    const summary = summarizeTree(filtered)
    expect(summary).toBe(
      [
        '<region aria-label="Pro Plan">',
        '  <heading level=3>Pro</heading>',
        '  <text>$20/mo</text>',
        '  <list>',
        '    <item>Unlimited projects</item>',
        '    <item>Priority support</item>',
        '    <item>Full history</item>',
        '  </list>',
        '  <button name="Buy" data-testid="buy-pro">Buy</button>',
        '</region>',
      ].join('\n'),
    )
  })
})

describe('estimateTokens', () => {
  it('uses the chars/4 heuristic', () => {
    expect(estimateTokens('a'.repeat(412 * 4))).toBe(412)
  })
})

describe('chunkText', () => {
  it('returns a single chunk when under budget', () => {
    expect(chunkText('short text', 8192)).toEqual(['short text'])
  })

  it('splits into multiple chunks when over budget', () => {
    const line = 'x'.repeat(100) + '\n'
    const text = line.repeat(100) // ~10.1KB, over an 8KB budget
    const chunks = chunkText(text, 8192)
    expect(chunks.length).toBeGreaterThan(1)
    // no chunk exceeds the budget
    for (const c of chunks) expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(8192)
    // rejoining reconstructs the original text
    expect(chunks.join('')).toBe(text)
  })
})

describe('buildAgentCapture', () => {
  it('runs filter -> prune -> summarize -> chunk end to end with token/chunk meta', () => {
    const result = buildAgentCapture(proPlanFixture, 8192)
    expect(result.text).toContain('<region aria-label="Pro Plan">')
    expect(result.text).toContain('<button name="Buy" data-testid="buy-pro">Buy</button>')
    expect(result.meta.chunks).toBe(1)
    expect(result.meta.tokens).toBe(estimateTokens(result.text))
  })
})

describe('formatHtmlCapture', () => {
  it('concatenates outerHTML per node with a separator comment', () => {
    const out = formatHtmlCapture([
      { selector: '#a', outerHTML: '<div id="a">A</div>' },
      { selector: '#b', outerHTML: '<div id="b">B</div>' },
    ])
    expect(out).toBe(
      [
        '<!-- node 1: #a -->',
        '<div id="a">A</div>',
        '',
        '<!-- node 2: #b -->',
        '<div id="b">B</div>',
      ].join('\n'),
    )
  })
})

describe('formatSelectorChain', () => {
  it('marks the highest-precedence available selector as preferred', () => {
    const out = formatSelectorChain({
      css: 'article.plan--pro button.btn-primary',
      xpath: "//article[contains(@class,'plan--pro')]//button",
      role: 'button',
      name: 'Buy',
      testId: 'buy-pro',
    })
    expect(out).toBe(
      [
        'css    article.plan--pro button.btn-primary',
        "xpath  //article[contains(@class,'plan--pro')]//button",
        'aria   role=button name="Buy"',
        'test   [data-testid="buy-pro"]   ← preferred',
      ].join('\n'),
    )
  })

  it('falls back to css as preferred when no testId/aria available', () => {
    const out = formatSelectorChain({ css: 'div.foo > span:nth-of-type(2)', xpath: '/html/body/div[1]/span[2]' })
    expect(out).toContain('css    div.foo > span:nth-of-type(2)   ← preferred')
  })
})

describe('formatA11yTree', () => {
  it('formats role/name/level/states as an indented tree', () => {
    const tree = {
      role: 'region',
      name: 'Pro Plan',
      children: [
        { role: 'heading', name: 'Pro', level: 3 },
        { role: 'text', name: '$20/mo' },
        {
          role: 'list',
          children: [
            { role: 'listitem', name: 'Unlimited projects' },
            { role: 'listitem', name: 'Priority support' },
            { role: 'listitem', name: 'Full history' },
          ],
        },
        { role: 'button', name: 'Buy', states: ['focusable'], testId: 'buy-pro' },
      ],
    }
    const out = formatA11yTree(tree)
    expect(out).toContain('region')
    expect(out).toContain('"Pro Plan"')
    expect(out).toContain('heading')
    expect(out).toContain('level 3')
    expect(out).toContain('listitem  "Unlimited projects"')
    expect(out).toContain('button')
    expect(out).toContain('focusable')
    expect(out).toContain('data-testid=buy-pro')
  })
})
