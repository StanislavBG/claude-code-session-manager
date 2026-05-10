/**
 * Curated groupings for the ~60 top-level keys in settings.json. Schema
 * order is alphabetical and technical — this module organizes keys into
 * themed sections with plain-English titles and one-line group summaries
 * so the Settings tab can surface what matters first and hide enterprise
 * knobs behind an "advanced" toggle.
 *
 * Keys not listed here fall through into a single "Other" group at render
 * time. When Claude Code adds new keys, they'll auto-appear in "Other"
 * until someone slots them into a themed group.
 */

export interface SettingGroup {
  id: string
  title: string
  /** One-line summary shown below the group title. */
  summary: string
  /** Keys appear in this exact order within the group. */
  keys: string[]
  /** Hide from the default view; shown behind "show advanced". */
  advanced?: boolean
}

export const SETTINGS_GROUPS: SettingGroup[] = [
  {
    id: 'essentials',
    title: 'Essentials',
    summary: 'The knobs you reach for first.',
    keys: ['model', 'language', 'outputStyle', 'permissions'],
  },
  {
    id: 'git',
    title: 'Git & Commits',
    summary: 'How Claude writes commits and pull requests on your behalf.',
    keys: ['attribution', 'includeGitInstructions', 'includeCoAuthoredBy'],
  },
  {
    id: 'memory',
    title: 'Memory & Plans',
    summary: 'Context Claude keeps between sessions and where it files plans.',
    keys: [
      'autoMemoryEnabled',
      'plansDirectory',
      'claudeMdExcludes',
      'respectGitignore',
    ],
  },
  {
    id: 'model',
    title: 'Model & Reasoning',
    summary: 'Which model runs, how hard it thinks, and fast-mode toggles.',
    keys: [
      'availableModels',
      'modelOverrides',
      'effortLevel',
      'fastMode',
      'fastModePerSessionOptIn',
      'alwaysThinkingEnabled',
    ],
  },
  {
    id: 'interface',
    title: 'Interface',
    summary: 'Visual polish — spinners, progress bars, motion.',
    keys: [
      'spinnerTipsEnabled',
      'spinnerTipsOverride',
      'spinnerVerbs',
      'terminalProgressBarEnabled',
      'showTurnDuration',
      'prefersReducedMotion',
      'companyAnnouncements',
      'statusLine',
      'teammateMode',
    ],
  },
  {
    id: 'updates',
    title: 'Updates & Cleanup',
    summary: 'Release channel and how long transcripts stick around.',
    keys: ['autoUpdatesChannel', 'cleanupPeriodDays'],
  },
  {
    id: 'env',
    title: 'Environment & Auth',
    summary: 'Environment variables and auth-helper scripts.',
    keys: ['env', 'apiKeyHelper', 'awsCredentialExport', 'awsAuthRefresh'],
  },
  {
    id: 'hooks',
    title: 'Hooks',
    summary: 'Scripts Claude runs before/after tool use.',
    keys: ['hooks', 'disableAllHooks', 'allowedHttpHookUrls', 'httpHookAllowedEnvVars'],
  },
  {
    id: 'mcp',
    title: 'MCP Servers',
    summary: 'External tool providers Claude can talk to.',
    keys: [
      'enableAllProjectMcpServers',
      'enabledMcpjsonServers',
      'disabledMcpjsonServers',
    ],
  },
  {
    id: 'plugins',
    title: 'Plugins',
    summary: 'Installed plugins, marketplaces, and per-plugin configuration.',
    keys: [
      'enabledPlugins',
      'extraKnownMarketplaces',
      'skippedPlugins',
      'skippedMarketplaces',
      'pluginConfigs',
    ],
  },
  {
    id: 'filesystem',
    title: 'File Picker & Sandbox',
    summary: 'How Claude browses files and the sandbox it runs in.',
    keys: ['fileSuggestion', 'sandbox', 'worktree'],
  },
  {
    id: 'login',
    title: 'Login',
    summary: 'Which login method to force on startup.',
    keys: ['forceLoginMethod', 'forceLoginOrgUUID'],
  },
  {
    id: 'feedback',
    title: 'Feedback',
    summary: 'Session-quality surveys.',
    keys: ['feedbackSurveyRate'],
  },
  {
    id: 'advanced',
    title: 'Advanced / Enterprise',
    summary: 'Managed-settings-only keys and enterprise allow/denylists.',
    advanced: true,
    keys: [
      'allowedMcpServers',
      'deniedMcpServers',
      'allowManagedHooksOnly',
      'allowManagedPermissionRulesOnly',
      'allowManagedMcpServersOnly',
      'strictKnownMarketplaces',
      'blockedMarketplaces',
      'pluginTrustMessage',
      'otelHeadersHelper',
      'skipWebFetchPreflight',
    ],
  },
]

/**
 * Turn camelCase schema keys into human titles:
 *   autoMemoryEnabled → "Auto memory enabled"
 *   includeCoAuthoredBy → "Include co authored by"
 *   MCPServers edge-case handled via replacements map.
 */
const WORD_FIXES: Record<string, string> = {
  mcp: 'MCP',
  url: 'URL',
  urls: 'URLs',
  http: 'HTTP',
  ui: 'UI',
  id: 'ID',
  uuid: 'UUID',
  api: 'API',
  aws: 'AWS',
  otel: 'OTel',
  json: 'JSON',
}

export function humanizeKey(key: string): string {
  // $schema and similar prefixed keys → strip leading $
  const k = key.replace(/^\$/, '')
  // Split camelCase & PascalCase
  const parts = k
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return parts
    .map((p, i) => {
      const fixed = WORD_FIXES[p]
      if (fixed) return fixed
      if (i === 0) return p.charAt(0).toUpperCase() + p.slice(1)
      return p
    })
    .join(' ')
}

/**
 * Compute the rendering plan for a set of known + present keys:
 *  - return groups in SETTINGS_GROUPS order, each with the subset of its
 *    declared keys that actually exist in the schema (or in data)
 *  - collect unknown keys (present or known but not grouped) into "Other"
 *  - advanced groups are flagged so the UI can hide them behind a toggle
 */
export interface GroupPlan {
  id: string
  title: string
  summary: string
  advanced: boolean
  keys: string[]
}

export function planGroups(allKeys: Set<string>): GroupPlan[] {
  const placed = new Set<string>()
  const plans: GroupPlan[] = []
  for (const g of SETTINGS_GROUPS) {
    const keys = g.keys.filter((k) => allKeys.has(k))
    keys.forEach((k) => placed.add(k))
    if (keys.length === 0) continue
    plans.push({
      id: g.id,
      title: g.title,
      summary: g.summary,
      advanced: !!g.advanced,
      keys,
    })
  }
  const other = Array.from(allKeys)
    .filter((k) => !placed.has(k) && k !== '$schema')
    .sort()
  if (other.length > 0) {
    plans.push({
      id: 'other',
      title: 'Other',
      summary: 'Keys not yet grouped.',
      advanced: false,
      keys: other,
    })
  }
  return plans
}
