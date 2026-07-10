// ─────────────────────────────────────────────────────────────────────────────
// LOCKED DESIGN — Browser tab · imported from claude.ai/design project
// "Session Manager" (0ca33cd3-c2fa-4644-b728-bde42292abbd), file variants/browser.jsx
// Imported 2026-07-09 via claude_design MCP. This is the SoT for the Browser tab
// visual + interaction spec. It is a design mock (uses window.ALMANAC tokens + a
// fake in-page pricing site); real impl swaps FakePricingPage for an Electron
// WebContentsView and the mock state for real IPC. Do NOT edit to "improve" — it
// is the contract the PRDs are cut against.
//
// ALMANAC token set (from variants/almanac.jsx) — the warm-paper chrome palette:
//   paper #f6efe1 · panel #efe6d3 · card #fbf6ec · edge #e0d3b8 · rule #d9c9a8
//   ink #2a221a · inkSoft #5b4a36 · inkMute #8a7a60
//   accent #b85c34 (terracotta) · accentSoft #e8a988 · sage #6f7d52 · butter #e4b85a
//   serif 'Newsreader' · sans 'Geist' · mono 'IBM Plex Mono'
//   picker/active fill used throughout: #f7e4da (terracotta wash)
//   dark code-block: bg #2a2118, fg #e8ddc9, comment #a89a80
//
// WEB token set (the rendered external page uses its OWN cool language so it reads
// as someone else's content inside our warm chrome):
//   bg #ffffff · panel #f6f8fb · ink #0f172a · inkMute #64748b · edge #e2e8f0
//   accent #2f6df6 (blue) · sans 'Geist'
// ─────────────────────────────────────────────────────────────────────────────

const BR = window.ALMANAC;

// The rendered page uses its OWN visual language (cool, system-font, blue
// accent) so it reads as *external web content* inside our warm paper chrome —
// the whole point of the tab is that it's someone else's page, not ours.
const WEB = {
  bg:     '#ffffff',
  panel:  '#f6f8fb',
  ink:    '#0f172a',
  inkMute:'#64748b',
  edge:   '#e2e8f0',
  accent: '#2f6df6',
  sans:   "'Geist', system-ui, sans-serif",
};

// ── The fake external page: a pricing page (matches the spec's example) ──
// Each pickable node carries a selector so the picker can surface it.
const PLANS = [
  { name: 'Starter', price: '$0',  cadence: '/forever', sel: 'article.plan--starter', feat: ['1 project', 'Community support', '7-day history'], cta: 'Get started', primary: false },
  { name: 'Pro',     price: '$20', cadence: '/mo',      sel: 'article.plan--pro',     feat: ['Unlimited projects', 'Priority support', 'Full history', 'Custom domains'], cta: 'Buy', primary: true, testid: 'buy-pro' },
  { name: 'Team',    price: '$60', cadence: '/mo',      sel: 'article.plan--team',    feat: ['Everything in Pro', 'SSO & SAML', 'Audit log', 'Shared billing'], cta: 'Contact sales', primary: false },
];

