// DECODED MOCK — claude.ai/design project 0ca33cd3-c2fa-4644-b728-bde42292abbd,
// file variants/home-global.jsx (etag 1785529020061423). Reference only.
//
// Home (fixed leftmost tab) — cross-project, machine-wide. Usage window,
// active sessions, recent sessions. No Quick start; nothing invented.

const HG = window.ALMANAC;

const HG_PROJECTS = [
  { id: 'session-manager', label: 'session-manager', dot: '#b85c34', sessions: 2, tokens: '1.2M', activity: 'now' },
  { id: 'social-signals-trader', label: 'social-signals-trader', dot: '#6f7d52', sessions: 0, tokens: '820k', activity: '2h ago' },
  { id: 'burrow', label: 'burrow', dot: '#d0983b', sessions: 0, tokens: '310k', activity: 'yesterday' },
  { id: 'sigma', label: 'sigma', dot: '#4f7a6f', sessions: 0, tokens: '460k', activity: '18m ago' },
];

const HG_ACTIVE = [
  { name: 'scheduler:828-epic-queue-controls', project: 'session-manager', kind: 'scheduler job', for: 'Epic · Contextual chat per Epic', tokens: '412k', started: '6m ago', state: 'running' },
  { name: 'chat:epic-contextual-composer', project: 'session-manager', kind: 'chat run', for: 'Epic · Contextual chat per Epic', tokens: '188k', started: '2m ago', state: 'running' },
];

const HG_RECENT = [
  { id: 'bc70f290', project: 'session-manager', epic: 'Contextual chat per Epic', size: '251k', when: 'just now' },
  { id: 'ca69b521', project: 'session-manager', epic: 'Usage analytics dashboard', size: '321k', when: '26m ago' },
  { id: '949fcb64', project: 'sigma', epic: 'Signal scoring pass', size: '1.29M', when: '18m ago' },
  { id: '7f21ab03', project: 'session-manager', epic: 'Voice edit in document view', size: '188k', when: '3h ago' },
  { id: 'd410c7e5', project: 'social-signals-trader', epic: 'Backfill ingest', size: '742k', when: 'yesterday' },
];

const hgCard = { background: HG.card, border: `1px solid ${HG.edge}`, borderRadius: 13, minWidth: 0 };

function HgMeter({ label, tag, pct, resets }) {
  return <div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: HG.sage }} />
      <span style={{ fontFamily: HG.serif, fontSize: 17, fontWeight: 600, color: HG.ink }}>{label}</span>
      <span style={{ fontFamily: HG.mono, fontSize: 10.5, color: HG.inkMute, border: `1px solid ${HG.rule}`, borderRadius: 999, padding: '1.5px 8px' }}>{tag}</span>
      <span style={{ marginLeft: 'auto', fontFamily: HG.mono, fontSize: 19, fontWeight: 600, color: HG.sage, letterSpacing: -0.5 }}>{pct}%</span>
    </div>
    <div style={{ height: 9, background: HG.paper, border: `1px solid ${HG.rule}`, borderRadius: 999, overflow: 'hidden', margin: '10px 0 7px' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: HG.sage }} />
    </div>
    <div style={{ fontFamily: HG.mono, fontSize: 11.5, color: HG.inkMute }}>{resets}</div>
  </div>;
}

