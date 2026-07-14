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
})
