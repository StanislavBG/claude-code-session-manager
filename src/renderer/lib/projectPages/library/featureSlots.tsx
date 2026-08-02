// Feature Description Page — slot variants. Ported from
// source/20-feature-slots-core.jsx (header · mechanism · rules · status) and
// source/21-feature-slots-visual.jsx (walk · states, visual-first, spliced
// in before rules) — folded into one file per lens. Components read
// `summary.feature` instead of the sample library's global PROJ.feature.
// No client-side interactivity — every "interactive" variant renders its
// default/first state since this is a static-HTML renderer.
import { PK, PkEyebrow, PkPill, PkDot, PkBtn, PkShot, PkSection, PkH, PkBody } from './kit';
import type { ProjectPageSummary } from '../summaryType';
import type { PageLensDef } from './types';

type P = { summary: ProjectPageSummary };

// ── HEADER ─────────────────────────────────────────────────
function FHeadSpec({ summary }: P) {
  const f = summary.feature;
  return <PkSection pad="56px 80px 40px" style={{ borderBottom: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <PkEyebrow>{f.kicker}</PkEyebrow><span style={{ color: PK.rule }}>/</span>
      <PkPill bg={PK.card}><PkDot />{f.status}</PkPill><PkPill>{f.owner}</PkPill>
    </div>
    <PkH size={46} style={{ marginTop: 18 }}>{f.name}</PkH>
    <PkBody size={18} style={{ marginTop: 14, maxWidth: 720 }}>{f.oneLine}</PkBody>
    <div style={{ display: 'flex', gap: 40, marginTop: 30, flexWrap: 'wrap' }}>
      {([['Owner', f.owner], ['Status', f.status], ['Rules', String(f.rules.length)], ['Since', f.timeline[0]?.w ?? f.status]] as const).map(([k, v]) =>
        <div key={k}><div style={{ fontFamily: PK.mono, fontSize: 10.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: PK.inkMute }}>{k}</div><div style={{ fontFamily: PK.sans, fontSize: 14, color: PK.ink, marginTop: 5 }}>{v}</div></div>)}
    </div>
  </PkSection>;
}
function FHeadProblem({ summary }: P) {
  const f = summary.feature;
  return <PkSection pad="64px 80px" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 56, borderBottom: `1px solid ${PK.rule}` }}>
    <div>
      <PkEyebrow tone={PK.inkMute}>The problem</PkEyebrow>
      <PkBody size={17} style={{ marginTop: 14 }}>{f.problem}</PkBody>
    </div>
    <div>
      <PkEyebrow>{f.name}</PkEyebrow>
      <PkH size={34} style={{ marginTop: 14 }}>{f.oneLine}</PkH>
      <PkBody style={{ marginTop: 14 }}>{f.solution}</PkBody>
    </div>
  </PkSection>;
}
function FHeadHero({ summary }: P) {
  const f = summary.feature;
  return <PkSection pad="64px 80px 0" style={{ background: PK.panel, borderBottom: `1px solid ${PK.rule}` }}>
    <div style={{ maxWidth: 700 }}>
      <PkEyebrow>{f.kicker} · {f.status}</PkEyebrow>
      <PkH size={48} style={{ marginTop: 16 }}>{f.name}</PkH>
      <PkBody size={17} style={{ marginTop: 14 }}>{f.oneLine}</PkBody>
    </div>
    <PkShot h={260} label="feature in context" style={{ marginTop: 36, marginBottom: -1, borderRadius: '12px 12px 0 0', background: PK.card, borderStyle: 'solid', borderBottom: 'none' }} />
  </PkSection>;
}
function FHeadBeforeAfter({ summary }: P) {
  const f = summary.feature;
  return <PkSection pad="56px 80px" style={{ borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>{f.kicker}</PkEyebrow>
    <PkH size={40} style={{ marginTop: 14 }}>{f.name}</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginTop: 30 }}>
      {([['Before', f.problem, PK.rule], ['After', f.solution, PK.sage]] as const).map(([k, v, c]) =>
        <div key={k} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 24, borderTop: `3px solid ${c}` }}>
          <div style={{ fontFamily: PK.mono, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: PK.inkMute }}>{k}</div>
          <PkBody size={15} style={{ marginTop: 10 }}>{v}</PkBody>
        </div>)}
    </div>
  </PkSection>;
}

