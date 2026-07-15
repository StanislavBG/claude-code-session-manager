// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderChatMarkdown } from '../renderChatMarkdown'

describe('renderChatMarkdown', () => {
  // Issue #3 repro: Claude often emits checkmark-prefixed lines with a single
  // newline between them — not valid GFM list syntax (no -/*/digit marker) —
  // so without `breaks: true` marked collapses them into one run-on <p>.
  it('renders single-newline-separated lines as <br>-separated, not run-on text', () => {
    const src = '✓ item one\n✓ item two\n✓ item three'
    const html = renderChatMarkdown(src)
    expect(html).toBe('<p>✓ item one<br>✓ item two<br>✓ item three</p>\n')
  })

  it('still renders real GFM list syntax as separate <li> elements', () => {
    const src = '- item one\n- item two\n- item three'
    const html = renderChatMarkdown(src)
    expect(html).toBe('<ul>\n<li>item one</li>\n<li>item two</li>\n<li>item three</li>\n</ul>\n')
  })

  // Issue #2: Claude emits a standard GFM table; it must reach a real <table>
  // wrapped in the scroll container so a wide table can't force the chat column
  // to overflow. `.prose-chat-table-wrap` carries the overflow + is what the
  // `.prose-chat table` rules in styles.css hang off.
  describe('GFM tables (issue #2)', () => {
    it('renders a GFM table into a real <table> inside the scroll wrapper', () => {
      const src = '| Name | Status |\n|------|--------|\n| build | passing |'
      const html = renderChatMarkdown(src)
      expect(html).toContain('<div class="prose-chat-table-wrap">')
      expect(html).toContain('<table>')
      expect(html).toContain('<th>Name</th>')
      expect(html).toContain('<td>build</td>')
    })

    it('still parses a table when breaks:true is active (no <br> interference)', () => {
      const src = 'before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nafter'
      const html = renderChatMarkdown(src)
      expect(html).toContain('<table>')
      expect(html).toContain('<td>1</td>')
    })

    // The renderer overrides marked's `table` renderer. It must WRAP the default
    // output, never reimplement it — otherwise marked's escaping is bypassed.
    // These assert the sanitize+escape chain still holds for model-emitted text,
    // which can relay attacker-controlled content from files/web/tool results.
    it('strips a <script> payload in a table cell', () => {
      const html = renderChatMarkdown('| A | B |\n|---|---|\n| <script>alert(1)</script> | x |')
      expect(html).not.toContain('<script>')
    })

    it('strips an event handler in a table cell', () => {
      const html = renderChatMarkdown('| A | B |\n|---|---|\n| <img src=x onerror=alert(1)> | x |')
      expect(html).not.toContain('onerror')
    })

    it('strips a javascript: URI in a table cell link', () => {
      const html = renderChatMarkdown('| A |\n|---|\n| [click](javascript:alert(1)) |')
      expect(html.toLowerCase()).not.toContain('javascript:')
    })

    it('does not let a cell break out of the wrapper div', () => {
      const html = renderChatMarkdown('| A |\n|---|\n| </div><script>alert(1)</script><div> |')
      expect(html).not.toContain('<script>')
    })
  })
})
