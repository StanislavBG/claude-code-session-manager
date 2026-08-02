// Architecture Overview Page — slot variants.
// Slots: summary · map · flow · decisions

const A = () => PROJ.arch;
const A_TONE = { accent: PK.accent, butter: PK.butter, sage: PK.sage, mute: PK.inkMute };

// ── SUMMARY ────────────────────────────────────────────────
function ASumLayers() {
  return <PkSection pad="56px 80px" style={{ borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Architecture</PkEyebrow>
    <PkH size={40} style={{ marginTop: 14, maxWidth: 760 }}>{A().summary}</PkH>
    <div style={{ marginTop: 34, display: 'grid', gap: 8 }}>
      {A().layers.map((l, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 90px', gap: 24, alignItems: 'center', background: PK.card, border: `1px solid ${PK.edge}`, borderLeft: `4px solid ${A_TONE[l.tone]}`, borderRadius: 10, padding: '16px 20px' }}>
        <span style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink }}>{l.n}</span>
        <span style={{ fontFamily: PK.sans, fontSize: 14, color: PK.inkSoft }}>{l.d}</span>
        <span style={{ fontFamily: PK.mono, fontSize: 12, color: PK.inkMute, textAlign: 'right' }}>{l.f}</span>
      </div>)}
    </div>
  </PkSection>;
}
function ASumPrinciples() {
  return <PkSection pad="56px 80px" style={{ borderBottom: `1px solid ${PK.rule}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 56 }}>
    <div>
      <PkEyebrow>Architecture</PkEyebrow>
      <PkH size={34} style={{ marginTop: 14 }}>{A().summary}</PkH>
    </div>
    <div style={{ display: 'grid', gap: 0 }}>
      {A().principles.map((p, i) => <div key={i} style={{ padding: '14px 0', borderTop: `1px solid ${PK.rule}` }}>
        <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink }}>{p.t}</div>
        <PkBody size={14} style={{ marginTop: 5 }}>{p.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function ASumStack() {
  return <PkSection pad="56px 80px" style={{ background: PK.deep, color: PK.paper }}>
    <PkEyebrow tone={PK.butter}>System overview</PkEyebrow>
    <PkH size={36} style={{ marginTop: 14, color: PK.paper, maxWidth: 780 }}>{A().summary}</PkH>
    <div style={{ marginTop: 30, display: 'grid', gap: 6 }}>
      {A().layers.map((l, i) => <div key={i} style={{ border: '1px solid #3b3025', borderRadius: 8, padding: '14px 18px', display: 'flex', justifyContent: 'space-between', gap: 24, alignItems: 'center', background: i === 0 ? '#241d16' : 'transparent' }}>
        <span style={{ fontFamily: PK.mono, fontSize: 13, color: l.tone === 'mute' ? '#8f8271' : A_TONE[l.tone] }}>{l.n}</span>
        <span style={{ fontFamily: PK.sans, fontSize: 13.5, color: '#bdaf97', flex: 1 }}>{l.d}</span>
        <span style={{ fontFamily: PK.mono, fontSize: 11.5, color: '#7d715e' }}>{l.f}</span>
      </div>)}
    </div>
  </PkSection>;
}
function ASumBoundary() {
  return <PkSection pad="56px 80px" style={{ borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Architecture</PkEyebrow>
    <PkH size={38} style={{ marginTop: 14, maxWidth: 720 }}>{A().summary}</PkH>
    <div style={{ marginTop: 32, border: `1px solid ${PK.edge}`, borderRadius: 14, padding: 22, background: PK.card }}>
      <div style={{ fontFamily: PK.mono, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: PK.inkMute, marginBottom: 14 }}>trust boundary — nothing crosses to the network</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
        {A().layers.map((l, i) => <div key={i} style={{ background: PK.paper, border: `1px solid ${PK.edge}`, borderRadius: 10, padding: 16, borderTop: `3px solid ${A_TONE[l.tone]}` }}>
          <div style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{l.n}</div>
          <PkBody size={12.5} style={{ marginTop: 6 }}>{l.d}</PkBody>
          <div style={{ fontFamily: PK.mono, fontSize: 11, color: PK.inkMute, marginTop: 10 }}>{l.f}</div>
        </div>)}
      </div>
    </div>
  </PkSection>;
}

// ── MODULE MAP ─────────────────────────────────────────────
function AMapBoxes() {
  const m = A().modules;
  return <PkSection pad="56px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Module map</PkEyebrow>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginTop: 24 }}>
      {m.map((x, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: PK.mono, fontSize: 13.5, color: PK.ink }}>{x.n}</span>
          <span style={{ fontFamily: PK.mono, fontSize: 11, color: PK.inkMute }}>{x.f} files</span>
        </div>
        <PkBody size={13} style={{ marginTop: 8 }}>{x.d}</PkBody>
        <div style={{ height: 3, borderRadius: 2, background: PK.rule, marginTop: 14 }}><div style={{ width: `${x.heat * 100}%`, height: '100%', borderRadius: 2, background: PK.accent }} /></div>
        {x.dep.length > 0 && <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>{x.dep.map(d => <PkPill key={d} tone={PK.inkMute}>→ {d}</PkPill>)}</div>}
      </div>)}
    </div>
  </PkSection>;
}
function AMapMatrix() {
  const m = A().modules;
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Dependency matrix</PkEyebrow>
    <PkBody size={14} style={{ marginTop: 8 }}>Row depends on column.</PkBody>
    <div style={{ marginTop: 22, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontFamily: PK.mono, fontSize: 12 }}>
        <thead><tr><th style={{ width: 130 }} />{m.map(c => <th key={c.n} style={{ padding: '8px 6px', color: PK.inkMute, fontWeight: 400, writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 96, textAlign: 'left' }}>{c.n}</th>)}</tr></thead>
        <tbody>{m.map(r => <tr key={r.n}>
          <td style={{ padding: '7px 12px 7px 0', color: PK.ink, whiteSpace: 'nowrap', borderTop: `1px solid ${PK.rule}` }}>{r.n}</td>
          {m.map(c => { const on = r.dep.includes(c.n); return <td key={c.n} style={{ borderTop: `1px solid ${PK.rule}`, borderLeft: `1px solid ${PK.rule}`, width: 40, height: 34, textAlign: 'center', background: on ? PK.accent : r.n === c.n ? PK.panel : 'transparent', color: '#fff' }}>{on ? '●' : ''}</td>; })}
        </tr>)}</tbody>
      </table>
    </div>
  </PkSection>;
}
function AMapTree() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Where the code lives</PkEyebrow>
    <div style={{ marginTop: 22, background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: '18px 22px', fontFamily: PK.mono, fontSize: 13, lineHeight: 2 }}>
      <div style={{ color: PK.inkMute }}>src/</div>
      {A().modules.map((x, i) => <div key={i} style={{ display: 'flex', gap: 14, paddingLeft: 18 }}>
        <span style={{ color: PK.inkMute }}>{i === A().modules.length - 1 ? '└─' : '├─'}</span>
        <span style={{ color: PK.ink, minWidth: 120 }}>{x.n}/</span>
        <span style={{ color: PK.inkMute, fontSize: 12 }}>{x.f} files · {x.d}</span>
      </div>)}
    </div>
  </PkSection>;
}
function AMapLanes() {
  const lanes = [['Renderer', ['shell', 'usage']], ['Main', ['sessionPool', 'scheduler', 'epicStore']], ['Storage', ['queueStore']]];
  const byName = Object.fromEntries(A().modules.map(m => [m.n, m]));
  return <PkSection pad="56px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Process lanes</PkEyebrow>
    <div style={{ marginTop: 24, display: 'grid', gap: 12 }}>
      {lanes.map(([lane, names]) => <div key={lane} style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 20, alignItems: 'center' }}>
        <div style={{ fontFamily: PK.mono, fontSize: 11.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: PK.inkMute }}>{lane}</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {names.map(n => <div key={n} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 10, padding: '12px 16px', minWidth: 190 }}>
            <div style={{ fontFamily: PK.mono, fontSize: 13, color: PK.ink }}>{n}</div>
            <div style={{ fontFamily: PK.sans, fontSize: 12.5, color: PK.inkSoft, marginTop: 4 }}>{byName[n].d}</div>
          </div>)}
        </div>
      </div>)}
    </div>
  </PkSection>;
}

// ── FLOW ───────────────────────────────────────────────────
function AFlowSequence() {
  return <PkSection pad="56px 80px">
    <PkEyebrow>Control flow — approving a PRD</PkEyebrow>
    <div style={{ marginTop: 24 }}>
      {A().flow.map((f, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(70px,120px) 24px minmax(70px,120px) minmax(0,1fr)', gap: 16, alignItems: 'center', padding: '14px 0', borderTop: `1px solid ${PK.rule}` }}>
        <span style={{ fontFamily: PK.mono, fontSize: 12.5, color: PK.ink, textAlign: 'right' }}>{f.a}</span>
        <span style={{ color: PK.accent, textAlign: 'center', fontFamily: PK.mono }}>→</span>
        <span style={{ fontFamily: PK.mono, fontSize: 12.5, color: PK.ink }}>{f.b}</span>
        <span><span style={{ fontFamily: PK.mono, fontSize: 12.5, color: PK.accent }}>{f.t}</span><span style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.inkMute, marginLeft: 12 }}>{f.n}</span></span>
      </div>)}
    </div>
  </PkSection>;
}
function AFlowRail() {
  return <PkSection pad="56px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>The path of one job</PkEyebrow>
    <div style={{ marginTop: 26, position: 'relative', paddingLeft: 26 }}>
      <div style={{ position: 'absolute', left: 5, top: 6, bottom: 6, width: 2, background: PK.rule }} />
      {A().flow.map((f, i) => <div key={i} style={{ position: 'relative', paddingBottom: 22 }}>
        <span style={{ position: 'absolute', left: -26, top: 4, width: 12, height: 12, borderRadius: '50%', background: PK.card, border: `2px solid ${PK.accent}` }} />
        <div style={{ fontFamily: PK.mono, fontSize: 13, color: PK.ink }}>{f.a} <span style={{ color: PK.inkMute }}>→</span> {f.b}</div>
        <div style={{ fontFamily: PK.mono, fontSize: 12.5, color: PK.accent, marginTop: 4 }}>{f.t}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.inkSoft, marginTop: 3 }}>{f.n}</div>
      </div>)}
    </div>
  </PkSection>;
}
function AFlowDiagram() {
  const nodes = ['Renderer', 'IPC', 'scheduler', 'sessionPool', 'CLI', 'epicStore'];
  return <PkSection pad="56px 80px">
    <PkEyebrow>Message path</PkEyebrow>
    <div style={{ marginTop: 26, display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap', rowGap: 14 }}>
      {nodes.map((n, i) => <React.Fragment key={n}>
        <div style={{ border: `1px solid ${PK.edge}`, background: PK.card, borderRadius: 999, padding: '9px 16px', fontFamily: PK.mono, fontSize: 12.5, color: PK.ink }}>{n}</div>
        {i < nodes.length - 1 && <div style={{ flex: '1 1 30px', minWidth: 30, height: 1, background: PK.rule, position: 'relative' }}><span style={{ position: 'absolute', right: -1, top: -4, color: PK.rule, fontSize: 10 }}>▶</span></div>}
      </React.Fragment>)}
    </div>
    <div style={{ marginTop: 26, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
      {A().flow.map((f, i) => <div key={i} style={{ border: `1px solid ${PK.edge}`, borderRadius: 10, padding: 14, background: PK.card }}>
        <div style={{ fontFamily: PK.mono, fontSize: 12, color: PK.accent }}>{f.t}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 13, color: PK.inkSoft, marginTop: 6 }}>{f.n}</div>
      </div>)}
    </div>
  </PkSection>;
}

// ── DECISIONS ──────────────────────────────────────────────
function ADecAdr() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Decisions of record</PkEyebrow>
    <div style={{ marginTop: 22 }}>
      {A().decisions.map((d, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 24, padding: '18px 0', borderTop: `1px solid ${PK.rule}` }}>
        <div><div style={{ fontFamily: PK.mono, fontSize: 12, color: PK.accent }}>{d.id}</div><PkPill tone={PK.sage} style={{ marginTop: 8 }}>{d.s}</PkPill></div>
        <div><div style={{ fontFamily: PK.sans, fontSize: 16, fontWeight: 600, color: PK.ink }}>{d.t}</div><PkBody size={14.5} style={{ marginTop: 6, maxWidth: 660 }}>{d.w}</PkBody></div>
      </div>)}
    </div>
  </PkSection>;
}
function ADecCards() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Decisions of record</PkEyebrow>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16, marginTop: 24 }}>
      {A().decisions.map((d, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ fontFamily: PK.mono, fontSize: 11.5, color: PK.accent }}>{d.id}</span><PkPill tone={PK.sage}>{d.s}</PkPill></div>
        <div style={{ fontFamily: PK.sans, fontSize: 15.5, fontWeight: 600, color: PK.ink, marginTop: 10 }}>{d.t}</div>
        <PkBody size={14} style={{ marginTop: 7 }}>{d.w}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function ADecRisks() {
  const tone = { open: PK.accent, watching: PK.butter, mitigated: PK.sage };
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}`, background: PK.panel }}>
    <PkEyebrow>Known risks</PkEyebrow>
    <div style={{ marginTop: 22, display: 'grid', gap: 10 }}>
      {A().risks.map((r, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderLeft: `4px solid ${tone[r.s]}`, borderRadius: 10, padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr 110px', gap: 20, alignItems: 'center' }}>
        <div><div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink }}>{r.t}</div><PkBody size={13.5} style={{ marginTop: 5 }}>{r.d}</PkBody></div>
        <PkPill tone={tone[r.s]} style={{ justifySelf: 'end' }}>{r.s}</PkPill>
      </div>)}
    </div>
  </PkSection>;
}
function ADecPrinciples() {
  return <PkSection pad="56px 80px" style={{ background: PK.deep }}>
    <PkEyebrow tone={PK.butter}>Rules the system holds itself to</PkEyebrow>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 26, marginTop: 26 }}>
      {A().principles.map((p, i) => <div key={i}>
        <div style={{ fontFamily: PK.serif, fontSize: 22, color: PK.paper }}>{p.t}</div>
        <PkBody size={14} style={{ marginTop: 8, color: '#bdaf97' }}>{p.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}

window.PAGE_ARCH = {
  id: 'arch', label: 'Architecture Overview', blurb: 'Orients an engineer to the shape of the system before they touch it.',
  slots: [
    { id: 'summary', label: 'System summary', variants: [
      { id: 'layers', label: 'Layer ledger', note: 'Stacked rows, top to bottom. The default.', C: ASumLayers },
      { id: 'principles', label: 'Summary + principles', note: 'Statement left, rules right.', C: ASumPrinciples },
      { id: 'stack', label: 'Dark stack', note: 'Inverted; reads as a systems doc.', C: ASumStack },
      { id: 'boundary', label: 'Trust boundary', note: 'Boxes inside an explicit boundary frame.', C: ASumBoundary },
    ] },
    { id: 'map', label: 'Module map', variants: [
      { id: 'boxes', label: 'Module cards', note: 'Grid with churn bars and dependency chips.', C: AMapBoxes },
      { id: 'matrix', label: 'Dependency matrix', note: 'Row depends on column. Densest, most precise.', C: AMapMatrix },
      { id: 'tree', label: 'Source tree', note: 'Mono tree of directories. Good for newcomers.', C: AMapTree },
      { id: 'lanes', label: 'Process lanes', note: 'Groups modules by the process they run in.', C: AMapLanes },
    ] },
    { id: 'flow', label: 'Control flow', variants: [
      { id: 'seq', label: 'Sequence rows', note: 'A → B with message and note.', C: AFlowSequence },
      { id: 'rail', label: 'Vertical rail', note: 'One job followed end to end.', C: AFlowRail },
      { id: 'diagram', label: 'Node chain + calls', note: 'Path across the top, calls beneath.', C: AFlowDiagram },
    ] },
    { id: 'dec', label: 'Decisions & risk', variants: [
      { id: 'adr', label: 'ADR list', note: 'Numbered, with the reasoning kept.', C: ADecAdr },
      { id: 'cards', label: 'Decision cards', note: 'Two-up, scannable.', C: ADecCards },
      { id: 'risks', label: 'Risk register', note: 'What could still bite, and its state.', C: ADecRisks },
      { id: 'principles', label: 'Dark principles', note: 'Closes on the values, not the caveats.', C: ADecPrinciples },
    ] },
  ],
  presets: [
    { id: 'v1', label: 'Orientation', note: 'For a new engineer on day one.', pick: { summary: 'layers', map: 'boxes', flow: 'rail', dec: 'adr' } },
    { id: 'v2', label: 'Review', note: 'Precise and dense — for an architecture review.', pick: { summary: 'boundary', map: 'matrix', flow: 'seq', dec: 'risks' } },
    { id: 'v3', label: 'Narrative', note: 'Reads like a systems essay.', pick: { summary: 'stack', map: 'lanes', flow: 'diagram', dec: 'principles' } },
  ],
};
