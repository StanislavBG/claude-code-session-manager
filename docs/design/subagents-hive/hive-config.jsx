// Hive · Configured (agent editor) + Library. Loads after hive-shared.jsx.

// ── Configured: roster list + editor form ───────────────────────────
function FieldRow({ label, children, hint }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontFamily: HIVE.sans, fontSize: 12.5, fontWeight: 600, color: HIVE.inkSoft, marginBottom: 6 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: HIVE.inkMute, marginTop: 5, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box', border: `1px solid ${HIVE.edge}`, background: HIVE.paper,
  borderRadius: 9, padding: '9px 12px', fontFamily: HIVE.sans, fontSize: 14, color: HIVE.ink, outline: 'none',
};

function HiveConfigured() {
  const [sel, setSel] = React.useState(HIVE_AGENTS[0].id);
  const a = HIVE_AGENT_BY_ID[sel];
  const allTools = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task'];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0,1fr)', gap: 0, border: `1px solid ${HIVE.edge}`, borderRadius: 14, overflow: 'hidden', background: HIVE.card }}>
      {/* roster */}
      <div style={{ borderRight: `1px solid ${HIVE.rule}`, background: HIVE.panel, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${HIVE.rule}` }}>
          <input placeholder="filter agents…" style={{ ...inputStyle, fontSize: 12.5, padding: '7px 10px' }} />
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 6 }}>
          {HIVE_AGENTS.map(ag => {
            const active = ag.id === sel;
            return (
              <button key={ag.id} onClick={() => setSel(ag.id)} style={{
                appearance: 'none', border: 0, cursor: 'pointer', width: '100%', textAlign: 'left',
                display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 9, marginBottom: 2,
                background: active ? HIVE.card : 'transparent',
                boxShadow: active ? `inset 0 0 0 1px ${HIVE.edge}` : 'none',
                fontFamily: HIVE.mono, fontSize: 13, fontWeight: active ? 600 : 500,
                color: active ? HIVE.ink : HIVE.inkSoft,
              }}>
                <HiveCell color={ag.dot} size={13} />
                {ag.name}
              </button>
            );
          })}
        </div>
        <button style={{
          appearance: 'none', border: 0, borderTop: `1px solid ${HIVE.rule}`, cursor: 'pointer',
          padding: '11px 14px', background: 'transparent', fontFamily: HIVE.sans, fontSize: 13, fontWeight: 600, color: HIVE.accent,
          display: 'flex', alignItems: 'center', gap: 7,
        }}><SMIcon name="plus" size={14} /> New agent</button>
      </div>

      {/* editor */}
      <div style={{ padding: '20px 22px', maxHeight: 620, overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <HiveCell color={a.dot} size={18} />
          <span style={{ fontFamily: HIVE.serif, fontSize: 22, fontWeight: 600, color: HIVE.ink }}>{a.name}</span>
          <span style={{ marginLeft: 'auto', fontFamily: HIVE.mono, fontSize: 11.5, color: HIVE.inkMute }}>~/.claude/agents/{a.name}.md</span>
        </div>
        <p style={{ margin: '0 0 18px', fontSize: 13.5, color: HIVE.inkSoft, lineHeight: 1.5, maxWidth: 600 }}>{a.blurb}</p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <FieldRow label="name"><input style={inputStyle} defaultValue={a.name} /></FieldRow>
          <FieldRow label="model" hint="Cheaper model for simple agents; opus for hard reasoning.">
            <select style={{ ...inputStyle, appearance: 'none' }} defaultValue={a.model}>
              <option>inherit</option><option>haiku</option><option>sonnet</option><option>opus</option>
            </select>
          </FieldRow>
        </div>
        <FieldRow label="description" hint="Main Claude reads this to decide when to delegate. Be specific about scope.">
          <input style={inputStyle} defaultValue={a.role + ' — ' + a.returns} />
        </FieldRow>

        <FieldRow label="tools" hint="A whitelist. Tightening this is the easiest way to make an agent safer.">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, padding: 8, border: `1px solid ${HIVE.edge}`, borderRadius: 9, background: HIVE.paper }}>
            {allTools.map(t => {
              const on = a.tools.includes(t);
              const isWrite = ['Write', 'Edit', 'Bash'].includes(t);
              return (
                <span key={t} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                  fontFamily: HIVE.mono, fontSize: 12, padding: '4px 9px', borderRadius: 7,
                  background: on ? (isWrite ? '#f5e3c8' : '#e9efdc') : 'transparent',
                  color: on ? (isWrite ? '#8a6818' : '#4a5e2e') : HIVE.inkMute,
                  boxShadow: `inset 0 0 0 1px ${on ? (isWrite ? '#e6cfa0' : '#cdd8b6') : HIVE.edge}`,
                  opacity: on ? 1 : 0.7,
                }}>{on ? '✓' : '+'} {t}</span>
              );
            })}
          </div>
        </FieldRow>

        <FieldRow label="system prompt" hint="The body of the markdown file — what this agent should and shouldn't do. Tell it to summarise, not dump.">
          <div style={{ background: '#2a241c', borderRadius: 10, padding: '14px 16px', fontFamily: HIVE.mono, fontSize: 12.5, lineHeight: 1.6, color: '#d8c9ad' }}>
            <span style={{ color: HIVE.butter }}>You are {a.name}.</span> {a.blurb} Work in isolation and return {a.returns} — at most a page. Do not dump raw logs; the main session only needs your conclusions.
          </div>
        </FieldRow>

        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button style={{ appearance: 'none', border: 0, cursor: 'pointer', background: HIVE.accent, color: '#fff', borderRadius: 9, padding: '9px 18px', fontFamily: HIVE.sans, fontSize: 13.5, fontWeight: 600 }}>Save</button>
          <button style={{ appearance: 'none', cursor: 'pointer', background: 'transparent', border: `1px solid ${HIVE.edge}`, color: HIVE.inkSoft, borderRadius: 9, padding: '9px 18px', fontFamily: HIVE.sans, fontSize: 13.5, fontWeight: 500 }}>Revert</button>
          <button style={{ marginLeft: 'auto', appearance: 'none', cursor: 'pointer', background: 'transparent', border: 0, color: HIVE.inkMute, fontFamily: HIVE.sans, fontSize: 13, fontWeight: 500 }}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── Library: community recipes & agents ─────────────────────────────
function HiveLibrary() {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
          <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: HIVE.inkMute, display: 'inline-flex' }}><SMIcon name="search" size={15} /></span>
          <input placeholder="search the library…" style={{ ...inputStyle, paddingLeft: 34 }} />
        </div>
        <div style={{ display: 'flex', gap: 4, background: HIVE.panel, padding: 3, borderRadius: 9, boxShadow: `inset 0 0 0 1px ${HIVE.edge}` }}>
          {['All', 'Recipes', 'Agents'].map((f, i) => (
            <button key={f} style={{
              appearance: 'none', border: 0, cursor: 'pointer', padding: '5px 13px', borderRadius: 7,
              background: i === 0 ? HIVE.card : 'transparent', boxShadow: i === 0 ? `inset 0 0 0 1px ${HIVE.edge}` : 'none',
              fontFamily: HIVE.sans, fontSize: 12.5, fontWeight: i === 0 ? 600 : 500, color: i === 0 ? HIVE.ink : HIVE.inkSoft,
            }}>{f}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        {HIVE_LIBRARY.map((it, i) => (
          <div key={i} style={{ background: HIVE.card, border: `1px solid ${HIVE.edge}`, borderRadius: 13, padding: '15px 16px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 7 }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, background: HIVE.paper, border: `1px solid ${HIVE.edge}`, display: 'grid', placeItems: 'center' }}>
                <HiveCell color={it.kind === 'recipe' ? HIVE.accent : HIVE.sage} size={15} filled={it.kind === 'recipe'} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: HIVE.mono, fontSize: 13.5, fontWeight: 600, color: HIVE.ink }}>{it.name}</div>
                <div style={{ fontSize: 11.5, color: HIVE.inkMute }}>{it.kind} · @{it.author}</div>
              </div>
              <span style={{ marginLeft: 'auto', fontFamily: HIVE.mono, fontSize: 11.5, color: HIVE.inkMute }}>↓ {it.installs}</span>
            </div>
            <div style={{ fontSize: 13, color: HIVE.inkSoft, lineHeight: 1.45, marginBottom: 12, flex: 1 }}>{it.blurb}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
              {it.tools.map(t => <ToolChip key={t} tone={['Write', 'Edit', 'Bash'].includes(t) ? 'write' : 'readonly'}>{t}</ToolChip>)}
            </div>
            <button style={{
              appearance: 'none', border: `1px solid ${HIVE.edge}`, cursor: 'pointer', width: '100%',
              background: HIVE.paper, color: HIVE.ink, borderRadius: 9, padding: '8px 14px',
              fontFamily: HIVE.sans, fontSize: 13, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            }}><SMIcon name="plus" size={14} /> Install</button>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { HiveConfigured, HiveLibrary });
