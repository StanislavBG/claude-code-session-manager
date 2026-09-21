'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { check } = require('../check-main-ts-check.cjs')

let root
const write = (rel, body) => {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}
const cfg = (include, checkJs = false) =>
  write('tsconfig.main.json', JSON.stringify({ compilerOptions: { checkJs }, include }))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-ts-check-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('check-main-ts-check', () => {
  it('passes when allowlist and directive agree (leading blank lines ok)', () => {
    write('src/main/a.cjs', '\n// @ts-check\n1\n')
    write('src/main/b.cjs', "'use strict'\n")
    write('src/main/__tests__/t.cjs', '// @ts-check\n')
    cfg(['src/main/a.cjs'])
    expect(check(root)).toEqual([])
  })

  it('flags an included file without the directive', () => {
    write('src/main/a.cjs', "'use strict'\n// @ts-check\n")
    cfg(['src/main/a.cjs'])
    expect(check(root).join('\n')).toMatch(/src\/main\/a\.cjs: in include but first non-empty line/)
  })

  it('flags an included file that does not exist', () => {
    cfg(['src/main/gone.cjs'])
    expect(check(root).join('\n')).toMatch(/gone\.cjs: .*does not exist/)
  })

  it('flags a glob in include', () => {
    cfg(['src/main/**/*.cjs'])
    expect(check(root).join('\n')).toMatch(/glob in include/)
  })

  it('flags checkJs not false', () => {
    write('src/main/a.cjs', '// @ts-check\n')
    cfg(['src/main/a.cjs'], true)
    expect(check(root).join('\n')).toMatch(/checkJs must be false/)
  })

  it('flags a directive file missing from include', () => {
    write('src/main/a.cjs', '// @ts-check\n')
    write('src/main/lib/c.cjs', '// @ts-check\n')
    cfg(['src/main/a.cjs'])
    expect(check(root)).toEqual([
      'src/main/lib/c.cjs: starts with "// @ts-check" but is missing from tsconfig.main.json include',
    ])
  })
})