// ── MECHANISM ──────────────────────────────────────────────
function FMechSteps({ summary }: P) {
  const steps = summary.feature.steps;
  return <PkSection pad="56px 80px">
    <PkEyebrow>How it works</PkEyebrow>
    <PkH size={32} style={{ marginTop: 12 }}>{steps.length} steps, start to finish.</PkH>
    <div style={{ marginTop: 30 }}>
      {steps.map((s, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '44px minmax(110px,200px) minmax(0,1fr)', gap: 20, padding: '18px 0', borderTop: `1px solid ${PK.rule}`, alignItems: 'baseline' }}>
        <div style={{ fontFamily: PK.mono, fontSize: 13, color: PK.accent }}>{String(i + 1).padStart(2, '0')}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink }}>{s.t}</div>
        <PkBody size={14.5}>{s.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function FMechFlow({ summary }: P) {
  const steps = summary.feature.steps;
  return <PkSection pad="56px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>The path a job takes</PkEyebrow>
    <div style={{ display: 'flex', gap: 0, marginTop: 26, alignItems: 'stretch', flexWrap: 'wrap' }}>
      {steps.map((s, i) => <div key={i} style={{ display: 'contents' }}>
        <div style={{ flex: '1 1 150px', background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 10, padding: 16 }}>
          <div style={{ fontFamily: PK.mono, fontSize: 10.5, color: PK.accent }}>{String(i + 1).padStart(2, '0')}</div>
          <div style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink, marginTop: 8 }}>{s.t}</div>
          <PkBody size={12.5} style={{ marginTop: 6 }}>{s.d}</PkBody>
        </div>
        {i < steps.length - 1 && <div style={{ width: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: PK.inkMute, fontFamily: PK.mono }}>→</div>}
      </div>)}
    </div>
  </PkSection>;
}
function FMechAnnotated({ summary }: P) {
  return <PkSection pad="56px 80px" style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 40 }}>
    <div>
      <PkEyebrow>Anatomy</PkEyebrow>
      <PkH size={30} style={{ marginTop: 12 }}>What you are looking at.</PkH>
      <PkShot h={300} label="annotated interface" style={{ marginTop: 22 }} />
    </div>
    <div style={{ paddingTop: 78 }}>
      {summary.feature.steps.slice(0, 4).map((s, i) => <div key={i} style={{ display: 'flex', gap: 12, padding: '14px 0', borderTop: `1px solid ${PK.rule}` }}>
        <span style={{ flex: 'none', width: 20, height: 20, borderRadius: '50%', background: PK.accent, color: '#fff', fontFamily: PK.mono, fontSize: 11, display: 'grid', placeItems: 'center' }}>{i + 1}</span>
        <div><div style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{s.t}</div><PkBody size={13} style={{ marginTop: 4 }}>{s.d}</PkBody></div>
      </div>)}
    </div>
  </PkSection>;
}
function FMechNarrative({ summary }: P) {
  const f = summary.feature;
  return <PkSection pad="56px 80px">
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 48 }}>
      <PkEyebrow style={{ paddingTop: 6 }}>How it works</PkEyebrow>
      <div style={{ maxWidth: 640 }}>
        <PkBody size={17.5}>{f.solution}</PkBody>
        <div style={{ marginTop: 26, borderLeft: `2px solid ${PK.accent}`, paddingLeft: 20, display: 'grid', gap: 14 }}>
          {f.steps.map((s, i) => <div key={i}>
            <span style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink }}>{s.t}. </span>
            <span style={{ fontFamily: PK.sans, fontSize: 15, lineHeight: 1.6, color: PK.inkSoft }}>{s.d}</span>
          </div>)}
        </div>
      </div>
    </div>
  </PkSection>;
}