function FakePricingPage({ picking, hovered, selected, onHover, onPick }) {
  // outline style for a pickable node
  const ring = (sel) => {
    if (!picking) return {};
    const isSel = selected.includes(sel);
    const isHov = hovered === sel;
    if (isSel) return { outline: `2px solid ${BR.accent}`, outlineOffset: 2, borderRadius: 8, position: 'relative' };
    if (isHov) return { outline: `2px dashed ${BR.accent}`, outlineOffset: 2, borderRadius: 8, position: 'relative' };
    return {};
  };
  const pick = (sel, label) => picking ? {
    onMouseEnter: () => onHover(sel),
    onMouseLeave: () => onHover(null),
    onClick: (e) => { e.stopPropagation(); onPick(sel, label); },
    style: { cursor: 'crosshair' },
  } : {};

  const Tag = ({ sel, label }) => (picking && hovered === sel) ? (
    <span style={{
      position: 'absolute', top: -22, left: -2, zIndex: 5,
      background: BR.accent, color: '#fff', fontFamily: BR.mono, fontSize: 10.5,
      padding: '2px 7px', borderRadius: 5, whiteSpace: 'nowrap', fontWeight: 600,
      boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
    }}>{label}</span>
  ) : null;

  return (
    <div style={{ minHeight: '100%', background: WEB.bg, fontFamily: WEB.sans, color: WEB.ink }}>
      {/* site nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '18px 40px', borderBottom: `1px solid ${WEB.edge}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontWeight: 700, fontSize: 17, letterSpacing: -0.3 }}>
          <span style={{ width: 22, height: 22, borderRadius: 6, background: WEB.accent, display: 'inline-block' }} />
          Northwind
        </div>
        <div style={{ display: 'flex', gap: 22, marginLeft: 8, fontSize: 14, color: WEB.inkMute }}>
          <span>Product</span><span>Docs</span><span style={{ color: WEB.ink, fontWeight: 600 }}>Pricing</span><span>Blog</span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center', fontSize: 14 }}>
          <span style={{ color: WEB.inkMute }}>Sign in</span>
          <span style={{ background: WEB.ink, color: '#fff', padding: '8px 16px', borderRadius: 8, fontWeight: 600 }}>Start free</span>
        </div>
      </div>

      {/* heading */}
      <div style={{ textAlign: 'center', padding: '48px 40px 8px' }}>
        <div style={{ position: 'relative', display: 'inline-block', ...ring('h1.pricing-title') }} {...pick('h1.pricing-title', 'h1.pricing-title')}>
          <Tag sel="h1.pricing-title" label="h1.pricing-title" />
          <h1 style={{ margin: 0, fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>Simple, honest pricing</h1>
        </div>
        <p style={{ margin: '14px auto 0', fontSize: 17, color: WEB.inkMute, maxWidth: 520, lineHeight: 1.5 }}>
          Start free, upgrade when you grow. No credit card required to begin.
        </p>
      </div>

      {/* plan cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 20, maxWidth: 940, margin: '32px auto', padding: '0 40px' }}>
        {PLANS.map(pl => (
          <div key={pl.name} {...pick(pl.sel, pl.sel)} style={{
            position: 'relative', background: pl.primary ? '#fff' : WEB.panel,
            border: pl.primary ? `2px solid ${WEB.accent}` : `1px solid ${WEB.edge}`,
            borderRadius: 16, padding: '26px 24px', display: 'flex', flexDirection: 'column', gap: 14,
            boxShadow: pl.primary ? '0 12px 30px -12px rgba(47,109,246,0.4)' : 'none',
            ...ring(pl.sel),
          }}>
            <Tag sel={pl.sel} label={pl.sel} />
            {pl.primary && <span style={{ position: 'absolute', top: -12, left: 24, background: WEB.accent, color: '#fff', fontSize: 11.5, fontWeight: 700, padding: '4px 10px', borderRadius: 999 }}>MOST POPULAR</span>}
            <div style={{ fontSize: 15, fontWeight: 600, color: WEB.inkMute }}>{pl.name}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
              <span style={{ fontSize: 38, fontWeight: 800, letterSpacing: -1 }}>{pl.price}</span>
              <span style={{ fontSize: 15, color: WEB.inkMute }}>{pl.cadence}</span>
            </div>
            <div style={{ position: 'relative', ...ring(`button.btn-${pl.primary ? 'primary' : 'ghost'}`) }}
              {...pick(`button.btn-${pl.primary ? 'primary' : 'ghost'}`, pl.testid ? `button[data-testid="${pl.testid}"]` : `button.btn-ghost`)}>
              <Tag sel={`button.btn-${pl.primary ? 'primary' : 'ghost'}`} label={pl.testid ? `button[data-testid="${pl.testid}"]` : 'button.btn-ghost'} />
              <button style={{
                width: '100%', appearance: 'none', border: pl.primary ? 'none' : `1px solid ${WEB.edge}`, cursor: 'inherit',
                background: pl.primary ? WEB.accent : '#fff', color: pl.primary ? '#fff' : WEB.ink,
                padding: '11px 0', borderRadius: 10, fontFamily: WEB.sans, fontSize: 14.5, fontWeight: 700,
              }}>{pl.cta}</button>
            </div>
            <div style={{ height: 1, background: WEB.edge, margin: '2px 0' }} />
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 9 }}>
              {pl.feat.map(f => (
                <li key={f} style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 13.5, color: WEB.ink }}>
                  <span style={{ color: WEB.accent, display: 'inline-flex' }}><SMIcon name="check" size={15} stroke={2.2} /></span>{f}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div style={{ textAlign: 'center', padding: '8px 40px 56px', fontSize: 13.5, color: WEB.inkMute }}>
        Prices in USD. Cancel anytime · <span style={{ color: WEB.accent }}>Compare all features →</span>
      </div>
    </div>
  );
}

// ── Sub-tab strip (browser tabs live INSIDE the Browser tab) ─────────
function SubTabStrip({ tabs, activeId, onSelect }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', gap: 2, padding: '6px 12px 0', flexShrink: 0,
      background: BR.panel, borderBottom: `1px solid ${BR.edge}`,
    }}>
      {tabs.map(t => {
        const on = t.id === activeId;
        return (
          <div key={t.id} onClick={() => onSelect(t.id)} style={{
            display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
            padding: '8px 12px 9px', borderRadius: '9px 9px 0 0', maxWidth: 220,
            background: on ? BR.paper : 'transparent',
            border: on ? `1px solid ${BR.edge}` : '1px solid transparent', borderBottom: 'none',
            position: 'relative', top: 1,
          }}>
            <span style={{ width: 13, height: 13, borderRadius: 3, background: t.color, flexShrink: 0 }} />
            <span style={{ fontFamily: BR.sans, fontSize: 12.5, fontWeight: on ? 600 : 500, color: on ? BR.ink : BR.inkSoft, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
            <span style={{ color: BR.inkMute, display: 'inline-flex', opacity: 0.6 }}><SMIcon name="x" size={12} /></span>
          </div>
        );
      })}
      <button title="New tab" style={{ appearance: 'none', border: 0, background: 'transparent', color: BR.inkMute, padding: '8px 10px', cursor: 'pointer' }}>
        <SMIcon name="plus" size={14} />
      </button>
    </div>
  );
}

function IconBtn({ name, title, onClick, active, disabled, size = 16 }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled} style={{
      appearance: 'none', border: `1px solid ${active ? BR.accent : 'transparent'}`, cursor: disabled ? 'default' : 'pointer',
      width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center',
      background: active ? '#f7e4da' : 'transparent', color: disabled ? BR.rule : (active ? BR.accent : BR.inkSoft),
    }}>
      <SMIcon name={name} size={size} />
    </button>
  );
}

// ── Address bar (morphs to a PICKING banner in capture mode) ─────────
function AddressBar({ url, mode, onExitPicker }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', flexShrink: 0,
      background: BR.paper, borderBottom: `1px solid ${BR.edge}`,
    }}>
      <IconBtn name="arrowleft" title="Back" />
      <IconBtn name="arrowright" title="Forward" disabled />
      <IconBtn name="reload" title="Reload" />
      <div style={{ width: 6 }} />
      {mode === 'capture' ? (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 10, height: 34, padding: '0 12px',
          background: '#f7e4da', border: `1px solid ${BR.accentSoft}`, borderRadius: 9,
          fontFamily: BR.sans, fontSize: 13, color: BR.accent, fontWeight: 600,
        }}>
          <span className="hv-pulse" style={{ color: BR.accent, display: 'inline-flex' }}><SMIcon name="target" size={15} /></span>
          PICKING — hover to highlight, click to select · ⌘-click for multi
          <button onClick={onExitPicker} style={{ marginLeft: 'auto', appearance: 'none', border: `1px solid ${BR.accentSoft}`, background: BR.paper, color: BR.accent, borderRadius: 6, padding: '3px 9px', fontFamily: BR.mono, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Esc</button>
        </div>
      ) : (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 9, height: 34, padding: '0 12px',
          background: BR.card, border: `1px solid ${BR.edge}`, borderRadius: 9,
          fontFamily: BR.mono, fontSize: 13, color: BR.ink,
        }}>
          <span style={{ color: BR.sage, display: 'inline-flex' }}><SMIcon name="lock" size={13} /></span>
          <span style={{ color: BR.inkMute }}>https://</span>{url}
          {mode === 'observe' && <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: BR.sans, fontSize: 11.5, fontWeight: 600, color: BR.accent }}><span className="hv-pulse" style={{ display: 'inline-flex' }}><SMIcon name="eye" size={13} /></span>observed</span>}
        </div>
      )}
      <div style={{ width: 6 }} />
      <IconBtn name="usage" title="Zoom / find" />
      <IconBtn name="terminal" title="DevTools" />
      <IconBtn name="settings" title="Page settings" />
    </div>
  );
}

// ── Bottom action bar — the "dev browser, not Chrome" tell ───────────
const VERBS = [
  { id: 'capture', label: 'Capture DOM', icon: 'target' },
  { id: 'record',  label: 'Record',      icon: 'record' },
  { id: 'observe', label: 'Observe',     icon: 'eye' },
  { id: 'shot',    label: 'Screenshot',  icon: 'camera' },
];
function ActionBar({ mode, onVerb, recording }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', flexShrink: 0,
      background: BR.panel, borderTop: `1px solid ${BR.edge}`,
    }}>
      <span style={{ fontFamily: BR.serif, fontSize: 12.5, fontStyle: 'italic', color: BR.inkMute, marginRight: 6 }}>
        Hand this page to the agent →
      </span>
      {VERBS.map(v => {
        const on = mode === v.id || (v.id === 'record' && recording);
        return (
          <button key={v.id} onClick={() => onVerb(v.id)} style={{
            appearance: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '8px 15px', borderRadius: 9, fontFamily: BR.sans, fontSize: 13, fontWeight: 600,
            border: `1px solid ${on ? BR.accent : BR.edge}`,
            background: on ? BR.accent : BR.card, color: on ? '#fff' : BR.inkSoft,
          }}>
            <span style={{ display: 'inline-flex', color: v.id === 'record' && !on ? '#c0503a' : 'inherit' }}><SMIcon name={v.icon} size={15} /></span>
            {v.label}
          </button>
        );
      })}
      <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: BR.mono, fontSize: 11.5, color: BR.inkMute }}>
        <span style={{ color: BR.sage, display: 'inline-flex' }}><SMIcon name="shield" size={13} /></span>
        sandboxed · no filesystem · no passwords
      </div>
    </div>
  );
}

// ── Panel scaffolding ────────────────────────────────────────────────
function PanelShell({ title, icon, onClose, children, foot }) {
  return (
    <aside style={{ width: 344, flexShrink: 0, background: BR.panel, borderLeft: `1px solid ${BR.edge}`, display: 'flex', flexDirection: 'column', fontFamily: BR.sans }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '13px 16px', borderBottom: `1px solid ${BR.rule}` }}>
        <span style={{ color: BR.accent, display: 'inline-flex' }}><SMIcon name={icon} size={16} /></span>
        <span style={{ fontFamily: BR.serif, fontSize: 16, fontWeight: 600, color: BR.ink }}>{title}</span>
        <button onClick={onClose} style={{ marginLeft: 'auto', appearance: 'none', border: 0, background: 'transparent', color: BR.inkMute, cursor: 'pointer', display: 'inline-flex' }}><SMIcon name="x" size={16} /></button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '14px 16px' }}>{children}</div>
      {foot && <div style={{ borderTop: `1px solid ${BR.rule}`, padding: '12px 16px' }}>{foot}</div>}
    </aside>
  );
}

const CAPTURE_MODES = [
  { id: 'agent',   label: 'Agent-ready DOM', hint: 'filter → prune → summarize → chunk' },
  { id: 'html',    label: 'Full HTML',       hint: 'outer HTML of the selection' },
  { id: 'a11y',    label: 'Accessibility tree', hint: 'roles, ARIA, labels & states' },
  { id: 'selector',label: 'Selector',        hint: 'CSS · XPath · ARIA fallback chain' },
  { id: 'shot',    label: 'Screenshot',      hint: 'PNG — covers non-semantic UI' },
];
const DESTS = [
  { id: 'claude', label: 'Claude session', icon: 'sparkle' },
  { id: 'scratch', label: 'Scratch file', icon: 'file' },
  { id: 'clip', label: 'Clipboard', icon: 'copy' },
  { id: 'prd', label: 'PRD fixture', icon: 'book' },
];

function CapturePanel({ selected, capMode, setCapMode, dest, setDest, onClose, captured, onCapture }) {
  return (
    <PanelShell title="Capture" icon="target" onClose={onClose} foot={
      captured ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={{ flex: 1, appearance: 'none', border: 0, cursor: 'pointer', background: BR.ink, color: BR.paper, borderRadius: 9, padding: '9px 0', fontFamily: BR.sans, fontSize: 13, fontWeight: 600 }}>Copy</button>
          <button style={{ flex: 1.4, appearance: 'none', border: 0, cursor: 'pointer', background: BR.accent, color: '#fff', borderRadius: 9, padding: '9px 0', fontFamily: BR.sans, fontSize: 13, fontWeight: 600 }}>→ Claude session</button>
          <button style={{ appearance: 'none', border: `1px solid ${BR.edge}`, cursor: 'pointer', background: BR.card, color: BR.inkSoft, borderRadius: 9, padding: '9px 12px', fontFamily: BR.sans, fontSize: 13, fontWeight: 600 }}>Save .txt</button>
        </div>
      ) : (
        <button onClick={onCapture} disabled={!selected.length} style={{
          width: '100%', appearance: 'none', border: 0, cursor: selected.length ? 'pointer' : 'default',
          background: selected.length ? BR.accent : BR.rule, color: '#fff', borderRadius: 10, padding: '11px 0',
          fontFamily: BR.sans, fontSize: 14, fontWeight: 700,
        }}>Capture {selected.length || ''} {selected.length === 1 ? 'element' : selected.length ? 'elements' : '— pick an element'}</button>
      )
    }>
      {/* selection */}
      <SectionLabel>Selection</SectionLabel>
      {selected.length ? selected.map(s => (
        <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, background: BR.card, border: `1px solid ${BR.edge}`, borderRadius: 8, padding: '8px 10px', marginBottom: 6, fontFamily: BR.mono, fontSize: 12, color: BR.ink }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: BR.accent, flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s}</span>
        </div>
      )) : (
        <div style={{ fontSize: 12.5, color: BR.inkMute, lineHeight: 1.5, marginBottom: 4 }}>Hover the page and click an element. ⌘-click to add more.</div>
      )}

      {!captured && <>
        <SectionLabel style={{ marginTop: 16 }}>Mode</SectionLabel>
        <div style={{ display: 'grid', gap: 5 }}>
          {CAPTURE_MODES.map(m => {
            const on = capMode === m.id;
            return (
              <button key={m.id} onClick={() => setCapMode(m.id)} style={{
                appearance: 'none', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                border: `1px solid ${on ? BR.accent : BR.edge}`, background: on ? '#f7e4da' : BR.card, borderRadius: 9, padding: '8px 11px',
              }}>
                <span style={{ width: 15, height: 15, borderRadius: '50%', flexShrink: 0, border: `2px solid ${on ? BR.accent : BR.rule}`, background: on ? BR.accent : 'transparent', boxShadow: on ? `inset 0 0 0 2px ${on ? '#f7e4da' : '#fff'}` : 'none' }} />
                <span>
                  <div style={{ fontSize: 13, fontWeight: 600, color: BR.ink }}>{m.label}</div>
                  <div style={{ fontSize: 11, color: BR.inkMute, fontFamily: BR.mono }}>{m.hint}</div>
                </span>
              </button>
            );
          })}
        </div>

        <SectionLabel style={{ marginTop: 16 }}>Send to</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {DESTS.map(d => {
            const on = dest === d.id;
            return (
              <button key={d.id} onClick={() => setDest(d.id)} style={{
                appearance: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7,
                border: `1px solid ${on ? BR.accent : BR.edge}`, background: on ? '#f7e4da' : BR.card, borderRadius: 8, padding: '8px 10px',
                color: on ? BR.accent : BR.inkSoft, fontFamily: BR.sans, fontSize: 12.5, fontWeight: 600,
              }}>
                <SMIcon name={d.icon} size={14} />{d.label}
              </button>
            );
          })}
        </div>
      </>}

      {captured && <CaptureOutput capMode={capMode} />}
    </PanelShell>
  );
}

