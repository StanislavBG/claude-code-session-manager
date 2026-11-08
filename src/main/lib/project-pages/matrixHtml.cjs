'use strict';

/**
 * matrixHtml.cjs — renders a valid CompetitiveMatrix (competitiveMatrix.cjs)
 * into one self-contained, read-only HTML page for the Project Home Pages
 * library. Pure: no I/O. No <script>, no href=/src= attributes, no CSS url(),
 * so the page passes validateHomeHtml and never reaches the network.
 *
 * Every matrix string comes from web research, so every one of them goes
 * through escapeHtml before it reaches the document.
 */

const { missingFeatures } = require('./competitiveMatrix.cjs');

const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'none'];

const STATUS = {
  yes: { symbol: '✓', label: 'Has it' },
  partial: { symbol: '◐', label: 'Partial' },
  no: { symbol: '✗', label: 'Missing' },
  unknown: { symbol: '?', label: 'Unknown' },
};

const ESCAPES = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '@': '&#64;', '(': '&#40;',
};

/**
 * Escape & < > " ' for text and attribute contexts, plus @ and ( so research
 * text like "@import url(https://…)" or "eval(" never trips validateHomeHtml's
 * literal pattern checks.
 */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"'@(]/g, (c) => ESCAPES[c]);
}

const CSS = `
:root{--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--border:#d0d7de;--head:#f6f8fa;
--yes-bg:#dafbe1;--yes-fg:#116329;--partial-bg:#fff8c5;--partial-fg:#7d4e00;
--no-bg:#ffebe9;--no-fg:#a40e26;--unknown-bg:#eaeef2;--unknown-fg:#57606a;--accent:#0969da}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--border:#30363d;--head:#161b22;
--yes-bg:#0f2e1a;--yes-fg:#56d364;--partial-bg:#2e2508;--partial-fg:#e3b341;
--no-bg:#3a1118;--no-fg:#ff7b72;--unknown-bg:#21262d;--unknown-fg:#8d96a0;--accent:#4493f8}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);
font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px}
h3{font-size:15px;margin:18px 0 6px}
.meta,.muted{color:var(--muted)}
.meta{margin:0 0 8px}
.vs{font-weight:400;color:var(--muted)}
.empty{padding:16px;border:1px dashed var(--border);border-radius:6px;color:var(--muted)}
.scroll{overflow-x:auto;border:1px solid var(--border);border-radius:6px;margin-bottom:8px}
table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px}
th,td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
thead th{background:var(--head);font-weight:600;white-space:nowrap}
th.feat{position:sticky;left:0;z-index:1;background:var(--head);min-width:180px;max-width:280px}
tbody th.feat{background:var(--bg);font-weight:500}
tr:last-child th,tr:last-child td{border-bottom:none}
.chip{display:inline-block;padding:1px 7px;border-radius:10px;font-weight:600;font-size:12px;white-space:nowrap}
.s-yes{background:var(--yes-bg);color:var(--yes-fg)}
.s-partial{background:var(--partial-bg);color:var(--partial-fg)}
.s-no{background:var(--no-bg);color:var(--no-fg)}
.s-unknown{background:var(--unknown-bg);color:var(--unknown-fg)}
.note{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.prio{display:inline-block;min-width:34px;text-align:center;padding:1px 6px;border-radius:4px;
border:1px solid var(--border);font-weight:700;font-size:12px;margin-right:6px}
.p-P0{color:var(--no-fg);border-color:var(--no-fg)}
.p-P1{color:var(--partial-fg);border-color:var(--partial-fg)}
ol,ul{padding-left:20px}
li{margin:4px 0}
.feature{border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin:8px 0}
.feature h3{margin:0 0 4px}
.url{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;color:var(--accent)}
`;

function rank(f) {
  return PRIORITIES.indexOf(f.recommendation.priority);
}

function byPriorityThenTitle(a, b) {
  return (rank(a) - rank(b)) || a.title.localeCompare(b.title);
}

function dateOf(iso) {
  return escapeHtml(String(iso || '').slice(0, 10));
}

function chip(status) {
  const s = STATUS[status] || STATUS.unknown;
  const key = STATUS[status] ? status : 'unknown';
  return `<span class="chip s-${key}">${s.symbol} ${s.label}</span>`;
}

function renderHeader(matrix) {
  const names = matrix.competitors.map((c) => escapeHtml(c.name)).join(', ');
  const runs = matrix.runs.length;
  return [
    '<header>',
    `<h1>${escapeHtml(matrix.product.name)} <span class="vs">vs ${names}</span></h1>`,
    `<p class="meta">Updated ${dateOf(matrix.updatedAt)} · ${runs} run${runs === 1 ? '' : 's'}`
      + ` · ${matrix.features.length} feature${matrix.features.length === 1 ? '' : 's'}</p>`,
    matrix.product.summary ? `<p class="muted">${escapeHtml(matrix.product.summary)}</p>` : '',
    '</header>',
  ].join('\n');
}

