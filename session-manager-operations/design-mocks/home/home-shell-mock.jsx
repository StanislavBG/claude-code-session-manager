// DECODED MOCK — claude.ai/design project 0ca33cd3-c2fa-4644-b728-bde42292abbd,
// file variants/home-shell.jsx (etag 1785529334416949). Reference only — the real
// app implements this via TabBar.tsx + AlmanacSidebar.tsx + Tailwind tokens.
//
// Shell — fixed leftmost Home tab (machine-wide) + one tab per project.
// A project tab's own Home is the generated Project brief.

const HS = window.ALMANAC;

const HS_NAV = [
  { group: 'Workspace', items: [
    { k: 'home', label: 'Home', icon: 'home', note: 'What this project is, and what is in flight' },
    { k: 'epics', label: 'Epics', icon: 'tasks', note: 'Goal-scoped threads with their own PRDs' },
    { k: 'browser', label: 'Browser', icon: 'browser', note: 'Embedded dev browser' },
    { k: 'files', label: 'File Explorer', icon: 'folder', note: 'Browse and edit, per project' },
    { k: 'scheduler', label: 'Scheduler', icon: 'scheduler', note: 'Run accepted PRDs as headless jobs' },
    { k: 'usage', label: 'Usage', icon: 'usage', note: 'Tokens by project and Epic' },
  ] },
  { group: 'Configure', items: [
    { k: 'sysprompt', label: 'System Prompt', icon: 'sysprompt' },
    { k: 'skills', label: 'Skills', icon: 'skills' },
    { k: 'plugins', label: 'Plugins', icon: 'plugins' },
    { k: 'mcp', label: 'MCP Servers', icon: 'mcp' },
    { k: 'hooks', label: 'Hooks', icon: 'hooks' },
    { k: 'memory', label: 'Memory', icon: 'memory' },
  ] },
];

function HsTabStrip({ tabs, active, onSelect, onClose }) {
  return <div style={{ display: 'flex', alignItems: 'stretch', gap: 4, background: HS.panel, borderBottom: `1px solid ${HS.edge}`, padding: '7px 12px 0' }}>
    <button onClick={() => onSelect('home')} title="Machine-wide Home — always leftmost" style={{
      appearance: 'none', cursor: 'pointer', border: 0, borderRadius: '10px 10px 0 0', padding: '8px 15px 9px',
      background: active === 'home' ? HS.paper : 'transparent', color: active === 'home' ? HS.ink : HS.inkSoft,
      fontFamily: HS.sans, fontSize: 13, fontWeight: 650, display: 'inline-flex', alignItems: 'center', gap: 7,
      boxShadow: active === 'home' ? `inset 0 2px 0 ${HS.accent}` : 'none',
    }}><SMIcon name="home" size={15} /> Home</button>
    <span style={{ width: 1, background: HS.edge, margin: '7px 6px 6px' }} />
    {tabs.map(t => {
      const on = active === t.id;
      return <span key={t.id} style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, borderRadius: '10px 10px 0 0', padding: '8px 11px 9px 13px',
        background: on ? HS.paper : 'transparent', boxShadow: on ? `inset 0 2px 0 ${t.dot}` : 'none',
      }}>
        <button onClick={() => onSelect(t.id)} style={{
          appearance: 'none', cursor: 'pointer', border: 0, background: 'transparent', padding: 0,
          display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: HS.sans, fontSize: 13, fontWeight: on ? 650 : 500,
          color: on ? HS.ink : HS.inkSoft,
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.dot }} />{t.label}
        </button>
        <button onClick={() => onClose(t.id)} title="Close project" style={{ appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', padding: 0, color: HS.inkMute, display: 'inline-flex', opacity: on ? 0.8 : 0.4 }}>
          <SMIcon name="x" size={12} />
        </button>
      </span>;
    })}
    <button title="Open a project" style={{ appearance: 'none', cursor: 'pointer', border: 0, background: 'transparent', color: HS.inkMute, padding: '0 9px', display: 'inline-flex', alignItems: 'center' }}>
      <SMIcon name="plus" size={15} />
    </button>
    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 9, paddingRight: 4, fontFamily: HS.mono, fontSize: 10.5, color: HS.inkMute }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: HS.sage }} /> connected · 11% of 5h window
    </span>
  </div>;
}

