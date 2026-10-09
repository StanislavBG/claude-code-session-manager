import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// navigator.clipboard is denied by Electron's permission handler; all writes
// must go through lib/clipboard.ts copyText.
const here = dirname(fileURLToPath(import.meta.url))
const rendererRoot = resolve(here, '..')
const allowed = resolve(here, 'clipboard.ts')

function walk(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(full)
  }
  return out
}

describe('clipboard guard', () => {
  it('no renderer source uses navigator.clipboard', () => {
    const offenders = walk(rendererRoot, [])
      .filter((f) => f !== allowed)
      .filter((f) => readFileSync(f, 'utf8').includes('navigator.clipboard'))
      .map((f) => f.slice(rendererRoot.length + 1))
    expect(offenders, `use copyText from lib/clipboard.ts instead of navigator.clipboard in: ${offenders.join(', ')}`).toEqual([])
  })
})
