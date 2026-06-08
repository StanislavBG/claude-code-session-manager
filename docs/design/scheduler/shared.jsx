// Shared chrome + data for all three Session Manager variants.

// ────────────────────────────────────────────────────────────────────
// Project tabs + nav items, sourced from the screenshots the user sent
// ────────────────────────────────────────────────────────────────────
const SM_PROJECTS = [
  { id: 'session-manager',      label: 'session-manager',      branch: 'main',              dot: '#7a8f5f' },
  { id: 'social-signals-trader',label: 'social-signals-trader',branch: 'universe-coverage', dot: '#c96442' },
  { id: 'burrow',               label: 'burrow',               branch: 'main',              dot: '#a39079' },
  { id: 'torlashka-sreshta',    label: 'torlashka-sreshta',    branch: 'main',              dot: '#7a8466' },
];

// Mirrors the real app: ~17 tabs split across "Workspace" (the things you
// look at while working) and "Configure" (the things you set up once).
const SM_NAV_WORKSPACE = [
  { id: 'home',      label: 'Home',       hint: "Today's sessions & the 5-hour window" },
  { id: 'terminal',  label: 'Terminal',   hint: 'Live Claude Code, in-app (xterm)' },
  { id: 'subagents', label: 'Subagents',  hint: 'Sub-agents working in parallel' },
  { id: 'scheduler', label: 'Scheduler',  hint: 'Queue claude -p jobs against your window' },
  { id: 'plans',     label: 'Plans',      hint: 'PRDs that drive the scheduler' },
  { id: 'tasks',     label: 'Tasks',      hint: 'Active to-dos across sessions' },
  { id: 'history',   label: 'History',    hint: 'Every session, ever — resumable' },
  { id: 'usage',     label: 'Usage',      hint: 'Tokens, cost, sessions per day' },
];

const SM_NAV_CONFIG = [
  { id: 'skills',   label: 'Skills',       hint: 'Reusable instructions Claude loads' },
  { id: 'plugins',  label: 'Plugins',      hint: 'Extensions for Claude Code' },
  { id: 'mcp',      label: 'MCP Servers',  hint: 'External tools & integrations' },
  { id: 'hooks',    label: 'Hooks',        hint: 'Run scripts on session events' },
  { id: 'keys',     label: 'Keybindings',  hint: 'Shortcuts you can override' },
  { id: 'docs',     label: 'Doc Editor',   hint: 'Edit CLAUDE.md & friends' },
  { id: 'memory',   label: 'Agent Memory', hint: 'Long-term context store' },
  { id: 'projects', label: 'Projects',     hint: 'All known project folders' },
  { id: 'settings', label: 'Settings',     hint: 'Voice input, theme, billing window' },
];

// ────────────────────────────────────────────────────────────────────
// Fake recent-session data for Home screens
// ────────────────────────────────────────────────────────────────────
const SM_RECENT_SESSIONS = [
  { project: 'social-signals-trader', branch: 'universe-coverage', task: 'write a test for snapshot.py',          ago: '12 min ago', tokens: '34.2k', status: 'paused' },
  { project: 'session-manager',       branch: 'main',              task: 'redesign the toolbar — friendlier nav',  ago: '2 hr ago',   tokens: '128k',  status: 'done'   },
  { project: 'burrow',                branch: 'main',              task: 'fix off-by-one in tunnel allocator',     ago: 'yesterday',  tokens: '52.8k', status: 'done'   },
  { project: 'torlashka-sreshta',     branch: 'main',              task: 'first pass at hostname dictionary',      ago: '2 days ago', tokens: '18.1k', status: 'done'   },
  { project: 'burrow',                branch: 'feat/snapshot',     task: 'add JSON output mode',                    ago: '3 days ago', tokens: '74.4k', status: 'done'   },
];

const SM_QUICK_ACTIONS = [
  { id: 'new',    label: 'Start a session',  hint: 'Open Claude Code in a project',     icon: 'play'     },
  { id: 'resume', label: 'Resume last',      hint: 'social-signals-trader · 12m ago', icon: 'sparkle'  },
  { id: 'plan',   label: 'Draft a PRD',      hint: 'Plan a job for the scheduler',      icon: 'book'     },
  { id: 'invite', label: 'Add a project',    hint: 'Point me at a folder on disk',      icon: 'plus'     },
];