function HsRail({ project, view, onView }) {
  return <aside style={{ width: 244, flexShrink: 0, background: HS.panel, borderRight: `1px solid ${HS.edge}`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
    <div style={{ padding: '14px 14px 12px', borderBottom: `1px solid ${HS.edge}` }}>
      <div style={{ fontFamily: HS.mono, fontSize: 10, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', color: HS.inkMute, marginBottom: 7 }}>Project</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: project.dot }} />
        <span style={{ fontFamily: HS.serif, fontSize: 17, fontWeight: 600, color: HS.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.label}</span>
      </div>
      <div style={{ fontFamily: HS.mono, fontSize: 10.5, color: HS.inkMute, marginTop: 5 }}>⎇ main · v0.39.4</div>
    </div>
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '10px 8px 14px' }}>
      {HS_NAV.map(g => <div key={g.group} style={{ marginBottom: 14 }}>
        <div style={{ fontFamily: HS.mono, fontSize: 9.5, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', color: HS.inkMute, padding: '4px 8px 7px' }}>{g.group}</div>
        <div style={{ display: 'grid', gap: 2 }}>
          {g.items.map(it => {
            const on = view === it.k;
            return <button key={it.k} onClick={() => onView(it.k)} style={{
              appearance: 'none', cursor: 'pointer', textAlign: 'left', border: 0, borderRadius: 9, padding: '7px 9px',
              background: on ? HS.card : 'transparent', boxShadow: on ? `inset 2px 0 0 ${HS.accent}, 0 1px 2px rgba(42,34,26,.06)` : 'none',
              display: 'grid', gridTemplateColumns: '18px minmax(0,1fr)', gap: 9, alignItems: 'center',
            }}>
              <span style={{ display: 'inline-flex', color: on ? HS.accent : HS.inkMute }}><SMIcon name={it.icon} size={15} /></span>
              <span style={{ fontSize: 13, fontWeight: on ? 650 : 500, color: on ? HS.ink : HS.inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
            </button>;
          })}
        </div>
      </div>)}
    </div>
  </aside>;
}

function HsPlaceholder({ label }) {
  return <div style={{ height: '100%', display: 'grid', placeItems: 'center', background: HS.paper, padding: 40 }}>
    <div style={{ textAlign: 'center', maxWidth: 380 }}>
      <div style={{ fontFamily: HS.serif, fontSize: 20, fontWeight: 600, color: HS.ink, marginBottom: 7 }}>{label}</div>
      <p style={{ margin: 0, fontSize: 13, color: HS.inkMute, lineHeight: 1.55 }}>
        Designed in its own file — this shell only demonstrates the Home / project-tab split.
      </p>
    </div>
  </div>;
}

function HomeShell() {
  const [tabs, setTabs] = React.useState([
    { id: 'session-manager', label: 'session-manager', dot: '#b85c34' },
    { id: 'sigma', label: 'sigma', dot: '#4f7a6f' },
  ]);
  const [active, setActive] = React.useState('session-manager');
  const [view, setView] = React.useState('home');
  const project = tabs.find(t => t.id === active);
  const closeTab = (id) => {
    const rest = tabs.filter(t => t.id !== id);
    setTabs(rest);
    if (id === active) { setActive(rest.length ? rest[0].id : 'home'); setView('home'); }
  };

  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: HS.paper, fontFamily: HS.sans, color: HS.ink, minHeight: 0 }}>
    <HsTabStrip tabs={tabs} active={active} onSelect={setActive} onClose={closeTab} />
    {active === 'home' || !project
      ? <div style={{ flex: 1, minHeight: 0 }}><HomeGlobal onOpenProject={(id) => {
          if (!tabs.some(t => t.id === id)) {
            const p = (window.HG_PROJECTS || []).find(x => x.id === id);
            if (!p) return;
            setTabs(t => [...t, { id: p.id, label: p.label, dot: p.dot }]);
          }
          setActive(id); setView('home');
        }} /></div>
      : <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <HsRail project={project} view={view} onView={setView} />
          <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            {view === 'home'
              ? (active === 'session-manager' ? <ProjectHome /> : <HsPlaceholder label={`${project.label} — brief not synthesized yet`} />)
              : <HsPlaceholder label={(HS_NAV.flatMap(g => g.items).find(i => i.k === view) || {}).label} />}
          </div>
        </div>}
  </div>;
}

window.HomeShell = HomeShell;
