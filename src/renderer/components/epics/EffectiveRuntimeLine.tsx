import { prettyModel } from '../../lib/prettyModel'
import { formatEffortSegment } from '../../lib/effectiveModelInfo'
import type { EffectiveModelInfo } from '../../lib/effectiveModelInfo'

/**
 * Mirrors agentModelResolve.cjs's FALLBACK_MODEL — the model a dangling
 * agentType actually launches as. Duplicated as a display literal rather
 * than imported: that module is main-process CJS and can't be required from
 * the renderer (CLAUDE.md: no CommonJS in renderer, no ES modules in main).
 */
const FALLBACK_DISPLAY_MODEL = 'sonnet'

interface ModelSegment {
  text: string
  title: string
}

function modelSegment(info: EffectiveModelInfo): ModelSegment {
  if (info.modelSource === 'fallback') {
    return {
      text: `${FALLBACK_DISPLAY_MODEL} · persona not found`,
      title: `Agent "${info.agentType}" has no matching persona file — this session would launch at the fallback model (${FALLBACK_DISPLAY_MODEL}), not a real per-persona choice.`,
    }
  }

  const inherited = info.modelSource === 'inherit'
  const alias = inherited ? 'inherited' : info.modelAlias ?? 'inherited'

  if (!info.resolvedModelId) {
    return {
      text: `${alias} · resolved by the CLI at launch`,
      title: 'No session using this persona has run yet, so the concrete model is unknown — the CLI resolves this alias the moment it launches.',
    }
  }

  const concrete = prettyModel(info.resolvedModelId)
  if (inherited) {
    return {
      text: `inherited → ${concrete} (settings default)`,
      title: `This persona sets no model override, so it runs at the settings default — last observed running as ${concrete}.`,
    }
  }
  return {
    text: `${alias} → ${concrete}`,
    title: `Persona override "${alias}" last observed running as ${concrete}.`,
  }
}

/**
 * Pure formatter behind EffectiveRuntimeLine — exported so a caller that
 * needs a plain string (e.g. EpicAgentTag's own button `title`, which can't
 * hold a ReactNode) renders the identical text instead of a second,
 * divergent copy of this logic.
 */
export function formatEffectiveRuntimeLine(info: EffectiveModelInfo): { text: string; title: string } {
  const model = modelSegment(info)
  const effort = formatEffortSegment(info.effortLevel, info.effortSource)
  return { text: `${model.text} · ${effort}`, title: `${model.title} ${effort}.` }
}

/**
 * One honest line for "what will this agentType actually run as" — alias,
 * evidence-backed concrete model (via prettyModel), effort level, and the
 * provenance of each field. New Session and Epic detail both mount this
 * component rather than carrying their own divergent formatting; Home's
 * machine-wide caption reuses `formatEffortSegment` for the same reason,
 * without needing the model half.
 */
export function EffectiveRuntimeLine({ info }: { info: EffectiveModelInfo }) {
  const { text, title } = formatEffectiveRuntimeLine(info)
  return <span title={title}>{text}</span>
}
