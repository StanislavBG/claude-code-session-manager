// Phone-remote telemetry -> bilko.run observability pipeline. Mirrors host-kit's wire
// format (batch of events) but sends each event immediately: host-kit is a sibling-repo
// file: dependency and would break `npm ci` in job worktrees. Relative endpoint is
// deliberate — the bundle is only ever served same-origin from bilko.run, which stamps
// session_id/visitor_id from its own cookies.
export const APP = 'session-manager';

const ENDPOINT = '/api/telemetry/event';
const FLOW_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PII_RE = /(email|password|token|key|ssn|card|cvv|apikey)/i;

function send(name: string, props?: Record<string, unknown>): void {
  try {
    const p: Record<string, unknown> = { ...(props ?? {}) };
    if (p.path === undefined && typeof location !== 'undefined') p.path = location.pathname;
    for (const k of Object.keys(p)) if (PII_RE.test(k)) p[k] = '[redacted]';
    const body = JSON.stringify({ batch: [{ app: APP, name, ts: Date.now(), props: p }] });
    let sent = false;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        sent = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      }
    } catch { /* fall through to fetch */ }
    if (!sent && typeof fetch === 'function') {
      void fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
        credentials: 'same-origin',
      }).catch(() => {});
    }
  } catch { /* telemetry never breaks the app */ }
}

export function track(name: string, props?: Record<string, unknown>): void {
  send(name, props);
}

export function trackFlow(flow: string, step: string, props?: Record<string, unknown>): void {
  if (!FLOW_RE.test(flow) || !FLOW_RE.test(step)) return;
  send(`${flow}.${step}`, { ...(props ?? {}), flow, step });
}

export function trackScreen(screen: string): void {
  if (!FLOW_RE.test(screen)) return;
  send('screen_view', { screen });
}
