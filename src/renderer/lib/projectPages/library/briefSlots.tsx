// Brief — the 5th lens. Renders `summary.brief` (Stage 1's 1:1 mapping onto
// ProjectBrief's purpose/what/areas/scope/conventions, see summaryType.ts) as
// a static document — the generated form of what ProjectHome.tsx's PhWhat/
// PhAreas/PhScope/PhConventions render live today. Field semantics (and the
// heat/tone/markdown logic below) are ported from
// src/renderer/lib/projectBriefView.ts — the LOGIC only, never the Tailwind
// class strings it returns, since those don't work inside inline-styled
// static HTML. PhNow/PhOpenQuestions (live Epic-queue + open-question state)
// are deliberately NOT part of this lens — see the pipeline spec's "stays
// live React" boundary.
import type { ReactNode } from 'react';
import { PK, PkEyebrow, PkPill, PkSection, PkH, PkBody } from './kit';
import type { ProjectPageSummary, ProjectPageBrief, ProjectPageBriefScopeKind } from '../summaryType';
import type { PageLensDef } from './types';

type P = { summary: ProjectPageSummary };

// Never fabricate: a project whose brief.json has not been generated yet has
// no `summary.brief` — every slot below renders an honest empty state rather
// than invented content.
const EMPTY_BRIEF: ProjectPageBrief = { purpose: '', what: [], areas: [], scope: [], conventions: [] };

function brief(summary: ProjectPageSummary): ProjectPageBrief {
  return summary.brief ?? EMPTY_BRIEF;
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <PkBody size={13} style={{ color: PK.inkMute, fontStyle: 'italic' }}>{children}</PkBody>;
}

// ── mini-markdown (ported from projectBriefView.ts's tokenizeMd) ──────────
type MdToken = { type: 'text' | 'bold' | 'code'; text: string };

function tokenizeMd(text: string): MdToken[] {
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  const tokens: MdToken[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      tokens.push({ type: 'bold', text: part.slice(2, -2) });
    } else if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      tokens.push({ type: 'code', text: part.slice(1, -1) });
    } else {
      tokens.push({ type: 'text', text: part });
    }
  }
  return tokens;
}

function Md({ text }: { text: string }) {
  return <>{tokenizeMd(text).map((tok, i) => {
    if (tok.type === 'bold') return <strong key={i} style={{ color: PK.ink, fontWeight: 600 }}>{tok.text}</strong>;
    if (tok.type === 'code') return <code key={i} style={{ fontFamily: PK.mono, fontSize: '0.92em', background: PK.panel, borderRadius: 4, padding: '1px 5px' }}>{tok.text}</code>;
    return <span key={i}>{tok.text}</span>;
  })}</>;
}

// ── heat (ported from projectBriefView.ts's heatPercent) ──────────────────
function heatPercent(heat: number): number {
  if (typeof heat !== 'number' || !Number.isFinite(heat)) return 0;
  return Math.max(0, Math.min(100, Math.round(heat * 100)));
}

// ── scope kind → tone (ported from projectBriefView.ts's scopeTone, mapped
// onto PK's palette instead of Tailwind classes) ───────────────────────────
const SCOPE_TONE: Record<ProjectPageBriefScopeKind, { label: string; color: string }> = {
  added: { label: 'added', color: PK.sage },
  narrowed: { label: 'narrowed', color: PK.accentDeep },
  decided: { label: 'decided', color: PK.butter },
};

function scopeTone(kind: string): { label: string; color: string } {
  const known = SCOPE_TONE[kind as ProjectPageBriefScopeKind];
  if (known) return known;
  return { label: kind, color: PK.inkMute };
}

// ── PURPOSE ─────────────────────────────────────────────────────────────
function BfPurposeProse({ summary }: P) {
  const b = brief(summary);
  return <PkSection pad="72px 80px 48px">
    <PkEyebrow>the project</PkEyebrow>
    <PkH size={38} style={{ marginTop: 14, maxWidth: 760 }}>{b.purpose || summary.identity.claim}</PkH>
    <div style={{ marginTop: 26, display: 'grid', gap: 16, maxWidth: 720 }}>
      {b.what.length
        ? b.what.map((p, i) => <PkBody key={i} size={15}><Md text={p} /></PkBody>)
        : <EmptyNote>No &quot;what this is&quot; summary generated yet.</EmptyNote>}
    </div>
  </PkSection>;
}
function BfPurposeQuote({ summary }: P) {
  const b = brief(summary);
  return <PkSection pad="64px 80px" style={{ background: PK.deep, color: PK.paper }}>
    <PkEyebrow tone={PK.butter}>the project</PkEyebrow>
    <div style={{ fontFamily: PK.serif, fontSize: 34, lineHeight: 1.25, color: PK.paper, marginTop: 16, maxWidth: 760 }}>
      {b.purpose || summary.identity.claim}
    </div>
    <div style={{ marginTop: 24, display: 'grid', gap: 10, maxWidth: 680 }}>
      {b.what.length
        ? b.what.map((p, i) => <div key={i} style={{ fontFamily: PK.sans, fontSize: 14, lineHeight: 1.6, color: '#bdaf97' }}><Md text={p} /></div>)
        : <div style={{ fontFamily: PK.sans, fontSize: 13, color: '#8a7a60', fontStyle: 'italic' }}>No &quot;what this is&quot; summary generated yet.</div>}
    </div>
  </PkSection>;
}

