// Scheduler — page. Readable queue + PRD list + history.
// Loads after variants/scheduler-data.jsx.

const SCH_STATE = {
  running:       { label: 'running',      bg: SCH.accent,  fg: '#fff',     mark: 'pulse' },
  pending:       { label: 'pending',      bg: SCH.paper,   fg: SCH.inkSoft, edge: true,  mark: '○' },
  completed:     { label: 'completed',    bg: '#dde7c8',   fg: '#3f5226',  mark: '✓' },
  'needs-review':{ label: 'needs review', bg: '#f3e0bd',   fg: '#7a5713',  mark: '!' },
  failed:        { label: 'failed',       bg: '#f1d6cb',   fg: '#8f3a1f',  mark: '✕' },
};

function SchBadge({ state }) {
  const s = SCH_STATE[state];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
      fontFamily: SCH.sans, fontSize: 12.5, fontWeight: 600, letterSpacing: 0.1,
      padding: '5px 11px', borderRadius: 8, minWidth: 104, justifyContent: 'center',
      background: s.bg, color: s.fg,
      boxShadow: s.edge ? `inset 0 0 0 1px ${SCH.edge}` : 'none',
    }}>
      {s.mark === 'pulse'
        ? <span className="hv-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff' }} />
        : <span style={{ fontSize: 12 }}>{s.mark}</span>}
      {s.label}
    </span>
  );
}

function ProjectTag({ name }) {
  const p = SM_PROJECTS.find(x => x.label === name);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: SCH.mono, fontSize: 12, color: SCH.inkSoft }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: p ? p.dot : SCH.inkMute }} />
      {name}
    </span>
  );
}

// ── A job row that expands to a readable detail panel ───────────────
function JobRow({ job, open, onToggle }) {
  const running = job.state === 'running';
  return (
    <div style={{ borderTop: `1px solid ${SCH.rule}` }}>
      <button onClick={onToggle} style={{
        appearance: 'none', border: 0, cursor: 'pointer', width: '100%', textAlign: 'left',
        display: 'grid', gridTemplateColumns: '116px 1fr auto auto', alignItems: 'center', gap: 16,
        padding: '14px 18px', background: open ? SCH.paper : 'transparent', fontFamily: SCH.sans,
      }}>
        <SchBadge state={job.state} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 500, color: SCH.ink, lineHeight: 1.4, textWrap: 'pretty' }}>{job.title}</div>
          {job.note && <div style={{ fontSize: 12.5, color: job.state === 'failed' ? '#9a3b1f' : SCH.inkMute, marginTop: 3 }}>{job.note}</div>}
        </div>
        <ProjectTag name={job.project} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: SCH.mono, fontSize: 12, color: SCH.inkMute }}>
          {job.took}
          <span style={{ color: SCH.inkMute, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', display: 'inline-flex' }}>
            <SMIcon name="chevron" size={14} />
          </span>
        </span>
      </button>

      {running && !open && (
        <div style={{ height: 4, background: SCH.rule, margin: '0 18px 12px', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ width: `${job.pct * 100}%`, height: '100%', background: SCH.accent }} />
        </div>
      )}

      {open && (
        <div style={{ padding: '4px 18px 20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 20, background: SCH.paper }}>
          <DetailBlock label="Status">
            <DetailLine k="result" v={job.detail.exit} />
            <DetailLine k="state" v={SCH_STATE[job.state].label} />
          </DetailBlock>
          <DetailBlock label="Timing">
            <DetailLine k="started" v={job.detail.started} />
            <DetailLine k="finished" v={job.detail.finished} />
            <DetailLine k="duration" v={job.detail.duration} />
          </DetailBlock>
          <DetailBlock label="Location">
            <DetailLine k="group" v={job.detail.group} />
            <DetailLine k="cwd" v={job.detail.cwd} wrap />
          </DetailBlock>
          <DetailBlock label="Actions">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, alignItems: 'flex-start' }}>
              <SchTextBtn>view log</SchTextBtn>
              <SchTextBtn>reset to pending</SchTextBtn>
              {job.state === 'needs-review' && <SchTextBtn accent>approve & merge</SchTextBtn>}
            </div>
          </DetailBlock>
        </div>
      )}
    </div>
  );
}

