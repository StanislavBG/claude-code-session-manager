import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

// The app frame's root boxes must be `overflow: clip`, not `overflow: hidden`:
// a hidden box is still a scroll container, so scrollIntoView / focus scroll /
// find-in-page can shift the whole frame with no way for the user to scroll back.
const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(here, '..', 'styles.css'), 'utf8')

function rootRuleBody(): string {
  const m = css.match(/html\s*,\s*body\s*,\s*#root\s*\{([^}]*)\}/)
  if (!m) throw new Error('html, body, #root rule not found in styles.css')
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('app frame root overflow', () => {
  it('html/body/#root use overflow: clip, not overflow: hidden', () => {
    const body = rootRuleBody()
    expect(body).toMatch(/overflow\s*:\s*clip\s*;/)
    expect(body).not.toMatch(/overflow\s*:\s*hidden/)
  })
})