// ── AREAS (how it's put together) ──────────────────────────────────────
function BfAreasTable({ summary }: P) {
  const b = brief(summary);
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>structure</PkEyebrow>
    <PkH size={28} style={{ marginTop: 12, maxWidth: 620 }}>How it&apos;s put together.</PkH>
    <div style={{ marginTop: 24 }}>
      {b.areas.length ? b.areas.map((a, i) => (
        <div key={a.name} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1.15fr) 120px', gap: 20, alignItems: 'center', padding: '16px 0', borderTop: i ? `1px solid ${PK.rule}` : 'none' }}>
          <span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontFamily: PK.mono, fontSize: 13, fontWeight: 600, color: PK.ink }}>{a.name}</span>
              <span style={{ fontFamily: PK.mono, fontSize: 11, color: PK.inkMute }}>{a.files} files</span>
            </span>
            <span style={{ display: 'block', fontFamily: PK.sans, fontSize: 12.5, color: PK.inkSoft, marginTop: 3 }}>{a.note}</span>
          </span>
          <span style={{ fontFamily: PK.mono, fontSize: 11.5, color: a.epic ? PK.inkSoft : PK.inkMute }}>
            {a.epic ? `touched by ${a.epic}` : 'no open Epic'}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, height: 6, background: PK.panel, border: `1px solid ${PK.rule}`, borderRadius: 999, overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${heatPercent(a.heat)}%`, background: PK.accent }} />
            </span>
            <span style={{ fontFamily: PK.mono, fontSize: 10.5, color: PK.inkMute, width: 24, textAlign: 'right' }}>{heatPercent(a.heat)}</span>
          </span>
        </div>
      )) : <EmptyNote>No areas inferred yet.</EmptyNote>}
    </div>
  </PkSection>;
}
function BfAreasCards({ summary }: P) {
  const b = brief(summary);
  return <PkSection pad="64px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>structure</PkEyebrow>
    <PkH size={28} style={{ marginTop: 12, maxWidth: 620 }}>How it&apos;s put together.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16, marginTop: 28 }}>
      {b.areas.length ? b.areas.map((a, i) => (
        <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: PK.mono, fontSize: 13, fontWeight: 600, color: PK.ink }}>{a.name}</span>
            <PkPill tone={PK.inkMute}>{heatPercent(a.heat)}% active</PkPill>
          </div>
          <PkBody size={13} style={{ marginTop: 8 }}>{a.note}</PkBody>
          <div style={{ fontFamily: PK.mono, fontSize: 10.5, color: PK.inkMute, marginTop: 10 }}>
            {a.files} files · {a.epic ? `touched by ${a.epic}` : 'no open Epic'}
          </div>
        </div>
      )) : <EmptyNote>No areas inferred yet.</EmptyNote>}
    </div>
  </PkSection>;
}

// ── SCOPE (how the goal has moved) ────────────────────────────────────
function BfScopeTimeline({ summary }: P) {
  const b = brief(summary);
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>scope</PkEyebrow>
    <PkH size={28} style={{ marginTop: 12, maxWidth: 620 }}>How the goal has moved.</PkH>
    <div style={{ marginTop: 24 }}>
      {b.scope.length ? b.scope.map((s, i) => {
        const tone = scopeTone(s.kind);
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '96px 92px minmax(0,1fr)', gap: 16, alignItems: 'start', padding: '14px 0', borderTop: i ? `1px solid ${PK.rule}` : 'none' }}>
            <span style={{ fontFamily: PK.mono, fontSize: 11, color: PK.inkMute, paddingTop: 2 }}>{s.when}</span>
            <PkPill tone={tone.color} border={tone.color} style={{ justifySelf: 'start' }}>{tone.label}</PkPill>
            <span>
              <span style={{ display: 'block', fontFamily: PK.sans, fontSize: 14, color: PK.ink, lineHeight: 1.55 }}><Md text={s.text} /></span>
              <span style={{ display: 'block', fontFamily: PK.mono, fontSize: 10.5, color: PK.inkMute, marginTop: 4 }}>from {s.src}</span>
            </span>
          </div>
        );
      }) : <EmptyNote>No scope history recorded yet.</EmptyNote>}
    </div>
  </PkSection>;
}
function BfScopeLog({ summary }: P) {
  const b = brief(summary);
  return <PkSection pad="56px 80px" style={{ background: PK.deep, color: PK.paper }}>
    <PkEyebrow tone={PK.butter}>scope</PkEyebrow>
    <div style={{ marginTop: 18, display: 'grid', gap: 4 }}>
      {b.scope.length ? b.scope.map((s, i) => {
        const tone = scopeTone(s.kind);
        return (
          <div key={i} style={{ fontFamily: PK.mono, fontSize: 12.5, lineHeight: 1.8, display: 'flex', gap: 10 }}>
            <span style={{ color: '#8a7a60' }}>{s.when}</span>
            <span style={{ color: tone.color, textTransform: 'uppercase', fontSize: 10.5 }}>{tone.label}</span>
            <span style={{ color: PK.paper, flex: 1 }}>{s.text}</span>
          </div>
        );
      }) : <div style={{ fontFamily: PK.sans, fontSize: 13, color: '#8a7a60', fontStyle: 'italic' }}>No scope history recorded yet.</div>}
    </div>
  </PkSection>;
}

// ── CONVENTIONS ─────────────────────────────────────────────────────────
function BfConventionsChecklist({ summary }: P) {
  const b = brief(summary);
  return <PkSection pad="64px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>rules</PkEyebrow>
    <PkH size={28} style={{ marginTop: 12, maxWidth: 620 }}>Conventions this project follows.</PkH>
    <div style={{ marginTop: 24, display: 'grid', gap: 12, maxWidth: 680 }}>
      {b.conventions.length ? b.conventions.map((c, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0,1fr)', gap: 10, alignItems: 'start' }}>
          <span style={{ color: PK.sage, fontFamily: PK.mono, fontSize: 13, lineHeight: '20px' }}>{'✓'}</span>
          <PkBody size={14}><Md text={c} /></PkBody>
        </div>
      )) : <EmptyNote>No conventions recorded yet.</EmptyNote>}
    </div>
  </PkSection>;
}
function BfConventionsChips({ summary }: P) {
  const b = brief(summary);
  return <PkSection pad="56px 80px">
    <PkEyebrow>rules</PkEyebrow>
    <PkH size={28} style={{ marginTop: 12, maxWidth: 620 }}>Conventions this project follows.</PkH>
    <div style={{ marginTop: 22, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {b.conventions.length ? b.conventions.map((c, i) => (
        <PkPill key={i} tone={PK.inkSoft} bg={PK.card} style={{ padding: '7px 12px', fontFamily: PK.sans, fontSize: 12.5, whiteSpace: 'normal', maxWidth: 340 }}>{c}</PkPill>
      )) : <EmptyNote>No conventions recorded yet.</EmptyNote>}
    </div>
  </PkSection>;
}

export const PAGE_BRIEF: PageLensDef = {
  id: 'brief', label: 'Brief', blurb: 'The project\'s synthesized Brief — purpose, structure, scope history, and conventions — as a static read, not a live dashboard.',
  slots: [
    { id: 'purpose', label: 'Purpose', variants: [
      { id: 'prose', label: 'Prose', note: 'Claim heading + what-this-is paragraphs. The default.', component: BfPurposeProse },
      { id: 'quote', label: 'Dark pull-quote', note: 'Inverted, serif-led — leads with the purpose as a statement.', component: BfPurposeQuote },
    ] },
    { id: 'areas', label: 'How it\'s put together', variants: [
      { id: 'table', label: 'Dense rows', note: 'Name, note, owning Epic, heat bar — one row per area.', component: BfAreasTable },
      { id: 'cards', label: '2×2 cards', note: 'Even weight across every area, heat as a pill.', component: BfAreasCards },
    ] },
    { id: 'scope', label: 'How the goal has moved', variants: [
      { id: 'timeline', label: 'Timeline', note: 'Dated rows with an added/narrowed/decided tone pill. The default.', component: BfScopeTimeline },
      { id: 'log', label: 'Dark log', note: 'Compact monospace log lines, inverted.', component: BfScopeLog },
    ] },
    { id: 'conventions', label: 'Conventions', variants: [
      { id: 'checklist', label: 'Checklist', note: 'One checkmark per convention. The default.', component: BfConventionsChecklist },
      { id: 'chips', label: 'Wrapped chips', note: 'Denser, no vertical list.', component: BfConventionsChips },
    ] },
  ],
  presets: [
    { id: 'v1', label: 'Read', note: 'Default — prose purpose, dense area rows, timeline scope, checklist conventions.', pick: { purpose: 'prose', areas: 'table', scope: 'timeline', conventions: 'checklist' } },
    { id: 'v2', label: 'Ledger', note: 'Denser, mono-leaning, two inverted sections.', pick: { purpose: 'quote', areas: 'cards', scope: 'log', conventions: 'chips' } },
  ],
};
