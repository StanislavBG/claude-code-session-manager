import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)

const { scanAggrLines, parseJSONL } =
  require('../../src/main/historyAggregator.cjs')

// Price-table and resolver tests live with the module: src/main/lib/claude/__tests__/modelPricing.test.cjs.

describe('scanAggrLines byModel bucketing', () => {
  it('accumulates per-model token buckets alongside the flat totals', () => {
    const acc: any = {
      promptCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      toolCallCount: 0, toolBreakdown: {}, byModel: {} as Record<string, any>, errorCount: 0,
    }
    const lines = [
      JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-5', usage: {
        input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5,
      } } }),
      JSON.stringify({ message: { role: 'assistant', model: 'claude-opus-4-8-20260115', usage: {
        input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      } } }),
      // a second sonnet line to verify same-model buckets sum, not overwrite
      JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-5', usage: {
        input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1,
      } } }),
      // no model on this line — must not touch byModel or throw
      JSON.stringify({ type: 'tool_result', is_error: false }),
    ]
    scanAggrLines(lines, acc, false)

    expect(acc.inputTokens).toBe(121)
    expect(acc.outputTokens).toBe(61)
    expect(acc.byModel['claude-sonnet-5']).toEqual({
      inputTokens: 101, outputTokens: 51, cacheReadTokens: 11, cacheCreationTokens: 6, cacheCreation1hTokens: 0,
    })
    expect(acc.byModel['claude-opus-4-8-20260115']).toEqual({
      inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0,
    })
  })
})

describe('parseJSONL tail-merge preserves byModel across appends', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await fsp.rm(dir, { recursive: true, force: true })
  })

  it('merges per-model buckets by key-sum on an append-only tail parse', async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-hist-test-'))
    const file = path.join(dir, 'session.jsonl')
    const sonnetLine = JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-5', usage: {
      input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0,
    } } })
    await fsp.writeFile(file, sonnetLine + '\n')
    let stat = await fsp.stat(file)
    const first = await parseJSONL(file, stat)
    expect(first.result.byModel['claude-sonnet-5'].inputTokens).toBe(100)

    // Append a second line for the SAME model — must sum, not replace.
    await fsp.appendFile(file, sonnetLine + '\n')
    stat = await fsp.stat(file)
    const second = await parseJSONL(file, stat)
    expect(second.cacheHit).toBe(false)
    expect(second.result.byModel['claude-sonnet-5'].inputTokens).toBe(200)
    expect(second.result.byModel['claude-sonnet-5'].outputTokens).toBe(100)

    // Exact same stat again → cache hit, same result.
    const third = await parseJSONL(file, stat)
    expect(third.cacheHit).toBe(true)
    expect(third.result.byModel['claude-sonnet-5'].inputTokens).toBe(200)
  })
})