// The 5-hour Claude billing window the scheduler runs against.
const SM_BILLING_WINDOW = {
  startedAt: '2:14 PM',
  endsAt:    '7:14 PM',
  elapsedPct: 0.42,   // 42% through the window
  promptsUsed: 184,
  promptsCap:  450,
  cost: 6.42,
};

// Queued / running scheduler jobs (claude -p)
const SM_SCHEDULER_QUEUE = [
  { id: 'j1', project: 'social-signals-trader', task: 'write tests for snapshot.py', state: 'running', eta: '~4 min' },
  { id: 'j2', project: 'burrow',                task: 'add JSON output mode',         state: 'queued',  eta: 'next'   },
  { id: 'j3', project: 'session-manager',       task: 'audit accessibility on Home',  state: 'queued',  eta: 'next · +1' },
];

// File-tree mirror of screenshot 1
const SM_FILE_TREE = [
  { kind: 'dir',  name: 'dashboard' },
  { kind: 'dir',  name: 'data' },
  { kind: 'dir',  name: 'docs' },
  { kind: 'dir',  name: 'prompts' },
  { kind: 'dir',  name: 'scripts' },
  { kind: 'dir',  name: 'src',    open: true,
    children: [
      { kind: 'file', name: 'main.py' },
      { kind: 'file', name: 'snapshot.py' },
      { kind: 'dir',  name: 'signals' },
    ] },
  { kind: 'dir',  name: 'tests' },
  { kind: 'file', name: 'ARCHITECTURE.md' },
  { kind: 'file', name: 'pyproject.toml' },
  { kind: 'file', name: 'README.md' },
  { kind: 'file', name: 'uv.lock' },
];

// ────────────────────────────────────────────────────────────────────
// Window-chrome primitives — paper-warm replacement for macOS toolbar
// ────────────────────────────────────────────────────────────────────
function SMTrafficLights({ size = 12 }) {
  const dot = (bg) => (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: bg,
      boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.18)',
    }} />
  );
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {dot('#ed6a5e')}{dot('#f4be4f')}{dot('#61c554')}
    </div>
  );
}

// Tiny pixel-art mascot reminiscent of the Claude Code one in the terminal
function SMMascot({ size = 28, fg = '#c96442' }) {
  // 8x8 grid: 1 = filled. A blocky friendly face.
  const grid = [
    '00111100',
    '01111110',
    '11011011',
    '11111111',
    '11011011',
    '01111110',
    '00111100',
    '00100100',
  ];
  const px = size / 8;
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges">
      {grid.map((row, y) => row.split('').map((c, x) =>
        c === '1' ? <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" fill={fg} /> : null
      ))}
    </svg>
  );
}

