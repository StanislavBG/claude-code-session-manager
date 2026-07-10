/**
 * Monoline stroke-based icon set used in the Almanac sidebar + Home.
 * Ported from the design bundle's `SMIcon` (project/variants/shared.jsx).
 * Inherits `currentColor` so it tints with whatever container sets `text-*`.
 *
 * Adding an icon: pick a 24×24 viewBox, design with stroke (not fill) where
 * possible so it inherits color, keep stroke width ≈ 1.6 for visual parity
 * with the rest of the set.
 */
export type AlmanacIconName =
  | 'home' | 'terminal' | 'agents' | 'skills' | 'history' | 'usage'
  | 'hive' | 'plugins' | 'mcp' | 'hooks' | 'keys' | 'plans' | 'tasks' | 'projects'
  | 'memory' | 'search' | 'chevron' | 'caret' | 'dot' | 'plus'
  | 'folder' | 'file' | 'play' | 'pause' | 'sparkle' | 'book' | 'compass'
  | 'scheduler' | 'settings' | 'mic' | 'clock' | 'leaf' | 'orchestrator'
  | 'race' | 'background' | 'repoviz' | 'subagents' | 'system-prompt'
  | 'permissions' | 'agent-memory' | 'tool' | 'quick-open' | 'global-search'
  | 'remote' | 'wifi' | 'shield' | 'link' | 'copy'
  | 'check' | 'x' | 'send'
  | 'browser' | 'target' | 'record' | 'eye' | 'camera'
  | 'arrowleft' | 'arrowright' | 'reload' | 'lock' | 'stop'
  | 'star' | 'minus'

interface IconProps {
  name: AlmanacIconName
  size?: number
  stroke?: number
  className?: string
}

