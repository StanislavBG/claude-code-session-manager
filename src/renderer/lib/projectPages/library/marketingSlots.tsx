// Marketing Landing Page — slot variants. Ported from
// source/10-marketing-slots-core.jsx (hero · proof · pillars · close) and
// source/11-marketing-slots-depth.jsx (tour · workflow · depth · faq,
// spliced in between pillars and close) — folded into one file per lens.
// Every component reads its project data from the `summary` prop instead of
// the sample library's hardcoded global PROJ. No client-side interactivity —
// this renders to static HTML, so every "interactive" variant (tabs,
// accordions, hotspots) just renders its default/first state.
import { PK, PkEyebrow, PkPill, PkDot, PkCmd, PkBtn, PkShot, PkSection, PkH, PkBody } from './kit';
import type { ProjectPageSummary } from '../summaryType';
import type { PageLensDef } from './types';

type P = { summary: ProjectPageSummary };

const M = { pad: '72px 80px' };

// ── HERO ───────────────────────────────────────────────────
function MHeroEditorial({ summary }: P) {
  const proj = summary.identity;
  return <PkSection pad="96px 80px 72px">
    <div style={{ maxWidth: 820 }}>
      <PkEyebrow>{proj.tag} · {proj.version}</PkEyebrow>
      <h1 style={{ margin: '20px 0 0', fontFamily: PK.serif, fontWeight: 400, fontSize: 68, lineHeight: 1.02, letterSpacing: '-0.028em', color: PK.ink, textWrap: 'balance' }}>{proj.claim}</h1>
      <PkBody size={18} style={{ marginTop: 24, maxWidth: 620 }}>{proj.sub}</PkBody>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 34 }}>
        <PkBtn primary>Download for macOS</PkBtn><PkCmd>{proj.install}</PkCmd>
      </div>
    </div>
  </PkSection>;
}
function MHeroSplit({ summary }: P) {
  const proj = summary.identity;
  return <PkSection pad="72px 80px" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 56, alignItems: 'center' }}>
    <div>
      <PkEyebrow>{proj.audience}</PkEyebrow>
      <h1 style={{ margin: '16px 0 0', fontFamily: PK.serif, fontWeight: 400, fontSize: 52, lineHeight: 1.06, letterSpacing: '-0.022em', color: PK.ink }}>{proj.claim}</h1>
      <PkBody style={{ marginTop: 18 }}>{proj.sub}</PkBody>
      <div style={{ display: 'flex', gap: 10, marginTop: 28 }}><PkBtn primary>Get the app</PkBtn><PkBtn>Read the docs</PkBtn></div>
    </div>
    <PkShot h={340} label="app screenshot" />
  </PkSection>;
}
function MHeroCentered({ summary }: P) {
  const proj = summary.identity;
  return <PkSection pad="104px 80px 84px" style={{ textAlign: 'center', background: PK.panel, borderBottom: `1px solid ${PK.rule}` }}>
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'grid', gap: 22, justifyItems: 'center' }}>
      <PkPill bg={PK.card}><PkDot />{proj.version} · local-first, no account</PkPill>
      <h1 style={{ margin: 0, fontFamily: PK.serif, fontWeight: 400, fontSize: 60, lineHeight: 1.05, letterSpacing: '-0.025em', color: PK.ink, textWrap: 'balance' }}>{proj.claim}</h1>
      <PkBody size={17} style={{ maxWidth: 560 }}>{proj.oneLine} {proj.sub}</PkBody>
      <PkCmd wide>{proj.install}</PkCmd>
    </div>
  </PkSection>;
}
function MHeroTerminal({ summary }: P) {
  const proj = summary.identity;
  return <PkSection pad="0" style={{ background: PK.deep, color: PK.paper }}>
    <div style={{ padding: '84px 80px', display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 60, alignItems: 'center' }}>
      <div>
        <PkEyebrow tone={PK.butter}>{proj.tag}</PkEyebrow>
        <h1 style={{ margin: '18px 0 0', fontFamily: PK.serif, fontWeight: 400, fontSize: 56, lineHeight: 1.04, letterSpacing: '-0.024em', color: PK.paper }}>{proj.claim}</h1>
        <PkBody style={{ marginTop: 18, color: '#c9bda8' }}>{proj.sub}</PkBody>
        <div style={{ marginTop: 30, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button style={{ appearance: 'none', cursor: 'pointer', background: PK.butter, color: PK.deep, border: 0, borderRadius: 9, padding: '11px 20px', fontFamily: PK.sans, fontWeight: 600, fontSize: 14 }}>Download</button>
          <span style={{ fontFamily: PK.mono, fontSize: 13, color: '#a2947c' }}>{proj.install}</span>
        </div>
      </div>
      <div style={{ background: '#211a14', border: '1px solid #3b3025', borderRadius: 12, padding: 20, fontFamily: PK.mono, fontSize: 12.5, lineHeight: 1.9, color: '#d8cbb4' }}>
        {([
          ['$ ', proj.install],
          ['→ ', proj.tag],
          ['✓ ', summary.feature.name],
          ['⟳ ', summary.pillars[0]?.t ?? proj.oneLine],
          ['✓ ', summary.stats[0] ? `${summary.stats[0].v} ${summary.stats[0].k}` : proj.oneLine],
        ] as const).map(([p, l], i) =>
          <div key={i}><span style={{ color: i === 0 ? PK.butter : PK.sage }}>{p}</span>{l}</div>)}
      </div>
    </div>
  </PkSection>;
}

// ── PROOF ──────────────────────────────────────────────────
function MProofStats({ summary }: P) {
  return <PkSection pad="0" style={{ borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)' }}>
      {summary.stats.map((s, i) => <div key={i} style={{ padding: '30px 32px', borderLeft: i ? `1px solid ${PK.rule}` : 'none' }}>
        <div style={{ fontFamily: PK.serif, fontSize: 40, lineHeight: 1, color: PK.ink }}>{s.v}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 13.5, fontWeight: 600, color: PK.ink, marginTop: 8 }}>{s.k}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 12.5, color: PK.inkMute, marginTop: 3 }}>{s.n}</div>
      </div>)}
    </div>
  </PkSection>;
}
function MProofTicker() {
  const items = ['local-first', 'no telemetry', 'sqlite-backed queue', 'Electron + React', 'MCP native', 'skills & hooks', 'headless claude -p', 'restart-safe'];
  return <div style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}`, padding: '16px 80px', display: 'flex', flexWrap: 'wrap', gap: '10px 12px' }}>
    {items.map(t => <PkPill key={t} bg={PK.card}>{t}</PkPill>)}
  </div>;
}
function MProofQuote({ summary }: P) {
  const q = summary.quotes[0];
  if (!q) return null;
  return <PkSection pad="56px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <blockquote style={{ margin: 0, maxWidth: 760 }}>
      <p style={{ margin: 0, fontFamily: PK.serif, fontSize: 30, lineHeight: 1.32, color: PK.ink, letterSpacing: '-0.012em' }}>&ldquo;{q.q}&rdquo;</p>
      <footer style={{ marginTop: 16, fontFamily: PK.sans, fontSize: 13.5, color: PK.inkMute }}>{q.a} — {q.r}</footer>
    </blockquote>
  </PkSection>;
}
function MProofLedger({ summary }: P) {
  return <PkSection pad="36px 80px" style={{ borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px 48px', alignItems: 'baseline' }}>
      {summary.stats.map((s, i) => <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span style={{ fontFamily: PK.mono, fontSize: 22, color: PK.accent }}>{s.v}</span>
        <span style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.inkSoft }}>{s.k}</span>
      </div>)}
    </div>
  </PkSection>;
}

// ── PILLARS ────────────────────────────────────────────────
function MPillarsCards({ summary }: P) {
  return <PkSection pad={M.pad}>
    <PkEyebrow>What you get</PkEyebrow>
    <PkH style={{ marginTop: 14, maxWidth: 620 }}>Four things it does that a terminal cannot.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 20, marginTop: 40 }}>
      {summary.pillars.map((p, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 14, padding: 26 }}>
        <PkEyebrow tone={PK.inkMute}>{p.k}</PkEyebrow>
        <div style={{ fontFamily: PK.serif, fontSize: 24, color: PK.ink, marginTop: 10 }}>{p.t}</div>
        <PkBody size={15} style={{ marginTop: 10 }}>{p.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function MPillarsAlternating({ summary }: P) {
  return <PkSection pad="56px 80px" style={{ display: 'grid', gap: 8 }}>
    {summary.pillars.map((p, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: i % 2 ? '1fr 0.9fr' : '0.9fr 1fr', gap: 48, alignItems: 'center', padding: '28px 0', borderTop: `1px solid ${PK.rule}` }}>
      <div style={{ order: i % 2 ? 2 : 1 }}>
        <PkEyebrow>{String(i + 1).padStart(2, '0')} · {p.k}</PkEyebrow>
        <PkH size={30} style={{ marginTop: 12 }}>{p.t}</PkH>
        <PkBody style={{ marginTop: 12, maxWidth: 480 }}>{p.d}</PkBody>
      </div>
      <PkShot h={180} label={`${p.k.toLowerCase()} view`} style={{ order: i % 2 ? 1 : 2 }} />
    </div>)}
  </PkSection>;
}
function MPillarsList({ summary }: P) {
  return <PkSection pad={M.pad}>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px,260px) minmax(0,1fr)', gap: 'clamp(24px,4vw,56px)' }}>
      <div>
        <PkEyebrow>Capabilities</PkEyebrow>
        <PkH size={32} style={{ marginTop: 14 }}>Built around how the work actually flows.</PkH>
      </div>
      <div>
        {summary.pillars.map((p, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(110px,150px) minmax(0,1fr)', gap: 'clamp(16px,2vw,28px)', padding: '22px 0', borderTop: `1px solid ${PK.rule}` }}>
          <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink }}>{p.t}</div>
          <PkBody size={15}>{p.d}</PkBody>
        </div>)}
      </div>
    </div>
  </PkSection>;
}
function MPillarsShowcase({ summary }: P) {
  return <PkSection pad={M.pad} style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkH style={{ maxWidth: 560 }}>One window, four jobs.</PkH>
    <PkShot h={300} label="primary product shot" style={{ marginTop: 32, background: PK.card, borderStyle: 'solid' }} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 18, marginTop: 26 }}>
      {summary.pillars.map((p, i) => <div key={i}>
        <div style={{ height: 2, background: i === 0 ? PK.accent : PK.rule, marginBottom: 12 }} />
        <div style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{p.t}</div>
        <PkBody size={13} style={{ marginTop: 6 }}>{p.d.split('.')[0]}.</PkBody>
      </div>)}
    </div>
  </PkSection>;
}

// ── CLOSE ──────────────────────────────────────────────────
function MCloseInstall({ summary }: P) {
  return <PkSection pad="72px 80px" style={{ background: PK.deep, textAlign: 'center' }}>
    <PkH size={38} style={{ color: PK.paper }}>Install it in one line.</PkH>
    <div style={{ marginTop: 22, display: 'flex', justifyContent: 'center' }}>
      <code style={{ fontFamily: PK.mono, fontSize: 15, color: PK.butter, border: '1px solid #4a3d2e', borderRadius: 10, padding: '14px 24px' }}>{summary.identity.install}</code>
    </div>
    <PkBody size={13.5} style={{ marginTop: 18, color: '#a2947c' }}>macOS & Linux · requires the Claude Code CLI</PkBody>
  </PkSection>;
}
function MCloseSplit() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 40, flexWrap: 'wrap' }}>
    <div><PkH size={30}>Ready when you are.</PkH><PkBody style={{ marginTop: 8 }}>Free while in beta. No account, no cloud.</PkBody></div>
    <div style={{ display: 'flex', gap: 10 }}><PkBtn primary>Download</PkBtn><PkBtn>View on GitHub</PkBtn></div>
  </PkSection>;
}
function MCloseQuiet({ summary }: P) {
  return <PkSection pad="48px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 40, alignItems: 'end' }}>
      <div><PkEyebrow>Get started</PkEyebrow><PkBody size={15} style={{ marginTop: 10, maxWidth: 460 }}>Point it at a folder on disk and it takes over from there. Everything stays local.</PkBody></div>
      <PkCmd>{summary.identity.install}</PkCmd>
    </div>
  </PkSection>;
}

// ── TOUR / WORKFLOW / DEPTH / FAQ (derived from summary) ───
// Every section below is real ProjectPageSummary data reshaped for its
// slot's layout — never hardcoded sample-project copy. Where the source
// library's "depth" slots leaned on content ProjectPageSummary has no field
// for (a fabricated competitor-comparison matrix, made-up CLI transcripts),
// the closest honest substitute in the actual summary is used instead:
// pillars stand in for the product tour, feature steps for the workflow
// rail, architecture layers for the spec ledger, architecture principles
// for the privacy panel, feature FAQ for the marketing FAQ, and known
// architecture risks (already carrying a real open/watching/mitigated
// status) for the "where it fits" comparison-style ledger.
type TourEntry = { k: string; t: string; d: string; pts: string[] };
function tourFromPillars(summary: ProjectPageSummary): TourEntry[] {
  return summary.pillars.map(p => ({ k: p.k, t: p.t, d: p.d, pts: [p.d] }));
}
type WorkflowStep = { t: string; d: string; c: string };
function workflowFromSteps(summary: ProjectPageSummary): WorkflowStep[] {
  const steps = summary.feature.steps;
  return steps.map((s, i) => ({ t: s.t, d: s.d, c: `step ${i + 1} of ${steps.length}` }));
}

function MTourTabs({ summary }: P) {
  const tour = tourFromPillars(summary);
  const t = tour[0];
  if (!t) return null;
  return <PkSection pad="72px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>A closer look</PkEyebrow>
    <PkH size={34} style={{ marginTop: 12, maxWidth: 620 }}>{tour.length} pillars, one project.</PkH>
    <div style={{ display: 'flex', gap: 6, marginTop: 26, flexWrap: 'wrap' }}>
      {tour.map((x, n) => <span key={x.k} style={{ fontFamily: PK.sans, fontSize: 13, fontWeight: n === 0 ? 600 : 500, padding: '8px 14px', borderRadius: 8, border: `1px solid ${n === 0 ? PK.accent : PK.rule}`, background: n === 0 ? PK.accent : 'transparent', color: n === 0 ? '#fff' : PK.inkSoft }}>{x.k}</span>)}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.1fr)', gap: 'clamp(24px,4vw,48px)', marginTop: 28, alignItems: 'center' }}>
      <div>
        <PkH size={26}>{t.t}</PkH>
        <PkBody style={{ marginTop: 12 }}>{t.d}</PkBody>
        <div style={{ marginTop: 18, display: 'grid', gap: 9 }}>
          {t.pts.map(p => <div key={p} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}><PkDot c={PK.sage} s={6} /><span style={{ fontFamily: PK.sans, fontSize: 14, color: PK.inkSoft }}>{p}</span></div>)}
        </div>
      </div>
      <PkShot h={280} label={`${t.k.toLowerCase()} view`} />
    </div>
  </PkSection>;
}
function MTourStacked({ summary }: P) {
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'grid', gap: 4 }}>
    <PkEyebrow>Inside the app</PkEyebrow>
    {tourFromPillars(summary).map((t, i) => <div key={t.k} style={{ display: 'grid', gridTemplateColumns: i % 2 ? 'minmax(0,1fr) minmax(0,0.95fr)' : 'minmax(0,0.95fr) minmax(0,1fr)', gap: 'clamp(24px,4vw,52px)', alignItems: 'center', padding: '32px 0', borderTop: `1px solid ${PK.rule}` }}>
      <div style={{ order: i % 2 ? 2 : 1 }}>
        <PkEyebrow tone={PK.inkMute}>{t.k}</PkEyebrow>
        <PkH size={28} style={{ marginTop: 10 }}>{t.t}</PkH>
        <PkBody style={{ marginTop: 12 }}>{t.d}</PkBody>
        <div style={{ marginTop: 16, display: 'grid', gap: 7 }}>{t.pts.map(p => <div key={p} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}><span style={{ color: PK.accent, fontFamily: PK.mono, fontSize: 12 }}>—</span><span style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.inkSoft }}>{p}</span></div>)}</div>
      </div>
      <PkShot h={230} label={`${t.k.toLowerCase()}`} style={{ order: i % 2 ? 1 : 2 }} />
    </div>)}
  </PkSection>;
}
function MTourCards({ summary }: P) {
  return <PkSection pad="64px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>A closer look</PkEyebrow>
    <PkH size={32} style={{ marginTop: 12, maxWidth: 560 }}>Every pillar earns its place.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 16, marginTop: 30 }}>
      {tourFromPillars(summary).map(t => <div key={t.k} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 14, overflow: 'hidden' }}>
        <PkShot h={130} label={t.k.toLowerCase()} style={{ borderRadius: 0, border: 'none', borderBottom: `1px solid ${PK.edge}` }} />
        <div style={{ padding: 20 }}>
          <PkEyebrow tone={PK.inkMute}>{t.k}</PkEyebrow>
          <div style={{ fontFamily: PK.serif, fontSize: 21, color: PK.ink, marginTop: 8, lineHeight: 1.2 }}>{t.t}</div>
          <PkBody size={13.5} style={{ marginTop: 9 }}>{t.d}</PkBody>
        </div>
      </div>)}
    </div>
  </PkSection>;
}
function MTourBigShot({ summary }: P) {
  const tour = tourFromPillars(summary);
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(200px,300px)', gap: 'clamp(24px,4vw,48px)', alignItems: 'start' }}>
      <div>
        <PkEyebrow>The workspace</PkEyebrow>
        <PkH size={32} style={{ marginTop: 12 }}>Everything in flight, on one screen.</PkH>
        <PkShot h={330} label="full app window" style={{ marginTop: 22, background: PK.card, borderStyle: 'solid' }} />
      </div>
      <div style={{ paddingTop: 76, display: 'grid', gap: 0 }}>
        {tour.map((t, i) => <div key={t.k} style={{ padding: '14px 0', borderTop: `1px solid ${PK.rule}` }}>
          <div style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}>
            <span style={{ fontFamily: PK.mono, fontSize: 11, color: PK.accent }}>{String(i + 1).padStart(2, '0')}</span>
            <span style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{t.k}</span>
          </div>
          <PkBody size={13} style={{ marginTop: 5 }}>{t.t}.</PkBody>
        </div>)}
      </div>
    </div>
  </PkSection>;
}

// ── WORKFLOW ───────────────────────────────────────────────
function MFlowSteps({ summary }: P) {
  const steps = workflowFromSteps(summary);
  return <PkSection pad="64px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>How it works</PkEyebrow>
    <PkH size={32} style={{ marginTop: 12, maxWidth: 560 }}>{steps.length} moves, then you stop watching.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginTop: 30 }}>
      {steps.map((s, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontFamily: PK.mono, fontSize: 11, color: PK.accent }}>{String(i + 1).padStart(2, '0')}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 15.5, fontWeight: 600, color: PK.ink, marginTop: 9 }}>{s.t}</div>
        <PkBody size={13.5} style={{ marginTop: 7 }}>{s.d}</PkBody>
        <div style={{ marginTop: 14, fontFamily: PK.mono, fontSize: 11.5, color: PK.inkMute, background: PK.paper, border: `1px solid ${PK.edge}`, borderRadius: 7, padding: '7px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.c}</div>
      </div>)}
    </div>
  </PkSection>;
}
function MFlowRail({ summary }: P) {
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'grid', gridTemplateColumns: 'minmax(160px,260px) minmax(0,1fr)', gap: 'clamp(24px,4vw,56px)' }}>
    <div>
      <PkEyebrow>The loop</PkEyebrow>
      <PkH size={30} style={{ marginTop: 12 }}>{summary.feature.oneLine}</PkH>
    </div>
    <div style={{ position: 'relative', paddingLeft: 28 }}>
      <div style={{ position: 'absolute', left: 6, top: 8, bottom: 8, width: 2, background: PK.rule }} />
      {workflowFromSteps(summary).map((s, i) => <div key={i} style={{ position: 'relative', paddingBottom: 26 }}>
        <span style={{ position: 'absolute', left: -28, top: 4, width: 14, height: 14, borderRadius: '50%', background: PK.paper, border: `2px solid ${PK.accent}` }} />
        <div style={{ fontFamily: PK.sans, fontSize: 16, fontWeight: 600, color: PK.ink }}>{s.t}</div>
        <PkBody size={14.5} style={{ marginTop: 5 }}>{s.d}</PkBody>
        <div style={{ marginTop: 9, fontFamily: PK.mono, fontSize: 12, color: PK.accent }}>{s.c}</div>
      </div>)}
    </div>
  </PkSection>;
}
function MFlowTerminal({ summary }: P) {
  const steps = workflowFromSteps(summary);
  return <PkSection pad="64px 80px" style={{ background: PK.deep }}>
    <PkEyebrow tone={PK.butter}>How it works</PkEyebrow>
    <PkH size={30} style={{ marginTop: 12, color: PK.paper, maxWidth: 520 }}>{summary.feature.oneLine}</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12, marginTop: 28 }}>
      {steps.map((s, i) => <div key={i} style={{ border: '1px solid #3b3025', borderRadius: 10, padding: 18, background: i === steps.length - 1 ? '#241d16' : 'transparent' }}>
        <div style={{ fontFamily: PK.mono, fontSize: 11, color: PK.butter }}>{String(i + 1).padStart(2, '0')}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.paper, marginTop: 8 }}>{s.t}</div>
        <PkBody size={13} style={{ marginTop: 7, color: '#bdaf97' }}>{s.d}</PkBody>
        <div style={{ marginTop: 12, fontFamily: PK.mono, fontSize: 11.5, color: PK.sage, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.c}</div>
      </div>)}
    </div>
  </PkSection>;
}

// ── DEPTH: risk ledger / specs / privacy ────────────────────
const MD_MARK: Record<'mitigated' | 'watching' | 'open', [string, string]> = { mitigated: [PK.sage, '●'], watching: [PK.butter, '◐'], open: [PK.rule, '○'] };
function MDepthCompare({ summary }: P) {
  const risks = summary.architecture.risks;
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Where it stands</PkEyebrow>
    <PkH size={32} style={{ marginTop: 12, maxWidth: 560 }}>Known risks, plainly marked.</PkH>
    <div style={{ marginTop: 28, border: `1px solid ${PK.edge}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(78px,1fr)', background: PK.panel, borderBottom: `1px solid ${PK.edge}` }}>
        <div />
        <div style={{ padding: '12px 10px', textAlign: 'center', fontFamily: PK.sans, fontSize: 12.5, fontWeight: 700, color: PK.accent }}>Status</div>
      </div>
      {risks.map((r, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(78px,1fr)', borderTop: i ? `1px solid ${PK.edge}` : 'none', background: i % 2 ? PK.card : 'transparent' }}>
        <div style={{ padding: '13px 18px', fontFamily: PK.sans, fontSize: 14, color: PK.ink }}>{r.t}</div>
        <div style={{ display: 'grid', placeItems: 'center', color: MD_MARK[r.s][0], fontSize: 15 }}>{MD_MARK[r.s][1]}</div>
      </div>)}
    </div>
    <div style={{ display: 'flex', gap: 18, marginTop: 12 }}>{Object.entries(MD_MARK).map(([k, [c, g]]) => <span key={k} style={{ fontFamily: PK.sans, fontSize: 12, color: PK.inkMute }}><span style={{ color: c, marginRight: 6 }}>{g}</span>{k}</span>)}</div>
  </PkSection>;
}
function MDepthSpecs({ summary }: P) {
  const specs = summary.architecture.layers.map(l => [l.n, l.f, l.d] as const);
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'grid', gridTemplateColumns: 'minmax(160px,240px) minmax(0,1fr)', gap: 'clamp(24px,4vw,52px)' }}>
    <div><PkEyebrow>The details</PkEyebrow><PkH size={28} style={{ marginTop: 12 }}>What it's built from.</PkH></div>
    <div>{specs.map((s, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px,130px) minmax(0,1fr)', gap: 'clamp(14px,2vw,24px)', padding: '13px 0', borderTop: `1px solid ${PK.rule}`, alignItems: 'baseline' }}>
      <span style={{ fontFamily: PK.mono, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: PK.inkMute }}>{s[0]}</span>
      <span><span style={{ fontFamily: PK.sans, fontSize: 14.5, fontWeight: 600, color: PK.ink }}>{s[1]}</span><span style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.inkMute, marginLeft: 10 }}>{s[2]}</span></span>
    </div>)}</div>
  </PkSection>;
}
function MDepthPrivacy({ summary }: P) {
  return <PkSection pad="64px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Principles</PkEyebrow>
    <PkH size={32} style={{ marginTop: 12, maxWidth: 600 }}>{summary.architecture.summary}</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 16, marginTop: 28 }}>
      {summary.architecture.principles.map((p, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 22, borderTop: `3px solid ${PK.sage}` }}>
        <div style={{ fontFamily: PK.sans, fontSize: 15.5, fontWeight: 600, color: PK.ink }}>{p.t}</div>
        <PkBody size={13.5} style={{ marginTop: 8 }}>{p.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function MDepthStack({ summary }: P) {
  const specs = summary.architecture.layers.map(l => [l.n, l.f, l.d] as const);
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'flex', gap: 'clamp(20px,4vw,48px)', flexWrap: 'wrap' }}>
      {specs.map((s, i) => <div key={i} style={{ minWidth: 150 }}>
        <div style={{ fontFamily: PK.mono, fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: PK.inkMute }}>{s[0]}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink, marginTop: 6 }}>{s[1]}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 12.5, color: PK.inkMute, marginTop: 3 }}>{s[2]}</div>
      </div>)}
    </div>
  </PkSection>;
}

