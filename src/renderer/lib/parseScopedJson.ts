/**
 * Turn a map of scope→path + file cache into merge-engine inputs. Parses each
 * scope's current draft (so unsaved edits appear immediately in the Effective
 * view). Scopes whose file is missing, empty, or unparseable are skipped —
 * errors surface in the Raw view's SaveBar, not here.
 */

import type { Scope } from './scopes'
import type { FileState } from '../state/config'
import type { ScopeInput } from './mergeScopes'

/** Low→high precedence order required by mergeScopes(). */
const ORDER: Scope[] = ['user', 'project', 'local']

export function parseScopedJson(
  files: Record<string, FileState>,
  paths: Partial<Record<Scope, string>>
): ScopeInput[] {
  const out: ScopeInput[] = []
  for (const scope of ORDER) {
    const p = paths[scope]
    if (!p) continue
    const f = files[p]
    if (!f || !f.exists) continue
    const raw = f.draftRaw ?? ''
    if (!raw.trim()) continue
    try {
      out.push({ scope, data: JSON.parse(raw) })
    } catch {
      // skip — raw-view editor surfaces the parse error
    }
  }
  return out
}
