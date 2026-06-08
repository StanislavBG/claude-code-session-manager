// Usage & limits — page. The in-app mirror of `claude /usage`.
// Rolling-window meters + a burn-rate projection + a collapsible
// session-topology view. Loads after variants/almanac.jsx (uses ALMANAC).

const U = window.ALMANAC;

// ── Status tones — calm, on-palette, high-contrast text ──────────────
// green (ok) → honey (caution, >=70%) → terracotta (alert, >=90%)
const U_TONES = {
  ok:      { bar: '#7f9159', track: '#e7ecdb', tint: '#edf1e3', text: '#566b34', dot: '#7f9159' },
  caution: { bar: '#d3a23c', track: '#f1e7cd', tint: '#f7eed5', text: '#9a6c12', dot: '#d3a23c' },
  alert:   { bar: '#c0552f', track: '#f0ddd2', tint: '#f6e4da', text: '#a3441f', dot: '#c0552f' },
};
function uTone(pct) {
  if (pct >= 0.9) return U_TONES.alert;
  if (pct >= 0.7) return U_TONES.caution;
  return U_TONES.ok;
}
const uPctLabel = (p) => `${Math.round(p * 100)}%`;

// ── Mock data, shaped like the real /usage payload ───────────────────
const USAGE_DATA = {
  plan:    { name: 'Max', code: 'default_claude_max_20x', updated: '38s ago', session: '9eb9e711', resetClock: '00:20:49' },
  meters: [
    { id: 'session',  label: 'Session', scope: '5-hour',     pct: 0.59, resetIn: '20m',     resetAt: '11:30 PM PT', sub: 'rolling 5-hour block' },
    { id: 'wk-all',   label: 'Weekly',  scope: 'all models', pct: 0.84, resetIn: '3d 10h',  resetAt: 'Thu 10:00 AM PT' },
    { id: 'wk-opus',  label: 'Weekly',  scope: 'Opus',       pct: 0.47, resetIn: '3d 10h',  resetAt: 'Thu 10:00 AM PT' },
    { id: 'wk-sonnet',label: 'Weekly',  scope: 'Sonnet',     pct: 0.12, resetIn: '3d 10h',  resetAt: 'Thu 10:00 AM PT' },
  ],
  extra:   { enabled: true, used: 12.40, cap: 50.00, cur: '$' },
  burn:    { current: 0.59, projected: 0.63, exhaustBy: null, elapsed: '4h 38m', windowLen: '5h', elapsedPct: 0.927 },
  topology: {
    activeSessions: 1, subagents: 0, combinedBurn: '87.6k', tokensToday: '557k',
    sessions: [
      { ws: 'session-manager', state: 'executing', turns: 439, avgTurn: '1.3k', tokPerMin: '87.6k', cache: 'warm', subagents: '—' },
    ],
    alerts: [
      { ws: 'session-manager', text: 'At turn 439 — context window about 78% full. Consider /compact before the next large read.' },
    ],
  },
};

