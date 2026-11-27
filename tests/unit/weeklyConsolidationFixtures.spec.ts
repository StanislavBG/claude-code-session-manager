import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const root = path.join(__dirname, '..', 'fixtures', 'weekly-consolidation')

function load(set: string) {
  const dir = path.join(root, set)
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => ({
      name: f,
      base: f.replace(/\.jsonl$/, ''),
      lines: fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    }))
}

function bashCommands(lines: any[]): string[] {
  const out: string[] = []
  for (const l of lines)
    for (const b of l.message?.content ?? [])
      if (b.type === 'tool_use' && b.name === 'Bash') out.push(b.input.command)
  return out
}

describe('weekly-consolidation fixtures', () => {
  const a = load('set-a')
  const b = load('set-b')

  it('has the expected file counts and names', () => {
    expect(a.map((f) => f.name)).toEqual([1, 2, 3].map((n) => `a1000000-0000-4000-8000-00000000000${n}.jsonl`))
    expect(b.map((f) => f.name)).toEqual([1, 2, 3].map((n) => `b1000000-0000-4000-8000-00000000000${n}.jsonl`))
  })

  it('every line parses in transcript shape with a matching sessionId', () => {
    for (const f of [...a, ...b]) {
      expect(f.lines.length).toBeGreaterThanOrEqual(8)
      expect(f.lines.length).toBeLessThanOrEqual(20)
      for (const l of f.lines) {
        expect(['user', 'assistant']).toContain(l.type)
        expect(l.sessionId).toBe(f.base)
        expect(l.timestamp >= '2026-11-16' && l.timestamp < '2026-11-23').toBe(true)
        expect(Array.isArray(l.message.content)).toBe(true)
      }
    }
  })

  it('set-a 001 and 002 each use ffmpeg; no set-b file does', () => {
    for (const f of a.slice(0, 2)) expect(bashCommands(f.lines).some((c) => c.includes('ffmpeg'))).toBe(true)
    for (const f of b) expect(bashCommands(f.lines).some((c) => c.includes('ffmpeg'))).toBe(false)
  })

  it('memory folder has one index line and its file', () => {
    const idx = fs.readFileSync(path.join(root, 'memory', 'MEMORY.md'), 'utf8').trim().split('\n')
    expect(idx).toHaveLength(1)
    const mem = fs.readFileSync(path.join(root, 'memory', 'demo_test_command.md'), 'utf8')
    expect(mem).toMatch(/^---\nname:.*\ndescription:.*\nmetadata:/)
    expect(idx[0] + mem).not.toMatch(/video|transcri/i)
  })
})
