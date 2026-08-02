import type { BilkoHostDocument, BilkoHostGetResult } from '../../preload/api'

/**
 * Pure Stage-0 compatibility gate for the Host on Bilko.run tab — see
 * session-manager-operations/architecture/bilko-host-integration.md
 * "Compatibility gate (Stage 0)". No IO; takes the already-fetched
 * BilkoHostGetResult and decides what the tab should show.
 */
export type BilkoHostReadiness =
  | { kind: 'no-marketing-page' }
  | { kind: 'private-needs-confirm' }
  | { kind: 'ready' }

export function computeBilkoHostReadiness(info: Pick<BilkoHostGetResult, 'hasMarketingPage' | 'packagePrivate' | 'packageHomepage'>): BilkoHostReadiness {
  if (!info.hasMarketingPage) return { kind: 'no-marketing-page' }
  if (info.packagePrivate && !info.packageHomepage) return { kind: 'private-needs-confirm' }
  return { kind: 'ready' }
}

export const PROJECT_PAGE_LENSES = ['home', 'marketing', 'feature', 'architecture'] as const
export type ProjectPageLens = (typeof PROJECT_PAGE_LENSES)[number]

const LENS_TITLES: Record<ProjectPageLens, string> = {
  home: 'Home page',
  marketing: 'Marketing page',
  feature: 'Feature page',
  architecture: 'Architecture page',
}

export function lensDocumentTitle(lens: ProjectPageLens): string {
  return LENS_TITLES[lens]
}

export interface ProjectPageLensStatus {
  lens: ProjectPageLens
  /** 'root': already the project's root page. 'hosted': already a sub-path document. 'available': not hosted yet — `subpath` is the suggested default. */
  status: 'root' | 'hosted' | 'available'
  subpath: string
  documentId: string | null
}

/**
 * Where each of the 4 generated Project Page lenses stands relative to the
 * current document list — "post all 4 as support" (session-manager-operations/
 * architecture/bilko-host-integration.md) reduces to: Marketing defaults to
 * the root document (seeded server-side the first time any document write
 * happens), and Home/Feature/Architecture default to flat sub-paths named
 * after the lens (bilko.run/projects/<slug>/home/, /feature/, /architecture/)
 * unless the human already hosted them somewhere else. Pure — no IO; the tab
 * renders one row per lens from this.
 */
export function computeProjectPageLensStatus(
  documents: Pick<BilkoHostDocument, 'id' | 'subpath' | 'source'>[],
): ProjectPageLensStatus[] {
  const rootDoc = documents.find((d) => d.subpath === '')
  return PROJECT_PAGE_LENSES.map((lens) => {
    const matching = documents.find((d) => d.source.kind === 'project-page-lens' && d.source.lens === lens)
    if (matching) {
      return {
        lens,
        status: matching.subpath === '' ? 'root' : 'hosted',
        subpath: matching.subpath,
        documentId: matching.id,
      }
    }
    // No document exists yet at all: Marketing will become the root as soon
    // as anything writes documents.json (bilkoHost.cjs's ensureSeededDocuments)
    // — reflect that inevitability rather than showing it as "available".
    if (!rootDoc && lens === 'marketing') {
      return { lens, status: 'root', subpath: '', documentId: null }
    }
    return { lens, status: 'available', subpath: lens, documentId: null }
  })
}

/** Kebab-case a display name into a slug candidate — mirrors bilkoHost.cjs's deriveSlug (renderer-side preview only; the real slug is computed server-side from package.json). */
export function deriveBilkoSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'project'
}
