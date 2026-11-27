// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RiskBadge } from '../RiskBadge'

describe('RiskBadge', () => {
  it('renders the label in the one danger tone, never honey', () => {
    const html = renderToStaticMarkup(<RiskBadge mark="public">PUBLIC</RiskBadge>)
    expect(html).toContain('PUBLIC')
    expect(html).toContain('data-mark="public"')
    expect(html).toContain('text-delta-bad')
    expect(html).not.toContain('honey')
  })
})
