// Feature Description — visual-first slots.
// Click-through walkthroughs, screenshot placeholders framed as app windows,
// and side-by-side "what you are seeing" descriptions.

// App-window frame around a screenshot placeholder the agent will fill.
function FvShot({ h = 300, label = 'screenshot', chrome = 'session-manager — Scheduler', style, children }) {
  return <figure style={{ margin: 0, border: `1px solid ${PK.edge}`, borderRadius: 12, overflow: 'hidden', background: PK.card, boxShadow: '0 6px 18px rgba(42,34,26,0.07)', ...style }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: PK.panel, borderBottom: `1px solid ${PK.edge}` }}>
      <span style={{ display: 'flex', gap: 5 }}>{['#d3a08a', '#e0cf9c', '#a8bb92'].map(c => <span key={c} style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />)}</span>
      <span style={{ fontFamily: PK.mono, fontSize: 10.5, color: PK.inkMute, marginLeft: 4 }}>{chrome}</span>
    </div>
    <div style={{ position: 'relative', height: h, background: `repeating-linear-gradient(135deg, ${PK.panel} 0 10px, ${PK.card} 10px 20px)`, display: 'grid', placeItems: 'center' }}>
      <span style={{ fontFamily: PK.mono, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: PK.inkMute }}>{label}</span>
      {children}
    </div>
  </figure>;
}
function FvMarkerUnused() { return null; }

const FV = {
  screens: [
    { k: 'Queue', t: 'The queue before anything runs', d: 'Approved PRDs sit in enqueue order with their dependency set visible. Nothing has claimed a slot yet — the pool shows 0 of 3 in use.', pts: ['Order is explicit and draggable', 'Dependencies shown as chips on each job', 'Pool counter is machine-wide'], chrome: 'session-manager — Scheduler · queue' },
    { k: 'Claim', t: 'A job claims one of three slots', d: 'When a slot frees and the memory gate is open, the head of the queue is claimed. The row changes state in place — no navigation, no modal.', pts: ['Memory gate state shown beside the pool', 'Claim is atomic; two jobs never share a slot', 'Blocked jobs say why they are blocked'], chrome: 'session-manager — Scheduler · running' },
    { k: 'Run', t: 'Output streams into the Epic', d: 'The headless run writes turns into the Epic thread as they happen, so the job and the conversation about it stay in one place.', pts: ['Live turn count and elapsed time', 'Tool calls appear as they are permitted', 'You can interrupt from the thread'], chrome: 'session-manager — Epic · thread' },
    { k: 'Done', t: 'Definition of done, checked', d: 'The runner evaluates the definition of done attached to the PRD, marks the job, and releases the slot for the next in line.', pts: ['Diff summary posted back to the Epic', 'Failures re-queue with the original deps', 'Slot released immediately on exit'], chrome: 'session-manager — Epic · summary' },
  ],
  hotspots: [
    { n: 1, x: 18, y: 22, t: 'Pool meter', d: 'Slots in use, machine-wide. Turns amber when the memory gate closes.' },
    { n: 2, x: 52, y: 40, t: 'Job row', d: 'State, project, dependency chips and elapsed time in one line.' },
    { n: 3, x: 78, y: 64, t: 'Window budget', d: 'How much of the 5-hour billing window is left to plan against.' },
    { n: 4, x: 32, y: 78, t: 'Drain control', d: 'Pause the queue without cancelling anything already claimed.' },
  ],
  states: [
    { k: 'Empty', d: 'No approved PRDs. The panel explains what approval does rather than showing a blank list.', tone: PK.inkMute },
    { k: 'Running', d: 'One job claimed, two slots free, elapsed time ticking on the active row.', tone: PK.sage },
    { k: 'Blocked', d: 'Memory gate closed — jobs stay queued and the reason is stated, not implied.', tone: PK.butter },
    { k: 'Failed', d: 'The run exited non-zero. The row keeps its deps and offers retry, take over, or skip.', tone: PK.accent },
  ],
  details: [
    { t: 'Dependency chip', d: 'Shows the job this one waits on. Satisfied deps go quiet; unsatisfied ones stay marked.' },
    { t: 'Slot badge', d: 'Which of the three slots a run holds — the same badge appears in the Epic thread.' },
    { t: 'Gate indicator', d: 'Free RAM against the threshold, so a stalled queue is never a mystery.' },
  ],
};

