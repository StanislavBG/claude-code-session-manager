/* Sample data for the Claude config mockups, taken from the live app (project "Self").
   Shared by ConfigToday / ConfigFolderTabs / ConfigLedger / ConfigWorkbench via window.CC_DATA.
   Icon paths are copied verbatim from src/renderer/components/layout/AlmanacIcon.tsx. */
(function () {
  var P = {
    memory: '<path d="M9 4a4 4 0 00-4 4v1a3 3 0 000 6v1a4 4 0 004 4h6a4 4 0 004-4v-1a3 3 0 000-6V8a4 4 0 00-4-4z"/><path d="M9 9v6M12 6v12M15 9v6"/>',
    file: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4 12H1M23 12h-3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    mcp: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><circle cx="6.5" cy="7" r=".5" fill="currentColor"/><circle cx="6.5" cy="17" r=".5" fill="currentColor"/>',
    skills: '<path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"/>',
    star: '<path d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.2-5.4 3.2 1.3-6-4.6-4.1 6.1-.6z"/>',
    link: '<path d="M9 12h6"/><path d="M10 8H7a4 4 0 000 8h3M14 8h3a4 4 0 010 8h-3"/>',
    sparkle: '<path d="M12 4v6M12 14v6M4 12h6M14 12h6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    reload: '<path d="M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
    keys: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M17 12v3M20 12v2"/>',
    plugins: '<path d="M9 3v4M15 3v4M5 7h14v6a5 5 0 01-5 5h-4a5 5 0 01-5-5V7z"/>',
    folder: '<path d="M3 7l3-3h4l2 2h9v13H3z"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    send: '<path d="M4 11l17-7-7 17-3-7z"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    hooks: '<path d="M12 4v9a3 3 0 003 3h5"/><path d="M9 17l3 3 3-3"/>',
    permissions: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="currentColor" stroke="none"/>',
    tool: '<path d="M14 4a4 4 0 014 4l-7 7-4-4 7-7zM7 11l-3 3 6 6 3-3"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/>',
    caret: '<path d="M6 9l6 6 6-6"/>',
    book: '<path d="M4 5a2 2 0 012-2h6v18H6a2 2 0 01-2-2zM12 3h6a2 2 0 012 2v14H12z"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none"/>'
  };
  function icon(name, color, sw) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + color +
      '" stroke-width="' + (sw || 1.6) + '" stroke-linecap="round" stroke-linejoin="round">' +
      (P[name] || P.dot).replace(/currentColor/g, color) + '</svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  var memories = [
    { slug: 'portfolio-action-project-field', desc: 'Portfolio ledger - never set action.project to burrow, Bilko or Self (the owner deleted those project entries 2026-11-12); name the repo in ref. Also: a Burrow action auto-marked done is not proof the pipeline runs', size: '4.8 KB', age: 'just now' },
    { slug: 'bilko-run-clicks-are-not-people', desc: 'Before a Portfolio decision cites bilko.run clicks, check they are people — bot and preview traffic inflate them', size: '3.9 KB', age: 'just now' },
    { slug: 'portfolio-readings-trend', desc: '2026-11-20 Epic 94b1a05a — goal readings → trend lines, never single points', size: '1.5 KB', age: 'just now' },
    { slug: 'portfolio-list-alignment', desc: '2026-11-19 bug Epic 5f093431 - Portfolio list columns must line up across rows', size: '3.0 KB', age: '1d ago' },
    { slug: 'portfolio-decisions-are-steps', desc: 'Owner 2026-11-15 - a Portfolio decision is an action step, not a note', size: '8.7 KB', age: '1d ago' },
    { slug: 'portfolio-habits-grow-independently', desc: 'Owner 2026-11-12 values the Habit vs Number split — habits grow on their own track', size: '2.6 KB', age: '1d ago' },
    { slug: 'portfolio-plain-language', desc: 'Owner 2026-11-19 - Portfolio records must be written in plain language', size: '1.2 KB', age: '1d ago' },
    { slug: 'human-for-hire-card-self-owned', desc: '2026-11-19 owner - Human For Hire is pitched by Self and owned by Self', size: '3.0 KB', age: '1d ago' },
    { slug: 'kiln-idea-tool', desc: '2026-11-15 Epic 07f2a491: Kiln business-idea tool scope and first readings', size: '13.6 KB', age: '4d ago' }
  ];
  var agents = ['architect', 'bilko-ceo', 'bilko-host-publisher', 'blender-artist', 'builder', 'competitive-analyst', 'competitive-research…', 'demo-video-builder', 'dev-lead'];

  var memBody = [
    { k: 'p', t: 'Two lessons from the Portfolio pulse of 2026-11-20 (my own findings, not owner words).' },
    { k: 'p', t: '**1. Omit `project` on action rows for internal tools.** The owner deleted the `burrow`, `Bilko`, `Self` and `social-signals-trader` entries from `portfolio.yaml` `projects` on the page on 2026-11-12 6:28 PM PST (commits a05e578, f010b6a, a9ae7d6, 8721c02). The list now holds only public products. I set `project: burrow` and `project: Bilko` on A-0019 and A-0020, and `board.py` raised two `project_not_in_settings` gaps. The skill says to fix that gap with `ledger_append.py project`, which would re-add what the owner removed.' },
    { k: 'h', t: 'WHY' },
    { k: 'p', t: 'a record the owner deleted is gone on purpose; agents never re-add it. The writer also refuses a same-status correction row, so a wrong field on an action cannot be fixed afterwards.' },
    { k: 'h', t: 'HOW TO APPLY' },
    { k: 'p', t: 'on an action row, leave `project` out unless it is a key in `portfolio.yaml` `projects`; name the carrying repo in `ref` ("Burrow session (bug)"). Never answer `project_not_in_settings` for burrow, Bilko or Self by appending a project. `ledger_append.py project` already refuses an owner-deleted id. A Self fix was queued on 2026-11-20 in Epic portfolio-portfolio-record-refresh-readings.' }
  ];

  // Markdown-ish inline runs: `code` and **bold** (bold may wrap code).
  function inline(text) {
    var out = [], bold = false;
    text.split(/(`[^`]*`)/).forEach(function (seg) {
      if (!seg) return;
      if (seg.charAt(0) === '`') { out.push({ t: seg.slice(1, -1), code: true, bold: bold }); return; }
      seg.split('**').forEach(function (s, i) {
        if (i > 0) bold = !bold;
        if (s) out.push({ t: s, code: false, bold: bold });
      });
    });
    return out;
  }
  // th: { p:{fs,lh,c}, h:{fs,c,ls,fw,mt}, code:{ff,fs,bg,pad,c}, boldW }
  function prose(th, body) {
    return (body || memBody).map(function (b, i) {
      var isH = b.k === 'h';
      var s = isH ? th.h : th.p;
      return {
        fs: s.fs, lh: isH ? '1.4' : s.lh, c: s.c, fw: isH ? s.fw : 400, ls: isH ? s.ls : 'normal',
        mt: i === 0 ? '0px' : (isH ? th.h.mt : th.gap), mb: isH ? th.h.mb || '0px' : '0px',
        parts: inline(b.t).map(function (r) {
          return {
            t: r.t, ff: r.code ? th.code.ff : 'inherit', fs: r.code ? th.code.fs : 'inherit',
            bg: r.code ? th.code.bg : 'transparent', pad: r.code ? th.code.pad : '0px',
            c: r.code ? th.code.c : 'inherit', fw: r.bold ? th.boldW : 'inherit'
          };
        })
      };
    });
  }

  var skillSrc = [
    '',
    '# bank-of-america-statements',
    '',
    'Critical financial input: most household spending flows through the BofA Adv Plus',
    'checking account. This skill turns the PDF eStatements into queryable data.',
    '',
    '## Boundary',
    '',
    '**Local data only.** This skill never logs into Bank of America or any portal.',
    'It reads PDFs that already exist on disk: `~/Downloads` (or `$BOA_INBOX`) and',
    '`finance/personal/bank-of-america/statements/`. New statements arrive by being',
    'dropped into either folder (downloaded manually or by a separate fetcher). If there',
    'are no new PDFs, there is nothing to do.',
    '',
    '## Run (uniform contract)',
    '',
    'Drop `eStmt*.pdf` into `~/Downloads` (or `statements/`), then:',
    '',
    '```',
    'python3 finance/personal/bank-of-america/bin/refresh.py',
    '```',
    '',
    '`refresh.py` runs `ingest.py` -> `parse_statements.py` -> `gen_boa_data.py` -> heartbeat:',
    'writes `boa_data.json` and records the `boa-statements` heartbeat. The',
    '`boa-refresh.path` systemd unit runs it automatically when `~/Downloads` or',
    '`statements/` changes. View at `http://<host>:1337/Bank-of-America`. Re-running with',
    'no new PDFs is a no-op success.',
    '',
    '- `ingest.py` detects the kind by content via `statement_kind.py` (checking: Account',
    '  summary / Beginning balance on / Ending balance on; mortgage: Principal balance /',
    '  Total amount due / Payment due date) and copies the PDF to',
    '  `statements/<kind>/<yyyy-mm>.pdf`.'
  ];
  // th: { head, headW, code, text, fence }
  function code(th, src) {
    var fence = false;
    return (src || skillSrc).map(function (line, i) {
      var parts = [];
      if (/^```/.test(line)) { fence = !fence; parts.push({ t: line, c: th.fence || th.code, w: 400 }); }
      else if (fence) parts.push({ t: line, c: th.code, w: 400 });
      else if (/^#/.test(line)) parts.push({ t: line, c: th.head, w: th.headW || 400 });
      else if (/^@/.test(line)) parts.push({ t: line, c: th.code, w: 400 });
      else inline(line).forEach(function (r) {
        parts.push({ t: r.code ? '`' + r.t + '`' : (r.bold ? '**' + r.t + '**' : r.t), c: r.code ? th.code : th.text, w: r.bold ? 700 : 400 });
      });
      if (!parts.length) parts.push({ t: ' ', c: th.text, w: 400 });
      return { n: i + 1, parts: parts };
    });
  }

  var skills = [
    { name: 'bank-of-america-statements', desc: 'Parse local Bank of America PDF eStatements (checking + mortgage) for the WA household into append-only structured data and refresh the served Bank-of-America page.' },
    { name: 'invoice-cross-valley-water', desc: 'Download, understand, process, and summarize the latest Cross Valley Water invoice into the household ledger.' },
    { name: 'invoice-property-tax', desc: 'Download, understand, process, and summarize the latest property-tax statement into the household ledger.' },
    { name: 'invoice-pse', desc: 'Download, understand, process, and summarize the latest PSE energy invoice into the household ledger.' },
    { name: 'invoice-snohomish-pud', desc: 'Download, understand, process, and summarize the latest Snohomish PUD invoice into the household ledger.' },
    { name: 'invoice-united-parcel', desc: 'Download, understand, process, and summarize the latest United invoice into the household ledger.' },
    { name: 'invoice-waste-management', desc: 'Download, understand, process, and summarize the latest Waste Management invoice into the household ledger.' },
    { name: 'invoice-ziply-fiber', desc: 'Download, understand, process, and summarize the latest Ziply Fiber invoice into the household ledger.' },
    { name: 'portfolio', desc: "One Portfolio run for Bilko's tools. Records the pulse, readings and actions in the ledger." },
    { name: 'process-invoices', desc: 'Wrapper that pools the per-service invoice skills into one run and reports what changed.' },
    { name: 'process-mailbox', desc: 'Sort the household mailbox into statements, invoices and everything else.' },
    { name: 'refresh-household-pages', desc: 'Rebuild the served household pages after any finance skill writes new data.' },
    { name: 'tax-documents', desc: 'Collect the year\'s tax forms from the inbox into one checked folder.' }
  ];

  var servers = [
    { name: 'burrow', type: 'http', origin: 'Community', cmd: 'http://127.0.0.1:8767/mcp' },
    { name: 'gmail-bilko', type: 'stdio', origin: 'Community', cmd: '' },
    { name: 'gmail-sg', type: 'stdio', origin: 'Community', cmd: '' },
    { name: 'kiln', type: 'stdio', origin: 'Local', cmd: '' },
    { name: 'satchel', type: 'stdio', origin: 'Local', cmd: '' }
  ];

  // settingsGroups rail as the Settings page shows it for Self (set / total).
  var groups = [
    { title: 'Essentials', icon: 'star', set: 2, total: 3 },
    { title: 'Git & Commits', icon: 'link', set: 0, total: 3 },
    { title: 'Memory & Plans', icon: 'memory', set: 0, total: 4 },
    { title: 'Model & Reasoning', icon: 'sparkle', set: 2, total: 10 },
    { title: 'Interface', icon: 'eye', set: 0, total: 9 },
    { title: 'Updates & Cleanup', icon: 'reload', set: 1, total: 2 },
    { title: 'Environment & Auth', icon: 'keys', set: 1, total: 4 },
    { title: 'Plugins', icon: 'plugins', set: 1, total: 4 },
    { title: 'File Picker & Sandbox', icon: 'folder', set: 0, total: 3 },
    { title: 'Login', icon: 'lock', set: 1, total: 2 },
    { title: 'Feedback', icon: 'send', set: 1, total: 1 },
    { title: 'Advanced / Enterprise', icon: 'shield', set: 0, total: 10 },
    { title: 'Other', icon: 'dot', set: 4, total: 78 }
  ];

  var sections = [
    { title: 'Essentials', summary: 'The knobs you reach first.', rows: [
      { name: 'Model', key: 'model', desc: 'Override the default model used by Claude Code.', value: 'opus', src: 'User', set: true, kind: 'select' },
      { name: 'Language', key: 'language', desc: "Configure Claude's preferred response language.", value: 'English', src: 'User', set: true, kind: 'text' },
      { name: 'Output style', key: 'outputStyle', desc: 'Controls the output style for assistant responses.', value: 'default', src: 'Default', set: false, kind: 'select' }
    ] },
    { title: 'Git & Commits', summary: 'How Claude writes commits and pull requests on your behalf.', rows: [
      { name: 'Attribution', key: 'attribution', desc: 'Text Claude adds to the commits and pull requests it writes.', value: 'not set', src: 'Not set', set: false, kind: 'text' },
      { name: 'Include co-authored-by', key: 'includeCoAuthoredBy', desc: 'Add a Co-Authored-By trailer to commits Claude makes.', value: 'on', src: 'Default', set: false, kind: 'bool' }
    ] }
  ];

  // The memory after the "Check against the repo" verdict (update) is applied.
  var memBodyFixed = memBody.slice(0, 5).concat([
    { k: 'p', t: 'on an action row, leave `project` out unless it is a key in `portfolio.yaml` `projects`; name the carrying repo in `ref`. Never answer `project_not_in_settings` for burrow, Bilko or Self by appending a project. `ledger_append.py project` already refuses an owner-deleted id.' }
  ]);
  var evidence = [
    { t: 'portfolio.yaml', note: 'tracked in git' },
    { t: 'board.py', note: 'tracked in git' },
    { t: 'ledger_append.py', note: 'tracked in git' },
    { t: '2 [[links]]', note: 'both resolve' },
    { t: '2 terms', note: 'also in 1 project doc' }
  ];
  var fixDiff = [
    { s: ' ', t: '**How to apply:** on an action row, leave `project` out unless it is a key in' },
    { s: '−', t: '`portfolio.yaml` `projects`; name the carrying repo in `ref` ("Burrow session (bug)").' },
    { s: '+', t: '`portfolio.yaml` `projects`; name the carrying repo in `ref`.' },
    { s: ' ', t: 'Never answer `project_not_in_settings` for burrow, Bilko or Self by appending a project.' },
    { s: '−', t: 'A Self fix was queued on 2026-11-20 in Epic portfolio-portfolio-record-refresh-readings.' }
  ];

  // Memory editor: the file as it sits on disk (frontmatter + markdown body).
  function memSrcLines(body) {
    var src = ['---', 'name: portfolio-action-project-field', 'description: ' + memories[0].desc, 'type: feedback', '---'];
    var label = null;
    body.forEach(function (b) {
      if (b.k === 'h') { label = b.t === 'WHY' ? 'Why' : 'How to apply'; return; }
      src.push('');
      src.push(label ? '**' + label + ':** ' + b.t : b.t);
      label = null;
    });
    return src;
  }
  function srcParts(line, th) {
    var out = [], bold = false;
    line.split(/(`[^`]*`)/).forEach(function (seg) {
      if (!seg) return;
      if (seg.charAt(0) === '`') { out.push({ t: seg, c: th.code, w: bold ? 600 : 400 }); return; }
      seg.split(/(\*\*)/).forEach(function (s) {
        if (!s) return;
        if (s === '**') { bold = !bold; out.push({ t: s, c: th.dash, w: 400 }); return; }
        out.push({ t: s, c: bold ? th.bold : th.text, w: bold ? 600 : 400 });
      });
    });
    return out;
  }
  // th: { dash, key, text, code, bold, mark, caretBg }; mode: 'edit' | 'edit-fix'
  function memSource(th, mode) {
    var orig = memSrcLines(memBody);
    var src = mode === 'edit-fix' ? memSrcLines(memBodyFixed) : orig;
    return src.map(function (line, i) {
      var parts;
      if (line === '---') parts = [{ t: line, c: th.dash, w: 400 }];
      else if (i > 0 && i < 4) { var k = line.indexOf(':') + 1; parts = [{ t: line.slice(0, k), c: th.key, w: 600 }, { t: line.slice(k), c: th.text, w: 400 }]; }
      else if (!line) parts = [{ t: ' ', c: th.text, w: 400 }];
      else parts = srcParts(line, th);
      var caret = mode !== 'edit-fix' && i === 10;
      var marked = mode === 'edit-fix' ? line !== orig[i] : caret;
      return { n: i + 1, parts: parts, mk: marked ? th.mark : 'transparent', bg: caret ? th.caretBg : 'transparent', caret: caret };
    });
  }

  // Home -> Claude config (~/.claude). Sample content, except the agent names (from the app).
  var G = {
    claudeMd: ['# House rules', '', 'Plain language everywhere: records, commits, PR descriptions.', '', '## Before you say it works', '', "- Run the project's own test command and read the output.", '- Name each file you changed, and why, in one line.', '', '## Never', '', '- Re-add something the owner deleted. Ask first.', '- Push to `main` without a green check.', '', '@~/.claude/rules/git.md', '@~/.claude/rules/writing.md'],
    imports: [{ name: 'rules/git.md', note: '42 lines' }, { name: 'rules/writing.md', note: '18 lines' }],
    servers: [
      { name: 'playwright', type: 'stdio', origin: 'Community', status: 'ok' },
      { name: 'context7', type: 'http', origin: 'Community', status: 'none' },
      { name: 'github', type: 'http', origin: 'Community', status: 'auth' }
    ],
    tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_snapshot', 'browser_take_screenshot', 'browser_wait_for', 'browser_press_key', 'browser_tabs'],
    skills: [
      { name: 'pdf', desc: 'Read, fill, split and merge PDF files. Use when a task involves a .pdf.' },
      { name: 'docx', desc: 'Create and edit Word documents, keeping tracked changes and comments.' },
      { name: 'xlsx', desc: 'Read and write spreadsheets, formulas included.' },
      { name: 'pptx', desc: 'Build and edit slide decks from an outline.' },
      { name: 'skill-creator', desc: 'Write a new skill: folder, SKILL.md and a first test run.' },
      { name: 'webapp-testing', desc: 'Drive a local web app in a real browser to check a change.' }
    ],
    skillSrc: ['', '# pdf', '', 'Work on PDF files with tools already on this machine.', '', '## Read', '', '- Text: `pdftotext -layout in.pdf -`', '- Scanned pages: run `ocrmypdf in.pdf out.pdf` first.', '', '## Fill a form', '', '1. List the fields: `python3 scripts/fields.py form.pdf`', '2. Put the values in `fields.json`.', '3. Fill: `python3 scripts/fill.py form.pdf fields.json out.pdf`', '', '## Split or merge', '', '```', 'qpdf in.pdf --pages . 1-3 -- part.pdf', 'qpdf --empty --pages a.pdf b.pdf -- merged.pdf', '```'],
    plugins: [
      { name: 'commit-commands', mkt: 'claude-plugins-official', on: true, adds: '3 commands' },
      { name: 'frontend-design', mkt: 'claude-plugins-official', on: true, adds: '1 skill' },
      { name: 'pr-review-toolkit', mkt: 'claude-plugins-official', on: false, adds: '1 command · 6 agents' },
      { name: 'security-guidance', mkt: 'claude-plugins-official', on: true, adds: '1 hook' }
    ],
    pluginCmds: [
      { cmd: '/commit', desc: 'Write a git commit for the staged changes' },
      { cmd: '/commit-push-pr', desc: 'Commit, push and open a pull request' },
      { cmd: '/clean_gone', desc: 'Delete local branches whose remote is gone' }
    ],
    agents: [
      { name: 'architect', model: 'opus', desc: 'Designs the shape of a change before anyone builds it.' },
      { name: 'bilko-ceo', model: 'opus', desc: "Sets the week's priorities for Bilko." },
      { name: 'bilko-host-publisher', model: 'sonnet', desc: 'Publishes finished pages and checks they load.' },
      { name: 'blender-artist', model: 'sonnet', desc: 'Builds and renders 3D scenes from a brief.' },
      { name: 'builder', model: 'sonnet', desc: 'Implements a design end to end, with tests.' },
      { name: 'competitive-analyst', model: 'sonnet', desc: 'Compares a product with named rivals.' },
      { name: 'competitive-researcher', model: 'haiku', desc: 'Finds who else solves the problem.' },
      { name: 'demo-video-builder', model: 'sonnet', desc: 'Turns a working feature into a short demo.' },
      { name: 'dev-lead', model: 'opus', desc: 'Reviews plans and diffs, splits work into Epics.' }
    ],
    agentPrompt: ['You are the architect for this workspace.', '', 'Before any code is written, write a short design:', '', '1. The problem, in one sentence.', '2. What changes, and what must not.', '3. The data flow, step by step.', '4. Each risk, and how it will be checked.', '', 'Keep it under a page. Name files, not concepts.', 'Hand the builder a checklist, not an essay.']
  };

  // ---- DocEditor: one document model for every markdown file (lines, preview, outline, stats) ----
  var DOCS = {
    'claude-project': { src: [], empty: ['Nothing tells Claude how this repo works yet.', 'It loads this file into every session started in Self — and so does anyone who clones the repo.'] },
    'claude-global': { src: G.claudeMd },
    'skill-project': { src: skillSrc },
    'skill-global': { src: G.skillSrc },
    'agent': { src: G.agentPrompt },
    'memory': { mem: 'edit' },
    'memory-fix': { mem: 'edit-fix' }
  };
  function mdBlocks(src, big) {
    var out = [], fence = false, fm = false, buf = [], prevBlank = true;
    function push(kind, text, num) { out.push({ kind: kind, text: text, num: num }); }
    src.forEach(function (line, idx) {
      if (idx === 0 && line === '---') { fm = true; return; }
      if (fm) { if (line === '---') { fm = false; push('fm', buf.join('\n')); buf = []; } else buf.push(line); return; }
      if (/^```/.test(line)) { if (fence) { push('pre', buf.join('\n')); buf = []; } fence = !fence; prevBlank = false; return; }
      if (fence) { buf.push(line); return; }
      if (!line.trim()) { prevBlank = true; return; }
      var m, last = out[out.length - 1];
      if ((m = line.match(/^(#{1,3}) (.*)$/))) push('h' + m[1].length, m[2]);
      else if ((m = line.match(/^[-*] (.*)$/))) push('li', m[1]);
      else if ((m = line.match(/^(\d+)\. (.*)$/))) push('ol', m[2], m[1] + '.');
      else if (/^@/.test(line)) push('imp', line.slice(1));
      else if (!prevBlank && last && (last.kind === 'p' || last.kind === 'li' || last.kind === 'ol')) last.text += ' ' + line.trim();
      else push('p', line);
      prevBlank = false;
    });
    var S = big ? { h1: '32px', h2: '22px', p: '15.5px' } : { h1: '26px', h2: '19px', p: '14px' };
    return out.map(function (b, i) {
      var s = { ff: 'Geist,system-ui,sans-serif', fs: S.p, fw: 400, lh: '1.65', c: '#2a221a', bg: 'transparent', pad: '0px', r: '0px', bd: '0px solid transparent', ws: 'normal', bdisp: 'none', btxt: '', mt: i === 0 ? '0px' : '10px' };
      var raw = false;
      if (b.kind === 'h1') Object.assign(s, { ff: 'Newsreader,Georgia,serif', fs: S.h1, fw: 500, lh: '1.2', mt: i === 0 ? '0px' : '22px' });
      else if (b.kind === 'h2') Object.assign(s, { ff: 'Newsreader,Georgia,serif', fs: S.h2, fw: 600, lh: '1.3', mt: i === 0 ? '0px' : '20px' });
      else if (b.kind === 'h3') Object.assign(s, { fw: 600, mt: '14px' });
      else if (b.kind === 'li' || b.kind === 'ol') Object.assign(s, { lh: '1.55', mt: '6px', bdisp: 'block', btxt: b.kind === 'li' ? '•' : b.num });
      else if (b.kind === 'pre') { raw = true; Object.assign(s, { ff: "'IBM Plex Mono',monospace", fs: '12.5px', lh: '1.6', bg: '#f6efe1', pad: '10px 14px', r: '8px', bd: '1px solid #e8e0cd', ws: 'pre', mt: '10px' }); }
      else if (b.kind === 'fm') { raw = true; Object.assign(s, { ff: "'IBM Plex Mono',monospace", fs: '12px', lh: '1.6', c: '#5b4a36', bg: '#efe6d3', pad: '10px 14px', r: '8px', ws: 'pre-wrap' }); }
      else if (b.kind === 'imp') Object.assign(s, { ff: "'IBM Plex Mono',monospace", fs: '12.5px', mt: '8px', bdisp: 'block', btxt: '@' });
      s.kind = b.kind; s.src = b.text; s.sh = 'none'; s.caret = false;
      s.parts = raw ? [{ t: b.text, ff: 'inherit', fs: 'inherit', bg: 'transparent', pad: '0px', c: 'inherit', fw: 'inherit' }] : inline(b.text).map(function (r) {
        return { t: r.t, ff: r.code ? "'IBM Plex Mono',monospace" : 'inherit', fs: r.code ? '0.88em' : 'inherit', bg: r.code ? '#efe6d3' : 'transparent', pad: r.code ? '1px 5px' : '0px', c: r.code ? '#814024' : 'inherit', fw: r.bold ? 600 : 'inherit' };
      });
      return s;
    });
  }
  function docView(key, big, paper) {
    var d = DOCS[key] || DOCS['claude-global'];
    var th = paper
      ? { head: '#814024', headW: 600, code: '#b85c34', text: '#2a221a', fence: '#8a7a60', dash: '#8a7a60', key: '#814024', bold: '#2a221a', mark: '#d3a23c', caretBg: 'rgba(42,34,26,.05)' }
      : { head: '#e4b85a', headW: 600, code: '#e8a988', text: '#efe6d3', fence: '#8a7a60', dash: '#8a7a60', key: '#e4b85a', bold: '#fbf6ec', mark: '#e4b85a', caretBg: 'rgba(246,239,225,.07)' };
    var src = d.mem ? memSrcLines(d.mem === 'edit-fix' ? memBodyFixed : memBody) : d.src;
    var lines;
    if (d.mem) lines = memSource(th, d.mem);
    else if (!src.length) lines = [{ n: 1, parts: [{ t: '', c: th.text, w: 400 }], mk: 'transparent', bg: th.caretBg, caret: true }];
    else lines = code(th, src).map(function (l) { return { n: l.n, parts: l.parts, mk: 'transparent', bg: 'transparent', caret: false }; });
    lines.forEach(function (l) { l.lh = big ? '22px' : '21px'; l.gw = big ? '58px' : '50px'; });
    var text = src.join('\n');
    var outline = src.filter(function (l) { return /^#{1,3} /.test(l); }).map(function (l) {
      var lvl = l.match(/^#+/)[0].length;
      return { t: l.replace(/^#+ /, ''), pl: lvl === 1 ? '0px' : (lvl === 2 ? '14px' : '28px'), fw: lvl === 1 ? 600 : 400, c: lvl === 1 ? '#2a221a' : '#5b4a36' };
    });
    var blocks = (src.length ? mdBlocks(src, big) : []).filter(function (b) { return b.kind !== 'fm'; });
    if (d.mem === 'edit-fix') {
      var orig = mdBlocks(memSrcLines(memBody), big).filter(function (b) { return b.kind !== 'fm'; });
      blocks.forEach(function (b, i) { if (!orig[i] || orig[i].src !== b.src) Object.assign(b, { bg: 'rgba(228,184,90,.2)', sh: 'inset 3px 0 0 #d3a23c', pad: '6px 12px', r: '6px' }); });
    } else if (d.mem === 'edit') {
      blocks.forEach(function (b) { if (/^\*\*Why/.test(b.src)) b.caret = true; });
    }
    var fmProps = [];
    if (src[0] === '---') for (var fi = 1; fi < src.length && src[fi] !== '---'; fi++) { var k = src[fi].indexOf(':'); fmProps.push({ k: src[fi].slice(0, k), v: src[fi].slice(k + 1).trim() }); }
    return {
      lines: lines, blocks: blocks, fmProps: fmProps, hasProps: fmProps.length > 0, outline: outline, noHeadings: !outline.length,
      isEmpty: !src.length, emptyTitle: d.empty ? d.empty[0] : '', emptyText: d.empty ? d.empty[1] : '',
      nLines: src.length || 1, nWords: (text.match(/\S+/g) || []).length, nTokens: Math.round(text.length / 4),
      ln: d.mem === 'edit' ? 11 : (d.mem ? 13 : 1), col: d.mem === 'edit' ? src[10].length + 1 : 1
    };
  }

  window.CC_DATA = {
    memBodyFixed: memBodyFixed, evidence: evidence, fixDiff: fixDiff, memSource: memSource, G: G, docView: docView,
    icon: icon, inline: inline, prose: prose, code: code,
    memories: memories, agents: agents, skills: skills, servers: servers, groups: groups, sections: sections
  };
})();
