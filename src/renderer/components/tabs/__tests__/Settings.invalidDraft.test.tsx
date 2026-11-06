// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Settings } from '../Settings'
import { useConfig } from '../../../state/config'
import { HOME, useNavfaceHarness } from './_navfaceHarness'

type Override = (path: string[], value: unknown) => void
const captured: { onOverride: Override | null } = { onOverride: null }

vi.mock('../../ui/EffectiveCards', () => ({
  EffectiveCards: (props: { onOverride: Override }) => {
    captured.onOverride = props.onOverride
    return null
  },
}))

const USER_PATH = `${HOME}/.claude/settings.json`

function installApi() {
  const raw = '{}\n'
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readJson: vi.fn().mockResolvedValue({ raw, data: {}, exists: true, mtimeMs: 0, parseError: null, error: null }),
      readText: vi.fn().mockResolvedValue({ text: raw, raw, exists: true, mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      writeText: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      exists: vi.fn().mockResolvedValue(true),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

const { mount } = useNavfaceHarness(Settings, installApi)

async function setRaw(raw: string) {
  await act(async () => {
    useConfig.getState().setDraft(USER_PATH, raw)
    await Promise.resolve()
  })
}

describe('Settings overrideInto with an unparseable draft', () => {
  it('refuses the edit, keeps draftRaw byte-identical, shows the error', async () => {
    const el = await mount()
    const bad = '{ "permissions": { oops'
    await setRaw(bad)
    await act(async () => {
      captured.onOverride!(['model'], 'opus')
      await Promise.resolve()
    })
    expect(useConfig.getState().files[USER_PATH].draftRaw).toBe(bad)
    expect(el.textContent).toContain(USER_PATH)
    expect(el.textContent).toContain('fix it in Raw')
  })

  it('a valid draft gains the key', async () => {
    await mount()
    await setRaw('{"a":1}')
    await act(async () => {
      captured.onOverride!(['model'], 'opus')
      await Promise.resolve()
    })
    expect(JSON.parse(useConfig.getState().files[USER_PATH].draftRaw)).toEqual({ a: 1, model: 'opus' })
  })
})
