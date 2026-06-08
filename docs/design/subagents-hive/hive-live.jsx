// Hive · Live — watch the hive work. Per-agent status, streaming output, and
// a results digest that fills in as agents finish. Loads after hive-shared.jsx.

function AgentMonitorRow({ live }) {
  const a = HIVE_AGENT_BY_ID[live.id];
  const running = live.state === 'running';
  const done = live.state === 'done';
  return (
    <div style={{
      background: HIVE.card, border: `1px solid ${running ? HIVE.accentSoft : HIVE.edge}`,
      borderRadius: 12, padding: '14px 16px',
      boxShadow: running ? `0 0 0 1px ${HIVE.accentSoft}` : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <HiveCell color={a.dot} size={16} />
        <span style={{ fontFamily: HIVE.mono, fontSize: 14, fontWeight: 600, color: HIVE.ink }}>{a.name}</span>
        <span style={{ fontSize: 12.5, color: HIVE.inkMute }}>· {a.role}</span>
        <span style={{ marginLeft: 'auto' }}><StatusPill state={live.state} /></span>
      </div>

      {/* progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <div style={{ flex: 1, height: 8, background: HIVE.paper, borderRadius: 999, overflow: 'hidden', border: `1px solid ${HIVE.rule}` }}>
          <div style={{
            width: `${Math.round(live.pct * 100)}%`, height: '100%',
            background: done ? HIVE.sage : `linear-gradient(90deg, ${HIVE.accent}, ${HIVE.accentSoft})`,
            transition: 'width .4s',
          }} />
        </div>
        <span style={{ fontFamily: HIVE.mono, fontSize: 12, color: HIVE.inkSoft, width: 38, textAlign: 'right' }}>
          {Math.round(live.pct * 100)}%
        </span>
      </div>

      {/* streaming output preview */}
      <div style={{
        marginTop: 11, background: '#2a241c', borderRadius: 8, padding: '9px 12px',
        fontFamily: HIVE.mono, fontSize: 11.5, lineHeight: 1.5, color: '#d8c9ad',
        display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden',
      }}>
        <span style={{ color: running ? HIVE.butter : HIVE.sage, flexShrink: 0 }}>{running ? '▍' : '✓'}</span>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{live.lastLine}</span>
      </div>

      {/* meta */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 10, fontFamily: HIVE.mono, fontSize: 11.5, color: HIVE.inkMute }}>
        <span>{live.tokens} tok</span>
        <span>{live.elapsed}</span>
        {live.findings > 0 && <span style={{ color: HIVE.accent }}>{live.findings} finding{live.findings > 1 ? 's' : ''}</span>}
        <button style={{
          marginLeft: 'auto', appearance: 'none', border: `1px solid ${HIVE.edge}`, background: HIVE.paper,
          cursor: 'pointer', borderRadius: 6, padding: '3px 9px', fontFamily: HIVE.sans, fontSize: 11.5, color: HIVE.inkSoft,
        }}>open transcript</button>
      </div>
    </div>
  );
}

function HiveLive({ onNewHive }) {
  const recipe = HIVE_RECIPES.find(r => r.id === HIVE_LIVE.recipeId);
  const live = HIVE_LIVE.agents;
  const doneCount = live.filter(a => a.state === 'done').length;
  const runningCount = live.filter(a => a.state === 'running').length;
  const overall = Math.round((live.reduce((s, a) => s + a.pct, 0) / live.length) * 100);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 360px', gap: 24, alignItems: 'start' }}>
      {/* LEFT — live agents */}
      <div>
        {/* banner */}
        <div style={{
          background: HIVE.card, border: `1px solid ${HIVE.edge}`, borderRadius: 14,
          padding: '16px 18px', marginBottom: 18,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span className="hv-pulse" style={{ width: 9, height: 9, borderRadius: '50%', background: HIVE.accent }} />
            <span style={{ fontFamily: HIVE.serif, fontSize: 20, fontWeight: 600, color: HIVE.ink }}>{recipe.name}</span>
            <span style={{ fontSize: 13, color: HIVE.inkMute }}>running for {HIVE_LIVE.startedAgo}</span>
            <button onClick={onNewHive} style={{
              marginLeft: 'auto', appearance: 'none', border: `1px solid ${HIVE.edge}`, background: HIVE.paper,
              cursor: 'pointer', borderRadius: 8, padding: '6px 12px', fontFamily: HIVE.sans, fontSize: 12.5, color: HIVE.inkSoft,
            }}>Launch another</button>
          </div>
          <div style={{ fontSize: 13.5, color: HIVE.inkSoft, fontFamily: HIVE.serif, fontStyle: 'italic', marginBottom: 12 }}>
            on "{HIVE_LIVE.target}"
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, height: 9, background: HIVE.paper, borderRadius: 999, overflow: 'hidden', border: `1px solid ${HIVE.rule}` }}>
              <div style={{ width: `${overall}%`, height: '100%', background: `linear-gradient(90deg, ${HIVE.accent}, ${HIVE.accentSoft})`, transition: 'width .4s' }} />
            </div>
            <span style={{ fontFamily: HIVE.mono, fontSize: 12.5, color: HIVE.ink, fontWeight: 600 }}>{overall}%</span>
            <span style={{ fontFamily: HIVE.mono, fontSize: 12, color: HIVE.inkMute }}>{doneCount} done · {runningCount} running</span>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          {live.map((l, i) => <AgentMonitorRow key={i} live={l} />)}
        </div>
      </div>

      {/* RIGHT — results digest */}
      <div style={{ position: 'sticky', top: 0 }}>
        <div style={{ background: HIVE.card, border: `1px solid ${HIVE.edge}`, borderRadius: 16, overflow: 'hidden' }}>
          <div style={{ padding: '15px 18px', borderBottom: `1px solid ${HIVE.rule}`, display: 'flex', alignItems: 'center', gap: 9 }}>
            <SMIcon name="book" size={17} />
            <span style={{ fontFamily: HIVE.serif, fontSize: 18, fontWeight: 600, color: HIVE.ink }}>Results digest</span>
            <span style={{ marginLeft: 'auto', fontFamily: HIVE.mono, fontSize: 12, color: HIVE.inkMute }}>{HIVE_DIGEST.length} so far</span>
          </div>
          <div style={{ padding: '6px 0' }}>
            {HIVE_DIGEST.map((d, i) => (
              <div key={i} style={{ padding: '11px 18px', borderTop: i ? `1px solid ${HIVE.rule}` : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <SevDot sev={d.sev} />
                  <span style={{ fontFamily: HIVE.mono, fontSize: 11, color: HIVE.inkMute }}>{d.agent}</span>
                </div>
                <div style={{ fontSize: 13, color: HIVE.ink, lineHeight: 1.45 }}>{d.text}</div>
              </div>
            ))}
          </div>
          <div style={{ padding: '14px 18px', borderTop: `1px solid ${HIVE.rule}`, background: HIVE.paper }}>
            <div style={{ fontSize: 12.5, color: HIVE.inkSoft, lineHeight: 1.5, marginBottom: 10 }}>
              The digest is what reaches your main session — intermediate output stays in each agent's context.
            </div>
            <button style={{
              appearance: 'none', border: 0, cursor: 'pointer', width: '100%',
              background: HIVE.ink, color: HIVE.paper, borderRadius: 10, padding: '10px 14px',
              fontFamily: HIVE.sans, fontSize: 13.5, fontWeight: 600,
            }}>Send digest to main session</button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { HiveLive });