describe('remote.aggregate', () => {
  // PROJECTS_DIR (historyAggregator.cjs), ROLLUP_PATH (historyRollup.cjs), and
  // allowedRoots/WRITE_PREFIXES (config.cjs) are all computed from
  // os.homedir() once at first require — so a bare re-require after
  // overriding HOME would still see the real paths. Purging these three
  // modules from require.cache and re-requiring under a fixture HOME (same
  // pattern as src/main/__tests__/historyAggregatorIntraday.test.cjs and
  // historyRollup.test.cjs) is what makes the scan hermetic instead of
  // walking the developer's real ~/.claude/projects tree.
  const MODULES_TO_RELOAD = [
    '../../src/main/lib/historyRollup.cjs',
    '../../src/main/historyAggregator.cjs',
    '../../src/main/config.cjs',
  ]

  function purgeRequireCache() {
    for (const m of MODULES_TO_RELOAD) {
      try { delete require.cache[require.resolve(m)] } catch { /* not loaded yet */ }
    }
  }

  let realHome: string | undefined
  let tmpHome: string
  let freshAggregator: any

  beforeEach(async () => {
    realHome = process.env.HOME
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-hist-aggregate-test-'))
    process.env.HOME = tmpHome

    const projectsDir = path.join(tmpHome, '.claude', 'projects')
    const proj1 = path.join(projectsDir, 'test-project-one')
    const proj2 = path.join(projectsDir, 'test-project-two')
    await fsp.mkdir(proj1, { recursive: true })
    await fsp.mkdir(proj2, { recursive: true })

    const assistantLine = (
      model: string,
      tokens: { in: number; out: number; cacheR: number; cacheC: number },
    ) =>
      JSON.stringify({
        message: {
          role: 'assistant',
          model,
          usage: {
            input_tokens: tokens.in,
            output_tokens: tokens.out,
            cache_read_input_tokens: tokens.cacheR,
            cache_creation_input_tokens: tokens.cacheC,
          },
        },
      })

    await fsp.writeFile(
      path.join(proj1, 'session.jsonl'),
      [
        assistantLine('claude-sonnet-5', { in: 1000, out: 500, cacheR: 200, cacheC: 100 }),
        assistantLine('claude-opus-4-8-20260115', { in: 2000, out: 1000, cacheR: 0, cacheC: 0 }),
      ].join('\n') + '\n',
    )
    await fsp.writeFile(
      path.join(proj2, 'session.jsonl'),
      assistantLine('claude-haiku-4-5-20251001', { in: 500, out: 250, cacheR: 50, cacheC: 0 }) + '\n',
    )

    purgeRequireCache()
    freshAggregator = require('../../src/main/historyAggregator.cjs')
  })

  afterEach(async () => {
    process.env.HOME = realHome
    purgeRequireCache()
    await fsp.rm(tmpHome, { recursive: true, force: true })
  })

  it('returns concrete rows/costUsd/cacheSavingsUsd computed from a hermetic fixture corpus, not the real ~/.claude/projects tree', async () => {
    const result = await freshAggregator.remote.aggregate({})

    expect(Array.isArray(result.rows)).toBe(true)
    expect(result.rows.length).toBe(2)
    expect(typeof result.scannedMs).toBe('number')

    const row1 = result.rows.find((r: any) => r.encodedCwd === 'test-project-one')
    const row2 = result.rows.find((r: any) => r.encodedCwd === 'test-project-two')
    expect(row1).toBeTruthy()
    expect(row2).toBeTruthy()

    expect(row1.byModel['claude-sonnet-5'].inputTokens).toBe(1000)
    expect(row1.byModel['claude-sonnet-5'].outputTokens).toBe(500)
    expect(row1.byModel['claude-sonnet-5'].cacheReadTokens).toBe(200)
    expect(row1.byModel['claude-sonnet-5'].cacheCreationTokens).toBe(100)
    // Priced by lib/claude/modelPricing.cjs. These fixture lines carry no 1-hour split object, so the
    // parser records cacheCreation1hTokens: 0 and every cache write is a 5-minute write.
    // sonnet-5 ($2/$10, cache read $0.20): 1000*2 + 500*10 + 200*0.2 + 100*2*1.25, per million
    expect(row1.byModel['claude-sonnet-5'].costUsd).toBeCloseTo(0.00729, 10)
    expect(row1.byModel['claude-sonnet-5'].estimated).toBeUndefined()
    // opus-4-8 ($5/$25): 2000*5 + 1000*25, per million
    expect(row1.byModel['claude-opus-4-8-20260115'].costUsd).toBeCloseTo(0.035, 10)
    // haiku-4-5 ($1/$5, cache read $0.10): 500*1 + 250*5 + 50*0.1, per million
    expect(row2.byModel['claude-haiku-4-5-20251001'].costUsd).toBeCloseTo(0.001755, 10)

    // cache-read savings = cacheReadTokens * (inputRate - cacheReadRate), summed across models:
    // sonnet 200*(2-0.2)/1e6 + opus 0 + haiku 50*(1-0.1)/1e6
    expect(result.cacheSavingsUsd).toBeCloseTo(0.000405, 10)
  })
})
