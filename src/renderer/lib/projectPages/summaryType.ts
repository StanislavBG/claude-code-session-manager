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

export interface ProjectPageSummary {
  identity: ProjectPageIdentity;
  stats: ProjectPageStat[];
  pillars: ProjectPagePillar[];
  feature: ProjectPageFeature;
  architecture: ProjectPageArchitecture;
  quotes: ProjectPageQuote[];
}

// One slot→variant pick per slot id, per lens.
export type ProjectPagePicks = Record<string, Record<string, string>>;
