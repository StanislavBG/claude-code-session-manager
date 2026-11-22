/**
 * Test helper: the real EditorStatusBar for a stubbed DocumentEditorPane, driven by the same
 * props the pane forwards (dirty / isNew / readOnly / onSave / onRevert). Monaco and Tiptap do
 * not render in jsdom, so suites stub the pane — this keeps its one footer (Save, Revert, the
 * save-state copy) real, mirroring DocumentEditorPane's own saveState rule.
 */
import { createElement } from 'react'
import { EditorStatusBar, type SaveState } from '../editor/EditorStatusBar'

export interface StubPaneProps {
  value: string
  dirty?: boolean
  isNew?: boolean
  readOnly?: boolean
  onSave?: () => void
  onRevert?: () => void
}

export function stubStatusBar(p: StubPaneProps) {
  const saveState: SaveState | undefined =
    p.dirty === undefined && !p.isNew ? undefined : p.dirty ? 'dirty' : p.isNew ? 'new' : 'saved'
  return createElement(EditorStatusBar, {
    text: p.value,
    cursor: null,
    saveState,
    dirty: !!p.dirty,
    isNew: p.isNew,
    onSave: p.readOnly ? undefined : p.onSave,
    onRevert: p.readOnly ? undefined : p.onRevert,
  })
}
