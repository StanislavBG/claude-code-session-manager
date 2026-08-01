// DECODED MOCK — claude.ai/design project 0ca33cd3-c2fa-4644-b728-bde42292abbd,
// file variants/project-home.jsx (etag 1785531705952422). Reference only.
//
// Project Home — the LLM-maintained project brief.
// Everything here is synthesized by a background session from CLAUDE.md, the
// Epic archive, and the user's own scope corrections. Each block carries its
// provenance and can be pinned (human-authored, never regenerated).

const PH = window.ALMANAC;

const PH_BRIEF = {
  project: 'session-manager',
  path: '/home/bilko/Projects/session-manager',
  branch: '⎇ main',
  version: 'v0.39.4',
  purpose: 'A local cockpit for Claude Code — one desktop app that owns the CLI, the session pool, and the work queue.',
  synthesized: '12 minutes ago',
  model: 'Sonnet 4.7',
  sources: [
    { label: 'CLAUDE.md', detail: '84 lines · changed 2h ago', drift: true },
    { label: '6 Epics', detail: '3 open · 1 needs you' },
    { label: '34 sessions', detail: 'last 14 days' },
    { label: 'git log', detail: '128 commits' },
  ],
  what: [
    'Session-Manager wraps the Claude Code CLI in a desktop shell so that everything the CLI can do — skills, hooks, MCP servers, scheduled headless jobs — has a place to live and a state you can see. It runs entirely on the local machine; nothing phones home.',
    'The organising unit is the **Tab**: one tab is one project on disk. Inside a project, work is broken into **Epics** — small goal-scoped threads, each with its own conversation, PRDs, and agent runs. An accepted PRD becomes a headless `claude -p` job that the **Scheduler** executes when a session slot frees up.',
    'The machine holds a single pool of **3 concurrent sessions**. Chat runs and scheduler jobs both request a slot before launching, and a memory gate defers work when free RAM drops — that is what stops a burst of parallel jobs from taking the app down.',
  ],
  areas: [
    { name: 'session pool', files: 14, note: 'slot allocation, memory gate, restart recovery', epic: 'Restart recovery', heat: 0.9 },
    { name: 'epics + PRDs', files: 22, note: 'epic store, thread schema, PRD lifecycle', epic: 'Contextual chat per Epic', heat: 1 },
    { name: 'scheduler', files: 11, note: 'headless job queue, sqlite persistence', epic: 'Scheduler drops jobs after restart', heat: 0.55 },
    { name: 'usage + cost', files: 7, note: 'token accounting, 5-hour window, analytics', epic: 'Usage analytics dashboard', heat: 0.7 },
    { name: 'document view', files: 9, note: 'editor, voice edit, inline diff review', epic: 'Voice edit in document view', heat: 0.45 },
    { name: 'shell + nav', files: 18, note: 'tabs, nav rail, settings surfaces', epic: null, heat: 0.3 },
  ],
  scope: [
    { when: 'today', kind: 'narrowed', text: 'Budget management removed from the usage dashboard — it tracks consumption only, no caps or run-rate.', src: 'your correction' },
    { when: '2 days ago', kind: 'added', text: 'Agent conversation moved inside each Epic; the global chat pane and right-hand session rail are being retired.', src: 'Epic · Contextual chat per Epic' },
    { when: '5 days ago', kind: 'added', text: 'History tab replaced by a faceted usage dashboard, token-led rather than spend-led.', src: 'Epic · Usage analytics dashboard' },
    { when: '1 week ago', kind: 'added', text: 'Voice edit added to the document view — selection-anchored, with a transcript confirmation step before the model is called.', src: 'CLAUDE.md' },
    { when: '2 weeks ago', kind: 'decided', text: 'Queue state persists to sqlite on enqueue; in-memory-only queues are no longer acceptable.', src: 'postmortem.md' },
  ],
  conventions: [
    'Never ship a feature that phones home — everything stays on the local machine.',
    'Aggregate metadata only: transcript text never leaves disk.',
    'Every scheduled job must survive a host restart.',
    'One goal per Epic; tags belong to the Epic, not to individual prompts.',
    'Health-check and version-bump before any npm publish.',
  ],
  questions: [
    { q: 'Once the right rail is gone, where do session status and the 5-hour window live — the Home tab only, or a persistent status bar?', from: 'Epic · Retire the session rail everywhere' },
    { q: 'All-time usage needs 360 days of aggregates but the local archive holds 214. Cap at archive depth, or extrapolate?', from: 'Epic · Usage analytics dashboard' },
  ],
  now: [
    { title: 'Contextual chat per Epic', status: 'running', note: 'threading epic_id through the composer' },
    { title: 'Usage analytics dashboard', status: 'needs', note: 'waiting on the archive-depth decision' },
    { title: 'Voice edit in document view', status: 'queued', note: 'ready to run when a slot frees' },
  ],
};

