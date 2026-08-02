// Project Home — slot variants. The 4th lens, alongside Marketing/Feature/
// Architecture: an internal-dashboard-flavored static page built from the
// same `identity`/`stats`/`pillars` fields Marketing's hero/proof/pillars
// slots already read — no new summary schema needed. Where Marketing pitches
// an outside reader, Home orients someone who already has the project open:
// denser, mono-leaning, no "Download"/"Get the app" CTAs.
import { PK, PkEyebrow, PkPill, PkCmd, PkSection, PkH, PkBody } from './kit';
import type { ProjectPageSummary } from '../summaryType';
import type { PageLensDef } from './types';

type P = { summary: ProjectPageSummary };

// ── OVERVIEW ───────────────────────────────────────────────
function HOverviewDashboard({ summary }: P) {
  const proj = summary.identity;
  return <>
    <PkSection pad="72px 80px 48px">
      <PkEyebrow>{proj.tag} · {proj.version}</PkEyebrow>
      <PkH size={44} style={{ marginTop: 16, maxWidth: 760 }}>{proj.claim}</PkH>
      <PkBody size={16} style={{ marginTop: 18, maxWidth: 640 }}>{proj.sub}</PkBody>
      <div style={{ marginTop: 26 }}><PkCmd>{proj.install}</PkCmd></div>
    </PkSection>
    <PkSection pad="0" style={{ borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, summary.stats.length)},1fr)` }}>
        {summary.stats.map((s, i) => <div key={i} style={{ padding: '26px 28px', borderLeft: i ? `1px solid ${PK.rule}` : 'none' }}>
          <div style={{ fontFamily: PK.mono, fontSize: 30, lineHeight: 1, color: PK.accent }}>{s.v}</div>
          <div style={{ fontFamily: PK.sans, fontSize: 13, fontWeight: 600, color: PK.ink, marginTop: 8 }}>{s.k}</div>
          <div style={{ fontFamily: PK.sans, fontSize: 12, color: PK.inkMute, marginTop: 3 }}>{s.n}</div>
        </div>)}
      </div>
    </PkSection>
  </>;
}
function HOverviewLedger({ summary }: P) {
  const proj = summary.identity;
  return <PkSection pad="64px 80px" style={{ background: PK.deep, color: PK.paper }}>
    <PkEyebrow tone={PK.butter}>{proj.audience}</PkEyebrow>
    <div style={{ fontFamily: PK.serif, fontSize: 38, color: PK.paper, marginTop: 14, maxWidth: 720 }}>{proj.oneLine}</div>
    <div style={{ marginTop: 30, display: 'flex', flexWrap: 'wrap', gap: '16px 40px', alignItems: 'baseline', borderTop: '1px solid #3b3025', paddingTop: 24 }}>
      {summary.stats.map((s, i) => <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span style={{ fontFamily: PK.mono, fontSize: 20, color: PK.butter }}>{s.v}</span>
        <span style={{ fontFamily: PK.sans, fontSize: 13, color: '#bdaf97' }}>{s.k}</span>
      </div>)}
    </div>
  </PkSection>;
}

// ── PILLARS (how the project is organized) ────────────────
function HPillarsGrid({ summary }: P) {
  return <PkSection pad="64px 80px">
    <PkEyebrow>How it&apos;s organized</PkEyebrow>
    <PkH size={30} style={{ marginTop: 12, maxWidth: 620 }}>The pillars this project is built around.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 18, marginTop: 32 }}>
      {summary.pillars.map((p, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 22 }}>
        <PkEyebrow tone={PK.inkMute}>{p.k}</PkEyebrow>
        <div style={{ fontFamily: PK.serif, fontSize: 21, color: PK.ink, marginTop: 9 }}>{p.t}</div>
        <PkBody size={14} style={{ marginTop: 9 }}>{p.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function HPillarsRows({ summary }: P) {
  return <PkSection pad="64px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>How it&apos;s organized</PkEyebrow>
    <div style={{ marginTop: 22 }}>
      {summary.pillars.map((p, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '130px minmax(0,1fr)', gap: 24, padding: '18px 0', borderTop: `1px solid ${PK.rule}` }}>
        <PkPill tone={PK.inkMute} style={{ justifySelf: 'start', alignSelf: 'start' }}>{p.k}</PkPill>
        <div>
          <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink }}>{p.t}</div>
          <PkBody size={14} style={{ marginTop: 5 }}>{p.d}</PkBody>
        </div>
      </div>)}
    </div>
  </PkSection>;
}

export const PAGE_HOME: PageLensDef = {
  id: 'home', label: 'Project Home', blurb: 'A dashboard-flavored overview — for someone who already has the project open, not an outside pitch.',
  slots: [
    { id: 'overview', label: 'Overview', variants: [
      { id: 'dashboard', label: 'Stat band', note: 'Claim + sub, then a ruled stat band. The default.', component: HOverviewDashboard },
      { id: 'ledger', label: 'Dark ledger', note: 'Inverted; compact inline figures.', component: HOverviewLedger },
    ] },
    { id: 'pillars', label: 'How it\'s organized', variants: [
      { id: 'grid', label: '2×2 cards', note: 'Even weight across every pillar.', component: HPillarsGrid },
      { id: 'rows', label: 'Tagged rows', note: 'Dense, text-only.', component: HPillarsRows },
    ] },
  ],
  presets: [
    { id: 'v1', label: 'Dashboard', note: 'Default — stat band + pillar cards.', pick: { overview: 'dashboard', pillars: 'grid' } },
    { id: 'v2', label: 'Ledger', note: 'Denser, mono-leaning.', pick: { overview: 'ledger', pillars: 'rows' } },
  ],
};
