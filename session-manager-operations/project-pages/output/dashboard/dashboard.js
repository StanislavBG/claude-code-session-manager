// Usage dashboard — vanilla, dependency-free. Loaded as a classic <script>
// (no import/export) so it works both via file:// and any static host.
// Exposed as globalThis.Dashboard so it can also be loaded directly by tests.
(function (global) {
  'use strict';

  var ENDPOINT = '/api/admin/session-manager/usage?days=30';
  var LOOKBACK_DAYS = 30;

  // ---- pure helpers -------------------------------------------------

  // Secondary sort (occurrences desc) only breaks ties on the primary key
  // (installsAffected desc) — this ordering is the feature: a single
  // machine's OOM-kill loop emits hundreds of correlated rows and must not
  // outrank a bug hitting nine distinct installs once each.
  function rankIssues(issues) {
    return (issues || []).slice().sort(function (a, b) {
      if (b.installsAffected !== a.installsAffected) {
        return b.installsAffected - a.installsAffected;
      }
      return b.occurrences - a.occurrences;
    });
  }

  function truncateMessage(msg, max) {
    max = max || 140;
    var s = String(msg == null ? '' : msg);
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  var LA_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  function formatDateTimeLA(unixSeconds) {
    if (unixSeconds == null) return 'unknown';
    var d = new Date(unixSeconds * 1000);
    if (isNaN(d.getTime())) return 'unknown';
    return LA_FORMATTER.format(d);
  }

  function formatWindow(days) {
    var n = days == null ? LOOKBACK_DAYS : days;
    return 'last ' + n + ' days';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function compactNumber(n) {
    if (n == null || isNaN(n)) return '0';
    var abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  // Trend charts share a single y-scale per chart (never dual-axis) and stay
  // in the LA timezone by reusing formatDateTimeLA for axis labels — the date
  // string is normalized to noon UTC first so the local-day boundary can't
  // shift it to the adjacent calendar day.
  var CHART_W = 640;
  var CHART_H = 160;
  var CHART_PAD_L = 8;
  var CHART_PAD_R = 8;
  var CHART_PAD_T = 14;
  var CHART_PAD_B = 22;

  function shortDateLabel(dateStr) {
    if (!dateStr) return '';
    var t = Date.parse(String(dateStr) + 'T12:00:00Z');
    if (isNaN(t)) return String(dateStr);
    var full = formatDateTimeLA(Math.floor(t / 1000));
    var m = full.match(/^[A-Za-z]{3,9}\s\d{1,2}/);
    return m ? m[0] : full;
  }

  function chartX(i, n) {
    var usable = CHART_W - CHART_PAD_L - CHART_PAD_R;
    if (n <= 1) return CHART_PAD_L + usable / 2;
    return CHART_PAD_L + (i / (n - 1)) * usable;
  }

  function chartY(v, max) {
    var usable = CHART_H - CHART_PAD_T - CHART_PAD_B;
    return CHART_H - CHART_PAD_B - (v / max) * usable;
  }

  // rows: array of daily records. series: [{ key, label, color }] sharing one
  // y-scale. Degrades to a flat/centered layout for n===0 or n===1 rather
  // than dividing by zero.
  function buildTimeSeriesChart(rows, series, ariaLabel) {
    rows = rows || [];
    var n = rows.length;

    var overallMax = 0;
    series.forEach(function (s) {
      rows.forEach(function (r) {
        var v = Number(r[s.key]) || 0;
        if (v > overallMax) overallMax = v;
      });
    });
    if (overallMax <= 0) overallMax = 1;

    var baselineY = chartY(0, overallMax).toFixed(1);
    var gridline =
      '<line x1="' + CHART_PAD_L + '" y1="' + baselineY + '" x2="' + (CHART_W - CHART_PAD_R) +
      '" y2="' + baselineY + '" stroke="var(--gridline)" stroke-width="1" />';

    var marks = series.map(function (s) {
      if (n === 0) return '';
      if (n === 1) {
        var v0 = Number(rows[0][s.key]) || 0;
        return '<circle cx="' + chartX(0, n).toFixed(1) + '" cy="' + chartY(v0, overallMax).toFixed(1) +
          '" r="3" fill="' + s.color + '" />';
      }
      var pts = rows.map(function (r, i) {
        var v = Number(r[s.key]) || 0;
        return chartX(i, n).toFixed(1) + ',' + chartY(v, overallMax).toFixed(1);
      }).join(' ');
      return '<polyline points="' + pts + '" fill="none" stroke="' + s.color +
        '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />';
    }).join('');

    var xLabels = '';
    if (n > 0) {
      // n>=3 always yields three distinct indices; n===2 is the one case
      // where the midpoint formula would collide with an endpoint.
      var idxs = n === 1 ? [0] : n === 2 ? [0, 1] : [0, Math.floor((n - 1) / 2), n - 1];
      xLabels = idxs.map(function (i) {
        return '<text x="' + chartX(i, n).toFixed(1) + '" y="' + (CHART_H - 6) +
          '" font-size="10" fill="var(--text-muted)" text-anchor="middle">' +
          escapeHtml(shortDateLabel(rows[i].date)) + '</text>';
      }).join('');
    }

    var yLabel = '<text x="' + CHART_PAD_L + '" y="' + (CHART_PAD_T - 3) +
      '" font-size="10" fill="var(--text-muted)" text-anchor="start">' +
      escapeHtml(compactNumber(overallMax)) + '</text>';

    var legend = series.map(function (s) {
      return '<span class="chart-legend__item"><span class="chart-legend__swatch" style="background:' +
        s.color + '"></span>' + escapeHtml(s.label) + '</span>';
    }).join('');

    return (
      '<div class="chart">' +
        '<svg viewBox="0 0 ' + CHART_W + ' ' + CHART_H + '" role="img" aria-label="' + escapeHtml(ariaLabel) +
          '" preserveAspectRatio="none" class="chart__svg">' +
          '<title>' + escapeHtml(ariaLabel) + '</title>' +
          gridline + marks + xLabels + yLabel +
        '</svg>' +
        '<div class="chart-legend">' + legend + '</div>' +
      '</div>'
    );
  }

  function isEmptyPayload(data) {
    var installsTotal = data && data.installs ? data.installs.total : 0;
    var issuesCount = data && Array.isArray(data.issues) ? data.issues.length : 0;
    var launches = 0;
    if (data && data.usage && Array.isArray(data.usage.daily)) {
      launches = data.usage.daily.reduce(function (sum, row) { return sum + (row.launches || 0); }, 0);
    }
    return !installsTotal && !issuesCount && !launches;
  }

  // ---- rendering ------------------------------------------------------

  function statTile(label, value) {
    return (
      '<div class="stat-tile">' +
        '<div class="stat-tile__label">' + escapeHtml(label) + '</div>' +
        '<div class="stat-tile__value">' + escapeHtml(value) + '</div>' +
      '</div>'
    );
  }

  function renderInstalls(installs) {
    installs = installs || {};
    var byVersion = installs.byVersion || [];
    var byPlatform = installs.byPlatform || [];
    var specs = installs.specs || {};

    var tiles = [
      statTile('Total installs', compactNumber(installs.total || 0)),
      statTile('Active (7d)', compactNumber(installs.active7 || 0)),
      statTile('Active (30d)', compactNumber(installs.active30 || 0)),
      statTile('New (7d)', compactNumber(installs.new7 || 0)),
    ].join('');

    var versionRows = byVersion.map(function (v) {
      return (
        '<tr><td>' + escapeHtml(v.version) + '</td>' +
        '<td class="num">' + compactNumber(v.installs) + '</td>' +
        '<td class="num">' + compactNumber(v.active7) + '</td></tr>'
      );
    }).join('');

    var platformRows = byPlatform.map(function (p) {
      return (
        '<tr><td>' + escapeHtml(p.platform) + ' / ' + escapeHtml(p.arch) + '</td>' +
        '<td class="num">' + compactNumber(p.installs) + '</td></tr>'
      );
    }).join('');

    return (
      '<section class="panel" aria-labelledby="installs-heading">' +
        '<h2 id="installs-heading">Installs</h2>' +
        '<div class="stat-row">' + tiles + '</div>' +
        '<div class="two-col">' +
          '<div><h3>By version</h3><table><thead><tr><th>Version</th><th class="num">Installs</th><th class="num">Active (7d)</th></tr></thead><tbody>' +
            (versionRows || '<tr><td colspan="3" class="muted">No data</td></tr>') +
          '</tbody></table></div>' +
          '<div><h3>By platform</h3><table><thead><tr><th>Platform / arch</th><th class="num">Installs</th></tr></thead><tbody>' +
            (platformRows || '<tr><td colspan="2" class="muted">No data</td></tr>') +
          '</tbody></table>' +
          '<p class="muted">Median specs: ' + compactNumber(specs.medianTotalMemMb || 0) + ' MB RAM, ' +
            compactNumber(specs.medianCpuCount || 0) + ' CPUs</p></div>' +
        '</div>' +
      '</section>'
    );
  }

  function renderUsage(usage) {
    usage = usage || {};
    var daily = usage.daily || [];
    var byVersion = usage.byVersion || [];

    var maxLaunches = daily.reduce(function (m, r) { return Math.max(m, r.launches || 0); }, 0) || 1;
    var bars = daily.map(function (row) {
      var h = Math.round(((row.launches || 0) / maxLaunches) * 64);
      return (
        '<div class="bar" style="height:' + Math.max(h, 2) + 'px" ' +
        'title="' + escapeHtml(row.date) + ': ' + compactNumber(row.launches) + ' launches"></div>'
      );
    }).join('');

    var versionRows = byVersion.map(function (v) {
      return (
        '<tr><td>' + escapeHtml(v.version) + '</td>' +
        '<td class="num">' + compactNumber(v.launches) + '</td>' +
        '<td class="num">' + compactNumber(v.sessions) + '</td></tr>'
      );
    }).join('');

    var dailyChart = buildTimeSeriesChart(daily, [
      { key: 'launches', label: 'Launches', color: 'var(--series-1)' },
      { key: 'sessions', label: 'Sessions', color: 'var(--series-2)' },
    ], 'Daily launches and sessions over the window');

    return (
      '<section class="panel" aria-labelledby="usage-heading">' +
        '<h2 id="usage-heading">Usage</h2>' +
        dailyChart +
        '<div class="sparkbars" role="img" aria-label="Daily launches over the window">' + bars + '</div>' +
        '<table><thead><tr><th>Version</th><th class="num">Launches</th><th class="num">Sessions</th></tr></thead><tbody>' +
          (versionRows || '<tr><td colspan="3" class="muted">No data</td></tr>') +
        '</tbody></table>' +
      '</section>'
    );
  }

  function renderIssues(issues) {
    var ranked = rankIssues(issues);
    var rows = ranked.map(function (issue) {
      return (
        '<tr>' +
          '<td><code>' + escapeHtml(issue.signature) + '</code></td>' +
          '<td>' + escapeHtml(issue.name) + '</td>' +
          '<td>' + escapeHtml(truncateMessage(issue.msg)) + '</td>' +
          '<td class="num"><strong>' + compactNumber(issue.installsAffected) + '</strong></td>' +
          '<td class="num muted">' + compactNumber(issue.occurrences) + '</td>' +
          '<td>' + escapeHtml(formatDateTimeLA(issue.firstSeen)) + '</td>' +
          '<td>' + escapeHtml(formatDateTimeLA(issue.lastSeen)) + '</td>' +
          '<td>' + escapeHtml((issue.versions || []).join(', ')) + '</td>' +
        '</tr>'
      );
    }).join('');

    return (
      '<section class="panel" aria-labelledby="issues-heading">' +
        '<h2 id="issues-heading">Issues to act on</h2>' +
        '<p class="muted">Ranked by distinct installs affected, not raw occurrence count.</p>' +
        '<table><thead><tr>' +
          '<th>Signature</th><th>Name</th><th>Message</th>' +
          '<th class="num">Installs affected</th><th class="num">Occurrences</th>' +
          '<th>First seen</th><th>Last seen</th><th>Versions</th>' +
        '</tr></thead><tbody>' +
          (rows || '<tr><td colspan="8" class="muted">No issues reported in this window</td></tr>') +
        '</tbody></table>' +
      '</section>'
    );
  }

  function renderErrors(errors) {
    errors = errors || {};
    var byVersion = errors.byVersion || [];
    var daily = errors.daily || [];
    var rows = byVersion.map(function (v) {
      return (
        '<tr><td>' + escapeHtml(v.version) + '</td>' +
        '<td class="num">' + compactNumber(v.errors) + '</td>' +
        '<td class="num">' + compactNumber(v.warns) + '</td>' +
        '<td class="num">' + compactNumber(v.installsAffected) + '</td></tr>'
      );
    }).join('');

    var dailyChart = buildTimeSeriesChart(daily, [
      { key: 'errors', label: 'Errors', color: 'var(--series-1)' },
      { key: 'warns', label: 'Warnings', color: 'var(--series-2)' },
    ], 'Daily errors and warnings over the window');

    return (
      '<section class="panel" aria-labelledby="errors-heading">' +
        '<h2 id="errors-heading">Errors by version</h2>' +
        dailyChart +
        '<table><thead><tr><th>Version</th><th class="num">Errors</th><th class="num">Warnings</th><th class="num">Installs affected</th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="4" class="muted">No data</td></tr>') +
        '</tbody></table>' +
      '</section>'
    );
  }

  function renderHeader(data) {
    return (
      '<header class="page-header">' +
        '<h1>Session Manager — usage dashboard</h1>' +
        '<p class="muted">Generated ' + escapeHtml(formatDateTimeLA(data.generatedAt)) +
          ' · window: ' + escapeHtml(formatWindow(data.windowDays)) + '</p>' +
      '</header>'
    );
  }

  function renderDashboard(root, data) {
    root.innerHTML =
      renderHeader(data) +
      renderInstalls(data.installs) +
      renderUsage(data.usage) +
      renderIssues(data.issues) +
      renderErrors(data.errors);
  }

  function renderMessageState(root, opts) {
    root.innerHTML =
      '<div class="state-card" data-state="' + escapeHtml(opts.state) + '">' +
        '<h2>' + escapeHtml(opts.title) + '</h2>' +
        '<p>' + escapeHtml(opts.body) + '</p>' +
        (opts.hint ? '<p class="muted">' + escapeHtml(opts.hint) + '</p>' : '') +
      '</div>';
  }

  function renderLoading(root) {
    renderMessageState(root, {
      state: 'loading',
      title: 'Loading usage data…',
      body: 'Fetching the last ' + LOOKBACK_DAYS + ' days from the collector.',
    });
  }

  function renderEmpty(root, data) {
    renderMessageState(root, {
      state: 'empty',
      title: 'No data yet',
      body: 'The collector is reachable but has not recorded any installs, launches, or issues for ' + formatWindow(data && data.windowDays) + '.',
    });
  }

  function renderUnauthorized(root) {
    renderMessageState(root, {
      state: 'unauthorized',
      title: 'Sign-in required',
      body: 'Sign in at bilko.run/admin to view this dashboard.',
    });
  }

  function renderNotDeployed(root) {
    renderMessageState(root, {
      state: 'not-deployed',
      title: 'The collector endpoint is not live yet',
      body: 'This page expects GET ' + ENDPOINT + ' on the same origin, gated behind bilko.run admin sign-in.',
      hint: 'Once the endpoint ships, this page will render real data automatically — no changes needed here.',
    });
  }

  function renderNetworkFailure(root, detail) {
    renderMessageState(root, {
      state: 'network-error',
      title: 'Could not reach the collector',
      body: 'A network error stopped this page from loading usage data. Check your connection and reload.',
      hint: detail ? String(detail) : undefined,
    });
  }

  // ---- fetch orchestration --------------------------------------------

  function loadFixture(fetchImpl) {
    return fetchImpl('./fixture.json').then(function (res) {
      if (!res.ok) throw new Error('fixture fetch failed: ' + res.status);
      return res.json();
    });
  }

  function loadLive(fetchImpl) {
    return fetchImpl(ENDPOINT, { headers: { Accept: 'application/json' } });
  }

  // root: DOM element. deps: { fetchImpl, search } — injectable for tests.
  function init(root, deps) {
    deps = deps || {};
    var fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    var search = deps.search != null ? deps.search : (typeof location !== 'undefined' ? location.search : '');
    var params = new URLSearchParams(search);
    var useFixture = params.get('fixture') === '1';

    renderLoading(root);

    if (!fetchImpl) {
      renderNetworkFailure(root, 'fetch is not available in this environment');
      return Promise.resolve();
    }

    if (useFixture) {
      return loadFixture(fetchImpl)
        .then(function (data) {
          if (isEmptyPayload(data)) renderEmpty(root, data);
          else renderDashboard(root, data);
        })
        .catch(function (err) { renderNetworkFailure(root, err && err.message); });
    }

    return loadLive(fetchImpl)
      .then(function (res) {
        if (res.status === 401 || res.status === 403) {
          renderUnauthorized(root);
          return;
        }
        if (res.status === 404) {
          renderNotDeployed(root);
          return;
        }
        if (!res.ok) {
          renderNetworkFailure(root, 'unexpected response: ' + res.status);
          return;
        }
        return res.json().then(function (data) {
          if (isEmptyPayload(data)) renderEmpty(root, data);
          else renderDashboard(root, data);
        });
      })
      .catch(function (err) {
        renderNetworkFailure(root, err && err.message);
      });
  }

  var api = {
    ENDPOINT: ENDPOINT,
    rankIssues: rankIssues,
    truncateMessage: truncateMessage,
    formatDateTimeLA: formatDateTimeLA,
    formatWindow: formatWindow,
    compactNumber: compactNumber,
    isEmptyPayload: isEmptyPayload,
    buildTimeSeriesChart: buildTimeSeriesChart,
    shortDateLabel: shortDateLabel,
    renderDashboard: renderDashboard,
    renderLoading: renderLoading,
    renderEmpty: renderEmpty,
    renderUnauthorized: renderUnauthorized,
    renderNotDeployed: renderNotDeployed,
    renderNetworkFailure: renderNetworkFailure,
    init: init,
  };

  global.Dashboard = api;

  if (typeof document !== 'undefined' && document.currentScript) {
    document.addEventListener('DOMContentLoaded', function () {
      var root = document.getElementById('app');
      if (root) init(root);
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