const PH_ST = { running: ['#8a4a1e', '#f4dfc8', '#b85c34'], needs: ['#8a2f2f', '#f2d8d0', '#a3441f'], queued: ['#6b5c40', '#ece0c6', '#a89670'] };
const PH_SCOPE_TINT = { added: '#566b34', narrowed: '#a3441f', decided: '#8a6a2f' };

function PhMd({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return <>{parts.map((p, i) =>
    p.startsWith('**') ? <strong key={i} style={{ fontWeight: 650, color: PH.ink }}>{p.slice(2, -2)}</strong>
    : p.startsWith('`') ? <code key={i} style={{ fontFamily: PH.mono, fontSize: '0.92em', background: PH.panel, border: `1px solid ${PH.rule}`, borderRadius: 5, padding: '1px 5px' }}>{p.slice(1, -1)}</code>
    : <React.Fragment key={i}>{p}</React.Fragment>)}</>;
}

function PhBlock({ kicker, title, note, right, children, pinned, onPin, id }) {
  return <section id={id} style={{ marginBottom: 30 }}>
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginBottom: 13 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5 }}>
          <span style={{ fontFamily: PH.mono, fontSize: 10, fontWeight: 600, letterSpacing: 1.1, textTransform: 'uppercase', color: PH.accent }}>{kicker}</span>
          {onPin && <button onClick={onPin} title={pinned ? 'Pinned — refreshes will not overwrite this' : 'Pin so refreshes leave it alone'} style={{
            appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', padding: 0, display: 'inline-flex',
            color: pinned ? PH.accent : PH.inkMute, opacity: pinned ? 1 : 0.45,
          }}><SMIcon name="skills" size={12} /></button>}
        </div>
        <h2 style={{ margin: 0, fontFamily: PH.serif, fontSize: 21, fontWeight: 600, letterSpacing: -0.2, color: PH.ink, lineHeight: 1.15 }}>{title}</h2>
        {note && <p style={{ margin: '5px 0 0', fontSize: 12.5, color: PH.inkMute, lineHeight: 1.45 }}>{note}</p>}
      </div>
      {right && <span style={{ marginLeft: 'auto', paddingBottom: 2 }}>{right}</span>}
    </div>
    {children}
  </section>;
}

const phCard = { background: PH.card, border: `1px solid ${PH.edge}`, borderRadius: 13, minWidth: 0 };

