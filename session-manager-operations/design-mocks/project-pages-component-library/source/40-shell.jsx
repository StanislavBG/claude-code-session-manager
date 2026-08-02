// Project Pages — the shell that composes agent-populated templates.
// Three lenses on one project; each page is a stack of slots, each slot has
// 3–4 interchangeable components, and each page ships three preset versions.

const PAGES = [window.PAGE_MARKETING, window.PAGE_FEATURE, window.PAGE_ARCH];

function ppInitial() {
  const s = {};
  PAGES.forEach(p => { s[p.id] = { preset: 'v1', pick: { ...p.presets[0].pick } }; });
  return s;
}

function PpChip({ active, onClick, children, title }) {
  return <button onClick={onClick} title={title} style={{
    appearance: 'none', cursor: 'pointer', fontFamily: PK.sans, fontSize: 12.5, fontWeight: active ? 600 : 500,
    padding: '5px 11px', borderRadius: 7, whiteSpace: 'nowrap',
    border: `1px solid ${active ? PK.accent : PK.rule}`, background: active ? PK.accent : PK.card, color: active ? '#fff' : PK.inkSoft,
  }}>{children}</button>;
}

function PpTab({ active, onClick, page }) {
  return <button onClick={onClick} style={{
    appearance: 'none', cursor: 'pointer', border: 0, background: 'transparent', padding: '10px 2px 12px', marginRight: 26,
    fontFamily: PK.sans, fontSize: 14.5, fontWeight: active ? 600 : 500, color: active ? PK.ink : PK.inkMute,
    borderBottom: `2px solid ${active ? PK.accent : 'transparent'}`,
  }}>{page.label}</button>;
}

// Scaled, non-interactive preview of a single variant.
function PpPreview({ C, scale = 0.42, h = 190 }) {
  return <div style={{ height: h, overflow: 'hidden', background: PK.paper, borderBottom: `1px solid ${PK.edge}`, position: 'relative' }}>
    <div style={{ width: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: 'top left', pointerEvents: 'none' }}><C /></div>
  </div>;
}