// ── WALKTHROUGH ────────────────────────────────────────────
function FvWalkClickthrough() {
  const [i, setI] = React.useState(0);
  const s = FV.screens[i];
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
      <div><PkEyebrow>Click through it</PkEyebrow><PkH size={30} style={{ marginTop: 10 }}>One job, start to finish.</PkH></div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontFamily: PK.mono, fontSize: 11.5, color: PK.inkMute, marginRight: 6 }}>{i + 1} / {FV.screens.length}</span>
        <PkBtn small onClick={() => setI(Math.max(0, i - 1))}>←</PkBtn>
        <PkBtn small primary onClick={() => setI((i + 1) % FV.screens.length)}>→</PkBtn>
      </div>
    </div>
    <div style={{ display: 'flex', gap: 6, marginTop: 20, flexWrap: 'wrap' }}>
      {FV.screens.map((x, n) => <button key={x.k} onClick={() => setI(n)} style={{ appearance: 'none', cursor: 'pointer', fontFamily: PK.sans, fontSize: 12.5, fontWeight: n === i ? 600 : 500, padding: '6px 13px', borderRadius: 999, border: `1px solid ${n === i ? PK.accent : PK.rule}`, background: n === i ? PK.accent : 'transparent', color: n === i ? '#fff' : PK.inkSoft }}>{n + 1}. {x.k}</button>)}
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
function FvWalkSideBySide() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'grid', gap: 4 }}>
    <PkEyebrow>Screen by screen</PkEyebrow>
    {FV.screens.map((s, i) => <div key={s.k} style={{ display: 'grid', gridTemplateColumns: i % 2 ? 'minmax(0,1fr) minmax(0,1.25fr)' : 'minmax(0,1.25fr) minmax(0,1fr)', gap: 'clamp(22px,3.5vw,44px)', alignItems: 'center', padding: '30px 0', borderTop: `1px solid ${PK.rule}` }}>
      <FvShot h={230} label={`${s.k.toLowerCase()} screen`} chrome={s.chrome} style={{ order: i % 2 ? 2 : 1 }} />
      <div style={{ order: i % 2 ? 1 : 2 }}>
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
function FvWalkFilmstrip() {
  return <PkSection pad="56px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>The whole path</PkEyebrow>
    <PkH size={28} style={{ marginTop: 10, maxWidth: 520 }}>Four screens, in the order you meet them.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14, marginTop: 26 }}>
      {FV.screens.map((s, i) => <div key={s.k}>
        <FvShot h={150} label={s.k.toLowerCase()} chrome={`${i + 1} · ${s.k}`} />
        <div style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink, marginTop: 12 }}>{s.t}</div>
        <PkBody size={13} style={{ marginTop: 6 }}>{s.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function FvWalkHotspots() {
  const [n, setN] = React.useState(1);
  const cur = FV.hotspots.find(h => h.n === n);
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Anatomy of the screen</PkEyebrow>
    <PkH size={30} style={{ marginTop: 10, maxWidth: 560 }}>Every control, and why it is there.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)', gap: 'clamp(20px,3vw,36px)', marginTop: 24, alignItems: 'start' }}>
      <FvShot h={340} label="scheduler — annotated" chrome="session-manager — Scheduler">
        {FV.hotspots.map(h => <button key={h.n} onClick={() => setN(h.n)} title={h.t} style={{ position: 'absolute', left: `${h.x}%`, top: `${h.y}%`, transform: 'translate(-50%,-50%)', width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', cursor: 'pointer', fontFamily: PK.mono, fontSize: 12, background: h.n === n ? PK.accent : PK.card, color: h.n === n ? '#fff' : PK.ink, border: `2px solid ${h.n === n ? PK.accent : PK.rule}`, boxShadow: '0 2px 6px rgba(42,34,26,0.18)', padding: 0 }}>{h.n}</button>)}
      </FvShot>
      <div style={{ display: 'grid', gap: 6 }}>
        {FV.hotspots.map(h => <button key={h.n} onClick={() => setN(h.n)} style={{ appearance: 'none', cursor: 'pointer', textAlign: 'left', display: 'grid', gridTemplateColumns: '26px minmax(0,1fr)', gap: 12, padding: '12px 14px', borderRadius: 10, border: `1px solid ${h.n === n ? PK.accent : PK.edge}`, background: h.n === n ? PK.card : 'transparent' }}>
          <span style={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', fontFamily: PK.mono, fontSize: 11.5, background: h.n === n ? PK.accent : PK.panel, color: h.n === n ? '#fff' : PK.inkSoft }}>{h.n}</span>
          <span>
            <span style={{ display: 'block', fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{h.t}</span>
            <span style={{ display: 'block', fontFamily: PK.sans, fontSize: 13, lineHeight: 1.5, color: PK.inkSoft, marginTop: 4 }}>{h.d}</span>
          </span>
        </button>)}
      </div>
    </div>
  </PkSection>;
}

// ── STATES ─────────────────────────────────────────────────
function FvStatesGrid() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Every state it can be in</PkEyebrow>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 16, marginTop: 22 }}>
      {FV.states.map(s => <div key={s.k}>
        <FvShot h={140} label={`${s.k.toLowerCase()} state`} chrome={`Scheduler · ${s.k.toLowerCase()}`} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}><PkDot c={s.tone} /><span style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{s.k}</span></div>
        <PkBody size={13} style={{ marginTop: 6 }}>{s.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function FvStatesPair() {
  return <PkSection pad="56px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Before / after</PkEyebrow>
    <PkH size={28} style={{ marginTop: 10, maxWidth: 520 }}>The same queue, one restart apart.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 18, marginTop: 24 }}>
      {[['Before — v0.43', 'Queue held in memory. A crash lost every pending job and the order they were in.'], ['After — v0.50', 'Queue written to sqlite at enqueue. Boot reconciliation restores order, deps and mid-run state.']].map(([k, d], i) => <div key={k}>
        <FvShot h={220} label={i ? 'restored queue' : 'lost queue'} chrome={k} />
        <div style={{ fontFamily: PK.sans, fontSize: 14.5, fontWeight: 600, color: PK.ink, marginTop: 12 }}>{k}</div>
        <PkBody size={13.5} style={{ marginTop: 6 }}>{d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function FvStatesDetails() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Detail shots</PkEyebrow>
    <PkH size={28} style={{ marginTop: 10, maxWidth: 520 }}>The small parts that carry the state.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16, marginTop: 24 }}>
      {FV.details.map(d => <div key={d.t} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ height: 96, background: `repeating-linear-gradient(135deg, ${PK.panel} 0 10px, ${PK.card} 10px 20px)`, display: 'grid', placeItems: 'center', borderBottom: `1px solid ${PK.edge}`, fontFamily: PK.mono, fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: PK.inkMute }}>detail crop</div>
        <div style={{ padding: 16 }}>
          <div style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{d.t}</div>
          <PkBody size={13} style={{ marginTop: 6 }}>{d.d}</PkBody>
        </div>
      </div>)}
    </div>
  </PkSection>;
}

// Splice visual slots into the Feature page and make the presets visual-first.
(function () {
  const P = window.PAGE_FEATURE;
  const walk = { id: 'walk', label: 'Walkthrough', variants: [
    { id: 'click', label: 'Click-through', note: 'Interactive stepper — one screen at a time with a description beside it.', C: FvWalkClickthrough },
    { id: 'side', label: 'Side-by-side rows', note: 'Alternating shot / explanation. The most thorough option.', C: FvWalkSideBySide },
    { id: 'strip', label: 'Filmstrip', note: 'Four screens in a row with captions. Fastest to scan.', C: FvWalkFilmstrip },
    { id: 'hotspots', label: 'Hotspot anatomy', note: 'One screen, numbered markers, clickable legend.', C: FvWalkHotspots },
  ] };
  const states = { id: 'states', label: 'States & details', variants: [
    { id: 'grid', label: 'State gallery', note: 'Empty, running, blocked, failed — each as its own shot.', C: FvStatesGrid },
    { id: 'pair', label: 'Before / after pair', note: 'Two large shots making one comparison.', C: FvStatesPair },
    { id: 'details', label: 'Detail crops', note: 'Zoomed component shots with micro-copy.', C: FvStatesDetails },
  ] };
  const at = P.slots.findIndex(s => s.id === 'rules');
  P.slots.splice(at, 0, walk, states);
  Object.assign(P.presets[0].pick, { walk: 'hotspots', states: 'grid' });
  Object.assign(P.presets[1].pick, { walk: 'click', states: 'pair' });
  Object.assign(P.presets[2].pick, { header: 'hero', mech: 'annotated', walk: 'side', states: 'details' });
  P.presets[2].note = 'Visual-first — screenshots and click-through carry the explanation.';
  P.blurb = 'Explains one capability in depth — mostly by showing it.';
})();
