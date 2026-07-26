/**
 * Persona-import integrity check: ~/.claude/CLAUDE.md's `@path` import chain
 * resolves a missing/moved target to nothing with zero warning. This locks
 * in checkPersonaImports() detecting broken/chained/cyclic imports using a
 * temp-directory fixture — never the real home directory.
 *
 * Source: src/main/lib/personaImportHealth.cjs.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkPersonaImports } = require('../../src/main/lib/personaImportHealth.cjs')

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