// ────────────────────────────────────────────────────────────────────
// A single rolling-window meter
// ────────────────────────────────────────────────────────────────────
function UsageMeter({ m, big }) {
  const tone = uTone(m.pct);
  const over = m.pct > 1;
  const fill = Math.min(m.pct, 1) * 100;
  return (
    <div style={{ padding: big ? '18px 0' : '15px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: tone.dot, flexShrink: 0 }} />
          <span style={{ fontSize: big ? 16 : 15, fontWeight: 600, color: U.ink }}>{m.label}</span>
          <span style={{
            fontFamily: U.mono, fontSize: 11.5, color: U.inkMute,
            background: U.paper, border: `1px solid ${U.rule}`,
            padding: '1px 8px', borderRadius: 999, whiteSpace: 'nowrap',
          }}>{m.scope}</span>
        </div>
        <span style={{
          fontFamily: U.mono, fontSize: big ? 24 : 20, fontWeight: 600, lineHeight: 1,
          color: tone.text, letterSpacing: -0.4, flexShrink: 0,
        }}>{uPctLabel(m.pct)}</span>
      </div>

      {/* bar */}
      <div style={{ height: big ? 12 : 10, background: tone.track, borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ width: `${fill}%`, height: '100%', background: tone.bar, borderRadius: 999, transition: 'width .4s ease' }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 9, gap: 12 }}>
        <span style={{ fontSize: 12.5, color: U.inkSoft }}>
          resets in <strong style={{ color: U.ink, fontWeight: 600 }}>{m.resetIn}</strong>
          <span style={{ color: U.inkMute }}> · </span>
          <span style={{ fontFamily: U.mono, fontSize: 12, color: U.inkMute }}>{m.resetAt}</span>
        </span>
        {over && <span style={{ fontSize: 11.5, fontWeight: 600, color: U_TONES.alert.text }}>over limit</span>}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Burn-rate projection — clean light card (replaces the muddy banner)
// ────────────────────────────────────────────────────────────────────
function BurnRate({ b }) {
  const projTone = uTone(b.projected);
  const onTrack = b.projected <= 1;
  const cur = Math.min(b.current, 1) * 100;
  const projAdd = Math.max(0, Math.min(b.projected, 1) - Math.min(b.current, 1)) * 100;

  return (
    <div style={{
      background: U.card, border: `1px solid ${U.edge}`, borderRadius: 16,
      padding: '20px 24px', marginBottom: 18,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ color: U.sage, display: 'inline-flex' }}><SMIcon name="usage" size={17} /></span>
          <span style={{ fontFamily: U.serif, fontSize: 19, fontWeight: 600, color: U.ink }}>Burn rate</span>
          <span style={{ fontSize: 13, color: U.inkMute }}>· this 5-hour session</span>
        </div>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600,
          color: onTrack ? U_TONES.ok.text : U_TONES.alert.text,
          background: onTrack ? U_TONES.ok.tint : U_TONES.alert.tint,
          border: `1px solid ${onTrack ? '#d6e0c0' : '#ecd2c4'}`,
          padding: '5px 12px', borderRadius: 999,
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: onTrack ? U_TONES.ok.dot : U_TONES.alert.dot }} />
          {onTrack ? 'On track' : 'Trending over'}
        </span>
      </div>

      {/* three readouts */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 20 }}>
        <BurnStat label="Current" value={uPctLabel(b.current)} tone={U.ink} />
        <BurnStat label="Projected at reset" value={uPctLabel(b.projected)} tone={projTone.text} />
        <BurnStat label="Exhaust by" value={b.exhaustBy || '—'} tone={b.exhaustBy ? U_TONES.alert.text : U.inkMute}
          hint={b.exhaustBy ? 'estimated' : 'not on track to exhaust'} />
      </div>

      {/* trajectory bar: solid current + striped projected addition */}
      <div style={{ position: 'relative', height: 14, background: U_TONES.ok.track, borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${cur}%`, background: U_TONES.ok.bar, borderRadius: 999 }} />
        <div style={{
          position: 'absolute', left: `${cur}%`, top: 0, bottom: 0, width: `${projAdd}%`,
          background: `repeating-linear-gradient(45deg, ${U_TONES.ok.bar}, ${U_TONES.ok.bar} 4px, ${U_TONES.ok.tint} 4px, ${U_TONES.ok.tint} 8px)`,
          opacity: 0.85,
        }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 9 }}>
        <span style={{ fontSize: 12.5, color: U.inkSoft }}>
          elapsed <strong style={{ color: U.ink, fontWeight: 600 }}>{b.elapsed}</strong> of {b.windowLen}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14, fontSize: 12, color: U.inkMute }}>
          <Swatch c={U_TONES.ok.bar} label="used now" />
          <Swatch striped label="projected" />
        </span>
      </div>
    </div>
  );
}
function BurnStat({ label, value, tone, hint }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: U.inkMute, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: U.mono, fontSize: 30, fontWeight: 600, lineHeight: 1, color: tone, letterSpacing: -1 }}>{value}</div>
      {hint && <div style={{ fontSize: 11.5, color: U.inkMute, marginTop: 5 }}>{hint}</div>}
    </div>
  );
}
function Swatch({ c, striped, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 14, height: 9, borderRadius: 3,
        background: striped ? `repeating-linear-gradient(45deg, ${U_TONES.ok.bar}, ${U_TONES.ok.bar} 3px, ${U_TONES.ok.tint} 3px, ${U_TONES.ok.tint} 6px)` : c,
      }} />
      {label}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────
// Extra-usage row (pay-as-you-go) — only when enabled
// ────────────────────────────────────────────────────────────────────
function ExtraUsage({ e }) {
  const pct = e.used / e.cap;
  const tone = uTone(pct);
  return (
    <div style={{ padding: '15px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: tone.dot }} />
          <span style={{ fontSize: 15, fontWeight: 600, color: U.ink }}>Extra usage</span>
          <span style={{
            fontFamily: U.mono, fontSize: 11.5, color: U.inkMute,
            background: U.paper, border: `1px solid ${U.rule}`, padding: '1px 8px', borderRadius: 999,
          }}>pay-as-you-go</span>
        </div>
        <span style={{ fontFamily: U.mono, fontSize: 16, fontWeight: 600, color: U.ink }}>
          {e.cur}{e.used.toFixed(2)} <span style={{ color: U.inkMute, fontWeight: 400 }}>/ {e.cur}{e.cap.toFixed(2)}</span>
        </span>
      </div>
      <div style={{ height: 10, background: tone.track, borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(pct, 1) * 100}%`, height: '100%', background: tone.bar, borderRadius: 999 }} />
      </div>
      <div style={{ marginTop: 9, fontSize: 12.5, color: U.inkSoft }}>
        monthly credit limit · resets <span style={{ fontFamily: U.mono, fontSize: 12, color: U.inkMute }}>1st of month</span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Session topology — collapsible secondary view
// ────────────────────────────────────────────────────────────────────
function Topology({ t }) {
  const [open, setOpen] = React.useState(true);
  return (
    <div style={{ marginTop: 24 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', padding: 0,
        display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14,
      }}>
        <span style={{ color: U.inkMute, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', display: 'inline-flex' }}>
          <SMIcon name="chevron" size={15} />
        </span>
        <span style={{ fontFamily: U.serif, fontSize: 19, fontWeight: 600, color: U.ink }}>Session topology</span>
        <span style={{ fontSize: 12.5, color: U.inkMute }}>· live across open tabs · not part of /usage</span>
      </button>

      {open && (
        <div style={{ background: U.card, border: `1px solid ${U.edge}`, borderRadius: 16, overflow: 'hidden' }}>
          {/* stat strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', borderBottom: `1px solid ${U.rule}` }}>
            <TopStat label="Active sessions" value={t.activeSessions} />
            <TopStat label="Subagents" value={`${t.subagents} total`} />
            <TopStat label="Combined burn" value={`${t.combinedBurn}/min`} mono />
            <TopStat label="Tokens today" value={t.tokensToday} mono last />
          </div>

          {/* active session matrix */}
          <div style={{ padding: '16px 22px 6px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: U.inkMute, marginBottom: 8 }}>Active sessions</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 110px repeat(4, 1fr)', gap: 12, padding: '6px 0', fontSize: 11.5, color: U.inkMute, fontWeight: 600, borderBottom: `1px solid ${U.rule}` }}>
              <span>workspace</span><span>state</span><span style={{ textAlign: 'right' }}>turns</span><span style={{ textAlign: 'right' }}>avg/turn</span><span style={{ textAlign: 'right' }}>tok/min</span><span style={{ textAlign: 'right' }}>cache</span>
            </div>
            {t.sessions.map((s, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.4fr 110px repeat(4, 1fr)', gap: 12, padding: '11px 0', alignItems: 'center', borderBottom: `1px solid ${U.rule}` }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 600, color: U.ink }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: U.sage }} />{s.ws}
                </span>
                <span>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600,
                    color: U_TONES.ok.text, background: U_TONES.ok.tint, border: '1px solid #d6e0c0',
                    padding: '3px 10px', borderRadius: 999,
                  }}>
                    <span className="hv-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: U.sage }} />
                    {s.state}
                  </span>
                </span>
                <span style={{ textAlign: 'right', fontFamily: U.mono, fontSize: 13, color: U.ink }}>{s.turns}</span>
                <span style={{ textAlign: 'right', fontFamily: U.mono, fontSize: 13, color: U.inkSoft }}>{s.avgTurn}</span>
                <span style={{ textAlign: 'right', fontFamily: U.mono, fontSize: 13, color: U.inkSoft }}>{s.tokPerMin}</span>
                <span style={{ textAlign: 'right', fontFamily: U.mono, fontSize: 13, color: U.inkMute }}>{s.cache}</span>
              </div>
            ))}
          </div>

          {/* behavioral alerts — now legible */}
          {t.alerts.length > 0 && (
            <div style={{ padding: '14px 22px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: U.inkMute, marginBottom: 10 }}>Behavioral alerts</div>
              {t.alerts.map((a, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 11,
                  background: U_TONES.caution.tint, border: '1px solid #ecdcb4',
                  borderRadius: 11, padding: '11px 14px',
                }}>
                  <span style={{
                    width: 20, height: 20, borderRadius: '50%', background: U_TONES.caution.bar, color: '#fff',
                    display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0, marginTop: 1,
                  }}>!</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: U.ink, marginBottom: 1 }}>{a.ws}</div>
                    <div style={{ fontSize: 13, color: U_TONES.caution.text, lineHeight: 1.45 }}>{a.text}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function TopStat({ label, value, mono, last }) {
  return (
    <div style={{ padding: '16px 22px', borderRight: last ? 'none' : `1px solid ${U.rule}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: U.inkMute, marginBottom: 7 }}>{label}</div>
      <div style={{ fontFamily: mono ? U.mono : U.sans, fontSize: 21, fontWeight: 600, color: U.ink, letterSpacing: mono ? -0.5 : 0 }}>{value}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────
function UsagePage({ project }) {
  const d = USAGE_DATA;
  return (
    <div style={{ padding: '28px 36px 44px', fontFamily: U.sans, color: U.ink, maxWidth: 880, margin: '0 auto' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: U.inkMute, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 4 }}>Workspace</div>
          <h1 style={{ margin: 0, fontFamily: U.serif, fontSize: 40, fontWeight: 600, lineHeight: 1, letterSpacing: -0.5, color: U.ink }}>Usage &amp; limits</h1>
        </div>
        <button style={{
          appearance: 'none', cursor: 'pointer', flexShrink: 0,
          border: `1px solid ${U.edge}`, background: U.card, color: U.ink,
          borderRadius: 9, padding: '8px 16px', fontFamily: U.sans, fontSize: 13, fontWeight: 600,
          display: 'inline-flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ color: U.sage, display: 'inline-flex' }}><SMIcon name="history" size={14} /></span>
          Refresh
        </button>
      </div>
      <p style={{ margin: '10px 0 0', fontSize: 14.5, color: U.inkSoft, lineHeight: 1.55, maxWidth: 600 }}>
        Your subscription's rolling-window limits — the same data as <span style={{ fontFamily: U.mono, fontSize: 13.5 }}>claude /usage</span>, pulled live from the billing API. Answers one question: <em style={{ fontStyle: 'italic', color: U.ink }}>am I about to hit a limit?</em>
      </p>

      {/* live status chip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '18px 0 20px', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: U.inkSoft }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: U.sage }} />
          <strong style={{ color: U.ink, fontWeight: 600 }}>{d.plan.name}</strong> plan
          <span style={{ fontFamily: U.mono, fontSize: 12, color: U.inkMute }}>{d.plan.code}</span>
        </span>
        <span style={{ width: 1, height: 16, background: U.rule }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: U.inkMute, fontFamily: U.mono }}>
          session {d.plan.session}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: U.inkMute }}>
          updated <span style={{ fontFamily: U.mono, fontSize: 12 }}>{d.plan.updated}</span>
        </span>
      </div>

      <BurnRate b={d.burn} />

      {/* meters card */}
      <div style={{ background: U.card, border: `1px solid ${U.edge}`, borderRadius: 16, padding: '6px 24px 18px' }}>
        {d.meters.map((m, i) => (
          <div key={m.id} style={{ borderTop: i ? `1px solid ${U.rule}` : 'none' }}>
            <UsageMeter m={m} big={m.id === 'session'} />
          </div>
        ))}
        {d.extra.enabled && (
          <div style={{ borderTop: `1px solid ${U.rule}` }}>
            <ExtraUsage e={d.extra} />
          </div>
        )}
      </div>

      {/* tip line */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 14,
        fontSize: 12.5, color: U.inkMute, lineHeight: 1.5, maxWidth: 640,
      }}>
        <span style={{ color: U.inkMute, display: 'inline-flex', marginTop: 1 }}><SMIcon name="sparkle" size={14} /></span>
        Percentages can read over 100% — the API reports raw utilization, so the bar caps at full while the number shows the truth in red.
      </div>

      <Topology t={d.topology} />
    </div>
  );
}

window.UsagePage = UsagePage;
