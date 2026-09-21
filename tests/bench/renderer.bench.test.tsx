// @vitest-environment jsdom
// Renderer micro-benchmarks — run via `npm run bench:renderer` (own vitest
// config; NOT in `npm run test:unit`). Prints a markdown table of median ms
// over REPS. No thresholds: numbers are machine-relative.
import { test } from 'vitest'
import { performance } from 'node:perf_hooks'
import { buildEpicTimeline } from '../../src/renderer/lib/epicTimeline'
import { renderChatMarkdown } from '../../src/renderer/lib/renderChatMarkdown'
import type { ChatTurn } from '../../src/renderer/state/chat'

const REPS = 9

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function timeMedian(fn: () => void): number {
  fn() // warm-up, not sampled
  const samples: number[] = []
  for (let r = 0; r < REPS; r++) {
    const t = performance.now()
    fn()
    samples.push(performance.now() - t)
  }
  return median(samples)
}

function makeTurns(n: number): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (let i = 0; i < n; i++) {
    turns.push({ id: `t${i}`, role: i % 2 === 0 ? 'user' : 'assistant', text: `turn ${i} body text`, at: 1_700_000_000_000 + i * 1000 })
  }
  return turns
}

function makeMarkdown(bytes: number): string {
  const block = '## Heading\n\nSome **bold** text with `code` and a [link](https://example.com).\n\n- item one\n- item two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n'
  let s = ''
  while (s.length < bytes) s += block
  return s.slice(0, bytes)
}

test('renderer bench', () => {
  const rows: Array<[string, number]> = []
  for (const n of [250, 500, 1000]) {
    const turns = makeTurns(n)
    rows.push([`buildEpicTimeline ${n} turns`, timeMedian(() => { buildEpicTimeline(turns, [], 'all' as never) })])
  }
  for (const kb of [4, 40]) {
    const src = makeMarkdown(kb * 1024)
    rows.push([`renderChatMarkdown ${kb} KB (cache: false)`, timeMedian(() => { renderChatMarkdown(src, { cache: false }) })])
  }
  const lines = [`| bench | median ms (n=${REPS}) |`, '| --- | --- |']
  for (const [name, ms] of rows) lines.push(`| ${name} | ${ms.toFixed(ms < 10 ? 3 : 1)} |`)
  console.log(lines.join('\n'))
})
