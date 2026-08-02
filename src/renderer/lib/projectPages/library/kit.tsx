// Shared kit for the three Project Pages lenses. Ported from
// session-manager-operations/design-mocks/project-pages-component-library/source/00-kit-and-project-summary-shape.jsx —
// tokens + shared primitives only; the sample PROJ constant became
// ProjectPageSummary (see ../summaryType.ts), never a hardcoded value here.
import type { CSSProperties, ReactNode } from 'react';

export const PK = {
  paper: '#f6efe1', panel: '#efe6d3', card: '#fbf6ec', deep: '#2a221a',
  edge: '#e0d3b8', rule: '#d9c9a8', ink: '#2a221a', inkSoft: '#5b4a36', inkMute: '#8a7a60',
  accent: '#b85c34', accentDeep: '#9c4a26', sage: '#6f7d52', butter: '#e4b85a', clay: '#c98a5e',
  serif: "'Newsreader', Georgia, serif", sans: "'Geist', system-ui, sans-serif", mono: "'IBM Plex Mono', ui-monospace, monospace",
};

export function PkEyebrow({ children, tone = PK.accent, style }: { children: ReactNode; tone?: string; style?: CSSProperties }) {
  return <div style={{ fontFamily: PK.mono, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: tone, fontWeight: 500, ...style }}>{children}</div>;
}
export function PkPill({ children, tone = PK.inkSoft, bg = 'transparent', border = PK.rule, style }: { children: ReactNode; tone?: string; bg?: string; border?: string; style?: CSSProperties }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: PK.mono, fontSize: 11, color: tone, background: bg, border: `1px solid ${border}`, borderRadius: 999, padding: '3px 9px', whiteSpace: 'nowrap', ...style }}>{children}</span>;
}
export function PkDot({ c = PK.sage, s = 7 }: { c?: string; s?: number }) {
  return <span style={{ width: s, height: s, borderRadius: '50%', background: c, flex: 'none' }} />;
}
export function PkCmd({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <code style={{ display: wide ? 'block' : 'inline-block', fontFamily: PK.mono, fontSize: 13, color: PK.paper, background: PK.deep, borderRadius: 8, padding: wide ? '12px 16px' : '7px 12px' }}>{children}</code>;
}
export function PkBtn({ children, primary, small }: { children: ReactNode; primary?: boolean; small?: boolean }) {
  return <button style={{ appearance: 'none', cursor: 'pointer', fontFamily: PK.sans, fontSize: small ? 12 : 14, fontWeight: 550, padding: small ? '6px 12px' : '11px 20px', borderRadius: 9, border: primary ? '1px solid transparent' : `1px solid ${PK.rule}`, background: primary ? PK.accent : 'transparent', color: primary ? '#fff' : PK.inkSoft }}>{children}</button>;
}
// Faint placeholder standing in for real imagery the agent will supply.
export function PkShot({ h = 220, label = 'screenshot', style }: { h?: number; label?: string; style?: CSSProperties }) {
  return <div style={{ height: h, borderRadius: 12, border: `1px dashed ${PK.rule}`, background: `repeating-linear-gradient(135deg, ${PK.panel} 0 10px, ${PK.card} 10px 20px)`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: PK.inkMute, fontFamily: PK.mono, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', ...style }}>{label}</div>;
}
export function PkSection({ children, pad = '64px 72px', bg, style }: { children: ReactNode; pad?: string; bg?: string; style?: CSSProperties }) {
  // Side padding scales down so sections survive a narrow preview frame.
  const p = String(pad).replace(/\b(72|80)px\b/g, 'clamp(22px, 5.5%, $1px)');
  return <section style={{ padding: p, background: bg, ...style }}>{children}</section>;
}
export function PkH({ children, size = 40, style }: { children: ReactNode; size?: number; style?: CSSProperties }) {
  return <h2 style={{ margin: 0, fontFamily: PK.serif, fontWeight: 500, fontSize: size, lineHeight: 1.1, letterSpacing: '-0.015em', color: PK.ink, textWrap: 'balance', ...style }}>{children}</h2>;
}
export function PkBody({ children, size = 16, style }: { children: ReactNode; size?: number; style?: CSSProperties }) {
  return <p style={{ margin: 0, fontFamily: PK.sans, fontSize: size, lineHeight: 1.62, color: PK.inkSoft, textWrap: 'pretty', ...style }}>{children}</p>;
}