function DetailBlock({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: SCH.inkMute, marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'grid', gap: 5 }}>{children}</div>
    </div>
  );
}
function DetailLine({ k, v, wrap }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontFamily: SCH.mono, fontSize: 12, lineHeight: 1.4 }}>
      <span style={{ color: SCH.inkMute, flexShrink: 0, width: 56 }}>{k}</span>
      <span style={{ color: SCH.ink, wordBreak: wrap ? 'break-all' : 'normal' }}>{v}</span>
    </div>
  );
}
function SchTextBtn({ children, accent }) {
  return (
    <button style={{
      appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', padding: 0,
      fontFamily: SCH.sans, fontSize: 13, fontWeight: 600, color: accent ? SCH.accent : SCH.inkSoft,
    }}>{children} →</button>
  );
}

// ── Policy bar (decoded) ────────────────────────────────────────────
function PolicyBar({ onFire }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
      background: SCH.panel, border: `1px solid ${SCH.edge}`, borderRadius: 12, padding: '12px 16px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, color: SCH.inkSoft }}>Start jobs</span>
        <select defaultValue={SCH_POLICY.when} style={{
          appearance: 'none', border: `1px solid ${SCH.edge}`, background: SCH.card, borderRadius: 8,
          padding: '6px 28px 6px 10px', fontFamily: SCH.sans, fontSize: 13, color: SCH.ink, fontWeight: 500,
        }}>
          <option>when available</option><option>only on reset</option><option>manually</option>
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, color: SCH.inkSoft }}>Up to</span>
        <input defaultValue={SCH_POLICY.parallel} style={{ width: 44, textAlign: 'center', border: `1px solid ${SCH.edge}`, background: SCH.card, borderRadius: 8, padding: '6px 4px', fontFamily: SCH.mono, fontSize: 13, color: SCH.ink }} />
        <span style={{ fontSize: 13, color: SCH.inkSoft }}>at once</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, color: SCH.inkSoft }}>Pause above</span>
        <input defaultValue={SCH_POLICY.utilCap} style={{ width: 44, textAlign: 'center', border: `1px solid ${SCH.edge}`, background: SCH.card, borderRadius: 8, padding: '6px 4px', fontFamily: SCH.mono, fontSize: 13, color: SCH.ink }} />
        <span style={{ fontSize: 13, color: SCH.inkSoft }}>% of window</span>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onFire} style={{ appearance: 'none', border: 0, cursor: 'pointer', background: SCH.accent, color: '#fff', borderRadius: 9, padding: '8px 16px', fontFamily: SCH.sans, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>Fire next batch</button>
        <button style={{ appearance: 'none', cursor: 'pointer', background: SCH.card, border: `1px solid ${SCH.edge}`, color: SCH.inkSoft, borderRadius: 9, padding: '8px 14px', fontFamily: SCH.sans, fontSize: 13, fontWeight: 500 }}>Refresh</button>
      </div>
    </div>
  );
}