function CaptureOutput({ capMode }) {
  const agent = `<region aria-label="Pro Plan">
  <heading level=3>Pro</heading>
  <text>$20/mo</text>
  <list>
    <item>Unlimited projects</item>
    <item>Priority support</item>
    <item>Full history</item>
  </list>
  <button name="Buy"
    data-testid="buy-pro">Buy</button>
</region>`;
  const a11y = `region  "Pro Plan"
  heading  "Pro"           level 3
  text     "$20/mo"
  list
    listitem "Unlimited projects"
    listitem "Priority support"
    listitem "Full history"
  button   "Buy"           focusable
           data-testid=buy-pro`;
  const sel = `css    article.plan--pro button.btn-primary
xpath  //article[contains(@class,'plan--pro')]//button
aria   role=button name="Buy"
test   [data-testid="buy-pro"]   ← preferred`;
  const body = capMode === 'a11y' ? a11y : capMode === 'selector' ? sel : agent;

  return (
    <div style={{ marginTop: 4 }}>
      {capMode === 'agent' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 11.5, color: BR.inkMute, fontFamily: BR.mono }}>
          <span style={{ color: BR.sage, display: 'inline-flex' }}><SMIcon name="check" size={13} stroke={2.4} /></span>
          filter → prune → summarize → chunk · 1 of 1 · 412 tok
        </div>
      )}
      {capMode === 'shot' ? (
        <div style={{ border: `1px solid ${BR.edge}`, borderRadius: 10, overflow: 'hidden', background: WEB.panel }}>
          <div style={{ padding: 16 }}>
            <div style={{ background: '#fff', border: `2px solid ${WEB.accent}`, borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 12, color: WEB.inkMute, fontWeight: 600 }}>Pro</div>
              <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: -0.5 }}>$20<span style={{ fontSize: 12, color: WEB.inkMute, fontWeight: 500 }}>/mo</span></div>
              <div style={{ marginTop: 10, background: WEB.accent, color: '#fff', textAlign: 'center', padding: '8px 0', borderRadius: 8, fontSize: 13, fontWeight: 700 }}>Buy</div>
            </div>
          </div>
          <div style={{ padding: '8px 12px', borderTop: `1px solid ${BR.edge}`, fontFamily: BR.mono, fontSize: 11, color: BR.inkMute, background: BR.card }}>element · 264×212 · PNG</div>
        </div>
      ) : (
        <pre style={{
          margin: 0, background: '#2a2118', color: '#e8ddc9', borderRadius: 10, padding: '12px 14px',
          fontFamily: BR.mono, fontSize: 11.5, lineHeight: 1.55, overflow: 'auto', whiteSpace: 'pre',
          border: `1px solid ${BR.rule}`,
        }}>{body}</pre>
      )}
      <div style={{ marginTop: 8, fontSize: 11.5, color: BR.inkMute, fontFamily: BR.sans, display: 'flex', alignItems: 'center', gap: 6 }}>
        <SMIcon name="chevron" size={12} /> raw HTML
      </div>
    </div>
  );
}

