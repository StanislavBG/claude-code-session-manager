
// Epics — epic-scoped workspace. Replaces the global chat + right rail:
// the queue lives on the left, and the agent conversation, PRDs and runs are
// all contextual to the selected Epic. Loads after shared.jsx / almanac.jsx.

const EP = window.ALMANAC;

const E_STATUS = {
  running:   { label: 'running',   fg: '#8a4a1e', bg: '#f4dfc8', dot: '#b85c34' },
  queued:    { label: 'queued',    fg: '#6b5c40', bg: '#ece0c6', dot: '#a89670' },
  needs:     { label: 'needs you', fg: '#8a2f2f', bg: '#f2d8d0', dot: '#a3441f' },
  completed: { label: 'completed', fg: '#4a5730', bg: '#e3e6cf', dot: '#6f7d52' },
  draft:     { label: 'draft',     fg: '#6b5c40', bg: 'transparent', dot: '#c0b291' },
};
const E_KINDS = ['Feature', 'Bug', 'Discussion'];
const E_KIND_TINT = { Feature: '#6f7d52', Bug: '#a3441f', Discussion: '#8a7a60' };

const E_EPICS = [
  {
    id: 'e-chat', sortAge: 0, title: 'Contextual chat per Epic', kind: 'Feature', status: 'running',
    goal: 'Retire the global chat pane and the right-hand session rail. Every conversation belongs to the Epic that created it.',
    branch: '⎇ epic/contextual-chat', opened: '2 days ago', activity: '0s ago', turns: 14, tools: 37, tokens: '1.2M',
    prds: [
      { name: 'contextual-chat.prd.md', status: 'accepted', lines: 142, note: 'Scope, non-goals, migration of existing threads' },
      { name: 'thread-schema.md', status: 'draft', lines: 58, note: 'epic_id foreign key on every prompt row' },
    ],
    thread: [
      { role: 'user', at: '2d ago', text: 'The Agent responses and the input box are still not contextual to the EPIC — everything lands in one global stream.' },
      { role: 'agent', at: '2d ago', tools: [['Read', 4], ['Grep', 2]], text: 'Confirmed: prompts are stored flat with no epic reference, so the renderer has nothing to scope by. Two changes needed — an `epic_id` on the prompt row, and the composer needs to carry the active Epic.', outcome: 'Diagnosis' },
      { role: 'user', at: '1d ago', text: 'Write the PRD before touching code. Include the migration path for threads that already exist.' },
      { role: 'agent', at: '1d ago', tools: [['Write', 1], ['Read', 2]], text: 'Drafted `contextual-chat.prd.md` — 142 lines. Existing prompts backfill into a synthetic "Unsorted" Epic per project so nothing is orphaned.', artifact: 'contextual-chat.prd.md', outcome: 'PRD ready for review' },
      { role: 'user', at: '4h ago', text: 'Approved. Implement the schema change and scope the composer.' },
      { role: 'agent', at: 'now', running: true, tools: [['Read', 3], ['Bash', 4], ['Edit', 6], ['ToolSearch', 1]], text: 'Migration written and applied to the local db. Now threading `epic_id` through the composer — send, queue, and cancel all resolve the active Epic instead of the global session.' },
    ],
  },
  {
    id: 'e-usage', sortAge: 0.43, title: 'Usage analytics dashboard', kind: 'Feature', status: 'needs',
    goal: 'Replace the History tab with a faceted analytical view of token usage per project.',
    branch: '⎇ epic/usage-analytics', opened: '5 days ago', activity: '26m ago', turns: 31, tools: 88, tokens: '3.4M',
    prds: [
      { name: 'usage-analytics.prd.md', status: 'accepted', lines: 96, note: 'Token-led metrics, 30/60/90/all-time facets' },
    ],
    thread: [
      { role: 'user', at: '5d ago', text: 'Redefine the dashboard into a clear analytical space — how much we use, and on what projects.' },
      { role: 'agent', at: '4d ago', tools: [['Write', 3], ['Bash', 2]], text: 'Built the stacked-trend + ranking + composition layout. Tokens lead; spend is the last optional measure.', artifact: 'usage-analytics.prd.md', outcome: 'Shipped to preview' },
      { role: 'agent', at: '26m ago', question: true, text: 'The All-time range needs 360 days of aggregates, but the local archive only holds 214. Do I extrapolate the earlier window or cap All-time at the real archive depth?' },
    ],
  },
  {
    id: 'e-voice', sortAge: 3, title: 'Voice edit in document view', kind: 'Feature', status: 'queued',
    goal: 'Select text, speak the change, review an inline diff before it lands.',
    branch: '⎇ epic/voice-edit', opened: '1 week ago', activity: '3h ago', turns: 22, tools: 61, tokens: '2.0M',
    prds: [
      { name: 'voice-edit.prd.md', status: 'accepted', lines: 118, note: 'Selection → mic → transcript → diff → accept' },
      { name: 'diff-review.md', status: 'accepted', lines: 44, note: 'Accept / reject / retry semantics' },
    ],
    thread: [
      { role: 'user', at: '1w ago', text: 'Voice edit should surface on selection, not as a mode you enter.' },
      { role: 'agent', at: '3h ago', tools: [['Edit', 9], ['Read', 5]], text: 'Popover now anchors to the selection rect. Transcript confirmation added before the model is called, so a misheard phrase never reaches the document.', outcome: 'Ready to queue' },
    ],
  },
  {
    id: 'e-flake', sortAge: 72, title: 'Scheduler drops jobs after restart', kind: 'Bug', status: 'completed',
    goal: 'Queued claude -p jobs vanished when the host process restarted.',
    branch: '⎇ fix/scheduler-persistence', opened: '2 weeks ago', activity: '3d ago', turns: 9, tools: 24, tokens: '540k',
    prds: [{ name: 'postmortem.md', status: 'accepted', lines: 31, note: 'In-memory queue, no write-ahead' }],
    thread: [
      { role: 'user', at: '2w ago', text: 'Everything queued before a restart is gone. Reproduces every time.' },
      { role: 'agent', at: '3d ago', tools: [['Bash', 6], ['Edit', 3]], text: 'The queue was memory-only. Jobs now persist to sqlite on enqueue and rehydrate on boot; verified across three forced restarts.', outcome: 'Fixed in v0.39.4' },
    ],
  },
  {
    id: 'e-rail', sortAge: 1, title: 'Retire the session rail everywhere', kind: 'Discussion', status: 'draft',
    goal: 'Decide where session status, token window and tool activity live once the right rail is gone.',
    branch: '⎇ main', opened: 'today', activity: '1h ago', turns: 2, tools: 0, tokens: '18k',
    prds: [],
    thread: [
      { role: 'user', at: '1h ago', spawned: 'Contextual chat per Epic', text: 'If the rail goes away, where does "this turn" tool activity live? Inline per turn, or a per-Epic runs view?' },
    ],
  },
];

