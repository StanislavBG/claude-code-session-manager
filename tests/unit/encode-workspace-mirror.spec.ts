import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { encodeWorkspace } from '../../src/renderer/lib/encodeWorkspace'

const requireCjs = createRequire(import.meta.url)
const { encodeCwd } = requireCjs('../../src/main/lib/encodeCwd.cjs') as {
  encodeCwd: (cwd: string | null) => string
}

/**
 * The renderer-side encodeWorkspace.ts and the main-side encodeCwd.cjs MUST
 * produce identical output for every input. Memory.tsx pre-computes the
 * workspace label render-side so the UI doesn't wait on an IPC round-trip;
 * if these drift, the displayed label diverges from the directory the main
 * process actually reads/writes.
 */
describe('encodeWorkspace render-side mirrors encodeCwd main-side', () => {
  const cases: Array<string | null> = [
    null,
    '',
    '   ',
    '/home/user/project',
    '/home/user/projects/my-app',
    'C:\\Users\\foo\\bar',
    '/path with spaces/and stuff',
    '/tmp',
    '/home/user/项目',
    '/home/user/.dotfile',
    '/',
    '~/repo',
  ]

  for (const c of cases) {
    it(`matches for input: ${JSON.stringify(c)}`, () => {
      expect(encodeWorkspace(c)).toBe(encodeCwd(c))
    })
  }
})
