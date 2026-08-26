import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)

const { remote, MODEL_PRICING, scanAggrLines, parseJSONL, resolvePricingKey } =
  require('../../src/main/historyAggregator.cjs')

describe('MODEL_PRICING', () => {
  it('has opus/sonnet/haiku buckets with input/output/cache-read rates', () => {
    for (const key of ['opus', 'sonnet', 'haiku']) {
      expect(MODEL_PRICING[key]).toBeTruthy()
      expect(typeof MODEL_PRICING[key].i).toBe('number')
      expect(typeof MODEL_PRICING[key].o).toBe('number')
      expect(typeof MODEL_PRICING[key].c).toBe('number')
    }
  })

  it('prices cache-read tokens far below input tokens (the cache-savings premise)', () => {
    for (const key of ['opus', 'sonnet', 'haiku']) {
      expect(MODEL_PRICING[key].c).toBeLessThan(MODEL_PRICING[key].i)
    }
  })
})

describe('resolvePricingKey', () => {
  it('matches opus/sonnet/haiku by case-insensitive substring', () => {
    expect(resolvePricingKey('claude-opus-4-8-20260115')).toEqual({ key: 'opus', estimated: false })
    expect(resolvePricingKey('claude-sonnet-5')).toEqual({ key: 'sonnet', estimated: false })
    expect(resolvePricingKey('claude-HAIKU-4-5-20251001')).toEqual({ key: 'haiku', estimated: false })
  })

  it('falls back to sonnet, flagged as estimated, for unrecognized ids', () => {
    expect(resolvePricingKey('some-future-model-x')).toEqual({ key: 'sonnet', estimated: true })
    expect(resolvePricingKey(undefined)).toEqual({ key: 'sonnet', estimated: true })
  })
})

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
      inputTokens: 101, outputTokens: 51, cacheReadTokens: 11, cacheCreationTokens: 6,
    })
    expect(acc.byModel['claude-opus-4-8-20260115']).toEqual({
      inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0,
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
    // (1000 input + 100 cache-creation) * $3/1e6 + 500 output * $15/1e6 + 200 cache-read * $0.3/1e6
    expect(row1.byModel['claude-sonnet-5'].costUsd).toBeCloseTo(0.01086, 10)
    // 2000 input * $15/1e6 + 1000 output * $75/1e6
    expect(row1.byModel['claude-opus-4-8-20260115'].costUsd).toBeCloseTo(0.105, 10)
    // 500 input * $0.8/1e6 + 250 output * $4/1e6 + 50 cache-read * $0.08/1e6
    expect(row2.byModel['claude-haiku-4-5-20251001'].costUsd).toBeCloseTo(0.001404, 10)

    // cache-read savings = cacheReadTokens * (inputRate - cacheReadRate), summed across models:
    // sonnet 200*(3-0.3)/1e6 + opus 0 + haiku 50*(0.8-0.08)/1e6
    expect(result.cacheSavingsUsd).toBeCloseTo(0.000576, 10)
  })
})