function HgSection({ title, right, children }) {
  return <section style={{ marginBottom: 26 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 11 }}>
      <h2 style={{ margin: 0, fontFamily: HG.serif, fontSize: 20, fontWeight: 600, letterSpacing: -0.2, color: HG.ink }}>{title}</h2>
      {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
    </div>
    {children}
  </section>;
}

function HomeGlobal({ onOpenProject }) {
  const slots = HG_ACTIVE.length;
  return <div style={{ height: '100%', overflowY: 'auto', background: HG.paper, fontFamily: HG.sans, color: HG.ink }}>
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '26px 34px 56px' }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontFamily: HG.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: 1.1, textTransform: 'uppercase', color: HG.inkMute, marginBottom: 6 }}>This machine</div>
        <h1 style={{ margin: 0, fontFamily: HG.serif, fontSize: 32, fontWeight: 600, letterSpacing: -0.6, lineHeight: 1.1 }}>
          Good afternoon. <span style={{ color: HG.accent }}>{slots} of 3</span> session slots are busy.
        </h1>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 14, marginBottom: 30 }}>
        <div style={{ ...hgCard, padding: '17px 20px 19px', display: 'grid', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ fontFamily: HG.mono, fontSize: 11.5, fontWeight: 600, color: HG.ink }}>Max</span>
            <span style={{ fontFamily: HG.mono, fontSize: 11, color: HG.inkMute }}>default_claude_max_20x</span>
            <span style={{ marginLeft: 'auto', fontFamily: HG.mono, fontSize: 10.5, color: HG.inkMute }}>updated 90s ago</span>
          </div>
          <HgMeter label="Session" tag="5-hour" pct={11} resets="resets in 3h 24m · 4:29 PM PT" />
          <div style={{ height: 1, background: HG.rule }} />
          <HgMeter label="Weekly" tag="all models" pct={29} resets="resets in 5d 20h · Thu 9:59 AM PT" />
        </div>

        <div style={{ ...hgCard, padding: '15px 17px 16px' }}>
          <div style={{ fontFamily: HG.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', color: HG.inkMute, marginBottom: 12 }}>Projects</div>
          <div style={{ display: 'grid', gap: 3 }}>
            {HG_PROJECTS.map(p => <button key={p.id} onClick={() => onOpenProject && onOpenProject(p.id)} style={{
              appearance: 'none', cursor: 'pointer', border: 0, background: 'transparent', borderRadius: 8, padding: '6px 7px',
              display: 'grid', gridTemplateColumns: '8px minmax(0,1fr) auto', gap: 9, alignItems: 'center', textAlign: 'left',
            }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.dot }} />
              <span style={{ fontSize: 12.5, fontWeight: 500, color: HG.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
              <span style={{ fontFamily: HG.mono, fontSize: 10.5, color: p.sessions ? HG.accent : HG.inkMute }}>{p.sessions ? `${p.sessions} live` : p.activity}</span>
            </button>)}
          </div>
        </div>
      </div>

      <HgSection title="Active sessions" right={<span style={{ fontFamily: HG.mono, fontSize: 11.5, color: HG.inkMute }}>{slots} of 3 slots in use</span>}>
        <div style={{ display: 'grid', gap: 8 }}>
          {HG_ACTIVE.map(s => <div key={s.name} style={{ ...hgCard, padding: '13px 16px', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 14, alignItems: 'center' }}>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: HG.accent }} />
                <span style={{ fontFamily: HG.mono, fontSize: 12.5, fontWeight: 600, color: HG.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                <span style={{ fontFamily: HG.mono, fontSize: 10.5, color: HG.inkMute, flexShrink: 0 }}>{s.kind}</span>
              </span>
              <span style={{ display: 'block', fontSize: 12, color: HG.inkMute }}>{s.project} · {s.for}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
              <span style={{ fontFamily: HG.mono, fontSize: 11.5, color: HG.inkSoft }}>{s.tokens}</span>
              <span style={{ fontFamily: HG.mono, fontSize: 11, color: HG.inkMute }}>{s.started}</span>
              <button style={{ appearance: 'none', cursor: 'pointer', border: `1px solid ${HG.edge}`, background: HG.paper, borderRadius: 8, padding: '5px 11px', fontFamily: HG.sans, fontSize: 12, fontWeight: 600, color: HG.inkSoft }}>Open</button>
            </span>
          </div>)}
        </div>
      </HgSection>

      <HgSection title="Recent sessions" right={<a href="#" style={{ fontFamily: HG.sans, fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>See all history →</a>}>
        <div style={{ ...hgCard, overflow: 'hidden' }}>
          {HG_RECENT.map((r, i) => <div key={r.id} style={{
            display: 'grid', gridTemplateColumns: '92px minmax(0,1.2fr) minmax(0,1fr) 80px 74px 78px', gap: 14, alignItems: 'center',
            padding: '11px 16px', borderTop: i ? `1px solid ${HG.rule}` : 'none',
          }}>
            <span style={{ fontFamily: HG.mono, fontSize: 11.5, color: HG.inkMute }}>{r.id}</span>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: HG.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.project}</span>
            <span style={{ fontSize: 12.5, color: HG.inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.epic}</span>
            <span style={{ fontFamily: HG.mono, fontSize: 11.5, color: HG.inkMute, textAlign: 'right' }}>{r.size}</span>
            <span style={{ fontFamily: HG.mono, fontSize: 11, color: HG.inkMute, textAlign: 'right' }}>{r.when}</span>
            <button style={{ appearance: 'none', cursor: 'pointer', border: 0, background: '#e3e6cf', color: '#4a5730', borderRadius: 8, padding: '5px 11px', fontFamily: HG.sans, fontSize: 12, fontWeight: 650, justifySelf: 'end' }}>resume</button>
          </div>)}
        </div>
      </HgSection>
    </div>
  </div>;
}

Object.assign(window, { HomeGlobal, HG_PROJECTS });
