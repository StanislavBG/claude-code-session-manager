// The per-project data every Project Pages slot/variant component renders from.
// Shape matches session-manager-operations/architecture/project-pages-pipeline.md's
// Stage 1 section — a strict superset of ProjectBrief, computed by the
// project-home-builder Epic, never fabricated.

export interface ProjectPageIdentity {
  name: string;
  tag: string;
  version: string;
  oneLine: string;
  claim: string;
  sub: string;
  audience: string;
  install: string;
}

export interface ProjectPageStat {
  v: string;
  k: string;
  n: string;
}

export interface ProjectPagePillar {
  t: string;
  d: string;
  k: string;
}

export interface ProjectPageQuote {
  q: string;
  a: string;
  r: string;
}

export interface ProjectPageFeatureStep {
  t: string;
  d: string;
}

export interface ProjectPageFeatureRule {
  t: string;
  d: string;
}

export type ProjectPageFeatureSpec = [label: string, value: string, note: string];

export interface ProjectPageFeatureFaq {
  q: string;
  a: string;
}

export type ProjectPageTimelineStatus = 'done' | 'next' | 'idea';

export interface ProjectPageTimelineEntry {
  w: string;
  t: string;
  s: ProjectPageTimelineStatus;
}

export interface ProjectPageFeature {
  name: string;
  kicker: string;
  status: string;
  owner: string;
  oneLine: string;
  problem: string;
  solution: string;
  steps: ProjectPageFeatureStep[];
  rules: ProjectPageFeatureRule[];
  specs: ProjectPageFeatureSpec[];
  faq: ProjectPageFeatureFaq[];
  timeline: ProjectPageTimelineEntry[];
}

export type ProjectPageLayerTone = 'accent' | 'butter' | 'sage' | 'mute';

export interface ProjectPageLayer {
  n: string;
  d: string;
  f: string;
  tone: ProjectPageLayerTone;
}

export interface ProjectPageModule {
  n: string;
  d: string;
  f: number;
  dep: string[];
  heat: number;
}

export interface ProjectPageFlowStep {
  a: string;
  b: string;
  t: string;
  n: string;
}

export type ProjectPageDecisionStatus = 'accepted' | 'proposed' | 'superseded';

export interface ProjectPageDecision {
  id: string;
  t: string;
  w: string;
  s: ProjectPageDecisionStatus;
}

export type ProjectPageRiskStatus = 'open' | 'watching' | 'mitigated';

export interface ProjectPageRisk {
  t: string;
  d: string;
  s: ProjectPageRiskStatus;
}

export interface ProjectPageArchitecture {
  summary: string;
  principles: { t: string; d: string }[];
  layers: ProjectPageLayer[];
  modules: ProjectPageModule[];
  flow: ProjectPageFlowStep[];
  decisions: ProjectPageDecision[];
  risks: ProjectPageRisk[];
}

// ── Brief lens source fields (Stage 1's `brief` mapping) ───────────────────
// Read directly off ProjectBrief (session-manager-operations/project-brief/brief.json)
// with no reshaping — field names/shapes mirror ProjectBriefArea/ProjectBriefScopeEntry
// (src/preload/api.d.ts) exactly, not a parallel schema.
export interface ProjectPageBriefArea {
  name: string;
  files: number;
  note: string;
  epic: string | null;
  heat: number;
}

export type ProjectPageBriefScopeKind = 'added' | 'narrowed' | 'decided';

export interface ProjectPageBriefScopeEntry {
  when: string;
  kind: ProjectPageBriefScopeKind;
  text: string;
  src: string;
}

export interface ProjectPageBrief {
  purpose: string;
  what: string[];
  areas: ProjectPageBriefArea[];
  scope: ProjectPageBriefScopeEntry[];
  conventions: string[];
}

export interface ProjectPageSummary {
  identity: ProjectPageIdentity;
  stats: ProjectPageStat[];
  pillars: ProjectPagePillar[];
  feature: ProjectPageFeature;
  architecture: ProjectPageArchitecture;
  quotes: ProjectPageQuote[];
  /** Optional: absent when this project's brief.json has not been generated yet. */
  brief?: ProjectPageBrief;
}

// One slot→variant pick per slot id, per lens.
export type ProjectPagePicks = Record<string, Record<string, string>>;
