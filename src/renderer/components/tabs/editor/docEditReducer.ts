/**
 * docEditReducer — pure phase-transition table for the Document Experience
 * edit flow (PRD 639 + PRD 640 voice extension). Extracted from useDocEdit
 * so the state machine is testable without DOM/audio: every transition here
 * is a plain function of (state, action) -> state, no IO.
 *
 * Phase graph:
 *   idle -> popover (SELECT)
 *   popover/review -> listening (LISTEN)
 *   listening -> review (HEARD)
 *   review -> listening (LISTEN again — "re-record")
 *   popover/review/diff -> thinking (RUN)
 *   thinking -> diff (RUN_OK) | popover (RUN_ERR)
 *   diff -> idle (ACCEPT, editCount + 1)
 *   any -> idle (CANCEL)
 */

export interface SelectionRect {
  top: number
  left: number
  bottom: number
  right: number
}

export interface SelectionInfo {
  text: string
  rect: SelectionRect
}

export type DocEditPhase = 'idle' | 'popover' | 'listening' | 'review' | 'thinking' | 'diff'

export interface DocEditDiff {
  before: string
  after: string
}

export interface DocEditState {
  phase: DocEditPhase
  selection: SelectionInfo | null
  instruction: string
  transcript: string
  diff: DocEditDiff | null
  editCount: number
  modelStatus: string | null
}

export const IDLE_STATE: DocEditState = {
  phase: 'idle',
  selection: null,
  instruction: '',
  transcript: '',
  diff: null,
  editCount: 0,
  modelStatus: null,
}

export type DocEditAction =
  | { type: 'SELECT'; selection: SelectionInfo }
  | { type: 'CANCEL' }
  | { type: 'LISTEN' }
  | { type: 'HEARD'; transcript: string }
  | { type: 'RUN'; instruction: string; recordInstruction: boolean }
  | { type: 'RUN_OK'; diff: DocEditDiff }
  | { type: 'RUN_ERR' }
  | { type: 'ACCEPT' }
  | { type: 'RESET_FILE' }
  | { type: 'MODEL_STATUS'; status: string; message: string }

const RUN_FROM: DocEditPhase[] = ['popover', 'review', 'diff']
/** Exported so useDocEdit's listen() can early-return without duplicating this list. */
export const LISTEN_FROM: DocEditPhase[] = ['popover', 'review']

export function docEditReducer(state: DocEditState, action: DocEditAction): DocEditState {
  switch (action.type) {
    case 'SELECT':
      return { ...IDLE_STATE, editCount: state.editCount, phase: 'popover', selection: action.selection }

    case 'CANCEL':
      return { ...IDLE_STATE, editCount: state.editCount }

    case 'LISTEN':
      if (!LISTEN_FROM.includes(state.phase)) return state
      return { ...state, phase: 'listening', transcript: '', modelStatus: null }

    case 'HEARD':
      if (state.phase !== 'listening') return state
      return { ...state, phase: 'review', transcript: action.transcript, modelStatus: null }

    case 'RUN':
      if (!RUN_FROM.includes(state.phase)) return state
      return {
        ...state,
        phase: 'thinking',
        instruction: action.recordInstruction ? action.instruction : state.instruction,
      }

    case 'RUN_OK':
      if (state.phase !== 'thinking') return state
      return { ...state, phase: 'diff', diff: action.diff }

    case 'RUN_ERR':
      if (state.phase !== 'thinking') return state
      return { ...state, phase: 'popover', transcript: '', diff: null }

    case 'ACCEPT':
      if (state.phase !== 'diff') return state
      return { ...IDLE_STATE, editCount: state.editCount + 1 }

    case 'RESET_FILE':
      return { ...IDLE_STATE, editCount: 0 }

    case 'MODEL_STATUS':
      if (state.phase !== 'listening') return state
      return { ...state, modelStatus: `${action.status}: ${action.message}` }

    default:
      return state
  }
}
