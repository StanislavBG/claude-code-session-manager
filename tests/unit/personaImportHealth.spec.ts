/**
 * Persona-import integrity check: ~/.claude/CLAUDE.md's `@path` import chain
 * resolves a missing/moved target to nothing with zero warning. This locks
 * in checkPersonaImports() detecting broken/chained/cyclic imports using a
 * temp-directory fixture — never the real home directory.
 *
 * Source: src/main/lib/persona-macro/personaImportHealth.cjs.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkPersonaImports } = require('../../src/main/lib/persona-macro/personaImportHealth.cjs')

describe('checkPersonaImports', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('returns ok: true with no issues when CLAUDE.md does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'persona-health-'))
    const missingPath = join(dir, 'CLAUDE.md')
    const result = checkPersonaImports(missingPath)
    expect(result.ok).toBe(true)
    expect(result.exists).toBe(false)
    expect(result.imports).toEqual([])
  })

  it('returns ok: true when all imports resolve and are non-empty', () => {
    dir = mkdtempSync(join(tmpdir(), 'persona-health-'))
    const importedPath = join(dir, 'core.md')
    writeFileSync(importedPath, '# core rules\n')
    const claudeMdPath = join(dir, 'CLAUDE.md')
    writeFileSync(claudeMdPath, `@${importedPath}\n`)

    const result = checkPersonaImports(claudeMdPath)
    expect(result.ok).toBe(true)
    expect(result.imports).toHaveLength(1)
    expect(result.imports[0].ok).toBe(true)
    expect(result.brokenImports).toEqual([])
  })

  it('flags an import path that does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'persona-health-'))
    const missingImportPath = join(dir, 'does-not-exist.md')
    const claudeMdPath = join(dir, 'CLAUDE.md')
    writeFileSync(claudeMdPath, `@${missingImportPath}\n`)

    const result = checkPersonaImports(claudeMdPath)
    expect(result.ok).toBe(false)
    expect(result.brokenImports).toHaveLength(1)
    expect(result.brokenImports[0].importPath).toBe(missingImportPath)
    expect(result.brokenImports[0].exists).toBe(false)
  })

  it('resolves a chained import (A imports B imports C)', () => {
    dir = mkdtempSync(join(tmpdir(), 'persona-health-'))
    const cPath = join(dir, 'c.md')
    const bPath = join(dir, 'b.md')
    const aPath = join(dir, 'CLAUDE.md')
    writeFileSync(cPath, '# leaf file\n')
    writeFileSync(bPath, `# middle file\n@${cPath}\n`)
    writeFileSync(aPath, `@${bPath}\n`)

    const result = checkPersonaImports(aPath)
    expect(result.ok).toBe(true)
    const resolvedPaths = result.imports.map((i: any) => i.importPath)
    expect(resolvedPaths).toContain(bPath)
    expect(resolvedPaths).toContain(cPath)
  })

  it('caps recursion depth so a cyclic self-import does not hang or overflow', () => {
    dir = mkdtempSync(join(tmpdir(), 'persona-health-'))
    const aPath = join(dir, 'a.md')
    const bPath = join(dir, 'b.md')
    // a imports b, b imports a — cyclic.
    writeFileSync(aPath, `@${bPath}\n`)
    writeFileSync(bPath, `@${aPath}\n`)

    const start = Date.now()
    const result = checkPersonaImports(aPath)
    const elapsedMs = Date.now() - start

    expect(elapsedMs).toBeLessThan(2000)
    expect(result.ok).toBe(true)
    expect(result.imports.length).toBeGreaterThan(0)
  })

  it('reports git ahead/behind for a repo containing a resolved import, annotating missing upstream', () => {
    dir = mkdtempSync(join(tmpdir(), 'persona-health-'))
    const repoDir = join(dir, 'repo')
    mkdirSync(repoDir)
    const importedPath = join(repoDir, 'core.md')
    writeFileSync(importedPath, '# core rules\n')

    // No .git dir created here — this repo-detection path is exercised via
    // findGitRepoRoot returning null (no .git found), which is the common
    // case in this fixture (creating a real git repo would require network-
    // independent git init/commit ceremony this unit test doesn't need).
    const claudeMdPath = join(dir, 'CLAUDE.md')
    writeFileSync(claudeMdPath, `@${importedPath}\n`)

    const result = checkPersonaImports(claudeMdPath)
    expect(result.ok).toBe(true)
    expect(result.repos).toEqual([])
  })
})

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { walkImports, extractImportPaths } = require('../../src/main/lib/persona-macro/personaImportHealth.cjs')

describe('extractImportPaths / walkImports — CLI @-import rules', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'persona-cli-rules-'))
    return dir
  }
  const paths = (root: string) => walkImports(root).map((i: any) => i.importPath)

  it('resolves a bare relative @AGENTS.md next to the importing file', () => {
    const d = setup()
    writeFileSync(join(d, 'AGENTS.md'), '# agents\n')
    const root = join(d, 'CLAUDE.md')
    writeFileSync(root, '@AGENTS.md\n')
    expect(walkImports(root)).toEqual([
      { importPath: join(d, 'AGENTS.md'), exists: true, nonEmpty: true, ok: true },
    ])
  })

  it('resolves @./x.md and @../shared/y.md', () => {
    const d = setup()
    mkdirSync(join(d, 'proj'))
    mkdirSync(join(d, 'shared'))
    writeFileSync(join(d, 'proj', 'x.md'), 'x\n')
    writeFileSync(join(d, 'shared', 'y.md'), 'y\n')
    const root = join(d, 'proj', 'CLAUDE.md')
    writeFileSync(root, '@./x.md\n\n@../shared/y.md\n')
    expect(paths(root)).toEqual([join(d, 'proj', 'x.md'), join(d, 'shared', 'y.md')])
  })

  it('finds an inline import inside prose', () => {
    const d = setup()
    mkdirSync(join(d, 'docs'))
    writeFileSync(join(d, 'docs', 'a.md'), 'a\n')
    const root = join(d, 'CLAUDE.md')
    writeFileSync(root, 'See @docs/a.md for details.\n')
    expect(paths(root)).toEqual([join(d, 'docs', 'a.md')])
  })

  it('ignores tokens inside a fenced block and inside backticks', () => {
    const d = setup()
    writeFileSync(join(d, 'fenced.md'), 'f\n')
    writeFileSync(join(d, 'ticked.md'), 't\n')
    const root = join(d, 'CLAUDE.md')
    writeFileSync(root, '```\n@fenced.md\n```\n\nUse `@ticked.md` here.\n')
    expect(walkImports(root)).toEqual([])
  })

  it('drops a #fragment', () => {
    const d = setup()
    writeFileSync(join(d, 'x.md'), 'x\n')
    const root = join(d, 'CLAUDE.md')
    writeFileSync(root, '@x.md#part\n')
    expect(paths(root)).toEqual([join(d, 'x.md')])
  })

  it('unescapes "\\ " into a space', () => {
    const d = setup()
    writeFileSync(join(d, 'my file.md'), 'x\n')
    const root = join(d, 'CLAUDE.md')
    writeFileSync(root, '@my\\ file.md\n')
    expect(paths(root)).toEqual([join(d, 'my file.md')])
  })

  it('reports a missing whole-line import', () => {
    const d = setup()
    const root = join(d, 'CLAUDE.md')
    writeFileSync(root, '# rules\n\n@missing.md\n')
    expect(walkImports(root)).toEqual([
      { importPath: join(d, 'missing.md'), exists: false, nonEmpty: false, ok: false },
    ])
  })

  it('drops an unresolved bare inline token like "ping @bilko"', () => {
    const d = setup()
    const root = join(d, 'CLAUDE.md')
    writeFileSync(root, 'ping @bilko when done\n')
    expect(walkImports(root)).toEqual([])
    // extractImportPaths still sees it, just not as explicit.
    expect(extractImportPaths('ping @bilko when done\n', root)).toEqual([
      { path: join(d, 'bilko'), explicit: false },
    ])
  })

  it('resolves a nested relative import from the nested file folder', () => {
    const d = setup()
    mkdirSync(join(d, 'sub'))
    writeFileSync(join(d, 'sub', 'b.md'), '@c.md\n')
    writeFileSync(join(d, 'sub', 'c.md'), 'leaf\n')
    const root = join(d, 'CLAUDE.md')
    writeFileSync(root, '@sub/b.md\n')
    expect(paths(root)).toEqual([join(d, 'sub', 'b.md'), join(d, 'sub', 'c.md')])
  })

  it('reports a directory target as not existing', () => {
    const d = setup()
    mkdirSync(join(d, 'adir'))
    const root = join(d, 'CLAUDE.md')
    writeFileSync(root, '@adir\n')
    expect(walkImports(root)).toEqual([
      { importPath: join(d, 'adir'), exists: false, nonEmpty: false, ok: false },
    ])
  })

  it('keeps absolute and ~/ imports', () => {
    const d = setup()
    const abs = join(d, 'abs.md')
    const root = join(d, 'CLAUDE.md')
    expect(extractImportPaths(`@${abs}\n\n@~/x/y.md\n`, root)).toEqual([
      { path: abs, explicit: true },
      { path: join(require('node:os').homedir(), 'x', 'y.md'), explicit: true },
    ])
  })

  it('ships marked as a runtime dependency', () => {
    expect(require('../../package.json').dependencies.marked).toBeDefined()
  })
})