// ── primitives ───────────────────────────────────────────────────────
function EChip({ s, small }) {
  const c = E_STATUS[s];
  return <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: small ? '1.5px 7px' : '3px 9px',
    borderRadius: 999, background: c.bg, color: c.fg, fontFamily: EP.sans, fontSize: small ? 10.5 : 11.5,
    fontWeight: 600, letterSpacing: 0.2, boxShadow: c.bg === 'transparent' ? `inset 0 0 0 1px ${EP.rule}` : 'none', whiteSpace: 'nowrap',
  }}>
    <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.dot }} />{c.label}
  </span>;
}

function EKind({ k, small }) {
  return <span style={{
    fontFamily: EP.mono, fontSize: small ? 10 : 10.5, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase',
    color: E_KIND_TINT[k], padding: small ? '1.5px 6px' : '2.5px 7px', borderRadius: 5,
    boxShadow: `inset 0 0 0 1px ${E_KIND_TINT[k]}44`, whiteSpace: 'nowrap',
  }}>{k}</span>;
}

function EMeta({ items }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'center' }}>
    {items.map(([k, v]) => <span key={k} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, fontSize: 12 }}>
      <span style={{ color: EP.inkMute }}>{k}</span>
      <span style={{ fontFamily: EP.mono, fontWeight: 600, color: EP.inkSoft }}>{v}</span>
    </span>)}
  </div>;
}

// ── attachments: files, pasted images, dropped screenshots ───────────
function useAttachments() {
  const [items, setItems] = React.useState([]);
  const add = (list) => {
    const next = [...list].map(fl => ({
      id: Math.random().toString(36).slice(2), name: fl.name || 'pasted-image.png',
      size: fl.size ? (fl.size > 1e6 ? (fl.size / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(fl.size / 1024)) + ' KB') : '—',
      url: fl.type && fl.type.startsWith('image/') ? URL.createObjectURL(fl) : null,
    }));
    if (next.length) setItems(p => [...p, ...next]);
  };
  const remove = (id) => setItems(p => p.filter(i => i.id !== id));
  return { items, add, remove, clear: () => setItems([]) };
}

