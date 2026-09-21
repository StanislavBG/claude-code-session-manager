'use strict'

const { checkSource } = require('../check-explicit-any.cjs')

const lines = (src) => checkSource('x.ts', src).map((v) => v.line)

describe('check-explicit-any', () => {
  it('flags each explicit-any form', () => {
    const src = [
      'let a: any = 1',
      'const b = x as any',
      'const c = <any>x',
      'let d: any[] = []',
      'let e: Record<string, any> = {}',
      '// @ts-ignore',
      '/* @ts-nocheck */',
    ].join('\n')
    expect(lines(src)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('honours the allow marker only with a reason', () => {
    expect(lines('let a: any = 1 // lint-allow-any: vendor typing gap')).toEqual([])
    expect(lines('let a: any = 1 // lint-allow-any:')).toEqual([1])
  })

  it('ignores any inside comments and strings; allows unknown/company', () => {
    const src = [
      '// let a: any = 1',
      '/* x as any',
      '   y: any */',
      "const s = 'a: any'",
      'const t = `as any`',
      'let u: unknown = 1',
      'const anyone = 2',
    ].join('\n')
    expect(lines(src)).toEqual([])
  })
})
