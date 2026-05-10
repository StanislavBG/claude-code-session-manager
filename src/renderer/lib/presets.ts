/**
 * Preconfigured session options shown in the "+ new" dropdown.
 *
 * Two categories:
 *   - `build`  — R&D sessions: Claude Code in a project directory
 *   - `engage` — Marketing sessions: loaded from Local-Browser-Automation's
 *                session-rules.json (source of record for platform limits)
 *
 * `cwd` is one of:
 *   - 'app-cwd'   → resolved at click-time via window.api.app.cwd()
 *   - 'home'      → resolved via window.api.app.homeDir()
 *   - 'pick'      → opens the directory picker
 *   - absolute path string
 *
 * `command` is a template rendered with the chosen {cwd, sessionId}. It is
 * written to the shell after spawn. If null, no command is auto-run (bare shell).
 */

export interface SessionRules {
  intervalMinutes: number
  maxDurationMinutes: number
  windowUtc: [number, number]
  limits: Record<string, number>
  timing?: {
    betweenResponses?: [number, number]
    replyCooldown?: number
  }
}

export interface SessionPreset {
  id: string
  label: string
  description: string
  category: 'build' | 'engage'
  cwd: 'app-cwd' | 'home' | 'pick' | string
  command: ((ctx: { sessionId: string; cwd: string }) => string) | null
  /** Platform identifier for engage presets (x, reddit, linkedin, facebook). */
  platform?: string
  /** Pipeline name in local-browser's orchestrator registry. */
  pipeline?: string
  /** Session rules — limits, timing, scheduling. Only present on engage presets. */
  rules?: SessionRules
  /** Display label for the model this preset launches (e.g. 'opus-4.7'). Optional. */
  model?: string
}

/** Single-quote a value for safe shell interpolation. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

const claudeDangerous = ({ sessionId }: { sessionId: string }) =>
  `claude --dangerously-skip-permissions --session-id ${shellQuote(sessionId)}`
const claudeSafe = ({ sessionId }: { sessionId: string }) =>
  `claude --session-id ${shellQuote(sessionId)}`
const claudeResume = () => `claude --resume`

export const DEFAULT_PRESETS: SessionPreset[] = [
  {
    id: 'sm-dangerous',
    label: 'Session Manager (skip perms)',
    description: 'claude --dangerously-skip-permissions in this project',
    category: 'build',
    cwd: 'app-cwd',
    command: claudeDangerous,
  },
  {
    id: 'sm-safe',
    label: 'Session Manager (safe)',
    description: 'claude with normal permission prompts in this project',
    category: 'build',
    cwd: 'app-cwd',
    command: claudeSafe,
  },
  {
    id: 'home-dangerous',
    label: 'Home (skip perms)',
    description: 'claude --dangerously-skip-permissions in ~',
    category: 'build',
    cwd: 'home',
    command: claudeDangerous,
  },
  {
    id: 'pick-dangerous',
    label: 'Pick directory (skip perms)…',
    description: 'Choose a folder, launch claude --dangerously-skip-permissions',
    category: 'build',
    cwd: 'pick',
    command: claudeDangerous,
  },
  {
    id: 'pick-safe',
    label: 'Pick directory (safe)…',
    description: 'Choose a folder, launch claude with normal prompts',
    category: 'build',
    cwd: 'pick',
    command: claudeSafe,
  },
  {
    id: 'pick-resume',
    label: 'Pick directory + resume…',
    description: 'Choose a folder, then pick a past session to resume',
    category: 'build',
    cwd: 'pick',
    command: claudeResume,
  },
  {
    id: 'pick-shell',
    label: 'Pick directory (shell only)…',
    description: 'Bare interactive shell, no claude auto-launch',
    category: 'build',
    cwd: 'pick',
    command: null,
  },
]

/**
 * Path to session-rules.json — source of record for engage session limits.
 * Read from the `SESSION_MANAGER_ENGAGE_RULES` environment variable at main-process
 * start time. Unset on a fresh install → no engage presets are loaded.
 */
let _engageCache: SessionPreset[] | null = null

/**
 * Load marketing/engage presets from a session-rules.json pointed at by
 * SESSION_MANAGER_ENGAGE_RULES. Returns [] if unset, missing, or malformed.
 */
export async function loadEngagePresets(): Promise<SessionPreset[]> {
  if (_engageCache) return _engageCache

  try {
    const rulesPath = await window.api.app.engageRulesPath()
    if (!rulesPath) {
      _engageCache = []
      return _engageCache
    }
    const result = await window.api.config.readJson(rulesPath)
    if (!result.exists || result.parseError || !result.data) {
      _engageCache = []
      return _engageCache
    }

    const rules = result.data as {
      version: number
      projectPath: string
      presets: Array<{
        id: string
        label: string
        description: string
        platform: string
        pipeline: string
        cliEntry: string
        rules: SessionRules
      }>
    }

    if (!rules.presets || !Array.isArray(rules.presets)) {
      _engageCache = []
      return _engageCache
    }

    const projectPath = rules.projectPath
    _engageCache = rules.presets.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      category: 'engage' as const,
      cwd: projectPath,
      platform: p.platform,
      pipeline: p.pipeline,
      rules: p.rules,
      command: () =>
        `cd ${shellQuote(projectPath)} && ${p.cliEntry}`,
    }))

    return _engageCache
  } catch (e) {
    console.warn('[presets] Failed to load engage presets:', e)
    _engageCache = []
    return _engageCache
  }
}

/** Invalidate the engage preset cache (e.g., after file change). */
export function clearEngageCache(): void {
  _engageCache = null
}

/** Look up a preset by id across both build and engage lists. */
export async function findPreset(presetId: string): Promise<SessionPreset | null> {
  const build = DEFAULT_PRESETS.find((p) => p.id === presetId)
  if (build) return build
  const engage = await loadEngagePresets()
  return engage.find((p) => p.id === presetId) ?? null
}

export async function resolvePresetCwd(
  preset: SessionPreset,
): Promise<string | null> {
  if (preset.cwd === 'app-cwd') return window.api.app.cwd()
  if (preset.cwd === 'home') return window.api.app.homeDir()
  if (preset.cwd === 'pick') return window.api.app.pickDirectory()
  return preset.cwd
}

export function renderCommand(
  preset: SessionPreset,
  ctx: { sessionId: string; cwd: string },
): string | null {
  return preset.command ? preset.command(ctx) : null
}