// ── FAQ (reuses the feature's own FAQ) ──────────────────────
function MFaqAccordion({ summary }: P) {
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Before you ask</PkEyebrow>
    <div style={{ marginTop: 18, maxWidth: 780 }}>
      {summary.feature.faq.map((f, i) => <div key={i} style={{ borderTop: `1px solid ${PK.rule}` }}>
        <div style={{ width: '100%', padding: '16px 0', display: 'flex', justifyContent: 'space-between', gap: 20, fontFamily: PK.sans, fontSize: 16, fontWeight: 550, color: PK.ink }}>
          {f.q}<span style={{ color: PK.inkMute }}>{i === 0 ? '−' : '+'}</span>
        </div>
        {i === 0 && <PkBody size={15} style={{ paddingBottom: 18, maxWidth: 640 }}>{f.a}</PkBody>}
      </div>)}
    </div>
  </PkSection>;
}
function MFaqColumns({ summary }: P) {
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Before you ask</PkEyebrow>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 'clamp(20px,3vw,40px)', marginTop: 24 }}>
      {summary.feature.faq.map((f, i) => <div key={i}>
        <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 650, color: PK.ink }}>{f.q}</div>
        <PkBody size={14} style={{ marginTop: 7 }}>{f.a}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function MFaqObjections({ summary }: P) {
  return <PkSection pad="64px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Fair objections</PkEyebrow>
    <div style={{ display: 'grid', gap: 10, marginTop: 22 }}>
      {summary.feature.faq.map((f, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: '18px 22px', display: 'grid', gridTemplateColumns: 'minmax(180px,280px) minmax(0,1fr)', gap: 'clamp(18px,3vw,36px)', alignItems: 'baseline' }}>
        <div style={{ fontFamily: PK.serif, fontSize: 19, color: PK.ink, lineHeight: 1.25 }}>{f.q}</div>
        <PkBody size={14}>{f.a}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}

export const PAGE_MARKETING: PageLensDef = {
  id: 'marketing', label: 'Marketing Landing', blurb: 'Positions the project to someone who has never seen it — then proves it works.',
  slots: [
    { id: 'hero', label: 'Hero', variants: [
      { id: 'editorial', label: 'Editorial statement', note: 'Serif claim, wide measure. Best when the idea sells itself.', component: MHeroEditorial },
      { id: 'split', label: 'Split with shot', note: 'Claim left, product image right. Needs a strong screenshot.', component: MHeroSplit },
      { id: 'centered', label: 'Centered + install', note: 'Symmetrical, CLI-forward. Good for dev tools.', component: MHeroCentered },
      { id: 'terminal', label: 'Dark terminal', note: 'Inverted panel with a live session transcript.', component: MHeroTerminal },
    ] },
    { id: 'proof', label: 'Proof strip', variants: [
      { id: 'stats', label: 'Four-up stat band', note: 'Ruled cells. Use when numbers are concrete.', component: MProofStats },
      { id: 'ticker', label: 'Attribute chips', note: 'Low-commitment; works with no metrics at all.', component: MProofTicker },
      { id: 'quote', label: 'Pull quote', note: 'A single voice. Needs a real quote.', component: MProofQuote },
      { id: 'ledger', label: 'Inline ledger', note: 'Compact one-liner of figures.', component: MProofLedger },
    ] },
    { id: 'pillars', label: 'Capability block', variants: [
      { id: 'cards', label: '2×2 cards', note: 'Even weight across four ideas.', component: MPillarsCards },
      { id: 'alt', label: 'Alternating rows', note: 'Each capability gets an image. Longest option.', component: MPillarsAlternating },
      { id: 'list', label: 'Definition list', note: 'Dense, text-only. Best for technical readers.', component: MPillarsList },
      { id: 'showcase', label: 'Hero shot + legend', note: 'One big image, four captions beneath.', component: MPillarsShowcase },
    ] },
    { id: 'tour', label: 'Product tour', variants: [
      { id: 'tabs', label: 'Tabbed tour', note: 'Interactive — one surface at a time, with a shot.', component: MTourTabs },
      { id: 'stacked', label: 'Alternating deep-dive', note: 'Every surface gets a full row. Longest, most convincing.', component: MTourStacked },
      { id: 'cards', label: 'Tour cards', note: 'Four capped cards with thumbnails. Scannable.', component: MTourCards },
      { id: 'bigshot', label: 'One window + legend', note: 'A single full-app shot with an indexed rail.', component: MTourBigShot },
    ] },
    { id: 'workflow', label: 'How it works', variants: [
      { id: 'steps', label: 'Four step cards', note: 'Each step carries the command that runs it.', component: MFlowSteps },
      { id: 'rail', label: 'Vertical loop', note: 'Reads as a sequence; good after a dense section.', component: MFlowRail },
      { id: 'terminal', label: 'Dark step band', note: 'Inverted; breaks up a long cream page.', component: MFlowTerminal },
    ] },
    { id: 'depth', label: 'Substance block', variants: [
      { id: 'compare', label: 'Comparison table', note: 'Against the two alternatives buyers already have.', component: MDepthCompare },
      { id: 'specs', label: 'Spec ledger', note: 'Requirements and limits, plainly stated.', component: MDepthSpecs },
      { id: 'privacy', label: 'Local-first panel', note: 'Leads with the privacy argument.', component: MDepthPrivacy },
      { id: 'stack', label: 'Inline spec strip', note: 'Lightest option — one band of facts.', component: MDepthStack },
    ] },
    { id: 'faq', label: 'Objections', variants: [
      { id: 'accordion', label: 'Accordion', note: 'Compact; hides answers until asked.', component: MFaqAccordion },
      { id: 'columns', label: 'Open columns', note: 'Everything visible, nothing to click.', component: MFaqColumns },
      { id: 'objections', label: 'Objection rows', note: 'Question as a serif statement, answer beside it.', component: MFaqObjections },
    ] },
    { id: 'close', label: 'Closing CTA', variants: [
      { id: 'install', label: 'Dark install band', note: 'Ends on the command.', component: MCloseInstall },
      { id: 'split', label: 'Split CTA', note: 'Statement left, buttons right.', component: MCloseSplit },
      { id: 'quiet', label: 'Quiet footer note', note: 'Understated; for tools that avoid a hard sell.', component: MCloseQuiet },
    ] },
  ],
  presets: [
    { id: 'v1', label: 'Editorial', note: 'Type-led, image-light. Safest for an unknown project.', pick: { hero: 'editorial', proof: 'stats', pillars: 'cards', tour: 'tabs', workflow: 'rail', depth: 'compare', faq: 'accordion', close: 'install' } },
    { id: 'v2', label: 'Product-led', note: 'Screenshots carry the argument.', pick: { hero: 'split', proof: 'quote', pillars: 'alt', tour: 'stacked', workflow: 'steps', depth: 'privacy', faq: 'objections', close: 'split' } },
    { id: 'v3', label: 'Developer', note: 'CLI-forward, dense, no marketing gloss.', pick: { hero: 'terminal', proof: 'ticker', pillars: 'list', tour: 'bigshot', workflow: 'terminal', depth: 'specs', faq: 'columns', close: 'quiet' } },
  ],
};
