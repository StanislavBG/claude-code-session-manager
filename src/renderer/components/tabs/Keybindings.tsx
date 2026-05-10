import { useEffect, useState } from 'react'
import { Panel } from '../ui/Panel'
import { SaveBar } from '../ui/SaveBar'
import { JsonEditor } from '../ui/JsonEditor'
import { EmptyState } from '../ui/EmptyState'
import { useConfig } from '../../state/config'
import { KEYBINDINGS_SCOPES } from '../../lib/scopes'
import { useHomeDir } from '../../lib/useHomeDir'

const DEFAULT_TEMPLATE = `{
  "$schema": "https://json.schemastore.org/claude-code-keybindings.json",
  "bindings": []
}
`

export function Keybindings() {
  const home = useHomeDir()
  const files = useConfig((s) => s.files)
  const loadJson = useConfig((s) => s.loadJson)
  const setDraft = useConfig((s) => s.setDraft)
  const saveJson = useConfig((s) => s.saveJson)
  const revert = useConfig((s) => s.revert)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  const path = home ? KEYBINDINGS_SCOPES.resolve('user', home, null) : null

  useEffect(() => {
    if (!path) return
    if (!files[path]) loadJson(path)
    watchFile(path)
    return () => unwatchFile(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const [saveError, setSaveError] = useState<string | null>(null)

  if (!home || !path) return <EmptyState title="loading…" />

  const file = files[path]

  return (
    <Panel
      toolbar={
        <>
          <span className="text-fg-faint truncate">{path}</span>
          <div className="flex-1" />
          <a
            href="https://code.claude.com/docs/en/keybindings"
            target="_blank"
            rel="noreferrer"
            className="text-fg-faint hover:text-fg-dim underline-offset-2 hover:underline"
          >
            reference ↗
          </a>
        </>
      }
      footer={
        file ? (
          <SaveBar
            dirty={file.dirty}
            busy={file.busy}
            parseError={saveError || file.parseError}
            lastSavedAt={file.lastSavedAt}
            leading={
              file.exists ? (
                <span>restart Claude Code to apply changes</span>
              ) : (
                <span>file will be created on save</span>
              )
            }
            onSave={async () => {
              setSaveError(null)
              const res = await saveJson(path)
              if (!res.ok) setSaveError(res.error ?? 'save failed')
            }}
            onRevert={() => {
              setSaveError(null)
              revert(path)
            }}
          />
        ) : null
      }
    >
      {file ? (
        <JsonEditor
          path={path}
          value={file.draftRaw === '' && !file.exists ? DEFAULT_TEMPLATE : file.draftRaw}
          onChange={(v) => {
            setSaveError(null)
            setDraft(path, v)
          }}
        />
      ) : (
        <EmptyState title="loading…" />
      )}
    </Panel>
  )
}
