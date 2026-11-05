import { describe, it, expect, vi } from 'vitest'
import { transcriptExists } from '../transcriptExists'

describe('transcriptExists', () => {
  it('asks transcripts.exists (not config.exists)', async () => {
    const exists = vi.fn().mockResolvedValue(true)
    const cfg = vi.fn()
    vi.stubGlobal('window', { api: { transcripts: { exists }, config: { exists: cfg } } })
    await expect(transcriptExists('/p', 's')).resolves.toBe(true)
    expect(exists).toHaveBeenCalledWith('/p', 's')
    expect(cfg).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