function SectionLabel({ children, style }) {
  return <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: BR.inkMute, marginBottom: 8, ...style }}>{children}</div>;
}

// ── Recorder panel ───────────────────────────────────────────────────
const REC_STEPS = [
  { n: 1, verb: 'navigate', target: 'northwind.design/login', kind: 'nav' },
  { n: 2, verb: 'click',    target: 'input#email' },
  { n: 3, verb: 'type',     target: 'input#password', variable: 'pw' },
  { n: 4, verb: 'click',    target: 'button[type=submit]' },
  { n: 5, verb: 'wait-for', target: 'text="Dashboard"', kind: 'assert' },
];
const REC_EXPORTS = [
  { id: 'pw', label: 'Playwright spec', hint: 'tests/e2e/*.spec.ts', primary: true },
  { id: 'md', label: 'Markdown steps',  hint: 'human repro' },
  { id: 'prd', label: 'PRD fixture',    hint: 'feed a claude -p job' },
];
function RecorderPanel({ onClose, recording, setRecording, elapsed }) {
  const [openStep, setOpenStep] = React.useState(3);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const verbColor = (v) => v === 'navigate' ? BR.sage : v === 'wait-for' ? BR.butter : BR.accent;

  return (
    <PanelShell title="Recorder" icon="record" onClose={onClose} foot={
      <div>
        <SectionLabel>Export as</SectionLabel>
        <div style={{ display: 'grid', gap: 6 }}>
          {REC_EXPORTS.map(e => (
            <button key={e.id} style={{
              appearance: 'none', cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10,
              border: `1px solid ${e.primary ? BR.accent : BR.edge}`, background: e.primary ? BR.accent : BR.card,
              borderRadius: 9, padding: '9px 12px',
            }}>
              <span style={{ display: 'inline-flex', color: e.primary ? '#fff' : BR.accent }}><SMIcon name="send" size={14} /></span>
              <span style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: e.primary ? '#fff' : BR.ink }}>{e.label}</div>
                <div style={{ fontSize: 11, fontFamily: BR.mono, color: e.primary ? 'rgba(255,255,255,0.75)' : BR.inkMute }}>{e.hint}</div>
              </span>
            </button>
          ))}
        </div>
      </div>
    }>
      {/* transport */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: BR.card, border: `1px solid ${BR.edge}`, borderRadius: 10, padding: '9px 12px', marginBottom: 14 }}>
        {recording
          ? <span className="hv-pulse" style={{ width: 10, height: 10, borderRadius: '50%', background: '#c0503a', flexShrink: 0 }} />
          : <span style={{ width: 10, height: 10, borderRadius: '50%', background: BR.rule, flexShrink: 0 }} />}
        <span style={{ fontFamily: BR.mono, fontSize: 13, color: BR.ink, fontWeight: 600 }}>{recording ? 'recording' : 'paused'} · {mm}:{ss}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <IconBtn name={recording ? 'pause' : 'record'} title={recording ? 'Pause' : 'Record'} onClick={() => setRecording(!recording)} />
          <IconBtn name="stop" title="Stop" size={14} />
          <IconBtn name="play" title="Replay" size={13} />
        </div>
      </div>

      <SectionLabel>Steps</SectionLabel>
      <div style={{ display: 'grid', gap: 4 }}>
        {REC_STEPS.map(s => {
          const on = openStep === s.n;
          return (
            <div key={s.n}>
              <button onClick={() => setOpenStep(on ? null : s.n)} style={{
                width: '100%', appearance: 'none', cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9,
                border: `1px solid ${on ? BR.accent : BR.edge}`, background: on ? '#f7e4da' : BR.card, borderRadius: 9, padding: '8px 10px',
              }}>
                <span style={{ width: 18, textAlign: 'center', fontFamily: BR.mono, fontSize: 11.5, color: BR.inkMute, flexShrink: 0 }}>{s.n}</span>
                <span style={{ fontFamily: BR.mono, fontSize: 11.5, fontWeight: 700, color: verbColor(s.verb), width: 62, flexShrink: 0 }}>{s.verb}</span>
                <span style={{ fontFamily: BR.mono, fontSize: 12, color: BR.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.target}</span>
                {s.variable && <span style={{ marginLeft: 'auto', flexShrink: 0, fontFamily: BR.mono, fontSize: 10.5, fontWeight: 700, color: BR.accent, background: BR.paper, border: `1px solid ${BR.accentSoft}`, borderRadius: 5, padding: '1px 6px' }}>{`{{${s.variable}}}`}</span>}
              </button>
              {on && (
                <div style={{ margin: '4px 0 4px 6px', padding: '10px 12px', borderLeft: `2px solid ${BR.accent}`, background: BR.card, borderRadius: '0 8px 8px 0' }}>
                  <div style={{ fontFamily: BR.mono, fontSize: 11.5, color: BR.inkSoft, lineHeight: 1.7 }}>
                    <div><span style={{ color: BR.inkMute }}>selector </span>{s.target}</div>
                    {s.verb === 'type' && <div><span style={{ color: BR.inkMute }}>value </span>●●●●●● → {`{{${s.variable}}}`}</div>}
                    {s.kind === 'assert' && <div><span style={{ color: BR.inkMute }}>assert </span>url contains /dashboard</div>}
                  </div>
                  {s.verb === 'type' && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8, fontFamily: BR.sans, fontSize: 12, color: BR.ink, cursor: 'pointer' }}>
                      <span style={{ width: 15, height: 15, borderRadius: 4, background: BR.accent, display: 'grid', placeItems: 'center', color: '#fff' }}><SMIcon name="check" size={11} stroke={3} /></span>
                      parameterize as {`{{${s.variable}}}`}
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10, fontSize: 11.5, color: BR.inkMute, fontFamily: BR.serif, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 6 }}>
        <SMIcon name="shield" size={13} /> Won't emit self-e2e jobs against scheduled plans.
      </div>
    </PanelShell>
  );
}

// ── Observe / Act panel (agent-in-the-loop) ──────────────────────────
function ObservePanel({ onClose, runMode, setRunMode }) {
  const line = (icon, color, children, mono) => (
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontFamily: mono ? BR.mono : BR.sans, fontSize: mono ? 12 : 13, color: BR.inkSoft, lineHeight: 1.5 }}>
      {icon && <span style={{ color, display: 'inline-flex', marginTop: 2, flexShrink: 0 }}><SMIcon name={icon} size={14} /></span>}
      <span>{children}</span>
    </div>
  );
  return (
    <PanelShell title="Claude session" icon="sparkle" onClose={onClose} foot={
      <div>
        <SectionLabel>Run context</SectionLabel>
        <div style={{ display: 'flex', gap: 6 }}>
          {[['in', 'logged-in', 'reuse cookies'], ['out', 'logged-out', 'clean context']].map(([id, label, hint]) => {
            const on = runMode === id;
            return (
              <button key={id} onClick={() => setRunMode(id)} style={{
                flex: 1, appearance: 'none', cursor: 'pointer', textAlign: 'left',
                border: `1px solid ${on ? BR.accent : BR.edge}`, background: on ? '#f7e4da' : BR.card, borderRadius: 9, padding: '8px 11px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 12, height: 12, borderRadius: '50%', border: `2px solid ${on ? BR.accent : BR.rule}`, background: on ? BR.accent : 'transparent', boxShadow: on ? 'inset 0 0 0 2px #f7e4da' : 'none' }} />
                  <span style={{ fontFamily: BR.sans, fontSize: 12.5, fontWeight: 600, color: BR.ink }}>{label}</span>
                </div>
                <div style={{ fontFamily: BR.mono, fontSize: 10.5, color: BR.inkMute, marginTop: 3, marginLeft: 18 }}>{hint}</div>
              </button>
            );
          })}
        </div>
      </div>
    }>
      <div style={{ display: 'grid', gap: 12 }}>
        {line('eye', BR.accent, <span><strong style={{ color: BR.ink }}>Observing</strong> northwind.design/pricing</span>)}
        {line('check', BR.sage, <span style={{ fontFamily: BR.mono, fontSize: 12 }}>DOM auto-captured on load · 412 tok</span>)}
        <div style={{ height: 1, background: BR.rule }} />
        {line(null, null, <span style={{ color: BR.ink, fontWeight: 600, fontFamily: BR.serif, fontSize: 15, fontStyle: 'italic' }}>The agent wants to:</span>)}
        <div style={{ background: '#2a2118', color: '#e8ddc9', borderRadius: 9, padding: '10px 12px', fontFamily: BR.mono, fontSize: 12, lineHeight: 1.5 }}>
          <span style={{ color: BR.butter }}>click</span> button[data-testid="buy-pro"]
          <div style={{ color: '#a89a80', fontSize: 11, marginTop: 4 }}># then read the checkout form fields</div>
        </div>
        <div style={{ display: 'flex', gap: 7 }}>
          <button style={{ flex: 1, appearance: 'none', border: 0, cursor: 'pointer', background: BR.accent, color: '#fff', borderRadius: 9, padding: '9px 0', fontFamily: BR.sans, fontSize: 13, fontWeight: 700 }}>Allow</button>
          <button style={{ flex: 1, appearance: 'none', border: `1px solid ${BR.edge}`, cursor: 'pointer', background: BR.card, color: BR.inkSoft, borderRadius: 9, padding: '9px 0', fontFamily: BR.sans, fontSize: 13, fontWeight: 600 }}>Allow all</button>
          <button style={{ flex: 1, appearance: 'none', border: `1px solid ${BR.edge}`, cursor: 'pointer', background: BR.card, color: '#9a3b1f', borderRadius: 9, padding: '9px 0', fontFamily: BR.sans, fontSize: 13, fontWeight: 600 }}>Deny</button>
        </div>
        <div style={{ fontFamily: BR.serif, fontStyle: 'italic', fontSize: 12, color: BR.inkMute, display: 'flex', gap: 7, alignItems: 'center' }}>
          <SMIcon name="shield" size={13} /> Each action is narrated & gated. No downloads, filesystem, or saved passwords.
        </div>
      </div>
    </PanelShell>
  );
}

// ── Page shell ───────────────────────────────────────────────────────
function BrowserPage({ project }) {
  const TABS = [
    { id: 't1', title: 'northwind.design', color: WEB.accent, url: 'northwind.design/pricing' },
    { id: 't2', title: 'docs.playwright', color: '#6f7d52', url: 'playwright.dev/docs/intro' },
  ];
  const [activeTab, setActiveTab] = React.useState('t1');
  const [mode, setMode] = React.useState('browse'); // browse | capture | record | observe
  const [hovered, setHovered] = React.useState(null);
  const [selected, setSelected] = React.useState(['button.btn-primary']);
  const [capMode, setCapMode] = React.useState('agent');
  const [dest, setDest] = React.useState('claude');
  const [captured, setCaptured] = React.useState(false);
  const [recording, setRecording] = React.useState(true);
  const [elapsed, setElapsed] = React.useState(42);
  const [runMode, setRunMode] = React.useState('in');

  const tab = TABS.find(t => t.id === activeTab);

  React.useEffect(() => {
    if (mode !== 'record' || !recording) return;
    const id = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(id);
  }, [mode, recording]);

  const onVerb = (v) => {
    if (v === 'shot') { setMode('capture'); setCapMode('shot'); setCaptured(false); return; }
    if (mode === v) { setMode('browse'); return; }
    setMode(v);
    if (v === 'capture') { setCaptured(false); setCapMode('agent'); }
  };

  const onPick = (sel) => {
    setCaptured(false);
    setSelected(prev => prev.includes(sel) ? prev.filter(x => x !== sel) : [sel]);
  };

  const picking = mode === 'capture' && !captured;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: BR.paper, minHeight: 0 }}>
      <SubTabStrip tabs={TABS} activeId={activeTab} onSelect={setActiveTab} />
      <AddressBar url={tab.url} mode={mode} onExitPicker={() => setMode('browse')} />

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* webview column */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <div style={{ flex: 1, overflow: 'auto', position: 'relative', background: WEB.bg, borderRight: mode === 'browse' ? 'none' : `1px solid ${BR.edge}` }}>
            <FakePricingPage
              picking={picking}
              hovered={hovered}
              selected={selected}
              onHover={setHovered}
              onPick={onPick}
            />
            {mode === 'record' && (
              <div style={{ position: 'sticky', top: 0, display: 'flex', alignItems: 'center', gap: 9, padding: '8px 16px', background: 'rgba(192,80,58,0.95)', color: '#fff', fontFamily: BR.sans, fontSize: 12.5, fontWeight: 600, zIndex: 6 }}>
                <span className="hv-pulse" style={{ width: 9, height: 9, borderRadius: '50%', background: '#fff' }} />
                Recording interactions — every click, type & navigation is captured as a step
              </div>
            )}
            {mode === 'observe' && (
              <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', boxShadow: `inset 0 0 0 3px ${BR.accent}`, zIndex: 4 }}>
                <span style={{ position: 'absolute', top: 10, right: 10, background: BR.accent, color: '#fff', fontFamily: BR.mono, fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 6, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span className="hv-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff' }} /> agent watching
                </span>
              </div>
            )}
          </div>
          <ActionBar mode={mode} onVerb={onVerb} recording={mode === 'record'} />
        </div>

        {/* contextual side panel */}
        {mode === 'capture' && (
          <CapturePanel
            selected={selected} capMode={capMode} setCapMode={(m) => { setCapMode(m); setCaptured(false); }}
            dest={dest} setDest={setDest} captured={captured}
            onCapture={() => setCaptured(true)} onClose={() => setMode('browse')}
          />
        )}
        {mode === 'record' && (
          <RecorderPanel onClose={() => setMode('browse')} recording={recording} setRecording={setRecording} elapsed={elapsed} />
        )}
        {mode === 'observe' && (
          <ObservePanel onClose={() => setMode('browse')} runMode={runMode} setRunMode={setRunMode} />
        )}
      </div>
    </div>
  );
}

window.BrowserPage = BrowserPage;