// ── WALKTHROUGH (visual) ───────────────────────────────────
function walkScreens(summary: ProjectPageSummary) {
  const f = summary.feature;
  const tag = summary.identity.tag;
  return [
    { k: 'Queue', t: `The ${f.name.toLowerCase()} before anything runs`, d: f.problem, pts: [f.rules[0]?.t, f.rules[1]?.t].filter((x): x is string => Boolean(x)), chrome: `${tag} — ${f.name}` },
    { k: 'Run', t: f.oneLine, d: f.solution, pts: f.steps.slice(0, 3).map(s => s.t), chrome: `${tag} — ${f.name} · running` },
    { k: 'Done', t: 'Definition of done, checked', d: f.rules[f.rules.length - 1]?.d ?? f.solution, pts: f.rules.slice(2).map(r => r.t), chrome: `${tag} — ${f.name} · summary` },
  ];
}
function FvShot({ h = 300, label = 'screenshot', chrome }: { h?: number; label?: string; chrome: string }) {
  return <figure style={{ margin: 0, border: `1px solid ${PK.edge}`, borderRadius: 12, overflow: 'hidden', background: PK.card, boxShadow: '0 6px 18px rgba(42,34,26,0.07)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: PK.panel, borderBottom: `1px solid ${PK.edge}` }}>
      <span style={{ display: 'flex', gap: 5 }}>{['#d3a08a', '#e0cf9c', '#a8bb92'].map(c => <span key={c} style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />)}</span>
      <span style={{ fontFamily: PK.mono, fontSize: 10.5, color: PK.inkMute, marginLeft: 4 }}>{chrome}</span>
    </div>
    <div style={{ position: 'relative', height: h, background: `repeating-linear-gradient(135deg, ${PK.panel} 0 10px, ${PK.card} 10px 20px)`, display: 'grid', placeItems: 'center' }}>
      <span style={{ fontFamily: PK.mono, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: PK.inkMute }}>{label}</span>
    </div>
  </figure>;
}
function FvWalkClickthrough({ summary }: P) {
  const screens = walkScreens(summary);
  const s = screens[0];
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
      <div><PkEyebrow>Click through it</PkEyebrow><PkH size={30} style={{ marginTop: 10 }}>One job, start to finish.</PkH></div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontFamily: PK.mono, fontSize: 11.5, color: PK.inkMute, marginRight: 6 }}>1 / {screens.length}</span>
        <PkBtn small>←</PkBtn>
        <PkBtn small primary>→</PkBtn>
      </div>
    </div>
    <div style={{ display: 'flex', gap: 6, marginTop: 20, flexWrap: 'wrap' }}>
      {screens.map((x, n) => <span key={x.k} style={{ fontFamily: PK.sans, fontSize: 12.5, fontWeight: n === 0 ? 600 : 500, padding: '6px 13px', borderRadius: 999, border: `1px solid ${n === 0 ? PK.accent : PK.rule}`, background: n === 0 ? PK.accent : 'transparent', color: n === 0 ? '#fff' : PK.inkSoft }}>{n + 1}. {x.k}</span>)}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.35fr) minmax(0,1fr)', gap: 'clamp(20px,3vw,36px)', marginTop: 22, alignItems: 'start' }}>
      <FvShot h={310} label={`${s.k.toLowerCase()} screen`} chrome={s.chrome} />
      <div style={{ paddingTop: 6 }}>
        <PkEyebrow tone={PK.inkMute}>What you are seeing</PkEyebrow>
        <PkH size={23} style={{ marginTop: 10 }}>{s.t}</PkH>
        <PkBody size={14.5} style={{ marginTop: 10 }}>{s.d}</PkBody>
        <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
          {s.pts.map(p => <div key={p} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}><PkDot c={PK.accent} s={6} /><span style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.inkSoft }}>{p}</span></div>)}
        </div>
      </div>
    </div>
  </PkSection>;
}
function FvWalkSideBySide({ summary }: P) {
  const screens = walkScreens(summary);
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'grid', gap: 4 }}>
    <PkEyebrow>Screen by screen</PkEyebrow>
    {screens.map((s, i) => <div key={s.k} style={{ display: 'grid', gridTemplateColumns: i % 2 ? 'minmax(0,1fr) minmax(0,1.25fr)' : 'minmax(0,1.25fr) minmax(0,1fr)', gap: 'clamp(22px,3.5vw,44px)', alignItems: 'center', padding: '30px 0', borderTop: `1px solid ${PK.rule}` }}>
      <FvShot h={230} label={`${s.k.toLowerCase()} screen`} chrome={s.chrome} />
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 22, height: 22, borderRadius: '50%', background: PK.accent, color: '#fff', fontFamily: PK.mono, fontSize: 11.5, display: 'grid', placeItems: 'center' }}>{i + 1}</span>
          <PkEyebrow tone={PK.inkMute}>{s.k}</PkEyebrow>
        </div>
        <PkH size={25} style={{ marginTop: 12 }}>{s.t}</PkH>
        <PkBody size={14.5} style={{ marginTop: 10 }}>{s.d}</PkBody>
        <div style={{ marginTop: 14, display: 'grid', gap: 7 }}>{s.pts.map(p => <div key={p} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}><span style={{ fontFamily: PK.mono, fontSize: 12, color: PK.accent }}>—</span><span style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.inkSoft }}>{p}</span></div>)}</div>
      </div>
    </div>)}
  </PkSection>;
}
function FvWalkFilmstrip({ summary }: P) {
  const screens = walkScreens(summary);
  return <PkSection pad="56px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>The whole path</PkEyebrow>
    <PkH size={28} style={{ marginTop: 10, maxWidth: 520 }}>{screens.length} screens, in the order you meet them.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14, marginTop: 26 }}>
      {screens.map((s, i) => <div key={s.k}>
        <FvShot h={150} label={s.k.toLowerCase()} chrome={`${i + 1} · ${s.k}`} />
        <div style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink, marginTop: 12 }}>{s.t}</div>
        <PkBody size={13} style={{ marginTop: 6 }}>{s.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function FvWalkHotspots({ summary }: P) {
  const rules = summary.feature.rules;
  const hotspots = rules.slice(0, 4).map((r, i) => ({ n: i + 1, x: [18, 52, 78, 32][i], y: [22, 40, 64, 78][i], t: r.t, d: r.d }));
  const cur = hotspots[0];
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Anatomy of the screen</PkEyebrow>
    <PkH size={30} style={{ marginTop: 10, maxWidth: 560 }}>Every control, and why it is there.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)', gap: 'clamp(20px,3vw,36px)', marginTop: 24, alignItems: 'start' }}>
      <div style={{ position: 'relative' }}>
        <FvShot h={340} label={`${summary.feature.name.toLowerCase()} — annotated`} chrome={`${summary.identity.tag} — ${summary.feature.name}`} />
        {hotspots.map(h => <span key={h.n} title={h.t} style={{ position: 'absolute', left: `${h.x}%`, top: `${h.y}%`, transform: 'translate(-50%,-50%)', width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', fontFamily: PK.mono, fontSize: 12, background: h.n === cur?.n ? PK.accent : PK.card, color: h.n === cur?.n ? '#fff' : PK.ink, border: `2px solid ${h.n === cur?.n ? PK.accent : PK.rule}`, boxShadow: '0 2px 6px rgba(42,34,26,0.18)' }}>{h.n}</span>)}
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {hotspots.map(h => <div key={h.n} style={{ textAlign: 'left', display: 'grid', gridTemplateColumns: '26px minmax(0,1fr)', gap: 12, padding: '12px 14px', borderRadius: 10, border: `1px solid ${h.n === cur?.n ? PK.accent : PK.edge}`, background: h.n === cur?.n ? PK.card : 'transparent' }}>
          <span style={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', fontFamily: PK.mono, fontSize: 11.5, background: h.n === cur?.n ? PK.accent : PK.panel, color: h.n === cur?.n ? '#fff' : PK.inkSoft }}>{h.n}</span>
          <span>
            <span style={{ display: 'block', fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{h.t}</span>
            <span style={{ display: 'block', fontFamily: PK.sans, fontSize: 13, lineHeight: 1.5, color: PK.inkSoft, marginTop: 4 }}>{h.d}</span>
          </span>
        </div>)}
      </div>
    </div>
  </PkSection>;
}

// ── STATES (visual) ────────────────────────────────────────
function FvStatesGrid({ summary }: P) {
  const states = summary.feature.timeline.map(t => ({ k: t.w, d: t.t, tone: t.s === 'done' ? PK.sage : t.s === 'next' ? PK.accent : PK.inkMute }));
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Every state it can be in</PkEyebrow>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 16, marginTop: 22 }}>
      {states.map(s => <div key={s.k}>
        <FvShot h={140} label={`${s.k.toLowerCase()} state`} chrome={`${summary.feature.name} · ${s.k.toLowerCase()}`} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}><PkDot c={s.tone} /><span style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{s.k}</span></div>
        <PkBody size={13} style={{ marginTop: 6 }}>{s.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function FvStatesPair({ summary }: P) {
  const t = summary.feature.timeline;
  const before = t[0];
  const after = t[t.length - 1];
  if (!before || !after) return null;
  return <PkSection pad="56px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Before / after</PkEyebrow>
    <PkH size={28} style={{ marginTop: 10, maxWidth: 520 }}>The same feature, one release apart.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 18, marginTop: 24 }}>
      {([[`Before — ${before.w}`, before.t], [`After — ${after.w}`, after.t]] as const).map(([k, d], i) => <div key={k}>
        <FvShot h={220} label={i ? 'current state' : 'earlier state'} chrome={k} />
        <div style={{ fontFamily: PK.sans, fontSize: 14.5, fontWeight: 600, color: PK.ink, marginTop: 12 }}>{k}</div>
        <PkBody size={13.5} style={{ marginTop: 6 }}>{d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function FvStatesDetails({ summary }: P) {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Detail shots</PkEyebrow>
    <PkH size={28} style={{ marginTop: 10, maxWidth: 520 }}>The small parts that carry the state.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16, marginTop: 24 }}>
      {summary.feature.rules.map(d => <div key={d.t} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ height: 96, background: `repeating-linear-gradient(135deg, ${PK.panel} 0 10px, ${PK.card} 10px 20px)`, display: 'grid', placeItems: 'center', borderBottom: `1px solid ${PK.edge}`, fontFamily: PK.mono, fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: PK.inkMute }}>detail crop</div>
        <div style={{ padding: 16 }}>
          <div style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{d.t}</div>
          <PkBody size={13} style={{ marginTop: 6 }}>{d.d}</PkBody>
        </div>
      </div>)}
    </div>
  </PkSection>;
}

// ── RULES / SPEC ───────────────────────────────────────────
function FRulesCards({ summary }: P) {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Rules it will not break</PkEyebrow>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16, marginTop: 24 }}>
      {summary.feature.rules.map((r, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink }}>{r.t}</div>
        <PkBody size={14} style={{ marginTop: 7 }}>{r.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function FRulesTable({ summary }: P) {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Specification</PkEyebrow>
    <div style={{ marginTop: 22, border: `1px solid ${PK.edge}`, borderRadius: 12, overflow: 'hidden' }}>
      {summary.feature.specs.map((r, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(110px,200px) minmax(120px,260px) minmax(0,1fr)', gap: 20, padding: '14px 20px', background: i % 2 ? PK.card : 'transparent', borderTop: i ? `1px solid ${PK.edge}` : 'none', fontFamily: PK.sans, fontSize: 14 }}>
        <span style={{ color: PK.ink, fontWeight: 600 }}>{r[0]}</span>
        <span style={{ fontFamily: PK.mono, fontSize: 12.5, color: PK.accent }}>{r[1]}</span>
        <span style={{ color: PK.inkSoft }}>{r[2]}</span>
      </div>)}
    </div>
  </PkSection>;
}
function FRulesFaq({ summary }: P) {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Questions people ask</PkEyebrow>
    <div style={{ marginTop: 20, maxWidth: 760 }}>
      {summary.feature.faq.map((f, i) => <div key={i} style={{ borderTop: `1px solid ${PK.rule}` }}>
        <div style={{ width: '100%', padding: '16px 0', display: 'flex', justifyContent: 'space-between', gap: 20, fontFamily: PK.sans, fontSize: 16, fontWeight: 550, color: PK.ink }}>
          {f.q}<span style={{ color: PK.inkMute }}>{i === 0 ? '−' : '+'}</span>
        </div>
        {i === 0 && <PkBody size={15} style={{ paddingBottom: 18, maxWidth: 620 }}>{f.a}</PkBody>}
      </div>)}
    </div>
  </PkSection>;
}
function FRulesInvariants({ summary }: P) {
  return <PkSection pad="56px 80px" style={{ background: PK.deep, color: PK.paper }}>
    <PkEyebrow tone={PK.butter}>Invariants</PkEyebrow>
    <div style={{ display: 'grid', gap: 0, marginTop: 20 }}>
      {summary.feature.rules.map((r, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 28, padding: '16px 0', borderTop: '1px solid #3b3025' }}>
        <span style={{ fontFamily: PK.mono, fontSize: 13.5, color: PK.paper }}>{r.t}</span>
        <span style={{ fontFamily: PK.sans, fontSize: 14.5, lineHeight: 1.6, color: '#c1b39c' }}>{r.d}</span>
      </div>)}
    </div>
  </PkSection>;
}

// ── STATUS ─────────────────────────────────────────────────
const F_ST: Record<'done' | 'next' | 'idea', string> = { done: PK.sage, next: PK.accent, idea: PK.inkMute };
function FStatusTimeline({ summary }: P) {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Where it stands</PkEyebrow>
    <div style={{ marginTop: 24, display: 'grid', gap: 0 }}>
      {summary.feature.timeline.map((t, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '80px 20px 1fr 90px', gap: 16, alignItems: 'center', padding: '13px 0', borderTop: i ? `1px solid ${PK.rule}` : 'none' }}>
        <span style={{ fontFamily: PK.mono, fontSize: 12.5, color: PK.inkMute }}>{t.w}</span>
        <PkDot c={F_ST[t.s]} />
        <span style={{ fontFamily: PK.sans, fontSize: 15, color: PK.ink }}>{t.t}</span>
        <PkPill tone={F_ST[t.s]} border={PK.rule}>{t.s}</PkPill>
      </div>)}
    </div>
  </PkSection>;
}
function FStatusMatrix({ summary }: P) {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}`, background: PK.panel }}>
    <PkEyebrow>Release state</PkEyebrow>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginTop: 22 }}>
      {summary.feature.timeline.map((t, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 10, padding: 16, borderTop: `3px solid ${F_ST[t.s]}` }}>
        <div style={{ fontFamily: PK.mono, fontSize: 11.5, color: PK.inkMute }}>{t.w}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.ink, marginTop: 8, lineHeight: 1.4 }}>{t.t}</div>
      </div>)}
    </div>
  </PkSection>;
}
function FStatusNext({ summary }: P) {
  return <PkSection pad="48px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48 }}>
    <div>
      <PkEyebrow>Shipped</PkEyebrow>
      {summary.feature.timeline.filter(t => t.s === 'done').map((t, i) => <div key={i} style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'baseline' }}><PkDot c={PK.sage} /><span style={{ fontFamily: PK.sans, fontSize: 14.5, color: PK.inkSoft }}>{t.t}</span></div>)}
    </div>
    <div>
      <PkEyebrow tone={PK.inkMute}>Not yet</PkEyebrow>
      {summary.feature.timeline.filter(t => t.s !== 'done').map((t, i) => <div key={i} style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'baseline' }}><PkDot c={F_ST[t.s]} /><span style={{ fontFamily: PK.sans, fontSize: 14.5, color: PK.inkSoft }}>{t.t}</span></div>)}
    </div>
  </PkSection>;
}

export const PAGE_FEATURE: PageLensDef = {
  id: 'feature', label: 'Feature Description', blurb: 'Explains one capability in depth — mostly by showing it.',
  slots: [
    { id: 'header', label: 'Feature header', variants: [
      { id: 'spec', label: 'Spec header', note: 'Title plus metadata row. Reads like documentation.', component: FHeadSpec },
      { id: 'problem', label: 'Problem / solution', note: 'Two columns. Use when the pain needs naming first.', component: FHeadProblem },
      { id: 'hero', label: 'Hero with shot', note: 'Bleeds an image into the next section.', component: FHeadHero },
      { id: 'ba', label: 'Before / after', note: 'Contrast cards. Strongest for a fix to an old behaviour.', component: FHeadBeforeAfter },
    ] },
    { id: 'mech', label: 'How it works', variants: [
      { id: 'steps', label: 'Numbered steps', note: 'Ruled rows. Best for sequential mechanics.', component: FMechSteps },
      { id: 'flow', label: 'Horizontal flow', note: 'Cards with arrows. Good when order matters visually.', component: FMechFlow },
      { id: 'annotated', label: 'Annotated screenshot', note: 'Image plus numbered call-outs.', component: FMechAnnotated },
      { id: 'narrative', label: 'Narrative + rail', note: 'Prose first, steps as a supporting rail.', component: FMechNarrative },
    ] },
    { id: 'walk', label: 'Walkthrough', variants: [
      { id: 'click', label: 'Click-through', note: 'Interactive stepper — one screen at a time with a description beside it.', component: FvWalkClickthrough },
      { id: 'side', label: 'Side-by-side rows', note: 'Alternating shot / explanation. The most thorough option.', component: FvWalkSideBySide },
      { id: 'strip', label: 'Filmstrip', note: 'Screens in a row with captions. Fastest to scan.', component: FvWalkFilmstrip },
      { id: 'hotspots', label: 'Hotspot anatomy', note: 'One screen, numbered markers, clickable legend.', component: FvWalkHotspots },
    ] },
    { id: 'states', label: 'States & details', variants: [
      { id: 'grid', label: 'State gallery', note: 'Each release milestone as its own shot.', component: FvStatesGrid },
      { id: 'pair', label: 'Before / after pair', note: 'Two large shots making one comparison.', component: FvStatesPair },
      { id: 'details', label: 'Detail crops', note: 'Zoomed component shots with micro-copy.', component: FvStatesDetails },
    ] },
    { id: 'rules', label: 'Behaviour detail', variants: [
      { id: 'cards', label: 'Rule cards', note: 'Four guarantees, equal weight.', component: FRulesCards },
      { id: 'table', label: 'Spec table', note: 'Key / value / note. Densest option.', component: FRulesTable },
      { id: 'faq', label: 'Expandable FAQ', note: 'For edge cases readers ask about.', component: FRulesFaq },
      { id: 'invariants', label: 'Dark invariants', note: 'Inverted panel for hard constraints.', component: FRulesInvariants },
    ] },
    { id: 'status', label: 'Status', variants: [
      { id: 'timeline', label: 'Release timeline', note: 'Version-by-version ledger.', component: FStatusTimeline },
      { id: 'matrix', label: 'Milestone cards', note: 'Scannable across five columns.', component: FStatusMatrix },
      { id: 'next', label: 'Shipped / not yet', note: 'Two honest lists.', component: FStatusNext },
    ] },
  ],
  presets: [
    { id: 'v1', label: 'Documentation', note: 'Metadata-forward, table-driven. For internal readers.', pick: { header: 'spec', mech: 'steps', walk: 'hotspots', states: 'grid', rules: 'table', status: 'timeline' } },
    { id: 'v2', label: 'Explainer', note: 'Frames the pain, then the mechanism, then the doubts.', pick: { header: 'problem', mech: 'flow', walk: 'click', states: 'pair', rules: 'faq', status: 'matrix' } },
    { id: 'v3', label: 'Showcase', note: 'Visual-first; leans on screenshots.', pick: { header: 'hero', mech: 'annotated', walk: 'side', states: 'details', rules: 'cards', status: 'next' } },
  ],
};