// ── Views ───────────────────────────────────────────────────────────
function SchedulerQueue() {
  const [openId, setOpenId] = React.useState('j-19');
  const [filter, setFilter] = React.useState('All');
  const filters = ['All', 'Running', 'Pending', 'Completed', 'Needs review', 'Failed'];
  const norm = s => s.replace('-', ' ');
  const jobs = SCH_JOBS.filter(j => filter === 'All' || norm(j.state) === filter.toLowerCase());

  return (
    <div>
      <PolicyBar onFire={() => {}} />

      {/* filter chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
          <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: SCH.inkMute, display: 'inline-flex' }}><SMIcon name="search" size={15} /></span>
          <input placeholder="filter jobs…" style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${SCH.edge}`, background: SCH.card, borderRadius: 9, padding: '8px 12px 8px 34px', fontFamily: SCH.sans, fontSize: 13.5, color: SCH.ink, outline: 'none' }} />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {filters.map(f => {
            const on = f === filter;
            return (
              <button key={f} onClick={() => setFilter(f)} style={{
                appearance: 'none', cursor: 'pointer', borderRadius: 999, padding: '6px 13px',
                border: `1px solid ${on ? SCH.accent : SCH.edge}`,
                background: on ? SCH.accent : SCH.card, color: on ? '#fff' : SCH.inkSoft,
                fontFamily: SCH.sans, fontSize: 12.5, fontWeight: on ? 600 : 500,
              }}>{f}</button>
            );
          })}
        </div>
      </div>

      {/* job table */}
      <div style={{ background: SCH.card, border: `1px solid ${SCH.edge}`, borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', background: SCH.panel }}>
          <span style={{ fontFamily: SCH.serif, fontSize: 16, fontWeight: 600, color: SCH.ink }}>
            {jobs.length} job{jobs.length !== 1 ? 's' : ''}
          </span>
          <button style={{ appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', fontFamily: SCH.sans, fontSize: 12.5, color: SCH.inkSoft, fontWeight: 500 }}>Clear completed</button>
        </div>
        {jobs.map(j => (
          <JobRow key={j.id} job={j} open={openId === j.id} onToggle={() => setOpenId(openId === j.id ? null : j.id)} />
        ))}
      </div>
    </div>
  );
}

function SchedulerPRDs({ onRun }) {
  const statusTone = { running: ['#fbe6c8', '#7a5713', 'running'], queued: ['#dde7c8', '#3f5226', 'queued'], ready: [SCH.paper, SCH.inkSoft, 'ready to run'], draft: [SCH.paper, SCH.inkMute, 'draft'] };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: 14, color: SCH.inkSoft, maxWidth: 560, lineHeight: 1.5 }}>
          PRDs are the source the scheduler runs from. Each one becomes a <span style={{ fontFamily: SCH.mono, fontSize: 13 }}>claude -p</span> job when you queue it.
        </p>
        <button style={{ appearance: 'none', border: 0, cursor: 'pointer', background: SCH.accent, color: '#fff', borderRadius: 9, padding: '9px 16px', fontFamily: SCH.sans, fontSize: 13.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <SMIcon name="plus" size={15} /> New PRD
        </button>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        {SCH_PRDS.map(prd => {
          const [bg, fg, label] = statusTone[prd.status];
          return (
            <div key={prd.id} style={{ background: SCH.card, border: `1px solid ${SCH.edge}`, borderRadius: 13, padding: '16px 18px', display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: SCH.serif, fontSize: 18, fontWeight: 600, color: SCH.ink }}>{prd.title}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 9px', borderRadius: 999, background: bg, color: fg, boxShadow: prd.status === 'ready' || prd.status === 'draft' ? `inset 0 0 0 1px ${SCH.edge}` : 'none' }}>{label}</span>
                </div>
                <p style={{ margin: '0 0 9px', fontSize: 13.5, color: SCH.inkSoft, lineHeight: 1.5, maxWidth: 640 }}>{prd.summary}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontFamily: SCH.mono, fontSize: 12, color: SCH.inkMute }}>
                  <ProjectTag name={prd.project} />
                  <span>{prd.steps} steps</span>
                  <span>{prd.est}</span>
                  <span>{prd.updated}</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
                <button onClick={onRun} style={{ appearance: 'none', border: 0, cursor: 'pointer', background: prd.status === 'draft' ? SCH.panel : SCH.ink, color: prd.status === 'draft' ? SCH.inkMute : SCH.paper, borderRadius: 9, padding: '8px 18px', fontFamily: SCH.sans, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {prd.status === 'running' ? 'View run' : 'Queue job'}
                </button>
                <button style={{ appearance: 'none', cursor: 'pointer', background: 'transparent', border: `1px solid ${SCH.edge}`, color: SCH.inkSoft, borderRadius: 9, padding: '8px 18px', fontFamily: SCH.sans, fontSize: 13, fontWeight: 500 }}>Edit</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SchedulerPage({ project }) {
  const [tab, setTab] = React.useState('queue');
  const tabs = [
    { id: 'queue', label: 'Queue' },
    { id: 'prds',  label: 'PRDs' },
    { id: 'history', label: 'History' },
  ];

  return (
    <div style={{ padding: '28px 36px 40px', fontFamily: SCH.sans, color: SCH.ink, maxWidth: 1100, margin: '0 auto' }}>
      {/* header */}
      <div style={{ fontSize: 12, fontWeight: 700, color: SCH.inkMute, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 4 }}>Workspace</div>
      <h1 style={{ margin: 0, fontFamily: SCH.serif, fontSize: 40, fontWeight: 600, lineHeight: 1, letterSpacing: -0.5, color: SCH.ink }}>Scheduler</h1>
      <p style={{ margin: '8px 0 0', fontSize: 14.5, color: SCH.inkSoft, lineHeight: 1.5, maxWidth: 600 }}>
        Author PRDs and run them as <span style={{ fontFamily: SCH.mono, fontSize: 13.5 }}>claude -p</span> jobs against your 5-hour window. Jobs auto-pause on rate-limit and resume on the next reset.
      </p>

      {/* window status strip — the cryptic line, decoded */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap',
        background: SCH.card, border: `1px solid ${SCH.edge}`, borderRadius: 12, padding: '12px 18px', margin: '18px 0 22px',
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: SCH.ink, fontWeight: 600, whiteSpace: 'nowrap' }}>
          <span style={{ color: SCH.sage, display: 'inline-flex' }}><SMIcon name="clock" size={15} /></span>
          Window resets in {SCH_WINDOW.resetsIn}
        </span>
        <span style={{ width: 1, height: 18, background: SCH.rule }} />
        <Legend dot={SCH.inkMute} n={SCH_WINDOW.pending} label="pending" />
        <Legend dot={SCH.accent} n={SCH_WINDOW.running} label="running" />
        <Legend dot={SCH.sage} n={SCH_WINDOW.done} label="completed today" />
        <span style={{ marginLeft: 'auto', fontFamily: SCH.mono, fontSize: 12.5, color: SCH.inkMute }}>last batch {SCH_WINDOW.lastRun}</span>
      </div>

      {/* sub-tabs */}
      <div style={{ display: 'flex', gap: 4, background: SCH.panel, padding: 4, borderRadius: 12, boxShadow: `inset 0 0 0 1px ${SCH.edge}`, width: 'fit-content', marginBottom: 22 }}>
        {tabs.map(t => {
          const on = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              appearance: 'none', border: 0, cursor: 'pointer', padding: '7px 18px', borderRadius: 9,
              background: on ? SCH.card : 'transparent', boxShadow: on ? `inset 0 0 0 1px ${SCH.edge}` : 'none',
              fontFamily: SCH.sans, fontSize: 13.5, fontWeight: on ? 600 : 500, color: on ? SCH.ink : SCH.inkSoft,
            }}>{t.label}</button>
          );
        })}
      </div>

      {tab === 'queue' && <SchedulerQueue />}
      {tab === 'prds' && <SchedulerPRDs onRun={() => setTab('queue')} />}
      {tab === 'history' && <SchedulerQueue />}
    </div>
  );
}

function Legend({ dot, n, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: SCH.inkSoft }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
      <strong style={{ color: SCH.ink, fontFamily: SCH.mono, fontSize: 13.5 }}>{n}</strong> {label}
    </span>
  );
}

window.SchedulerPage = SchedulerPage;
