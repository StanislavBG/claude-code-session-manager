// Hive · Launch — the front door. Pick a recipe → aim it → see exactly what
// will happen → fire. Loads after hive-shared.jsx.

// Fan-out diagram: main session → N agent cells → results digest.
function FanoutDiagram({ agents, accent }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 14,
      background: HIVE.paper, border: `1px solid ${HIVE.edge}`, borderRadius: 12, padding: '16px 14px',
    }}>
      {/* main */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 44, height: 44, borderRadius: 11, background: HIVE.card, border: `1px solid ${HIVE.edge}`, display: 'grid', placeItems: 'center' }}>
          <SMMascot size={24} fg={HIVE.accent} />
        </div>
        <div style={{ fontFamily: HIVE.mono, fontSize: 10, color: HIVE.inkMute, textAlign: 'center', maxWidth: 56 }}>main session</div>
      </div>
      {/* fan */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, position: 'relative' }}>
        {agents.map((a, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <svg width="34" height="14" style={{ flexShrink: 0 }}>
              <path d={`M0 7 C 14 7, 18 7, 34 7`} stroke={HIVE.rule} strokeWidth="1.5" fill="none" />
            </svg>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: HIVE.card, border: `1px solid ${HIVE.edge}`, borderRadius: 8, padding: '5px 10px', flex: 1 }}>
              <HiveCell color={a.dot} size={13} />
              <span style={{ fontFamily: HIVE.mono, fontSize: 12, color: HIVE.ink, fontWeight: 500 }}>{a.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10.5, color: HIVE.inkMute }}>isolated context</span>
            </div>
          </div>
        ))}
      </div>
      {/* digest */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 44, height: 44, borderRadius: 11, background: accent, display: 'grid', placeItems: 'center', color: '#fff' }}>
          <SMIcon name="book" size={20} />
        </div>
        <div style={{ fontFamily: HIVE.mono, fontSize: 10, color: HIVE.inkMute, textAlign: 'center', maxWidth: 60 }}>one digest back</div>
      </div>
    </div>
  );
}

function RecipeCard({ recipe, active, onClick }) {
  const agents = recipe.agentIds.map(id => HIVE_AGENT_BY_ID[id]);
  return (
    <button onClick={onClick} style={{
      appearance: 'none', textAlign: 'left', cursor: 'pointer', width: '100%',
      background: active ? HIVE.card : HIVE.paper,
      border: `1px solid ${active ? recipe.accent : HIVE.edge}`,
      boxShadow: active ? `0 0 0 1px ${recipe.accent}, 0 6px 18px rgba(60,40,20,0.10)` : 'none',
      borderRadius: 12, padding: '14px 16px', fontFamily: HIVE.sans,
      transition: 'box-shadow .12s, border-color .12s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ display: 'inline-flex' }}><HiveCell color={recipe.accent} size={16} /></span>
        <span style={{ fontFamily: HIVE.serif, fontSize: 18, fontWeight: 600, color: HIVE.ink }}>{recipe.name}</span>
        {active && <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: recipe.accent, fontFamily: HIVE.sans }}>SELECTED</span>}
      </div>
      <div style={{ fontSize: 13, color: HIVE.inkSoft, lineHeight: 1.45, marginBottom: 10 }}>{recipe.tagline}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {agents.map((a, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: HIVE.panel, border: `1px solid ${HIVE.edge}`, borderRadius: 7, padding: '3px 8px' }}>
            <HiveCell color={a.dot} size={11} />
            <span style={{ fontFamily: HIVE.mono, fontSize: 11.5, color: HIVE.inkSoft }}>{a.name}</span>
          </span>
        ))}
        <span style={{ marginLeft: 'auto', fontFamily: HIVE.mono, fontSize: 11.5, color: HIVE.inkMute }}>
          ~{recipe.estMin} min · ~${recipe.estCost.toFixed(2)}
        </span>
      </div>
    </button>
  );
}