function AttachTray({ att, tall }) {
  const input = React.useRef(null);
  const [over, setOver] = React.useState(false);
  const onPaste = (e) => {
    const fl = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (fl.length) { e.preventDefault(); att.add(fl); }
  };
  const onDrop = (e) => { e.preventDefault(); setOver(false); att.add(e.dataTransfer.files); };
  return <div>
    <div onPaste={onPaste} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
      tabIndex={0} style={{
        border: `1px dashed ${over ? EP.accent : EP.rule}`, background: over ? '#f7ece0' : 'transparent', borderRadius: 10,
        padding: tall ? '14px 14px' : '10px 12px', display: 'flex', alignItems: 'center', gap: 10, outline: 'none', cursor: 'default',
      }}>
      <span style={{ color: over ? EP.accent : EP.inkMute, display: 'inline-flex' }}><SMIcon name="camera" size={tall ? 18 : 16} /></span>
      <span style={{ fontSize: 12.5, color: EP.inkMute, lineHeight: 1.45 }}>
        Paste a screenshot (⌘V) or drop files here
      </span>
      <button onClick={() => input.current && input.current.click()} style={{
        marginLeft: 'auto', appearance: 'none', cursor: 'pointer', border: `1px solid ${EP.edge}`, background: EP.card,
        borderRadius: 8, padding: '5px 11px', fontFamily: EP.sans, fontSize: 12, fontWeight: 600, color: EP.inkSoft,
        display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
      }}><SMIcon name="files" size={13} /> Attach</button>
      <input ref={input} type="file" multiple onChange={e => { att.add(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
    </div>
    {att.items.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 9 }}>
      {att.items.map(i => <span key={i.id} style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, background: EP.card, border: `1px solid ${EP.edge}`,
        borderRadius: 9, padding: i.url ? '4px 9px 4px 4px' : '5px 9px 5px 8px', maxWidth: 240,
      }}>
        {i.url
          ? <img src={i.url} alt="" style={{ width: 30, height: 24, objectFit: 'cover', borderRadius: 6, display: 'block', border: `1px solid ${EP.rule}` }} />
          : <span style={{ color: EP.accent, display: 'inline-flex' }}><SMIcon name="file" size={13} /></span>}
        <span style={{ fontFamily: EP.mono, fontSize: 11, color: EP.inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
        <span style={{ fontFamily: EP.mono, fontSize: 10, color: EP.inkMute, flexShrink: 0 }}>{i.size}</span>
        <button onClick={() => att.remove(i.id)} title="Remove" style={{ appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', padding: 0, color: EP.inkMute, display: 'inline-flex', flexShrink: 0 }}>
          <SMIcon name="x" size={12} />
        </button>
      </span>)}
    </div>}
  </div>;
}

// ── left: the queue — built for hundreds of Epics ───────────────────
const E_GROUPS = {
  status: { label: 'status', order: ['running', 'needs', 'queued', 'draft', 'completed'], of: e => e.status, name: k => E_STATUS[k].label, dot: k => E_STATUS[k].dot },
  tag:    { label: 'tag',    order: E_KINDS, of: e => e.kind, name: k => k, dot: k => E_KIND_TINT[k] },
  age:    { label: 'recency', order: ['Today', 'This week', 'This month', 'Older'], dot: () => EP.rule, name: k => k,
            of: e => e.sortAge < 24 ? 'Today' : e.sortAge < 168 ? 'This week' : e.sortAge < 720 ? 'This month' : 'Older' },
};
const E_SORTS = { recent: ['last activity', (a, b) => a.sortAge - b.sortAge], turns: ['turns', (a, b) => b.turns - a.turns], tokens: ['tokens', (a, b) => b.tools - a.tools], title: ['title', (a, b) => a.title.localeCompare(b.title)] };
const PAGE = 18;

function MiniSelect({ value, onChange, options, label }) {
  return <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: EP.card, border: `1px solid ${EP.edge}`, borderRadius: 8, padding: '3px 7px 3px 8px' }}>
    <span style={{ fontFamily: EP.mono, fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase', color: EP.inkMute }}>{label}</span>
    <select value={value} onChange={e => onChange(e.target.value)} style={{
      appearance: 'none', border: 0, background: 'transparent', outline: 'none', cursor: 'pointer',
      fontFamily: EP.sans, fontSize: 11.5, fontWeight: 650, color: EP.ink, paddingRight: 2,
    }}>{options.map(o => <option key={o.k} value={o.k}>{o.l}</option>)}</select>
  </label>;
}

function QueueRow({ e, on, compact, pinned, onSelect, onPin }) {
  const st = E_STATUS[e.status];
  if (compact) return <button onClick={() => onSelect(e.id)} data-row={e.id} style={{
    appearance: 'none', cursor: 'pointer', textAlign: 'left', width: '100%', display: 'grid',
    gridTemplateColumns: '8px minmax(0,1fr) auto', gap: 9, alignItems: 'center',
    border: 0, borderLeft: `2px solid ${on ? st.dot : 'transparent'}`, background: on ? EP.card : 'transparent',
    padding: '6px 9px 6px 8px', borderRadius: 7,
  }}>
    <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.dot, opacity: e.status === 'completed' ? 0.45 : 1 }} />
    <span style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
      {pinned && <span style={{ color: EP.accent, display: 'inline-flex', flexShrink: 0 }}><SMIcon name="skills" size={10} /></span>}
      <span style={{ fontSize: 12.5, fontWeight: on ? 650 : 500, color: on ? EP.ink : EP.inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
    </span>
    <span style={{ fontFamily: EP.mono, fontSize: 10, color: EP.inkMute, flexShrink: 0 }}>{e.activity}</span>
  </button>;
  return <div style={{ position: 'relative' }}>
    <button onClick={() => onSelect(e.id)} data-row={e.id} style={{
      appearance: 'none', cursor: 'pointer', textAlign: 'left', width: '100%',
      border: `1px solid ${on ? EP.rule : 'transparent'}`, background: on ? EP.card : 'transparent',
      borderRadius: 11, padding: '10px 12px 11px', display: 'grid', gap: 6,
      boxShadow: on ? `inset 3px 0 0 ${st.dot}, 0 1px 2px rgba(42,34,26,.07)` : 'none',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <EChip s={e.status} small />
        <EKind k={e.kind} small />
        <span style={{ marginLeft: 'auto', fontFamily: EP.mono, fontSize: 10.5, color: EP.inkMute, paddingRight: 16 }}>{e.activity}</span>
      </span>
      <span style={{ fontSize: 13, fontWeight: 650, color: EP.ink, lineHeight: 1.3, display: 'block' }}>{e.title}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: EP.mono, fontSize: 10.5, color: EP.inkMute }}>
        {e.prds.length > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><SMIcon name="file" size={11} />{e.prds.length + (e.prds.length === 1 ? ' PRD' : ' PRDs')}</span>}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><SMIcon name="sysprompt" size={11} />{e.turns}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><SMIcon name="usage" size={11} />{e.tokens}</span>
      </span>
    </button>
    <button onClick={ev => { ev.stopPropagation(); onPin(e.id); }} title={pinned ? 'Unpin' : 'Pin to top'} style={{
      position: 'absolute', top: 8, right: 8, appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer',
      padding: 2, color: pinned ? EP.accent : EP.inkMute, opacity: pinned ? 1 : 0.4, display: 'inline-flex',
    }}><SMIcon name="skills" size={12} /></button>
  </div>;
}

function EpicQueue({ epics, selId, onSelect, onNew }) {
  const [q, setQ] = React.useState('');
  const [filter, setFilter] = React.useState('open');
  const [group, setGroup] = React.useState('status');
  const [sort, setSort] = React.useState('recent');
  const [compact, setCompact] = React.useState(false);
  const [closed, setClosed] = React.useState(() => new Set(['completed']));
  const [limits, setLimits] = React.useState({});
  const [pins, setPins] = React.useState(() => new Set());

  const counts = epics.reduce((o, e) => (o[e.status] = (o[e.status] || 0) + 1, o), {});
  const openN = epics.length - (counts.completed || 0);
  const matches = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return epics.filter(e =>
      (filter === 'all' || (filter === 'open' ? e.status !== 'completed' : filter === 'pinned' ? pins.has(e.id) : e.status === filter)) &&
      (!needle || (e.title + ' ' + e.goal + ' ' + e.kind).toLowerCase().includes(needle)));
  }, [epics, q, filter, pins]);
  const sorted = React.useMemo(() => [...matches].sort(E_SORTS[sort][1]), [matches, sort]);
  const pinned = sorted.filter(e => pins.has(e.id));

  const g = E_GROUPS[group];
  const sections = React.useMemo(() => {
    const buckets = new Map();
    sorted.filter(e => !pins.has(e.id)).forEach(e => {
      const k = g.of(e);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(e);
    });
    return g.order.filter(k => buckets.has(k)).map(k => ({ key: k, items: buckets.get(k) }));
  }, [sorted, group, pins]);

  const flat = [...pinned, ...sections.filter(s => !closed.has(s.key)).flatMap(s => s.items.slice(0, limits[s.key] || PAGE))];
  const togglePin = (id) => setPins(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const move = (d) => {
    const i = flat.findIndex(e => e.id === selId);
    const next = flat[Math.min(flat.length - 1, Math.max(0, (i < 0 ? 0 : i + d)))];
    if (next) { onSelect(next.id); const el = document.querySelector(`[data-row="${next.id}"]`); if (el && el.offsetParent) el.offsetParent.scrollTop += 0; }
  };
  React.useEffect(() => {
    const h = (ev) => {
      if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'SELECT') return;
      if (ev.key === 'j' || ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
      if (ev.key === 'k' || ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const chips = [
    { k: 'open', l: `Open ${openN}` },
    { k: 'needs', l: `Needs you ${counts.needs || 0}` },
    { k: 'running', l: `Running ${counts.running || 0}` },
    { k: 'pinned', l: `Pinned ${pins.size}` },
    { k: 'all', l: `All ${epics.length}` },
  ];

  return <aside style={{ width: 352, flexShrink: 0, borderRight: `1px solid ${EP.edge}`, background: EP.panel, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
    <div style={{ padding: '13px 14px 11px', borderBottom: `1px solid ${EP.edge}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
        <span style={{ fontFamily: EP.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: 1.1, textTransform: 'uppercase', color: EP.inkMute }}>Epic queue</span>
        <span style={{ fontFamily: EP.mono, fontSize: 10.5, color: EP.inkMute }}>{epics.length}</span>
        <button onClick={onNew} style={{
          marginLeft: 'auto', appearance: 'none', cursor: 'pointer', border: 0, borderRadius: 9, padding: '6px 12px',
          background: EP.accent, color: '#fdf7ee', fontFamily: EP.sans, fontSize: 12.5, fontWeight: 650,
          display: 'inline-flex', alignItems: 'center', gap: 6, boxShadow: '0 1px 2px rgba(42,34,26,.14)',
        }}><SMIcon name="plus" size={14} /> New Epic</button>
      </div>
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 9, top: 8, color: EP.inkMute, pointerEvents: 'none' }}><SMIcon name="search" size={14} /></span>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${epics.length} Epics`}
          style={{ width: '100%', appearance: 'none', border: `1px solid ${EP.edge}`, background: EP.card, borderRadius: 9, padding: '7px 10px 7px 30px', fontFamily: EP.sans, fontSize: 12.5, color: EP.ink, outline: 'none' }} />
        {q && <button onClick={() => setQ('')} style={{ position: 'absolute', right: 7, top: 7, appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', color: EP.inkMute, display: 'inline-flex' }}><SMIcon name="x" size={13} /></button>}
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 9, flexWrap: 'wrap' }}>
        {chips.map(t => {
          const on = filter === t.k;
          return <button key={t.k} onClick={() => setFilter(t.k)} style={{
            appearance: 'none', cursor: 'pointer', border: 0, borderRadius: 7, padding: '3.5px 8px',
            background: on ? EP.card : 'transparent', boxShadow: on ? `inset 0 0 0 1px ${EP.edge}` : 'none',
            fontFamily: EP.sans, fontSize: 11, fontWeight: on ? 650 : 500, color: on ? EP.ink : EP.inkMute,
          }}>{t.l}</button>;
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 9, alignItems: 'center' }}>
        <MiniSelect label="group" value={group} onChange={setGroup} options={Object.entries(E_GROUPS).map(([k, v]) => ({ k, l: v.label }))} />
        <MiniSelect label="sort" value={sort} onChange={setSort} options={Object.entries(E_SORTS).map(([k, v]) => ({ k, l: v[0] }))} />
        <button onClick={() => setCompact(!compact)} title={compact ? 'Comfortable rows' : 'Compact rows'} style={{
          marginLeft: 'auto', appearance: 'none', cursor: 'pointer', border: `1px solid ${EP.edge}`, background: compact ? EP.card : 'transparent',
          borderRadius: 8, width: 28, height: 26, display: 'grid', placeItems: 'center', color: compact ? EP.accent : EP.inkMute,
        }}><SMIcon name="tasks" size={13} /></button>
      </div>
    </div>

    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '6px 8px 10px' }}>
      {pinned.length > 0 && <>
        <div style={{ position: 'sticky', top: 0, zIndex: 2, background: EP.panel, padding: '7px 6px 5px', display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ color: EP.accent, display: 'inline-flex' }}><SMIcon name="skills" size={11} /></span>
          <span style={{ fontFamily: EP.mono, fontSize: 10, fontWeight: 600, letterSpacing: 0.9, textTransform: 'uppercase', color: EP.inkSoft }}>pinned</span>
          <span style={{ fontFamily: EP.mono, fontSize: 10, color: EP.inkMute }}>{pinned.length}</span>
        </div>
        <div style={{ display: 'grid', gap: compact ? 1 : 5, marginBottom: 8 }}>
          {pinned.map(e => <QueueRow key={e.id} e={e} on={e.id === selId} compact={compact} pinned onSelect={onSelect} onPin={togglePin} />)}
        </div>
      </>}

      {sections.map(s => {
        const shut = closed.has(s.key);
        const lim = limits[s.key] || PAGE;
        const rest = s.items.length - lim;
        return <div key={s.key} style={{ marginBottom: 6 }}>
          <button onClick={() => setClosed(p => { const n = new Set(p); n.has(s.key) ? n.delete(s.key) : n.add(s.key); return n; })} style={{
            position: 'sticky', top: 0, zIndex: 2, width: '100%', appearance: 'none', border: 0, cursor: 'pointer',
            background: EP.panel, padding: '7px 6px 6px', display: 'flex', alignItems: 'center', gap: 7, textAlign: 'left',
          }}>
            <span style={{ display: 'inline-flex', color: EP.inkMute, transform: shut ? 'none' : 'rotate(90deg)', transition: 'transform .12s' }}><SMIcon name="chevron" size={11} /></span>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: g.dot(s.key) }} />
            <span style={{ fontFamily: EP.mono, fontSize: 10, fontWeight: 600, letterSpacing: 0.9, textTransform: 'uppercase', color: EP.inkSoft }}>{g.name(s.key)}</span>
            <span style={{ fontFamily: EP.mono, fontSize: 10, color: EP.inkMute }}>{s.items.length}</span>
            <span style={{ marginLeft: 'auto', height: 1, flex: 1, background: EP.rule, opacity: 0.7 }} />
          </button>
          {!shut && <div style={{ display: 'grid', gap: compact ? 1 : 5 }}>
            {s.items.slice(0, lim).map(e => <QueueRow key={e.id} e={e} on={e.id === selId} compact={compact} pinned={false} onSelect={onSelect} onPin={togglePin} />)}
            {rest > 0 && <button onClick={() => setLimits(p => ({ ...p, [s.key]: lim + 40 }))} style={{
              appearance: 'none', cursor: 'pointer', border: `1px dashed ${EP.rule}`, background: 'transparent', borderRadius: 9,
              padding: '7px 10px', margin: '3px 0 2px', fontFamily: EP.sans, fontSize: 11.5, fontWeight: 600, color: EP.inkMute,
            }}>Show {Math.min(40, rest)} more · {rest} hidden</button>}
          </div>}
        </div>;
      })}
      {!sorted.length && <div style={{ padding: '26px 14px', textAlign: 'center', fontSize: 12.5, color: EP.inkMute, lineHeight: 1.5 }}>
        No Epics match “{q}”.<br /><button onClick={() => { setQ(''); setFilter('all'); }} style={{ appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', color: EP.accent, fontFamily: EP.sans, fontSize: 12.5, fontWeight: 600, padding: '6px 0 0' }}>Clear filters</button>
      </div>}
    </div>

    <div style={{ borderTop: `1px solid ${EP.edge}`, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 10, background: EP.panel }}>
      <span style={{ fontFamily: EP.mono, fontSize: 10.5, color: EP.inkMute }}>{sorted.length} shown · {counts.needs || 0} need you</span>
      <span style={{ marginLeft: 'auto', fontFamily: EP.mono, fontSize: 10, color: EP.inkMute }}>j / k to move</span>
    </div>
  </aside>;
}

// ── thread turns ─────────────────────────────────────────────────────
function ToolStrip({ tools, running }) {
  const [open, setOpen] = React.useState(false);
  const n = tools.reduce((a, t) => a + t[1], 0);
  return <div style={{ marginBottom: 9 }}>
    <button onClick={() => setOpen(!open)} style={{
      appearance: 'none', cursor: 'pointer', border: `1px solid ${EP.edge}`, background: EP.paper, borderRadius: 8,
      padding: '4px 9px', display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: EP.mono, fontSize: 11, color: EP.inkSoft,
    }}>
      <span style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}><SMIcon name="chevron" size={11} /></span>
      <span>{(running ? 'working · ' : 'used ') + n + (n === 1 ? ' tool' : ' tools')}</span>
      {running && <span style={{ width: 5, height: 5, borderRadius: '50%', background: EP.accent }} />}
    </button>
    {open && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
      {tools.map(([t, c]) => <span key={t} style={{
        fontFamily: EP.mono, fontSize: 10.5, color: EP.inkSoft, background: EP.paper,
        border: `1px solid ${EP.rule}`, borderRadius: 6, padding: '2.5px 7px',
      }}>{t}{c > 1 ? ` ×${c}` : ''}</span>)}
    </div>}
  </div>;
}

function Turn({ m, onOpenPrd }) {
  if (m.role === 'user') {
    return <div style={{ display: 'grid', justifyItems: 'end', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontFamily: EP.mono, fontSize: 10.5, color: EP.inkMute }}>you · {m.at}</span>
        {m.spawned && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: EP.mono, fontSize: 10.5, color: EP.accent }}>
          <SMIcon name="plus" size={11} /> split into “{m.spawned}”
        </span>}
      </div>
      <div style={{
        maxWidth: '76%', background: '#f2e2ce', border: `1px solid ${EP.edge}`, borderRadius: '12px 12px 4px 12px',
        padding: '11px 14px', fontSize: 13.5, lineHeight: 1.55, color: EP.ink, textWrap: 'pretty',
      }}>{m.text}</div>
    </div>;
  }
  const ask = m.question;
  return <div style={{ display: 'grid', gridTemplateColumns: '26px minmax(0,1fr)', gap: 11 }}>
    <span style={{
      width: 26, height: 26, borderRadius: 8, background: ask ? '#f2d8d0' : EP.card, border: `1px solid ${ask ? '#dcb6a8' : EP.edge}`,
      display: 'grid', placeItems: 'center', fontFamily: EP.serif, fontSize: 13, fontWeight: 600, color: ask ? '#8a2f2f' : EP.accent,
    }}>C</span>
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
        <span style={{ fontFamily: EP.mono, fontSize: 10.5, color: EP.inkMute }}>claude · {m.at}</span>
        {m.running && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: EP.mono, fontSize: 10.5, fontWeight: 600, color: EP.accent }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: EP.accent }} /> running
        </span>}
        {m.outcome && <span style={{ fontFamily: EP.mono, fontSize: 10.5, fontWeight: 600, color: EP.sage }}>{m.outcome}</span>}
      </div>
      {m.tools && <ToolStrip tools={m.tools} running={m.running} />}
      <div style={{
        background: ask ? '#fbeee9' : EP.card, border: `1px solid ${ask ? '#e3c4b8' : EP.edge}`, borderRadius: '4px 12px 12px 12px',
        padding: '12px 15px', fontSize: 13.5, lineHeight: 1.6, color: EP.ink, textWrap: 'pretty',
      }}>
        {ask && <div style={{ fontFamily: EP.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8a2f2f', marginBottom: 6 }}>Needs your decision</div>}
        {m.text}
        {m.artifact && <button onClick={() => onOpenPrd(m.artifact)} style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 11, appearance: 'none', cursor: 'pointer',
          border: `1px solid ${EP.rule}`, background: EP.paper, borderRadius: 9, padding: '6px 11px',
          fontFamily: EP.mono, fontSize: 11.5, fontWeight: 600, color: EP.inkSoft,
        }}><SMIcon name="file" size={13} />{m.artifact}<SMIcon name="arrowright" size={12} /></button>}
        {ask && <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
          <span style={{ appearance: 'none', border: 0, borderRadius: 8, padding: '6px 12px', background: EP.accent, color: '#fdf7ee', fontFamily: EP.sans, fontSize: 12.5, fontWeight: 650, cursor: 'pointer' }}>Cap at archive depth</span>
          <span style={{ appearance: 'none', border: `1px solid ${EP.edge}`, borderRadius: 8, padding: '6px 12px', background: EP.card, color: EP.inkSoft, fontFamily: EP.sans, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Extrapolate</span>
        </div>}
      </div>
    </div>
  </div>;
}

// ── PRD list ─────────────────────────────────────────────────────────
function PrdList({ epic }) {
  if (!epic.prds.length) return <div style={{
    border: `1px dashed ${EP.rule}`, borderRadius: 12, padding: '30px 22px', textAlign: 'center', color: EP.inkMute, fontSize: 13, lineHeight: 1.6,
  }}>
    No PRD yet for this Epic.<br />Ask Claude in the thread below to draft one — it will attach here.
  </div>;
  return <div style={{ display: 'grid', gap: 8 }}>
    {epic.prds.map(p => <div key={p.name} style={{
      background: EP.card, border: `1px solid ${EP.edge}`, borderRadius: 11, padding: '12px 14px',
      display: 'grid', gridTemplateColumns: '18px minmax(0,1fr) auto', gap: 11, alignItems: 'start',
    }}>
      <span style={{ color: EP.accent, marginTop: 1 }}><SMIcon name="file" size={16} /></span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: EP.mono, fontSize: 12.5, fontWeight: 600, color: EP.ink }}>{p.name}</span>
          <span style={{
            fontFamily: EP.sans, fontSize: 10.5, fontWeight: 600, padding: '1.5px 7px', borderRadius: 999,
            background: p.status === 'accepted' ? '#e3e6cf' : 'transparent', color: p.status === 'accepted' ? '#4a5730' : EP.inkMute,
            boxShadow: p.status === 'accepted' ? 'none' : `inset 0 0 0 1px ${EP.rule}`,
          }}>{p.status}</span>
        </span>
        <span style={{ display: 'block', fontSize: 12.5, color: EP.inkMute, marginTop: 4, lineHeight: 1.45 }}>{p.note}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: EP.mono, fontSize: 11, color: EP.inkMute }}>{p.lines} lines</span>
        <span style={{ display: 'inline-flex', color: EP.inkMute }}><SMIcon name="arrowright" size={14} /></span>
      </span>
    </div>)}
  </div>;
}

// ── composer, scoped to the Epic ─────────────────────────────────────
function Composer({ epic }) {
  const [text, setText] = React.useState('');
  const running = epic.status === 'running';
  const att = useAttachments();
  const file = React.useRef(null);
  const ta = React.useRef(null);
  const [over, setOver] = React.useState(false);
  const grow = () => {
    const el = ta.current; if (!el) return;
    el.style.height = 'auto';
    const chrome = el.offsetHeight - el.clientHeight; // borders, since box-sizing is border-box
    el.style.height = Math.min(180, Math.max(58, el.scrollHeight + chrome)) + 'px';
  };
  React.useEffect(() => { setText(''); att.clear(); }, [epic.id]);
  React.useEffect(grow, [text, epic.id]);
  const onPaste = (e) => { const fl = [...(e.clipboardData ? e.clipboardData.files : [])]; if (fl.length) { e.preventDefault(); att.add(fl); } };

  return <div onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
    onDrop={e => { e.preventDefault(); setOver(false); att.add(e.dataTransfer.files); }}
    style={{ borderTop: `1px solid ${over ? EP.accent : EP.edge}`, background: over ? '#f4e8da' : EP.panel, padding: '9px 22px 12px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
      <span style={{ fontFamily: EP.mono, fontSize: 10.5, color: EP.inkMute }}>iterating in</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 650, color: EP.ink, minWidth: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: E_STATUS[epic.status].dot, flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{epic.title}</span>
      </span>
      <EKind k={epic.kind} small />
      {over && <span style={{ marginLeft: 'auto', fontFamily: EP.mono, fontSize: 10.5, fontWeight: 600, color: EP.accent }}>drop to attach</span>}
    </div>
    {att.items.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 8 }}>
      {att.items.map(i => <span key={i.id} style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, background: EP.card, border: `1px solid ${EP.edge}`,
        borderRadius: 9, padding: i.url ? '3px 8px 3px 3px' : '4px 8px', maxWidth: 220,
      }}>
        {i.url
          ? <img src={i.url} alt="" style={{ width: 28, height: 22, objectFit: 'cover', borderRadius: 6, display: 'block', border: `1px solid ${EP.rule}` }} />
          : <span style={{ color: EP.accent, display: 'inline-flex' }}><SMIcon name="file" size={13} /></span>}
        <span style={{ fontFamily: EP.mono, fontSize: 11, color: EP.inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
        <button onClick={() => att.remove(i.id)} title="Remove" style={{ appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', padding: 0, color: EP.inkMute, display: 'inline-flex', flexShrink: 0 }}><SMIcon name="x" size={12} /></button>
      </span>)}
    </div>}
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
      <div style={{ display: 'flex', border: `1px solid ${EP.edge}`, background: EP.card, borderRadius: 10, overflow: 'hidden', flexShrink: 0, height: 58 }}>
        <button title="Dictate this prompt" style={{ appearance: 'none', cursor: 'pointer', border: 0, background: 'transparent', color: EP.accent, width: 44, display: 'grid', placeItems: 'center' }}>
          <SMIcon name="mic" size={18} />
        </button>
        <span style={{ width: 1, background: EP.edge }} />
        <button onClick={() => file.current && file.current.click()} title="Attach files or paste a screenshot" style={{ appearance: 'none', cursor: 'pointer', border: 0, background: 'transparent', color: EP.inkSoft, width: 44, display: 'grid', placeItems: 'center' }}>
          <SMIcon name="files" size={17} />
        </button>
        <input ref={file} type="file" multiple onChange={e => { att.add(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
      </div>
      <textarea ref={ta} value={text} onChange={e => setText(e.target.value)} onPaste={onPaste} rows={2}
        placeholder={running ? 'Running… send to queue a follow-up in this Epic' : `Add to “${epic.title}” — Enter to send, ⌘V to attach a screenshot`}
        style={{
          flex: 1, minWidth: 0, resize: 'none', appearance: 'none', border: `1px solid ${EP.edge}`, background: EP.card, borderRadius: 10,
          padding: '10px 13px', fontFamily: EP.sans, fontSize: 13, lineHeight: 1.5, color: EP.ink, outline: 'none',
          minHeight: 58, maxHeight: 180, overflowY: 'auto',
        }} />
      {running && <button style={{ appearance: 'none', cursor: 'pointer', border: 0, background: 'transparent', color: '#8a2f2f', padding: '0 4px', height: 58, fontFamily: EP.sans, fontSize: 12.5, fontWeight: 600, flexShrink: 0 }}>Cancel</button>}
      <button style={{
        appearance: 'none', cursor: 'pointer', border: 0, borderRadius: 10, padding: '0 20px', height: 58, flexShrink: 0,
        background: text || att.items.length ? EP.accent : '#e6d5be', color: text || att.items.length ? '#fdf7ee' : EP.inkMute,
        fontFamily: EP.sans, fontSize: 13, fontWeight: 650, display: 'inline-flex', alignItems: 'center', gap: 7,
      }}><SMIcon name="send" size={14} />{running ? 'Queue' : 'Send'}</button>
    </div>
  </div>;
}

// ── right side is gone: epic detail owns the full width ──────────────
function EpicDetail({ epic }) {
  const [view, setView] = React.useState('thread');
  const scroller = React.useRef(null);
  React.useEffect(() => { setView('thread'); }, [epic.id]);
  React.useEffect(() => {
    const pin = () => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; };
    pin();
    const r = requestAnimationFrame(pin), t = setTimeout(pin, 120);
    return () => { cancelAnimationFrame(r); clearTimeout(t); };
  }, [epic.id, view]);
  const queued = epic.thread.filter(m => m.role === 'user').length;
  const views = [
    { k: 'thread', l: `Discussion ${epic.thread.length}` },
    { k: 'prds', l: `PRDs ${epic.prds.length}` },
    { k: 'runs', l: `Runs ${epic.thread.filter(m => m.tools).length}` },
  ];
  return <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: EP.paper }}>
    <header style={{ padding: '16px 22px 0', borderBottom: `1px solid ${EP.edge}` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 7 }}>
            <EChip s={epic.status} />
            <EKind k={epic.kind} />
            <span style={{ fontFamily: EP.mono, fontSize: 11, color: EP.inkMute }}>{epic.branch}</span>
          </div>
          <h1 style={{ margin: 0, fontFamily: EP.serif, fontSize: 27, fontWeight: 600, letterSpacing: -0.4, lineHeight: 1.15, color: EP.ink }}>{epic.title}</h1>
          <p style={{ margin: '7px 0 0', fontSize: 13.5, color: EP.inkSoft, lineHeight: 1.5, maxWidth: 700, textWrap: 'pretty' }}>{epic.goal}</p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 7, flexShrink: 0 }}>
          <button style={{ appearance: 'none', cursor: 'pointer', border: `1px solid ${EP.edge}`, background: EP.card, color: EP.inkSoft, borderRadius: 9, padding: '7px 12px', fontFamily: EP.sans, fontSize: 12.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <SMIcon name="terminal" size={13} /> Open raw session
          </button>
          <button style={{ appearance: 'none', cursor: 'pointer', border: `1px solid ${EP.edge}`, background: EP.card, color: EP.inkSoft, borderRadius: 9, width: 34, height: 34, display: 'grid', placeItems: 'center' }}>
            <SMIcon name="caret" size={15} />
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, margin: '14px 0 0', paddingBottom: 11 }}>
        <EMeta items={[['opened', epic.opened], ['last activity', epic.activity], ['turns', epic.turns], ['tools', epic.tools], ['tokens', epic.tokens]]} />
      </div>
      <div style={{ display: 'flex', gap: 2 }}>
        {views.map(v => {
          const on = view === v.k;
          return <button key={v.k} onClick={() => setView(v.k)} style={{
            appearance: 'none', cursor: 'pointer', border: 0, background: 'transparent', padding: '9px 13px',
            fontFamily: EP.sans, fontSize: 13, fontWeight: on ? 650 : 500, color: on ? EP.ink : EP.inkMute,
            boxShadow: on ? `inset 0 -2px 0 ${EP.accent}` : 'none',
          }}>{v.l}</button>;
        })}
      </div>
    </header>

    <div ref={scroller} style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '20px 22px 26px' }}>
      {view === 'thread' && <div style={{ display: 'grid', gap: 18, maxWidth: 900 }}>
        {epic.prds.length > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', paddingBottom: 4 }}>
          <span style={{ fontFamily: EP.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: 0.9, textTransform: 'uppercase', color: EP.inkMute }}>attached</span>
          {epic.prds.map(p => <button key={p.name} onClick={() => setView('prds')} style={{
            appearance: 'none', cursor: 'pointer', border: `1px solid ${EP.edge}`, background: EP.card, borderRadius: 999,
            padding: '4px 11px 4px 8px', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: EP.mono, fontSize: 11, color: EP.inkSoft,
          }}><SMIcon name="file" size={12} />{p.name}</button>)}
        </div>}
        {epic.thread.map((m, i) => <Turn key={i} m={m} onOpenPrd={() => setView('prds')} />)}
      </div>}

      {view === 'prds' && <div style={{ maxWidth: 900, display: 'grid', gap: 14 }}>
        <PrdList epic={epic} />
        <div style={{ fontSize: 12.5, color: EP.inkMute, lineHeight: 1.55 }}>
          PRDs are written by Claude inside this Epic and stored alongside it — accepting one hands it to the Scheduler as a <span style={{ fontFamily: EP.mono }}>claude -p</span> job.
        </div>
      </div>}

      {view === 'runs' && <div style={{ maxWidth: 900, display: 'grid', gap: 8 }}>
        {epic.thread.filter(m => m.tools).map((m, i) => <div key={i} style={{
          background: EP.card, border: `1px solid ${EP.edge}`, borderRadius: 11, padding: '12px 14px', display: 'grid', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ fontFamily: EP.mono, fontSize: 11.5, fontWeight: 600, color: EP.ink }}>turn {i + 1}</span>
            <span style={{ fontFamily: EP.mono, fontSize: 11, color: EP.inkMute }}>{m.at}</span>
            {m.running ? <span style={{ fontFamily: EP.mono, fontSize: 11, fontWeight: 600, color: EP.accent }}>running</span>
              : <span style={{ fontFamily: EP.mono, fontSize: 11, fontWeight: 600, color: EP.sage }}>{m.outcome || 'done'}</span>}
            <span style={{ marginLeft: 'auto', fontFamily: EP.mono, fontSize: 11, color: EP.inkMute }}>{m.tools.reduce((a, t) => a + t[1], 0)} calls</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {m.tools.map(([t, c]) => <span key={t} style={{ fontFamily: EP.mono, fontSize: 10.5, color: EP.inkSoft, background: EP.paper, border: `1px solid ${EP.rule}`, borderRadius: 6, padding: '2.5px 7px' }}>{t}{c > 1 ? ` ×${c}` : ''}</span>)}
          </div>
        </div>)}
        {!epic.thread.some(m => m.tools) && <div style={{ border: `1px dashed ${EP.rule}`, borderRadius: 12, padding: '30px 22px', textAlign: 'center', color: EP.inkMute, fontSize: 13 }}>
          No agent runs in this Epic yet.
        </div>}
      </div>}
    </div>

    <Composer epic={epic} />
  </section>;
}

