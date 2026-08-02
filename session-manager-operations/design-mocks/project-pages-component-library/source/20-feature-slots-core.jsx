// Feature Description Page — slot variants.
// Slots: header · mechanism · rules · status

const F = () => PROJ.feature;

// ── HEADER ─────────────────────────────────────────────────
function FHeadSpec() {
  const f = F();
  return <PkSection pad="56px 80px 40px" style={{ borderBottom: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <PkEyebrow>{f.kicker}</PkEyebrow><span style={{ color: PK.rule }}>/</span>
      <PkPill bg={PK.card}><PkDot />{f.status}</PkPill><PkPill>{f.owner}</PkPill>
    </div>
    <PkH size={46} style={{ marginTop: 18 }}>{f.name}</PkH>
    <PkBody size={18} style={{ marginTop: 14, maxWidth: 720 }}>{f.oneLine}</PkBody>
    <div style={{ display: 'flex', gap: 40, marginTop: 30, flexWrap: 'wrap' }}>
      {[['Owner', f.owner], ['Status', f.status], ['Surfaces', 'Scheduler · Epics · Project Home'], ['Since', 'v0.44']].map(([k, v]) =>
        <div key={k}><div style={{ fontFamily: PK.mono, fontSize: 10.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: PK.inkMute }}>{k}</div><div style={{ fontFamily: PK.sans, fontSize: 14, color: PK.ink, marginTop: 5 }}>{v}</div></div>)}
    </div>
  </PkSection>;
}
function FHeadProblem() {
  const f = F();
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
function FHeadHero() {
  const f = F();
  return <PkSection pad="64px 80px 0" style={{ background: PK.panel, borderBottom: `1px solid ${PK.rule}` }}>
    <div style={{ maxWidth: 700 }}>
      <PkEyebrow>{f.kicker} · {f.status}</PkEyebrow>
      <PkH size={48} style={{ marginTop: 16 }}>{f.name}</PkH>
      <PkBody size={17} style={{ marginTop: 14 }}>{f.oneLine}</PkBody>
    </div>
    <PkShot h={260} label="feature in context" style={{ marginTop: 36, marginBottom: -1, borderRadius: '12px 12px 0 0', background: PK.card, borderStyle: 'solid', borderBottom: 'none' }} />
  </PkSection>;
}
function FHeadBeforeAfter() {
  const f = F();
  return <PkSection pad="56px 80px" style={{ borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>{f.kicker}</PkEyebrow>
    <PkH size={40} style={{ marginTop: 14 }}>{f.name}</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginTop: 30 }}>
      {[['Before', f.problem, PK.rule], ['After', f.solution, PK.sage]].map(([k, v, c]) =>
        <div key={k} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 24, borderTop: `3px solid ${c}` }}>
          <div style={{ fontFamily: PK.mono, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: PK.inkMute }}>{k}</div>
          <PkBody size={15} style={{ marginTop: 10 }}>{v}</PkBody>
        </div>)}
    </div>
  </PkSection>;
}

// ── MECHANISM ──────────────────────────────────────────────
function FMechSteps() {
  return <PkSection pad="56px 80px">
    <PkEyebrow>How it works</PkEyebrow>
    <PkH size={32} style={{ marginTop: 12 }}>Five steps, start to drain.</PkH>
    <div style={{ marginTop: 30 }}>
      {F().steps.map((s, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '44px minmax(110px,200px) minmax(0,1fr)', gap: 20, padding: '18px 0', borderTop: `1px solid ${PK.rule}`, alignItems: 'baseline' }}>
        <div style={{ fontFamily: PK.mono, fontSize: 13, color: PK.accent }}>{String(i + 1).padStart(2, '0')}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink }}>{s.t}</div>
        <PkBody size={14.5}>{s.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function FMechFlow() {
  return <PkSection pad="56px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>The path a job takes</PkEyebrow>
    <div style={{ display: 'flex', gap: 0, marginTop: 26, alignItems: 'stretch', flexWrap: 'wrap' }}>
      {F().steps.map((s, i) => <React.Fragment key={i}>
        <div style={{ flex: '1 1 150px', background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 10, padding: 16 }}>
          <div style={{ fontFamily: PK.mono, fontSize: 10.5, color: PK.accent }}>{String(i + 1).padStart(2, '0')}</div>
          <div style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink, marginTop: 8 }}>{s.t}</div>
          <PkBody size={12.5} style={{ marginTop: 6 }}>{s.d}</PkBody>
        </div>
        {i < 4 && <div style={{ width: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: PK.inkMute, fontFamily: PK.mono }}>→</div>}
      </React.Fragment>)}
    </div>
  </PkSection>;
}
function FMechAnnotated() {
  return <PkSection pad="56px 80px" style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 40 }}>
    <div>
      <PkEyebrow>Anatomy</PkEyebrow>
      <PkH size={30} style={{ marginTop: 12 }}>What you are looking at.</PkH>
      <PkShot h={300} label="annotated interface" style={{ marginTop: 22 }} />
    </div>
    <div style={{ paddingTop: 78 }}>
      {F().steps.slice(0, 4).map((s, i) => <div key={i} style={{ display: 'flex', gap: 12, padding: '14px 0', borderTop: `1px solid ${PK.rule}` }}>
        <span style={{ flex: 'none', width: 20, height: 20, borderRadius: '50%', background: PK.accent, color: '#fff', fontFamily: PK.mono, fontSize: 11, display: 'grid', placeItems: 'center' }}>{i + 1}</span>
        <div><div style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{s.t}</div><PkBody size={13} style={{ marginTop: 4 }}>{s.d}</PkBody></div>
      </div>)}
    </div>
  </PkSection>;
}
function FMechNarrative() {
  const f = F();
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

// ── RULES / SPEC ───────────────────────────────────────────
function FRulesCards() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Rules it will not break</PkEyebrow>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16, marginTop: 24 }}>
      {F().rules.map((r, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink }}>{r.t}</div>
        <PkBody size={14} style={{ marginTop: 7 }}>{r.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function FRulesTable() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Specification</PkEyebrow>
    <div style={{ marginTop: 22, border: `1px solid ${PK.edge}`, borderRadius: 12, overflow: 'hidden' }}>
      {F().specs.map((r, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(110px,200px) minmax(120px,260px) minmax(0,1fr)', gap: 20, padding: '14px 20px', background: i % 2 ? PK.card : 'transparent', borderTop: i ? `1px solid ${PK.edge}` : 'none', fontFamily: PK.sans, fontSize: 14 }}>
        <span style={{ color: PK.ink, fontWeight: 600 }}>{r[0]}</span>
        <span style={{ fontFamily: PK.mono, fontSize: 12.5, color: PK.accent }}>{r[1]}</span>
        <span style={{ color: PK.inkSoft }}>{r[2]}</span>
      </div>)}
    </div>
  </PkSection>;
}
function FRulesFaq() {
  const [open, setOpen] = React.useState(0);
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Questions people ask</PkEyebrow>
    <div style={{ marginTop: 20, maxWidth: 760 }}>
      {F().faq.map((f, i) => <div key={i} style={{ borderTop: `1px solid ${PK.rule}` }}>
        <button onClick={() => setOpen(open === i ? -1 : i)} style={{ appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', width: '100%', textAlign: 'left', padding: '16px 0', display: 'flex', justifyContent: 'space-between', gap: 20, fontFamily: PK.sans, fontSize: 16, fontWeight: 550, color: PK.ink }}>
          {f.q}<span style={{ color: PK.inkMute }}>{open === i ? '−' : '+'}</span>
        </button>
        {open === i && <PkBody size={15} style={{ paddingBottom: 18, maxWidth: 620 }}>{f.a}</PkBody>}
      </div>)}
    </div>
  </PkSection>;
}
function FRulesInvariants() {
  return <PkSection pad="56px 80px" style={{ background: PK.deep, color: PK.paper }}>
    <PkEyebrow tone={PK.butter}>Invariants</PkEyebrow>
    <div style={{ display: 'grid', gap: 0, marginTop: 20 }}>
      {F().rules.map((r, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 28, padding: '16px 0', borderTop: '1px solid #3b3025' }}>
        <span style={{ fontFamily: PK.mono, fontSize: 13.5, color: PK.paper }}>{r.t}</span>
        <span style={{ fontFamily: PK.sans, fontSize: 14.5, lineHeight: 1.6, color: '#c1b39c' }}>{r.d}</span>
      </div>)}
    </div>
  </PkSection>;
}

// ── STATUS ─────────────────────────────────────────────────
const F_ST = { done: PK.sage, next: PK.accent, idea: PK.inkMute };
function FStatusTimeline() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Where it stands</PkEyebrow>
    <div style={{ marginTop: 24, display: 'grid', gap: 0 }}>
      {F().timeline.map((t, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '80px 20px 1fr 90px', gap: 16, alignItems: 'center', padding: '13px 0', borderTop: i ? `1px solid ${PK.rule}` : 'none' }}>
        <span style={{ fontFamily: PK.mono, fontSize: 12.5, color: PK.inkMute }}>{t.w}</span>
        <PkDot c={F_ST[t.s]} />
        <span style={{ fontFamily: PK.sans, fontSize: 15, color: PK.ink }}>{t.t}</span>
        <PkPill tone={F_ST[t.s]} border={PK.rule}>{t.s}</PkPill>
      </div>)}
    </div>
  </PkSection>;
}
function FStatusMatrix() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}`, background: PK.panel }}>
    <PkEyebrow>Release state</PkEyebrow>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginTop: 22 }}>
      {F().timeline.map((t, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 10, padding: 16, borderTop: `3px solid ${F_ST[t.s]}` }}>
        <div style={{ fontFamily: PK.mono, fontSize: 11.5, color: PK.inkMute }}>{t.w}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.ink, marginTop: 8, lineHeight: 1.4 }}>{t.t}</div>
      </div>)}
    </div>
  </PkSection>;
}
function FStatusNext() {
  return <PkSection pad="48px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48 }}>
    <div>
      <PkEyebrow>Shipped</PkEyebrow>
      {F().timeline.filter(t => t.s === 'done').map((t, i) => <div key={i} style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'baseline' }}><PkDot c={PK.sage} /><span style={{ fontFamily: PK.sans, fontSize: 14.5, color: PK.inkSoft }}>{t.t}</span></div>)}
    </div>
    <div>
      <PkEyebrow tone={PK.inkMute}>Not yet</PkEyebrow>
      {F().timeline.filter(t => t.s !== 'done').map((t, i) => <div key={i} style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'baseline' }}><PkDot c={F_ST[t.s]} /><span style={{ fontFamily: PK.sans, fontSize: 14.5, color: PK.inkSoft }}>{t.t}</span></div>)}
    </div>
  </PkSection>;
}

window.PAGE_FEATURE = {
  id: 'feature', label: 'Feature Description', blurb: 'Explains one capability in depth to someone deciding whether to rely on it.',
  slots: [
    { id: 'header', label: 'Feature header', variants: [
      { id: 'spec', label: 'Spec header', note: 'Title plus metadata row. Reads like documentation.', C: FHeadSpec },
      { id: 'problem', label: 'Problem / solution', note: 'Two columns. Use when the pain needs naming first.', C: FHeadProblem },
      { id: 'hero', label: 'Hero with shot', note: 'Bleeds an image into the next section.', C: FHeadHero },
      { id: 'ba', label: 'Before / after', note: 'Contrast cards. Strongest for a fix to an old behaviour.', C: FHeadBeforeAfter },
    ] },
    { id: 'mech', label: 'How it works', variants: [
      { id: 'steps', label: 'Numbered steps', note: 'Ruled rows. Best for sequential mechanics.', C: FMechSteps },
      { id: 'flow', label: 'Horizontal flow', note: 'Cards with arrows. Good when order matters visually.', C: FMechFlow },
      { id: 'annotated', label: 'Annotated screenshot', note: 'Image plus numbered call-outs.', C: FMechAnnotated },
      { id: 'narrative', label: 'Narrative + rail', note: 'Prose first, steps as a supporting rail.', C: FMechNarrative },
    ] },
    { id: 'rules', label: 'Behaviour detail', variants: [
      { id: 'cards', label: 'Rule cards', note: 'Four guarantees, equal weight.', C: FRulesCards },
      { id: 'table', label: 'Spec table', note: 'Key / value / note. Densest option.', C: FRulesTable },
      { id: 'faq', label: 'Expandable FAQ', note: 'For edge cases readers ask about.', C: FRulesFaq },
      { id: 'invariants', label: 'Dark invariants', note: 'Inverted panel for hard constraints.', C: FRulesInvariants },
    ] },
    { id: 'status', label: 'Status', variants: [
      { id: 'timeline', label: 'Release timeline', note: 'Version-by-version ledger.', C: FStatusTimeline },
      { id: 'matrix', label: 'Milestone cards', note: 'Scannable across five columns.', C: FStatusMatrix },
      { id: 'next', label: 'Shipped / not yet', note: 'Two honest lists.', C: FStatusNext },
    ] },
  ],
  presets: [
    { id: 'v1', label: 'Documentation', note: 'Metadata-forward, table-driven. For internal readers.', pick: { header: 'spec', mech: 'steps', rules: 'table', status: 'timeline' } },
    { id: 'v2', label: 'Explainer', note: 'Frames the pain, then the mechanism, then the doubts.', pick: { header: 'problem', mech: 'flow', rules: 'faq', status: 'matrix' } },
    { id: 'v3', label: 'Showcase', note: 'Visual-first; leans on screenshots.', pick: { header: 'hero', mech: 'annotated', rules: 'cards', status: 'next' } },
  ],
};