// ── header: identity + provenance + refresh ──────────────────────────
function PhHeader({ b, refreshing, onRefresh }) {
  return <div style={{ ...phCard, padding: '20px 24px 18px', marginBottom: 14 }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: PH.mono, fontSize: 10, fontWeight: 600, letterSpacing: 1.1, textTransform: 'uppercase', color: PH.inkMute, marginBottom: 9 }}>The brief</div>
        <h1 style={{ margin: 0, fontFamily: PH.serif, fontSize: 30, fontWeight: 600, letterSpacing: -0.5, lineHeight: 1.15, color: PH.ink, maxWidth: 760, textWrap: 'pretty' }}>{b.purpose}</h1>
      </div>
      <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
        <button onClick={onRefresh} disabled={refreshing} style={{
          appearance: 'none', cursor: refreshing ? 'default' : 'pointer', border: 0, borderRadius: 10, padding: '8px 14px',
          background: refreshing ? '#e6d5be' : PH.accent, color: refreshing ? PH.inkSoft : '#fdf7ee',
          fontFamily: PH.sans, fontSize: 12.5, fontWeight: 650, display: 'inline-flex', alignItems: 'center', gap: 7,
        }}>
          <span style={{ display: 'inline-flex', animation: refreshing ? 'phspin 1.1s linear infinite' : 'none' }}><SMIcon name="reload" size={14} /></span>
          {refreshing ? 'Re-reading the project…' : 'Refresh brief'}
        </button>
        <div style={{ fontFamily: PH.mono, fontSize: 10.5, color: PH.inkMute, marginTop: 8, lineHeight: 1.5 }}>
          synthesized {b.synthesized}<br />by {b.model}
        </div>
      </div>
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${PH.rule}` }}>
      <span style={{ fontFamily: PH.mono, fontSize: 10, fontWeight: 600, letterSpacing: 0.9, textTransform: 'uppercase', color: PH.inkMute, alignSelf: 'center', marginRight: 3 }}>read from</span>
      {b.sources.map(s => <span key={s.label} style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, background: PH.paper, border: `1px solid ${s.drift ? '#dcb6a8' : PH.rule}`,
        borderRadius: 999, padding: '4px 11px',
      }}>
        <span style={{ fontFamily: PH.mono, fontSize: 11, fontWeight: 600, color: PH.inkSoft }}>{s.label}</span>
        <span style={{ fontSize: 11, color: PH.inkMute }}>{s.detail}</span>
        {s.drift && <span style={{ fontFamily: PH.mono, fontSize: 10, fontWeight: 600, color: '#a3441f' }}>newer than brief</span>}
      </span>)}
    </div>
  </div>;
}

// ── now: in-flight work, pulled from the Epic queue ──────────────────
function PhNow({ b }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 10 }}>
    {b.now.map(n => {
      const [fg, bg, dot] = PH_ST[n.status];
      return <div key={n.title} style={{ ...phCard, padding: '13px 15px 14px', display: 'grid', gap: 7 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 11, fontWeight: 600, justifySelf: 'start' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: dot }} />{n.status === 'needs' ? 'needs you' : n.status}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 650, color: PH.ink, lineHeight: 1.3 }}>{n.title}</span>
        <span style={{ fontSize: 12, color: PH.inkMute, lineHeight: 1.45 }}>{n.note}</span>
      </div>;
    })}
  </div>;
}

// ── structure map ────────────────────────────────────────────────────
function PhAreas({ b }) {
  return <div style={{ ...phCard, overflow: 'hidden' }}>
    {b.areas.map((a, i) => <div key={a.name} style={{
      display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1.15fr) 116px', gap: 18, alignItems: 'center',
      padding: '12px 16px', borderTop: i ? `1px solid ${PH.rule}` : 'none',
    }}>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span style={{ fontFamily: PH.mono, fontSize: 12.5, fontWeight: 600, color: PH.ink }}>{a.name}</span>
          <span style={{ fontFamily: PH.mono, fontSize: 11, color: PH.inkMute }}>{a.files} files</span>
        </span>
        <span style={{ display: 'block', fontSize: 12.5, color: PH.inkSoft, lineHeight: 1.45, marginTop: 3, textWrap: 'pretty' }}>{a.note}</span>
      </span>
      <span style={{ minWidth: 0, fontSize: 12, lineHeight: 1.4, color: a.epic ? PH.inkSoft : PH.inkMute }}>
        {a.epic
          ? <><span style={{ fontFamily: PH.mono, fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase', color: PH.inkMute, display: 'block', marginBottom: 2 }}>touched by</span>{a.epic}</>
          : <span style={{ fontFamily: PH.mono, fontSize: 11 }}>no open Epic</span>}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, height: 6, background: PH.paper, border: `1px solid ${PH.rule}`, borderRadius: 999, overflow: 'hidden' }}>
          <span style={{ display: 'block', width: `${a.heat * 100}%`, height: '100%', background: PH.accent, opacity: 0.7 }} />
        </span>
        <span style={{ fontFamily: PH.mono, fontSize: 10.5, color: PH.inkMute, width: 26, textAlign: 'right' }}>{Math.round(a.heat * 100)}</span>
      </span>
    </div>)}
  </div>;
}

// ── scope log ────────────────────────────────────────────────────────
function PhScope({ b }) {
  return <div style={{ display: 'grid', gap: 0 }}>
    {b.scope.map((s, i) => <div key={i} style={{
      display: 'grid', gridTemplateColumns: '92px 84px minmax(0,1fr)', gap: 14, alignItems: 'start',
      padding: '13px 2px', borderTop: `1px solid ${PH.rule}`,
    }}>
      <span style={{ fontFamily: PH.mono, fontSize: 11, color: PH.inkMute, paddingTop: 2 }}>{s.when}</span>
      <span style={{
        fontFamily: PH.mono, fontSize: 10, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase',
        color: PH_SCOPE_TINT[s.kind], border: `1px solid ${PH_SCOPE_TINT[s.kind]}44`, borderRadius: 5,
        padding: '2px 6px', justifySelf: 'start', marginTop: 1,
      }}>{s.kind}</span>
      <span>
        <span style={{ display: 'block', fontSize: 13.5, color: PH.ink, lineHeight: 1.5, textWrap: 'pretty' }}>{s.text}</span>
        <span style={{ display: 'block', fontFamily: PH.mono, fontSize: 10.5, color: PH.inkMute, marginTop: 4 }}>from {s.src}</span>
      </span>
    </div>)}
  </div>;
}

// ── page ─────────────────────────────────────────────────────────────
function ProjectHome() {
  const b = PH_BRIEF;
  const [refreshing, setRefreshing] = React.useState(false);
  const [pins, setPins] = React.useState(() => new Set(['conventions']));
  const pin = (k) => setPins(p => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const refresh = () => { setRefreshing(true); setTimeout(() => setRefreshing(false), 2600); };

  return <div style={{ height: '100%', overflowY: 'auto', background: PH.paper, fontFamily: PH.sans, color: PH.ink }}>
    <style>{'@keyframes phspin{to{transform:rotate(360deg)}}'}</style>
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '26px 34px 60px' }}>
      <PhHeader b={b} refreshing={refreshing} onRefresh={refresh} />

      {refreshing && <div style={{
        ...phCard, borderColor: '#e3c4b8', background: '#fbeee9', padding: '11px 15px', marginBottom: 14,
        display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: PH.inkSoft,
      }}>
        <span style={{ display: 'inline-flex', color: PH.accent }}><SMIcon name="sparkle" size={14} /></span>
        A headless session is re-reading CLAUDE.md, the Epic archive and recent commits. Pinned blocks are left untouched.
      </div>}

      <PhBlock kicker="now" title="What is in flight" note="Live from the Epic queue — this block is never hand-written.">
        <PhNow b={b} />
      </PhBlock>

      <PhBlock kicker="the project" title="What this is" pinned={pins.has('what')} onPin={() => pin('what')}
        note="Generated summary. Pin it once it reads right and refreshes will leave it alone.">
        <div style={{ ...phCard, padding: '18px 22px 20px', display: 'grid', gap: 13 }}>
          {b.what.map((p, i) => <p key={i} style={{ margin: 0, fontSize: 14, lineHeight: 1.62, color: PH.inkSoft, maxWidth: 780, textWrap: 'pretty' }}>
            <PhMd text={p} />
          </p>)}
        </div>
      </PhBlock>

      <PhBlock kicker="structure" title="How it is put together" note="Areas inferred from the tree and from which Epic has been editing them.">
        <PhAreas b={b} />
      </PhBlock>

      <PhBlock kicker="scope" title="How the goal has moved" note="Your corrections and CLAUDE.md changes, newest first — the reason the brief above says what it says.">
        <PhScope b={b} />
      </PhBlock>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr)', gap: 14 }}>
        <PhBlock kicker="rules" title="Conventions Claude follows" pinned={pins.has('conventions')} onPin={() => pin('conventions')}
          note="Mirrored from CLAUDE.md. Pinned, so a refresh cannot soften them.">
          <div style={{ ...phCard, padding: '14px 18px 16px', display: 'grid', gap: 10 }}>
            {b.conventions.map((c, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '16px minmax(0,1fr)', gap: 10, alignItems: 'start' }}>
              <span style={{ color: PH.sage, marginTop: 2, display: 'inline-flex' }}><SMIcon name="check" size={13} /></span>
              <span style={{ fontSize: 13, lineHeight: 1.5, color: PH.inkSoft, textWrap: 'pretty' }}>{c}</span>
            </div>)}
          </div>
        </PhBlock>

        <PhBlock kicker="open" title="Waiting on you" note="Questions the last synthesis could not resolve on its own.">
          <div style={{ display: 'grid', gap: 10 }}>
            {b.questions.map((q, i) => <div key={i} style={{ ...phCard, borderColor: '#e3c4b8', background: '#fbeee9', padding: '13px 16px 14px' }}>
              <div style={{ fontSize: 13, lineHeight: 1.55, color: PH.ink, textWrap: 'pretty' }}>{q.q}</div>
              <div style={{ marginTop: 10 }}>
                <div style={{ fontFamily: PH.mono, fontSize: 10.5, color: PH.inkMute, lineHeight: 1.45, marginBottom: 9 }}>{q.from}</div>
                <button style={{
                  appearance: 'none', cursor: 'pointer', border: `1px solid ${PH.edge}`, background: PH.card,
                  borderRadius: 8, padding: '5px 11px', fontFamily: PH.sans, fontSize: 12, fontWeight: 600, color: PH.inkSoft,
                  display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
                }}>Answer in Epic <SMIcon name="arrowright" size={12} /></button>
              </div>
            </div>)}
          </div>
        </PhBlock>
      </div>

      <div style={{ fontSize: 12, color: PH.inkMute, lineHeight: 1.55, maxWidth: 780, marginTop: 8 }}>
        The brief is regenerated by a headless session on demand and after every tenth Epic turn. Pinned blocks are treated as source of truth and are fed back into the next synthesis instead of being rewritten.
      </div>
    </div>
  </div>;
}

Object.assign(window, { PH_BRIEF, ProjectHome });