// ── new-epic sheet ───────────────────────────────────────────────────
function NewEpic({ onCancel }) {
  const [kind, setKind] = React.useState('Feature');
  const att = useAttachments();
  return <section style={{ flex: 1, minWidth: 0, display: 'grid', placeItems: 'center', background: EP.paper, padding: 30, overflowY: 'auto' }}>
    <div style={{ width: '100%', maxWidth: 620, background: EP.card, border: `1px solid ${EP.edge}`, borderRadius: 16, padding: '24px 26px 22px' }}>
      <div style={{ fontFamily: EP.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: 1.1, textTransform: 'uppercase', color: EP.accent, marginBottom: 7 }}>New Epic</div>
      <h2 style={{ margin: 0, fontFamily: EP.serif, fontSize: 24, fontWeight: 600, letterSpacing: -0.3, color: EP.ink }}>What are we trying to achieve?</h2>
      <p style={{ margin: '8px 0 18px', fontSize: 13.5, color: EP.inkSoft, lineHeight: 1.55 }}>
        One goal per Epic. Its discussion, PRDs and agent runs all stay inside it.
      </p>
      <input placeholder="Epic title" style={{ width: '100%', appearance: 'none', border: `1px solid ${EP.edge}`, background: EP.paper, borderRadius: 10, padding: '11px 13px', fontFamily: EP.sans, fontSize: 14, fontWeight: 600, color: EP.ink, outline: 'none', marginBottom: 9 }} />
      <textarea rows={3} placeholder="The goal, in a sentence or two — what done looks like." style={{ width: '100%', resize: 'vertical', appearance: 'none', border: `1px solid ${EP.edge}`, background: EP.paper, borderRadius: 10, padding: '11px 13px', fontFamily: EP.sans, fontSize: 13, lineHeight: 1.55, color: EP.ink, outline: 'none', marginBottom: 12 }} />
      <div style={{ fontFamily: EP.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: 0.9, textTransform: 'uppercase', color: EP.inkMute, marginBottom: 7 }}>
        references{att.items.length ? ` · ${att.items.length}` : ''}
      </div>
      <AttachTray att={att} tall />
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 16 }}>
        <span style={{ fontFamily: EP.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: 0.9, textTransform: 'uppercase', color: EP.inkMute }}>type</span>
        <span style={{ display: 'flex', gap: 3 }}>
          {E_KINDS.map(k => {
            const on = kind === k;
            return <button key={k} onClick={() => setKind(k)} style={{
              appearance: 'none', cursor: 'pointer', border: 0, borderRadius: 7, padding: '5px 11px',
              background: on ? EP.panel : 'transparent', boxShadow: on ? `inset 0 0 0 1px ${EP.edge}` : 'none',
              fontFamily: EP.sans, fontSize: 12, fontWeight: on ? 650 : 500, color: on ? E_KIND_TINT[k] : EP.inkMute,
            }}>{k}</button>;
          })}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>
          <button onClick={onCancel} style={{ appearance: 'none', cursor: 'pointer', border: `1px solid ${EP.edge}`, background: EP.paper, color: EP.inkSoft, borderRadius: 9, padding: '8px 14px', fontFamily: EP.sans, fontSize: 12.5, fontWeight: 600 }}>Cancel</button>
          <button onClick={onCancel} style={{ appearance: 'none', cursor: 'pointer', border: 0, background: EP.accent, color: '#fdf7ee', borderRadius: 9, padding: '8px 16px', fontFamily: EP.sans, fontSize: 12.5, fontWeight: 650 }}>Create Epic</button>
        </span>
      </div>
    </div>
  </section>;
}

// ── page ─────────────────────────────────────────────────────────────
const E_ALL = E_EPICS.concat(window.E_GENERATED || []);

function EpicsPage() {
  const [selId, setSelId] = React.useState(E_ALL[0].id);
  const [creating, setCreating] = React.useState(false);
  const epic = E_ALL.find(e => e.id === selId) || E_ALL[0];
  return <div style={{ display: 'flex', height: '100%', minHeight: 0, fontFamily: EP.sans, color: EP.ink, background: EP.paper }}>
    <EpicQueue epics={E_ALL} selId={creating ? null : selId} onSelect={(id) => { setSelId(id); setCreating(false); }} onNew={() => setCreating(true)} />
    {creating ? <NewEpic onCancel={() => setCreating(false)} /> : <EpicDetail epic={epic} />}
  </div>;
}

Object.assign(window, { E_EPICS, E_ALL, EpicsPage });

