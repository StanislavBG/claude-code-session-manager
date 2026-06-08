// Hive · page shell — header + sub-tabs + active sub-view.
// Loads last among the hive files.

function HivePage({ project }) {
  const [tab, setTab] = React.useState('launch');
  const [recipeId, setRecipeId] = React.useState('ship-ready');
  const [target, setTarget] = React.useState(
    'Review the changes to src/snapshot.py and the signals/ module before I merge. Focus on the 5-hour window math and anything that touches ingest.'
  );

  const counts = { configured: HIVE_AGENTS.length, library: HIVE_LIBRARY.length };

  return (
    <div style={{ padding: '28px 36px 40px', fontFamily: HIVE.sans, color: HIVE.ink, maxWidth: 1180, margin: '0 auto' }}>
      {/* header */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: HIVE.inkMute, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 4 }}>
          Workspace · Subagents
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, flexShrink: 0, fontFamily: HIVE.serif, fontSize: 40, fontWeight: 600, lineHeight: 1, letterSpacing: -0.5, color: HIVE.ink }}>
            The hive
          </h1>
          <p style={{ margin: 0, flex: '1 1 360px', fontSize: 14.5, color: HIVE.inkSoft, lineHeight: 1.5, maxWidth: 540 }}>
            Fire a bundle of focused subagents at a task. Each works in its own context and hands back one digest — your main session never drowns in their output.
          </p>
        </div>
      </div>

      {/* sub-tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
        <HiveSubTabs value={tab} onChange={setTab} counts={counts} />
        {tab === 'live' && (
          <span style={{ fontFamily: HIVE.mono, fontSize: 12.5, color: HIVE.inkSoft }}>
            1 hive · {HIVE_LIVE.agents.filter(a => a.state === 'running').length} agents working
          </span>
        )}
      </div>

      {/* active view */}
      {tab === 'launch' && (
        <HiveLaunch
          recipeId={recipeId} setRecipeId={setRecipeId}
          target={target} setTarget={setTarget}
          onLaunch={() => setTab('live')}
          project={project}
        />
      )}
      {tab === 'live' && <HiveLive onNewHive={() => setTab('launch')} />}
      {tab === 'configured' && <HiveConfigured />}
      {tab === 'library' && <HiveLibrary />}
    </div>
  );
}

window.HivePage = HivePage;