function PpSlotRail({ page, state, set, showOutline, setOutline }) {
  return <aside style={{ width: 268, flex: 'none', borderRight: `1px solid ${PK.rule}`, background: PK.panel, overflowY: 'auto', padding: '18px 16px 40px' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <PkEyebrow tone={PK.inkMute}>Composition</PkEyebrow>
      <button onClick={() => setOutline(!showOutline)} style={{ appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', fontFamily: PK.sans, fontSize: 11.5, color: showOutline ? PK.accent : PK.inkMute }}>{showOutline ? 'hide slots' : 'show slots'}</button>
    </div>
    {page.slots.map(slot => {
      const cur = state.pick[slot.id];
      return <div key={slot.id} style={{ marginTop: 18 }}>
        <div style={{ fontFamily: PK.sans, fontSize: 13, fontWeight: 600, color: PK.ink, marginBottom: 8 }}>{slot.label}</div>
        <div style={{ display: 'grid', gap: 4 }}>
          {slot.variants.map(v => {
            const on = v.id === cur;
            return <button key={v.id} onClick={() => set(slot.id, v.id)} title={v.note} style={{
              appearance: 'none', cursor: 'pointer', textAlign: 'left', width: '100%',
              border: `1px solid ${on ? PK.accent : PK.edge}`, background: on ? PK.card : 'transparent', borderRadius: 8, padding: '8px 10px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: on ? PK.accent : PK.rule, flex: 'none' }} />
                <span style={{ fontFamily: PK.sans, fontSize: 12.5, fontWeight: on ? 600 : 500, color: on ? PK.ink : PK.inkSoft }}>{v.label}</span>
              </div>
              <div style={{ fontFamily: PK.sans, fontSize: 11.5, lineHeight: 1.45, color: PK.inkMute, marginTop: 4, paddingLeft: 13 }}>{v.note}</div>
            </button>;
          })}
        </div>
      </div>;
    })}
  </aside>;
}

function PpComposedPage({ page, state, showOutline }) {
  return <div style={{ background: PK.paper }}>
    {page.slots.map(slot => {
      const v = slot.variants.find(x => x.id === state.pick[slot.id]) || slot.variants[0];
      const C = v.C;
      return <div key={slot.id} style={{ position: 'relative', outline: showOutline ? `1px dashed ${PK.accentDeep}` : 'none', outlineOffset: -1 }}>
        {showOutline && <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 3, background: PK.accentDeep, color: '#fff', fontFamily: PK.mono, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '3px 8px', borderBottomRightRadius: 6 }}>{slot.label} · {v.label}</div>}
        <C />
      </div>;
    })}
  </div>;
}

function PpLibrary({ page, state, set }) {
  return <div style={{ padding: '28px 32px 60px', background: PK.panel, minHeight: '100%' }}>
    <PkEyebrow>Component library — {page.label}</PkEyebrow>
    <PkBody size={14} style={{ marginTop: 8, maxWidth: 640 }}>Every option the agent may choose from for this page. Selecting one swaps it into the composed page.</PkBody>
    {page.slots.map(slot => <div key={slot.id} style={{ marginTop: 34 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, paddingBottom: 10, borderBottom: `1px solid ${PK.rule}` }}>
        <span style={{ fontFamily: PK.serif, fontSize: 22, color: PK.ink }}>{slot.label}</span>
        <span style={{ fontFamily: PK.mono, fontSize: 11, color: PK.inkMute }}>slot · {slot.variants.length} options</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16, marginTop: 16 }}>
        {slot.variants.map(v => {
          const on = state.pick[slot.id] === v.id;
          return <div key={v.id} style={{ border: `1px solid ${on ? PK.accent : PK.edge}`, borderRadius: 12, overflow: 'hidden', background: PK.card, boxShadow: on ? `0 0 0 2px ${PK.accent}22` : 'none' }}>
            <PpPreview C={v.C} />
            <div style={{ padding: '12px 14px', display: 'flex', gap: 14, alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontFamily: PK.sans, fontSize: 13.5, fontWeight: 600, color: PK.ink }}>{v.label}</div>
                <div style={{ fontFamily: PK.sans, fontSize: 12, color: PK.inkMute, marginTop: 3, maxWidth: 320 }}>{v.note}</div>
              </div>
              <PpChip active={on} onClick={() => set(slot.id, v.id)}>{on ? 'in use' : 'use'}</PpChip>
            </div>
          </div>;
        })}
      </div>
    </div>)}
  </div>;
}

function ProjectPages() {
  const [pageId, setPageId] = React.useState('marketing');
  const [mode, setMode] = React.useState('page');
  const [showOutline, setOutline] = React.useState(false);
  const [all, setAll] = React.useState(ppInitial);
  const page = PAGES.find(p => p.id === pageId);
  const state = all[pageId];

  const setPick = (slotId, variantId) => setAll(a => ({ ...a, [pageId]: { preset: 'custom', pick: { ...a[pageId].pick, [slotId]: variantId } } }));
  const applyPreset = p => setAll(a => ({ ...a, [pageId]: { preset: p.id, pick: { ...p.pick } } }));
  const activePreset = page.presets.find(p => p.id === state.preset);

  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: PK.paper, fontFamily: PK.sans }}>
    {/* chrome */}
    <header style={{ flex: 'none', borderBottom: `1px solid ${PK.rule}`, background: PK.card, padding: '0 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <PkDot c={PK.sage} />
          <span style={{ fontFamily: PK.sans, fontSize: 13.5, fontWeight: 600, color: PK.ink }}>{PROJ.tag}</span>
          <span style={{ fontFamily: PK.mono, fontSize: 11.5, color: PK.inkMute }}>Project Pages · generated {PROJ.version}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <PpChip active={mode === 'page'} onClick={() => setMode('page')}>Page</PpChip>
          <PpChip active={mode === 'library'} onClick={() => setMode('library')}>Component library</PpChip>
          <span style={{ width: 1, height: 18, background: PK.rule, margin: '0 6px' }} />
          <PkBtn small>Regenerate</PkBtn>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
        <nav style={{ display: 'flex' }}>{PAGES.map(p => <PpTab key={p.id} page={p} active={p.id === pageId} onClick={() => setPageId(p.id)} />)}</nav>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
          <span style={{ fontFamily: PK.mono, fontSize: 10.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: PK.inkMute }}>Version</span>
          {page.presets.map(p => <PpChip key={p.id} active={state.preset === p.id} onClick={() => applyPreset(p)} title={p.note}>{p.id.toUpperCase()} · {p.label}</PpChip>)}
          {state.preset === 'custom' && <PpChip active>Custom</PpChip>}
        </div>
      </div>
    </header>

    {/* context line */}
    <div style={{ flex: 'none', padding: '9px 24px', background: PK.panel, borderBottom: `1px solid ${PK.rule}`, display: 'flex', gap: 14, alignItems: 'center' }}>
      <span style={{ fontFamily: PK.sans, fontSize: 12.5, color: PK.inkSoft }}>{page.blurb}</span>
      <span style={{ fontFamily: PK.sans, fontSize: 12.5, color: PK.inkMute }}>{activePreset ? `${activePreset.label} — ${activePreset.note}` : 'Custom composition — not one of the three presets.'}</span>
    </div>

    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {mode === 'page' && <PpSlotRail page={page} state={state} set={setPick} showOutline={showOutline} setOutline={setOutline} />}
      <main style={{ flex: 1, overflowY: 'auto', background: mode === 'page' ? '#eae1cd' : PK.panel }}>
        {mode === 'page'
          ? <div style={{ padding: '26px 34px 60px' }}>
              <div style={{ maxWidth: 1080, margin: '0 auto', background: PK.paper, border: `1px solid ${PK.edge}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 12px 34px rgba(42,34,26,0.10)' }}>
                <PpComposedPage page={page} state={state} showOutline={showOutline} />
              </div>
            </div>
          : <PpLibrary page={page} state={state} set={setPick} />}
      </main>
    </div>
  </div>;
}

Object.assign(window, { ProjectPages });