function HiveLaunch({ recipeId, setRecipeId, target, setTarget, onLaunch, project }) {
  const recipe = HIVE_RECIPES.find(r => r.id === recipeId) || HIVE_RECIPES[0];
  const agents = recipe.agentIds.map(id => HIVE_AGENT_BY_ID[id]);
  const n = agents.length;
  const totalCost = recipe.estCost;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 400px', gap: 24, alignItems: 'start' }}>
      {/* ── LEFT: build the hive ───────────────────────────── */}
      <div>
        {/* Step 1 */}
        <StepHeader n="1" title="Pick a recipe" hint="A preset bundle of subagents. Fire it at a target and each one works in parallel, in isolation." />
        <div style={{ display: 'grid', gap: 10, marginBottom: 28 }}>
          {HIVE_RECIPES.map(r => (
            <RecipeCard key={r.id} recipe={r} active={r.id === recipeId} onClick={() => setRecipeId(r.id)} />
          ))}
          <button style={{
            appearance: 'none', cursor: 'pointer', width: '100%',
            background: 'transparent', border: `1px dashed ${HIVE.rule}`, borderRadius: 12,
            padding: '12px 16px', fontFamily: HIVE.sans, fontSize: 13, fontWeight: 500, color: HIVE.inkSoft,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            <SMIcon name="plus" size={15} /> Build a custom hive — hand-pick agents
          </button>
        </div>

        {/* Step 2 */}
        <StepHeader n="2" title="Aim it at a target" hint="What should the hive look at? Be specific — each agent gets this as its brief." />
        <div style={{ background: HIVE.card, border: `1px solid ${HIVE.edge}`, borderRadius: 12, padding: 4, marginBottom: 12 }}>
          <textarea
            value={target}
            onChange={e => setTarget(e.target.value)}
            spellCheck={false}
            style={{
              width: '100%', minHeight: 76, resize: 'vertical', border: 0, outline: 'none',
              background: 'transparent', padding: '12px 14px',
              fontFamily: HIVE.sans, fontSize: 14.5, lineHeight: 1.5, color: HIVE.ink,
            }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: HIVE.inkMute, fontFamily: HIVE.sans }}>Scope</span>
          <ScopeChip icon="folder">{project.label}</ScopeChip>
          <ScopeChip icon="dot">⌥{project.branch}</ScopeChip>
          <ScopeChip icon="file">src/ · signals/</ScopeChip>
          <button style={{
            appearance: 'none', border: `1px solid ${HIVE.edge}`, background: HIVE.paper, cursor: 'pointer',
            borderRadius: 7, padding: '4px 9px', fontFamily: HIVE.sans, fontSize: 12, color: HIVE.inkSoft,
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}><SMIcon name="plus" size={12} /> add path</button>
        </div>
      </div>

      {/* ── RIGHT: what will happen (sticky) ────────────────── */}
      <div style={{ position: 'sticky', top: 0 }}>
        <div style={{ background: HIVE.card, border: `1px solid ${HIVE.edge}`, borderRadius: 16, overflow: 'hidden', boxShadow: '0 8px 30px rgba(60,40,20,0.10)' }}>
          <div style={{ padding: '16px 18px 12px', borderBottom: `1px solid ${HIVE.rule}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: HIVE.inkMute, textTransform: 'uppercase', marginBottom: 8 }}>
              What will happen
            </div>
            <p style={{ margin: 0, fontFamily: HIVE.serif, fontSize: 18, lineHeight: 1.4, color: HIVE.ink }}>
              <strong style={{ color: recipe.accent }}>{n} agents</strong> read your code in parallel — each in its own context — and hand back a single digest. Nothing is written without your say-so.
            </p>
          </div>

          <div style={{ padding: '14px 18px', borderBottom: `1px solid ${HIVE.rule}` }}>
            <FanoutDiagram agents={agents} accent={recipe.accent} />
          </div>

          {/* per-agent clarity */}
          <div style={{ padding: '12px 18px', borderBottom: `1px solid ${HIVE.rule}`, display: 'grid', gap: 9 }}>
            {agents.map((a, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                <span style={{ marginTop: 2 }}><HiveCell color={a.dot} size={13} /></span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: HIVE.mono, fontSize: 12.5, fontWeight: 600, color: HIVE.ink }}>{a.name}</span>
                    <ToolChip tone={a.readOnly ? 'readonly' : 'write'}>{a.readOnly ? 'read-only' : 'can edit'}</ToolChip>
                  </div>
                  <div style={{ fontSize: 12, color: HIVE.inkSoft, marginTop: 2, lineHeight: 1.4 }}>
                    Returns {a.returns}.
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* estimate */}
          <div style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 16, fontFamily: HIVE.mono, fontSize: 12, color: HIVE.inkSoft }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><SMIcon name="clock" size={13} /> ~{recipe.estMin} min</span>
            <span>~${totalCost.toFixed(2)}</span>
            <span style={{ color: HIVE.sage }}>fits your window</span>
          </div>

          {/* CTA */}
          <div style={{ padding: '4px 18px 18px' }}>
            <button onClick={onLaunch} style={{
              appearance: 'none', border: 0, cursor: 'pointer', width: '100%',
              background: HIVE.accent, color: '#fff', borderRadius: 11,
              padding: '13px 16px', fontFamily: HIVE.sans, fontSize: 15.5, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
              boxShadow: '0 2px 0 #8f4222',
            }}>
              <HiveCell color="#fff" size={17} /> Launch the hive
            </button>
            <div style={{ textAlign: 'center', marginTop: 9, fontSize: 11.5, color: HIVE.inkMute, fontFamily: HIVE.sans }}>
              Auto-pauses on rate-limit · resumes on the next window reset
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepHeader({ n, title, hint }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 22, height: 22, borderRadius: 7, background: HIVE.accent, color: '#fff',
          display: 'grid', placeItems: 'center', fontFamily: HIVE.mono, fontSize: 12, fontWeight: 700,
        }}>{n}</span>
        <span style={{ fontFamily: HIVE.serif, fontSize: 22, fontWeight: 600, color: HIVE.ink }}>{title}</span>
      </div>
      <p style={{ margin: '6px 0 0 32px', fontSize: 13, color: HIVE.inkSoft, lineHeight: 1.45, maxWidth: 560 }}>{hint}</p>
    </div>
  );
}

function ScopeChip({ icon, children }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: HIVE.paper, border: `1px solid ${HIVE.edge}`, borderRadius: 7, padding: '4px 9px',
      fontFamily: HIVE.mono, fontSize: 12, color: HIVE.inkSoft,
    }}>
      <span style={{ color: HIVE.inkMute, display: 'inline-flex' }}><SMIcon name={icon} size={12} /></span>
      {children}
    </span>
  );
}

Object.assign(window, { HiveLaunch });
