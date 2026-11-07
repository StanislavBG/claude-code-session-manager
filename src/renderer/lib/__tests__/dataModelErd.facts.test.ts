import { describe, expect, it } from 'vitest'
import { erdEntity } from '../dataModelErd'

describe('dataModelErd on-disk facts', () => {
  it('ScheduleConfig lives in scheduler-machine.json under ~/.claude/session-manager', () => {
    const { path } = erdEntity('scheduleConfig').store
    expect(path).toContain('~/.claude/session-manager/scheduler-machine.json')
    expect(path).not.toContain('queue.json')
  })

  it('Macro entity names macros.json and macroLibrary.cjs', () => {
    const { store } = erdEntity('macro')
    expect(store.path).toBe('~/.claude/session-manager/macros.json')
    expect(store.writer).toBe('src/main/lib/persona-macro/macroLibrary.cjs')
  })

  it('app preferences entity lists all three pref files with owner libs', () => {
    const { store } = erdEntity('appPrefs')
    for (const [file, lib] of [
      ['app-prefs.json', 'appPrefs.ts'],
      ['ui-settings-prefs.json', 'uiSettingsPrefs.ts'],
      ['ui-chrome-prefs.json', 'uiChromePrefs.ts'],
    ]) {
      expect(store.path).toContain(file)
      expect(store.definedIn).toContain(lib)
    }
  })

  it('AgentPersona has effort, no live action fields; Tag says 7', () => {
    const names = erdEntity('agentPersona').fields.map((f) => f.name)
    expect(names).toContain('effort')
    expect(names).not.toContain('action')
    expect(names).not.toContain('actionLabel')
    const tag = erdEntity('tag')
    expect(tag.summary).toContain('7')
    expect(tag.summary).not.toContain('5-taxonomy')
  })
})