export function AlmanacIcon({ name, size = 17, stroke = 1.6, className }: IconProps) {
  const props = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: stroke,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
  }
  switch (name) {
    case 'home':         return <svg {...props}><path d="M4 11l8-7 8 7" /><path d="M6 10v9h12v-9" /><path d="M10 19v-5h4v5" /></svg>
    case 'terminal':     return <svg {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 10l3 2-3 2" /><path d="M13 14h4" /></svg>
    case 'agents':
    case 'subagents':    return <svg {...props}><circle cx="7" cy="9" r="2.5" /><circle cx="17" cy="9" r="2.5" /><circle cx="12" cy="17" r="2.5" /><path d="M8.6 11l2.8 4M15.4 11l-2.8 4M9.5 9h5" /></svg>
    case 'skills':       return <svg {...props}><path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z" /></svg>
    case 'history':      return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /><path d="M4 6l2 2" /></svg>
    case 'usage':        return <svg {...props}><path d="M4 19V8M10 19V5M16 19v-7M22 19H2" /></svg>
    case 'hive':         return <svg {...props}><path d="M8 4h8l4 7-4 7H8l-4-7z" /><circle cx="12" cy="11" r="2.5" /></svg>
    case 'plugins':      return <svg {...props}><path d="M9 3v4M15 3v4M5 7h14v6a5 5 0 01-5 5h-4a5 5 0 01-5-5V7z" /></svg>
    case 'mcp':          return <svg {...props}><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><circle cx="6.5" cy="7" r=".5" fill="currentColor" /><circle cx="6.5" cy="17" r=".5" fill="currentColor" /></svg>
    case 'hooks':        return <svg {...props}><path d="M12 4v9a3 3 0 003 3h5" /><path d="M9 17l3 3 3-3" /></svg>
    case 'keys':         return <svg {...props}><circle cx="8" cy="12" r="4" /><path d="M12 12h9M17 12v3M20 12v2" /></svg>
    case 'plans':        return <svg {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>
    case 'tasks':        return <svg {...props}><rect x="3" y="4" width="7" height="7" rx="1.5" /><rect x="3" y="13" width="7" height="7" rx="1.5" /><path d="M14 6h7M14 10h5M14 15h7M14 19h5" /></svg>
    case 'projects':     return <svg {...props}><path d="M3 7l3-3h4l2 2h9v13H3z" /></svg>
    case 'memory':
    case 'agent-memory': return <svg {...props}><path d="M9 4a4 4 0 00-4 4v1a3 3 0 000 6v1a4 4 0 004 4h6a4 4 0 004-4v-1a3 3 0 000-6V8a4 4 0 00-4-4z" /><path d="M9 9v6M12 6v12M15 9v6" /></svg>
    case 'search':
    case 'global-search':return <svg {...props}><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4" /></svg>
    case 'chevron':      return <svg {...props}><path d="M9 6l6 6-6 6" /></svg>
    case 'caret':        return <svg {...props}><path d="M6 9l6 6 6-6" /></svg>
    case 'dot':          return <svg {...props}><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></svg>
    case 'plus':         return <svg {...props}><path d="M12 5v14M5 12h14" /></svg>
    case 'folder':       return <svg {...props}><path d="M3 7l3-3h4l2 2h9v13H3z" /></svg>
    case 'file':         return <svg {...props}><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4" /></svg>
    case 'play':         return <svg {...props}><path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none" /></svg>
    case 'pause':        return <svg {...props}><rect x="7" y="5" width="3.5" height="14" fill="currentColor" stroke="none" rx="0.5" /><rect x="13.5" y="5" width="3.5" height="14" fill="currentColor" stroke="none" rx="0.5" /></svg>
    case 'sparkle':      return <svg {...props}><path d="M12 4v6M12 14v6M4 12h6M14 12h6" /></svg>
    case 'book':         return <svg {...props}><path d="M4 5a2 2 0 012-2h6v18H6a2 2 0 01-2-2zM12 3h6a2 2 0 012 2v14H12z" /></svg>
    case 'compass':      return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="M15 9l-2 5-5 2 2-5z" fill="currentColor" stroke="none" /></svg>
    case 'scheduler':    return <svg {...props}><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><path d="M8 14l2 2 4-4" /></svg>
    case 'settings':     return <svg {...props}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4 12H1M23 12h-3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>
    case 'mic':          return <svg {...props}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3M9 21h6" /></svg>
    case 'clock':        return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>
    case 'leaf':         return <svg {...props}><path d="M20 4c-9 0-14 5-14 11 0 3 2 5 5 5 6 0 9-5 9-14z" /><path d="M6 20c2-5 5-8 11-11" /></svg>
    case 'orchestrator': return <svg {...props}><circle cx="12" cy="6" r="2.5" /><circle cx="5" cy="17" r="2.5" /><circle cx="12" cy="17" r="2.5" /><circle cx="19" cy="17" r="2.5" /><path d="M12 8.5v6M12 14.5l-7 0M12 14.5l7 0" /></svg>
    case 'race':         return <svg {...props}><path d="M5 4v16M5 5h7l-1 3h7v6h-7l-1 3H5" /></svg>
    case 'background':   return <svg {...props}><path d="M3 4h18v4H3zM3 10h18v4H3zM3 16h18v4H3z" /><circle cx="6" cy="6" r=".75" fill="currentColor" stroke="none" /><circle cx="6" cy="12" r=".75" fill="currentColor" stroke="none" /><circle cx="6" cy="18" r=".75" fill="currentColor" stroke="none" /></svg>
    case 'repoviz':      return <svg {...props}><circle cx="6" cy="12" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M8.5 10.5L15.5 7.5M8.5 13.5L15.5 16.5" /></svg>
    case 'system-prompt':return <svg {...props}><rect x="4" y="4" width="16" height="14" rx="2" /><path d="M8 10h8M8 14h5M9 18l-2 3M15 18l2 3" /></svg>
    case 'permissions':  return <svg {...props}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /><circle cx="12" cy="15.5" r="1.2" fill="currentColor" stroke="none" /></svg>
    case 'tool':         return <svg {...props}><path d="M14 4a4 4 0 014 4l-7 7-4-4 7-7zM7 11l-3 3 6 6 3-3" /></svg>
    case 'quick-open':   return <svg {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18M7 13h10M7 16h6" /></svg>
    case 'remote':       return <svg {...props}><path d="M5 12.5a7 7 0 0114 0M1.5 9a11 11 0 0121 0M8.5 16a3.5 3.5 0 017 0" /><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" /></svg>
    case 'wifi':         return <svg {...props}><path d="M5 12.5a10 10 0 0114 0M8 15.5a6 6 0 018 0M12 18.5h.01" /></svg>
    case 'shield':       return <svg {...props}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg>
    case 'link':         return <svg {...props}><path d="M9 12h6" /><path d="M10 8H7a4 4 0 000 8h3M14 8h3a4 4 0 010 8h-3" /></svg>
    case 'copy':         return <svg {...props}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h8" /></svg>
    case 'check':        return <svg {...props}><path d="M5 12l5 5 9-10" /></svg>
    case 'x':            return <svg {...props}><path d="M6 6l12 12M18 6L6 18" /></svg>
    case 'send':         return <svg {...props}><path d="M4 11l17-7-7 17-3-7z" /></svg>
    case 'browser':      return <svg {...props}><circle cx="12" cy="12" r="8" /><ellipse cx="12" cy="12" rx="3.2" ry="8" /><path d="M4 12h16" /></svg>
    case 'target':       return <svg {...props}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
    case 'record':       return <svg {...props}><circle cx="12" cy="12" r="7" fill="currentColor" stroke="none" /></svg>
    case 'eye':          return <svg {...props}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
    case 'camera':        return <svg {...props}><path d="M4 8h3l2-2h6l2 2h3v11H4z" /><circle cx="12" cy="13.5" r="3.5" /></svg>
    case 'arrowleft':    return <svg {...props}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
    case 'arrowright':   return <svg {...props}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
    case 'reload':       return <svg {...props}><path d="M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></svg>
    case 'lock':         return <svg {...props}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
    case 'stop':         return <svg {...props}><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" /></svg>
    case 'star':         return <svg {...props}><path d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.2-5.4 3.2 1.3-6-4.6-4.1 6.1-.6z" /></svg>
    case 'minus':        return <svg {...props}><path d="M5 12h14" /></svg>
    default: return null
  }
}
