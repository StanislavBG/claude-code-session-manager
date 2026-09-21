import { Choice } from '../ui/Choice'
import { useModelCatalog } from '../../lib/useModelCatalog'
import { modelFamily } from '../../lib/prettyModel'
import { MODELS, EFFORTS } from '../tabs/AgentLibrary'

/** The default option — writes no field on the Epic, so the persona's own value applies. */
const AGENT_DEFAULT = "agent's setting"
const LATEST = 'latest'

/** Static fallbacks (catalog === null) are the Agent Library's own lists, minus its `inherit` chip. */
const STATIC_MODELS = MODELS.filter((m) => m !== 'inherit')
const STATIC_EFFORTS = EFFORTS.filter((e) => e !== 'inherit')

/**
 * New Session's per-Epic MODEL / EFFORT override. '' = "use the agent's setting" (the default, and
 * the only value that leaves the Epic record without a `model`/`effort` field). The parent owns the
 * state (it needs it at create time) and re-seeds both to '' whenever the selected agent changes.
 */
export function EpicRuntimeOverride({
  cwd,
  personaModel,
  personaEffort,
  model,
  effort,
  onModel,
  onEffort,
}: {
  cwd: string | null
  personaModel: string | null
  personaEffort: string | null
  model: string
  effort: string
  onModel: (v: string) => void
  onEffort: (v: string) => void
}) {
  const { catalog } = useModelCatalog(cwd)
  const aliases = catalog ? catalog.aliases : STATIC_MODELS
  const levels = catalog && catalog.effortLevels.length ? catalog.effortLevels : STATIC_EFFORTS

  const family = modelFamily(model)
  const suffix = /\[[^\]]*\]$/.exec(model)?.[0] ?? ''
  // A pinned concrete id (claude-opus-5) maps back to its family alias so the alias row shows it selected.
  const alias = family && model.startsWith('claude-') ? family + suffix : model
  const showVersion = !!catalog && !!family && aliases.includes(alias)
  const versions = showVersion ? catalog!.models.filter((id) => modelFamily(id) === family).map((id) => id + suffix) : []

  const personaLabel = (v: string | null) => (v && v !== 'inherit' ? v : 'none set')

  return (
    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="new-epic-runtime-override">
      <div className="min-w-0" data-testid="new-epic-model-override">
        <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.09em] text-fg-faint" title="Overrides the agent's model for THIS session only.">
          model · agent: {personaLabel(personaModel)}
        </div>
        <Choice options={[AGENT_DEFAULT, ...aliases]} value={model ? alias : AGENT_DEFAULT} onChange={(v) => onModel(v === AGENT_DEFAULT ? '' : v)} mono />
        {showVersion && (
          <div className="mt-1" data-testid="new-epic-model-version-row">
            <Choice
              options={[LATEST, ...versions]}
              value={model === alias ? LATEST : model}
              onChange={(v) => onModel(v === LATEST ? alias : v)}
              mono
            />
          </div>
        )}
      </div>
      <div className="min-w-0" data-testid="new-epic-effort-override">
        <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.09em] text-fg-faint" title="Overrides the agent's effort for THIS session only.">
          effort · agent: {personaLabel(personaEffort)}
        </div>
        <Choice options={[AGENT_DEFAULT, ...levels]} value={effort || AGENT_DEFAULT} onChange={(v) => onEffort(v === AGENT_DEFAULT ? '' : v)} mono />
      </div>
    </div>
  )
}