// Icon glyphs — small, hand-tuned, monoline. Stroke-based so they inherit colour.
const SMIcon = ({ name, size = 18, stroke = 1.6 }) => {
  const s = size;
  const props = { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'home':     return <svg {...props}><path d="M4 11l8-7 8 7" /><path d="M6 10v9h12v-9" /><path d="M10 19v-5h4v5" /></svg>;
    case 'terminal': return <svg {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 10l3 2-3 2" /><path d="M13 14h4" /></svg>;
    case 'agents':   return <svg {...props}><circle cx="7" cy="9" r="2.5" /><circle cx="17" cy="9" r="2.5" /><circle cx="12" cy="17" r="2.5" /><path d="M8.6 11l2.8 4M15.4 11l-2.8 4M9.5 9h5" /></svg>;
    case 'skills':   return <svg {...props}><path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z" /></svg>;
    case 'history':  return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /><path d="M4 6l2 2" /></svg>;
    case 'usage':    return <svg {...props}><path d="M4 19V8M10 19V5M16 19v-7M22 19H2" /></svg>;
    case 'hive':     return <svg {...props}><path d="M8 4h8l4 7-4 7H8l-4-7z" /><circle cx="12" cy="11" r="2.5" /></svg>;
    case 'subagents':return <svg {...props}><path d="M12 3l3 1.7v3.4L12 9.8 9 8.1V4.7zM6.5 12.5l3 1.7v3.4l-3 1.7-3-1.7v-3.4zM17.5 12.5l3 1.7v3.4l-3 1.7-3-1.7v-3.4z" /></svg>;
    case 'plugins':  return <svg {...props}><path d="M9 3v4M15 3v4M5 7h14v6a5 5 0 01-5 5h-4a5 5 0 01-5-5V7z" /></svg>;
    case 'mcp':      return <svg {...props}><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><circle cx="6.5" cy="7" r=".5" fill="currentColor" /><circle cx="6.5" cy="17" r=".5" fill="currentColor" /></svg>;
    case 'hooks':    return <svg {...props}><path d="M12 4v9a3 3 0 003 3h5" /><path d="M9 17l3 3 3-3" /></svg>;
    case 'keys':     return <svg {...props}><circle cx="8" cy="12" r="4" /><path d="M12 12h9M17 12v3M20 12v2" /></svg>;
    case 'plans':    return <svg {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>;
    case 'tasks':    return <svg {...props}><rect x="3" y="4" width="7" height="7" rx="1.5" /><rect x="3" y="13" width="7" height="7" rx="1.5" /><path d="M14 6h7M14 10h5M14 15h7M14 19h5" /></svg>;
    case 'projects': return <svg {...props}><path d="M3 7l3-3h4l2 2h9v13H3z" /></svg>;
    case 'docs':     return <svg {...props}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 13h6M9 17h6M9 9h3" /></svg>;
    case 'memory':   return <svg {...props}><path d="M9 4a4 4 0 00-4 4v1a3 3 0 000 6v1a4 4 0 004 4h6a4 4 0 004-4v-1a3 3 0 000-6V8a4 4 0 00-4-4z" /><path d="M9 9v6M12 6v12M15 9v6" /></svg>;
    case 'search':   return <svg {...props}><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4" /></svg>;
    case 'chevron':  return <svg {...props}><path d="M9 6l6 6-6 6" /></svg>;
    case 'caret':    return <svg {...props}><path d="M6 9l6 6 6-6" /></svg>;
    case 'dot':      return <svg {...props}><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></svg>;
    case 'plus':     return <svg {...props}><path d="M12 5v14M5 12h14" /></svg>;
    case 'folder':   return <svg {...props}><path d="M3 7l3-3h4l2 2h9v13H3z" /></svg>;
    case 'file':     return <svg {...props}><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4" /></svg>;
    case 'play':     return <svg {...props}><path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none" /></svg>;
    case 'pause':    return <svg {...props}><rect x="7" y="5" width="3.5" height="14" fill="currentColor" stroke="none" rx="0.5" /><rect x="13.5" y="5" width="3.5" height="14" fill="currentColor" stroke="none" rx="0.5" /></svg>;
    case 'sparkle':  return <svg {...props}><path d="M12 4v6M12 14v6M4 12h6M14 12h6" /></svg>;
    case 'book':     return <svg {...props}><path d="M4 5a2 2 0 012-2h6v18H6a2 2 0 01-2-2zM12 3h6a2 2 0 012 2v14H12z" /></svg>;
    case 'compass':  return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="M15 9l-2 5-5 2 2-5z" fill="currentColor" stroke="none" /></svg>;
    case 'scheduler':return <svg {...props}><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><path d="M8 14l2 2 4-4" /></svg>;
    case 'settings': return <svg {...props}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4 12H1M23 12h-3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>;
    case 'mic':      return <svg {...props}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3M9 21h6" /></svg>;
    case 'clock':    return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>;
    case 'leaf':     return <svg {...props}><path d="M20 4c-9 0-14 5-14 11 0 3 2 5 5 5 6 0 9-5 9-14z" /><path d="M6 20c2-5 5-8 11-11" /></svg>;
    default: return null;
  }
};

// Tiny inline file-tree for the sidebar's "Files" mode
function SMTreeRow({ item, depth = 0, mutedColor, accent }) {
  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '3px 8px', paddingLeft: 8 + depth * 14,
        fontSize: 13, color: item.kind === 'dir' ? '#3a2f24' : mutedColor,
        cursor: 'default',
      }}>
        <span style={{ color: item.kind === 'dir' ? accent : mutedColor, display: 'inline-flex' }}>
          <SMIcon name={item.kind === 'dir' ? 'folder' : 'file'} size={14} stroke={1.5} />
        </span>
        <span>{item.name}</span>
      </div>
      {item.open && item.children && item.children.map((c, i) =>
        <SMTreeRow key={i} item={c} depth={depth + 1} mutedColor={mutedColor} accent={accent} />
      )}
    </>
  );
}

Object.assign(window, {
  SM_PROJECTS, SM_NAV_WORKSPACE, SM_NAV_CONFIG,
  SM_RECENT_SESSIONS, SM_QUICK_ACTIONS, SM_FILE_TREE,
  SM_BILLING_WINDOW, SM_SCHEDULER_QUEUE,
  SMTrafficLights, SMMascot, SMIcon, SMTreeRow,
});
