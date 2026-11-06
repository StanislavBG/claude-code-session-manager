import { shellQuote, modelFlag, effortFlag } from './presets'

// Re-exported so the Epic launch surface has one home for its flag helpers
// (the implementations stay in presets.ts, shared with the tab launchers).
export { shellQuote, modelFlag, effortFlag }

/** Plugin key of the dev plugin in `enabledPlugins`. MUST equal ENABLED_KEY in
 *  src/main/seedDevPlugin.cjs (the renderer cannot import main). */
export const DEV_PLUGIN_ENABLED_KEY = 'session-manager-dev@session-manager'

export interface EpicClaudeCommandInput {
  sessionId: string
  resume: boolean
  model?: string
  effort?: string | null
  /** false = Epic started with the develop loop off; absent/true = on. */
  developLoop?: boolean
}

/** The line typed into an Epic Terminal pane's shell (trailing CR included). */
export function buildEpicClaudeCommand({ sessionId, resume, model, effort, developLoop }: EpicClaudeCommandInput): string {
  const flag = resume ? `--resume ${shellQuote(sessionId)}` : `--session-id ${shellQuote(sessionId)}`
  const settings =
    developLoop === false
      ? ` --settings ${shellQuote(JSON.stringify({ enabledPlugins: { [DEV_PLUGIN_ENABLED_KEY]: false } }))}`
      : ''
  return `claude --dangerously-skip-permissions ${flag}${modelFlag(model)}${effortFlag(effort)}${settings}\r`
}