function renderGroupTable(group, features, products) {
  const out = [];
  out.push(`<h3>${escapeHtml(group.title)}</h3>`);
  if (group.description) out.push(`<p class="muted">${escapeHtml(group.description)}</p>`);
  out.push('<div class="scroll"><table><thead><tr><th class="feat">Feature</th>');
  for (const p of products) out.push(`<th>${escapeHtml(p.name)}</th>`);
  out.push('</tr></thead><tbody>');
  for (const f of features) {
    out.push(`<tr><th class="feat">${escapeHtml(f.title)}</th>`);
    for (const p of products) {
      const s = f.support[p.id] || { status: 'unknown', note: '' };
      const note = s.note ? `<span class="note">${escapeHtml(s.note)}</span>` : '';
      out.push(`<td>${chip(s.status)}${note}</td>`);
    }
    out.push('</tr>');
  }
  out.push('</tbody></table></div>');
  return out.join('');
}

function renderMatrixSection(matrix) {
  const out = ['<section>', '<h2>Feature matrix</h2>'];
  if (matrix.features.length === 0) {
    out.push('<p class="empty">No features yet</p>', '</section>');
    return out.join('\n');
  }
  const products = [{ id: 'self', name: matrix.product.name }, ...matrix.competitors];
  for (const g of matrix.groups) {
    const features = matrix.features.filter((f) => f.groupId === g.id).sort(byPriorityThenTitle);
    if (features.length === 0) continue;
    out.push(renderGroupTable(g, features, products));
  }
  out.push('</section>');
  return out.join('\n');
}

function renderRecommendations(matrix) {
  const missing = missingFeatures(matrix);
  const out = ['<section>', '<h2>Recommendations</h2>'];
  if (missing.length === 0) {
    out.push('<p class="muted">Nothing missing — every tracked feature is covered.</p>');
  } else {
    out.push('<ol>');
    for (const f of missing) {
      const p = f.recommendation.priority;
      out.push(`<li><span class="prio p-${escapeHtml(p)}">${escapeHtml(p)}</span>`
        + `<strong>${escapeHtml(f.title)}</strong> ${chip(f.support.self.status)}`
        + (f.recommendation.rationale ? `<span class="note">${escapeHtml(f.recommendation.rationale)}</span>` : '')
        + '</li>');
    }
    out.push('</ol>');
  }
  out.push('</section>');
  return out.join('\n');
}

function renderDetails(matrix) {
  if (matrix.features.length === 0) return '';
  const groupTitle = new Map(matrix.groups.map((g) => [g.id, g.title]));
  const groupOrder = new Map(matrix.groups.map((g, i) => [g.id, i]));
  const features = matrix.features.slice().sort((a, b) =>
    (groupOrder.get(a.groupId) - groupOrder.get(b.groupId)) || byPriorityThenTitle(a, b));
  const out = ['<section>', '<h2>Feature details</h2>'];
  for (const f of features) {
    out.push('<div class="feature">',
      `<h3>${escapeHtml(f.title)} <span class="vs">· ${escapeHtml(groupTitle.get(f.groupId) || f.groupId)}</span></h3>`,
      `<p>${escapeHtml(f.description)}</p>`,
      `<p class="muted">Sentiment: <strong>${escapeHtml(f.sentiment.signal)}</strong>`
        + (f.sentiment.summary ? ` — ${escapeHtml(f.sentiment.summary)}` : '') + '</p>',
      '</div>');
  }
  out.push('</section>');
  return out.join('\n');
}

function renderSources(matrix) {
  const out = ['<section>', '<h2>Sources</h2>'];
  if (matrix.sources.length === 0) {
    out.push('<p class="muted">No sources yet</p>');
  } else {
    out.push('<ul>');
    for (const s of matrix.sources) {
      const bits = [s.publisher, s.publishedAt].filter(Boolean).map(escapeHtml).join(' · ');
      out.push(`<li><strong>${escapeHtml(s.title)}</strong>`
        + (bits ? ` <span class="muted">${bits}</span>` : '')
        + `<span class="note url">${escapeHtml(s.url)}</span></li>`);
    }
    out.push('</ul>');
  }
  out.push('</section>');
  return out.join('\n');
}

function renderRuns(matrix) {
  const runs = matrix.runs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const out = ['<section>', '<h2>Run history</h2>', '<ul>'];
  for (const r of runs) {
    out.push(`<li><strong>${escapeHtml(String(r.at).replace('T', ' ').slice(0, 16))}</strong>`
      + ` <span class="muted">${escapeHtml(r.model)} · ${r.added.length} added · ${r.changed.length} changed`
      + (r.competitors.length ? ` · vs ${r.competitors.map(escapeHtml).join(', ')}` : '') + '</span>'
      + (r.notes ? `<span class="note">${escapeHtml(r.notes)}</span>` : '') + '</li>');
  }
  out.push('</ul>', '</section>');
  return out.join('\n');
}

/** renderMatrixHtml(matrix) → complete self-contained HTML document string. */
function renderMatrixHtml(matrix) {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(matrix.product.name)} — Competitor matrix</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
    renderHeader(matrix),
    renderMatrixSection(matrix),
    renderRecommendations(matrix),
    renderDetails(matrix),
    renderSources(matrix),
    renderRuns(matrix),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

module.exports = { renderMatrixHtml, escapeHtml };
