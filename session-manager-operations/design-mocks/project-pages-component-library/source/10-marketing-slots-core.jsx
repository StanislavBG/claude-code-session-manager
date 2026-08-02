// Marketing Landing Page — slot variants.
// Slots: hero · proof · pillars · voice · close

const M = { pad: '72px 80px' };

// ── HERO ───────────────────────────────────────────────────
function MHeroEditorial() {
  return <PkSection pad="96px 80px 72px">
    <div style={{ maxWidth: 820 }}>
      <PkEyebrow>{PROJ.tag} · {PROJ.version}</PkEyebrow>
      <h1 style={{ margin: '20px 0 0', fontFamily: PK.serif, fontWeight: 400, fontSize: 68, lineHeight: 1.02, letterSpacing: '-0.028em', color: PK.ink, textWrap: 'balance' }}>{PROJ.claim}</h1>
      <PkBody size={18} style={{ marginTop: 24, maxWidth: 620 }}>{PROJ.sub}</PkBody>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 34 }}>
        <PkBtn primary>Download for macOS</PkBtn><PkCmd>{PROJ.install}</PkCmd>
      </div>
    </div>
  </PkSection>;
}
function MHeroSplit() {
  return <PkSection pad="72px 80px" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 56, alignItems: 'center' }}>
    <div>
      <PkEyebrow>{PROJ.audience}</PkEyebrow>
      <h1 style={{ margin: '16px 0 0', fontFamily: PK.serif, fontWeight: 400, fontSize: 52, lineHeight: 1.06, letterSpacing: '-0.022em', color: PK.ink }}>{PROJ.claim}</h1>
      <PkBody style={{ marginTop: 18 }}>{PROJ.sub}</PkBody>
      <div style={{ display: 'flex', gap: 10, marginTop: 28 }}><PkBtn primary>Get the app</PkBtn><PkBtn>Read the docs</PkBtn></div>
    </div>
    <PkShot h={340} label="app screenshot" />
  </PkSection>;
}
function MHeroCentered() {
  return <PkSection pad="104px 80px 84px" style={{ textAlign: 'center', background: PK.panel, borderBottom: `1px solid ${PK.rule}` }}>
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'grid', gap: 22, justifyItems: 'center' }}>
      <PkPill bg={PK.card}><PkDot />{PROJ.version} · local-first, no account</PkPill>
      <h1 style={{ margin: 0, fontFamily: PK.serif, fontWeight: 400, fontSize: 60, lineHeight: 1.05, letterSpacing: '-0.025em', color: PK.ink, textWrap: 'balance' }}>{PROJ.claim}</h1>
      <PkBody size={17} style={{ maxWidth: 560 }}>{PROJ.oneLine} {PROJ.sub}</PkBody>
      <PkCmd wide>{PROJ.install}</PkCmd>
    </div>
  </PkSection>;
}
function MHeroTerminal() {
  return <PkSection pad="0" style={{ background: PK.deep, color: PK.paper }}>
    <div style={{ padding: '84px 80px', display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 60, alignItems: 'center' }}>
      <div>
        <PkEyebrow tone={PK.butter}>{PROJ.tag}</PkEyebrow>
        <h1 style={{ margin: '18px 0 0', fontFamily: PK.serif, fontWeight: 400, fontSize: 56, lineHeight: 1.04, letterSpacing: '-0.024em', color: PK.paper }}>{PROJ.claim}</h1>
        <PkBody style={{ marginTop: 18, color: '#c9bda8' }}>{PROJ.sub}</PkBody>
        <div style={{ marginTop: 30, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button style={{ appearance: 'none', cursor: 'pointer', background: PK.butter, color: PK.deep, border: 0, borderRadius: 9, padding: '11px 20px', fontFamily: PK.sans, fontWeight: 600, fontSize: 14 }}>Download</button>
          <span style={{ fontFamily: PK.mono, fontSize: 13, color: '#a2947c' }}>{PROJ.install}</span>
        </div>
      </div>
      <div style={{ background: '#211a14', border: '1px solid #3b3025', borderRadius: 12, padding: 20, fontFamily: PK.mono, fontSize: 12.5, lineHeight: 1.9, color: '#d8cbb4' }}>
        {[['$ ', 'session-manager open .'], ['→ ', 'pool 1/3 · window 2h 41m left'], ['✓ ', 'epic "scheduler drain" approved'], ['⟳ ', 'claude -p running · 4m12s'], ['✓ ', '3 files changed · tests green']].map(([p, l], i) =>
          <div key={i}><span style={{ color: i === 0 ? PK.butter : PK.sage }}>{p}</span>{l}</div>)}
      </div>
    </div>
  </PkSection>;
}

// ── PROOF ──────────────────────────────────────────────────
function MProofStats() {
  return <PkSection pad="0" style={{ borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)' }}>
      {PROJ.stats.map((s, i) => <div key={i} style={{ padding: '30px 32px', borderLeft: i ? `1px solid ${PK.rule}` : 'none' }}>
        <div style={{ fontFamily: PK.serif, fontSize: 40, lineHeight: 1, color: PK.ink }}>{s.v}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 13.5, fontWeight: 600, color: PK.ink, marginTop: 8 }}>{s.k}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 12.5, color: PK.inkMute, marginTop: 3 }}>{s.n}</div>
      </div>)}
    </div>
  </PkSection>;
}
function MProofTicker() {
  const items = ['local-first', 'no telemetry', 'sqlite-backed queue', 'Electron + React', 'MCP native', 'skills & hooks', 'headless claude -p', 'restart-safe'];
  return <div style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}`, padding: '16px 80px', display: 'flex', flexWrap: 'wrap', gap: '10px 12px' }}>
    {items.map(t => <PkPill key={t} bg={PK.card}>{t}</PkPill>)}
  </div>;
}
function MProofQuote() {
  const q = PROJ.quotes[0];
  return <PkSection pad="56px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <blockquote style={{ margin: 0, maxWidth: 760 }}>
      <p style={{ margin: 0, fontFamily: PK.serif, fontSize: 30, lineHeight: 1.32, color: PK.ink, letterSpacing: '-0.012em' }}>“{q.q}”</p>
      <footer style={{ marginTop: 16, fontFamily: PK.sans, fontSize: 13.5, color: PK.inkMute }}>{q.a} — {q.r}</footer>
    </blockquote>
  </PkSection>;
}
function MProofLedger() {
  return <PkSection pad="36px 80px" style={{ borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px 48px', alignItems: 'baseline' }}>
      {PROJ.stats.map((s, i) => <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span style={{ fontFamily: PK.mono, fontSize: 22, color: PK.accent }}>{s.v}</span>
        <span style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.inkSoft }}>{s.k}</span>
      </div>)}
    </div>
  </PkSection>;
}

// ── PILLARS ────────────────────────────────────────────────
function MPillarsCards() {
  return <PkSection pad={M.pad}>
    <PkEyebrow>What you get</PkEyebrow>
    <PkH style={{ marginTop: 14, maxWidth: 620 }}>Four things it does that a terminal cannot.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 20, marginTop: 40 }}>
      {PROJ.pillars.map((p, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 14, padding: 26 }}>
        <PkEyebrow tone={PK.inkMute}>{p.k}</PkEyebrow>
        <div style={{ fontFamily: PK.serif, fontSize: 24, color: PK.ink, marginTop: 10 }}>{p.t}</div>
        <PkBody size={15} style={{ marginTop: 10 }}>{p.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function MPillarsAlternating() {
  return <PkSection pad="56px 80px" style={{ display: 'grid', gap: 8 }}>
    {PROJ.pillars.map((p, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: i % 2 ? '1fr 0.9fr' : '0.9fr 1fr', gap: 48, alignItems: 'center', padding: '28px 0', borderTop: `1px solid ${PK.rule}` }}>
      <div style={{ order: i % 2 ? 2 : 1 }}>
        <PkEyebrow>{String(i + 1).padStart(2, '0')} · {p.k}</PkEyebrow>
        <PkH size={30} style={{ marginTop: 12 }}>{p.t}</PkH>
        <PkBody style={{ marginTop: 12, maxWidth: 480 }}>{p.d}</PkBody>
      </div>
      <PkShot h={180} label={`${p.k.toLowerCase()} view`} style={{ order: i % 2 ? 1 : 2 }} />
    </div>)}
  </PkSection>;
}
function MPillarsList() {
  return <PkSection pad={M.pad}>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px,260px) minmax(0,1fr)', gap: 'clamp(24px,4vw,56px)' }}>
      <div>
        <PkEyebrow>Capabilities</PkEyebrow>
        <PkH size={32} style={{ marginTop: 14 }}>Built around how the work actually flows.</PkH>
      </div>
      <div>
        {PROJ.pillars.map((p, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(110px,150px) minmax(0,1fr)', gap: 'clamp(16px,2vw,28px)', padding: '22px 0', borderTop: `1px solid ${PK.rule}` }}>
          <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink }}>{p.t}</div>
          <PkBody size={15}>{p.d}</PkBody>
        </div>)}
      </div>
    </div>
  </PkSection>;
}
function MPillarsShowcase() {
  return <PkSection pad={M.pad} style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkH style={{ maxWidth: 560 }}>One window, four jobs.</PkH>
    <PkShot h={300} label="primary product shot" style={{ marginTop: 32, background: PK.card, borderStyle: 'solid' }} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 18, marginTop: 26 }}>
      {PROJ.pillars.map((p, i) => <div key={i}>
        <div style={{ height: 2, background: i === 0 ? PK.accent : PK.rule, marginBottom: 12 }} />
        <div style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{p.t}</div>
        <PkBody size={13} style={{ marginTop: 6 }}>{p.d.split('.')[0]}.</PkBody>
      </div>)}
    </div>
  </PkSection>;
}

// ── CLOSE ──────────────────────────────────────────────────
function MCloseInstall() {
  return <PkSection pad="72px 80px" style={{ background: PK.deep, textAlign: 'center' }}>
    <PkH size={38} style={{ color: PK.paper }}>Install it in one line.</PkH>
    <div style={{ marginTop: 22, display: 'flex', justifyContent: 'center' }}>
      <code style={{ fontFamily: PK.mono, fontSize: 15, color: PK.butter, border: '1px solid #4a3d2e', borderRadius: 10, padding: '14px 24px' }}>{PROJ.install}</code>
    </div>
    <PkBody size={13.5} style={{ marginTop: 18, color: '#a2947c' }}>macOS & Linux · requires the Claude Code CLI</PkBody>
  </PkSection>;
}
function MCloseSplit() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 40, flexWrap: 'wrap' }}>
    <div><PkH size={30}>Ready when you are.</PkH><PkBody style={{ marginTop: 8 }}>Free while in beta. No account, no cloud.</PkBody></div>
    <div style={{ display: 'flex', gap: 10 }}><PkBtn primary>Download</PkBtn><PkBtn>View on GitHub</PkBtn></div>
  </PkSection>;
}
function MCloseQuiet() {
  return <PkSection pad="48px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 40, alignItems: 'end' }}>
      <div><PkEyebrow>Get started</PkEyebrow><PkBody size={15} style={{ marginTop: 10, maxWidth: 460 }}>Point it at a folder on disk and it takes over from there. Everything stays local.</PkBody></div>
      <PkCmd>{PROJ.install}</PkCmd>
    </div>
  </PkSection>;
}

window.PAGE_MARKETING = {
  id: 'marketing', label: 'Marketing Landing', blurb: 'Positions the project to someone who has never seen it.',
  slots: [
    { id: 'hero', label: 'Hero', variants: [
      { id: 'editorial', label: 'Editorial statement', note: 'Serif claim, wide measure. Best when the idea sells itself.', C: MHeroEditorial },
      { id: 'split', label: 'Split with shot', note: 'Claim left, product image right. Needs a strong screenshot.', C: MHeroSplit },
      { id: 'centered', label: 'Centered + install', note: 'Symmetrical, CLI-forward. Good for dev tools.', C: MHeroCentered },
      { id: 'terminal', label: 'Dark terminal', note: 'Inverted panel with a live session transcript.', C: MHeroTerminal },
    ] },
    { id: 'proof', label: 'Proof strip', variants: [
      { id: 'stats', label: 'Four-up stat band', note: 'Ruled cells. Use when numbers are concrete.', C: MProofStats },
      { id: 'ticker', label: 'Attribute chips', note: 'Low-commitment; works with no metrics at all.', C: MProofTicker },
      { id: 'quote', label: 'Pull quote', note: 'A single voice. Needs a real quote.', C: MProofQuote },
      { id: 'ledger', label: 'Inline ledger', note: 'Compact one-liner of figures.', C: MProofLedger },
    ] },
    { id: 'pillars', label: 'Capability block', variants: [
      { id: 'cards', label: '2×2 cards', note: 'Even weight across four ideas.', C: MPillarsCards },
      { id: 'alt', label: 'Alternating rows', note: 'Each capability gets an image. Longest option.', C: MPillarsAlternating },
      { id: 'list', label: 'Definition list', note: 'Dense, text-only. Best for technical readers.', C: MPillarsList },
      { id: 'showcase', label: 'Hero shot + legend', note: 'One big image, four captions beneath.', C: MPillarsShowcase },
    ] },
    { id: 'close', label: 'Closing CTA', variants: [
      { id: 'install', label: 'Dark install band', note: 'Ends on the command.', C: MCloseInstall },
      { id: 'split', label: 'Split CTA', note: 'Statement left, buttons right.', C: MCloseSplit },
      { id: 'quiet', label: 'Quiet footer note', note: 'Understated; for tools that avoid a hard sell.', C: MCloseQuiet },
    ] },
  ],
  presets: [
    { id: 'v1', label: 'Editorial', note: 'Type-led, image-light. Safest for an unknown project.', pick: { hero: 'editorial', proof: 'stats', pillars: 'cards', close: 'install' } },
    { id: 'v2', label: 'Product-led', note: 'Screenshots carry the argument.', pick: { hero: 'split', proof: 'quote', pillars: 'alt', close: 'split' } },
    { id: 'v3', label: 'Developer', note: 'CLI-forward, dense, no marketing gloss.', pick: { hero: 'terminal', proof: 'ticker', pillars: 'list', close: 'quiet' } },
  ],
};
