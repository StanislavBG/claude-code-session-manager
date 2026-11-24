// App wiring — open captures first, describe → send pipeline, receipt / error + outbox, identify.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'preact/test-utils';
import type { CaptureResult } from '../capture';
import { resolveConfig, type ResolvedConfig } from '../host';
import type { EnqueueInput } from '../outbox';
import type { SendOptions, SendResult } from '../transport';
import { mountApp, toDraftMarks, type AppServices, type MountedApp } from '../ui/App';

if (!('adoptedStyleSheets' in ShadowRoot.prototype)) {
  const sheets = new WeakMap<ShadowRoot, CSSStyleSheet[]>();
  Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
    configurable: true,
    get(this: ShadowRoot) {
      return sheets.get(this) ?? [];
    },
    set(this: ShadowRoot, v: CSSStyleSheet[]) {
      sheets.set(this, v);
    },
  });
}

const KEY = 'fbk1_ABCDEFGH.AAAAAAAAAAAAAAAAAAAAAA';

let host: HTMLDivElement;
let shadow: ShadowRoot;
let app: MountedApp | null;
let log: string[];
let sendResults: SendResult[];
let sent: SendOptions[];
let queued: EnqueueInput[];
let visibleAtCapture: boolean[];

function config(): ResolvedConfig {
  window.FeedbackConfig = { key: KEY, project: 'demo' };
  return resolveConfig(null);
}

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

function services(): Partial<AppServices> {
  let ids = 0;
  return {
    capture: async () => {
      log.push('capture');
      visibleAtCapture.push(shadow.querySelector('.fw-tb, .fw-surface, .fw-launcher') !== null);
      const r: CaptureResult = { png: new Blob([new Uint8Array([1])], { type: 'image/png' }), width: 800, height: 600, scale: 1 };
      return r;
    },
    flatten: async (png) => {
      log.push('flatten');
      return png;
    },
    // jsdom's FormData/Blob cannot feed Node's Response (report.spec.ts runs the real one under
    // the node environment), so the body here is the report JSON itself.
    multipart: async (report) => {
      log.push('multipart');
      return {
        body: new TextEncoder().encode(JSON.stringify(report)) as Uint8Array<ArrayBuffer>,
        contentType: 'multipart/form-data; boundary=test',
      };
    },
    send: async (o) => {
      log.push('send');
      sent.push(o);
      o.onProgress?.({ loaded: 50, total: 100 });
      return sendResults.shift() ?? { ok: true, id: 'fb_x' };
    },
    enqueue: async (i) => {
      queued.push(i);
      return true;
    },
    newId: () => `cid-${++ids}`,
  };
}

async function mount(user: { name: string } | null = null) {
  await act(async () => {
    app = mountApp({ config: config(), hostEl: host, shadow, buffers: null, user, services: services() });
  });
  await flush();
}

/** Polls (real timers) until `ok()` holds — the multipart body is built through Response streams. */
async function until(ok: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await flush(1);
}

const q = <T extends Element = HTMLElement>(sel: string) => shadow.querySelector<T>(sel);
const click = async (sel: string) => {
  await act(async () => {
    q(sel)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
};
const settled = () =>
  q('[data-part="receipt"]') !== null || q('[data-part="error-banner"]') !== null || q('#fw-pn-title-error') !== null;
const send = async () => {
  await click('[data-part="send"]');
  await until(settled);
};
const typeTitle = async (v: string) => {
  const input = q<HTMLInputElement>('#fw-pn-title')!;
  await act(async () => {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
async function openAndDescribe(title = 'Button broken') {
  await act(async () => app!.open());
  await flush();
  await click('[data-part="describe"]');
  await typeTitle(title);
}

beforeEach(() => {
  log = [];
  sent = [];
  queued = [];
  sendResults = [];
  visibleAtCapture = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  shadow = host.attachShadow({ mode: 'open' });
});

afterEach(async () => {
  await act(async () => app?.unmount());
  app = null;
  host.remove();
  delete window.FeedbackConfig;
});

describe('App', () => {
  it('captures before any widget UI shows, then shows chrome and toolbar', async () => {
    await mount();
    expect(q('.fw-launcher')).not.toBeNull();
    expect(q('.fw-surface')).toBeNull();
    await act(async () => app!.open());
    await flush();
    expect(log).toEqual(['capture']);
    expect(visibleAtCapture).toEqual([false]);
    expect(q('.fw-surface')).not.toBeNull();
    expect(q('.fw-tb')?.classList.contains('fw-tb-hidden')).toBe(false);
    expect(q('.fw-launcher')).toBeNull();
  });

  it('Shift+F and the launcher open through the same capture path', async () => {
    await mount();
    await click('.fw-launcher');
    expect(log).toEqual(['capture']);
    await act(async () => app!.close());
    await flush();
    expect(q('.fw-surface')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', shiftKey: true }));
    });
    await flush();
    expect(log).toEqual(['capture', 'capture']);
    expect(q('.fw-surface')).not.toBeNull();
  });

  it('Describe enters review; close() with content asks to discard', async () => {
    await mount();
    await openAndDescribe('Something');
    expect(q('.fw-panel')?.classList.contains('fw-panel--hidden')).toBe(false);
    await act(async () => app!.close());
    await flush();
    expect(q('.fw-discard-scrim')).not.toBeNull();
    await click('.fw-discard-go');
    expect(q('.fw-surface')).toBeNull();
  });

  it('Send validates the title first', async () => {
    await mount();
    await openAndDescribe('ab');
    await send();
    expect(log).toEqual(['capture']);
    expect(q('#fw-pn-title-error')).not.toBeNull();
  });

  it('ok: build → flatten → send, then the receipt with the id; Done returns to idle', async () => {
    await mount({ name: 'Ada Lovelace' });
    await openAndDescribe();
    await send();
    expect(log).toEqual(['capture', 'flatten', 'multipart', 'send']);
    const o = sent[0]!;
    expect(o.clientReportId).toBe('cid-1');
    expect(o.key).toEqual({ boxId: 'ABCDEFGH', fingerprint: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(o.multipart.contentType).toMatch(/^multipart\/form-data/);
    const text = new TextDecoder().decode(o.multipart.body);
    expect(text).toContain('"title":"Button broken"');
    expect(text).toContain('"clientReportId":"cid-1"');
    expect(text).toContain('"user":{"id":"Ada Lovelace","name":"Ada Lovelace"}');
    expect(q('[data-part="receipt"]')?.textContent).toContain('fb_x');
    await click('[data-part="done"]');
    expect(q('.fw-surface')).toBeNull();
    expect(q('.fw-launcher')).not.toBeNull();
  });

  it('retryable: error state + outbox with the same id; Retry now re-sends it', async () => {
    sendResults = [{ ok: false, kind: 'retryable' }, { ok: true, id: 'fb_2' }];
    await mount();
    await openAndDescribe();
    await send();
    expect(q('[data-part="error-banner"]')).not.toBeNull();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.clientReportId).toBe('cid-1');
    expect(queued[0]!.key).toBe(KEY);
    expect(q('[data-part="send-label"]')?.textContent).toBe('Retry now');
    await send();
    expect(sent.map((s) => s.clientReportId)).toEqual(['cid-1', 'cid-1']);
    expect(q('[data-part="receipt"]')?.textContent).toContain('fb_2');
  });

  it('rejected failures are not queued', async () => {
    sendResults = [{ ok: false, kind: 'rejected', status: 400 }];
    await mount();
    await openAndDescribe();
    await send();
    expect(q('[data-part="error-banner"]')).not.toBeNull();
    expect(queued).toHaveLength(0);
  });

  it('Send another re-captures and starts a fresh report', async () => {
    await mount();
    await openAndDescribe();
    await send();
    await click('[data-part="send-another"]');
    expect(log.filter((l) => l === 'capture')).toHaveLength(2);
    expect(q('.fw-tb')?.classList.contains('fw-tb-hidden')).toBe(false);
    await click('[data-part="describe"]');
    expect(q<HTMLInputElement>('#fw-pn-title')!.value).toBe('');
    await typeTitle('Second one');
    await send();
    expect(sent.map((s) => s.clientReportId)).toEqual(['cid-1', 'cid-2']);
  });

  it('identify(user|null) updates the footer and the report user', async () => {
    await mount();
    await act(async () => app!.identify({ id: 'u1', name: 'Grace Hopper' }));
    await openAndDescribe();
    expect(q('[data-part="name"]')?.textContent).toBe('Grace Hopper');
    await act(async () => app!.identify(null));
    await flush();
    expect(q('[data-part="name"]')?.textContent).not.toBe('Grace Hopper');
    await send();
    expect(new TextDecoder().decode(sent[0]!.multipart.body)).toContain('"user":null');
  });

  it('toDraftMarks maps UI marks to report marks', () => {
    const out = toDraftMarks([
      { id: 'a', kind: 'pin', x: 1, y: 2, color: '#a83818', comment: 'hi' },
      { id: 'b', kind: 'draw', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], color: '#1a1612' },
      { id: 'c', kind: 'element', x: 0, y: 0, w: 10, h: 10, color: '#a83818', selector: 'button.go' },
    ]);
    expect(out[0]).toMatchObject({ kind: 'pin', note: 'hi' });
    expect(out[1]).toMatchObject({ kind: 'draw', points: [[1, 1], [2, 2]] });
    expect(out[2]).toMatchObject({ kind: 'element', element: { selector: 'button.go', tag: 'button' } });
  });
});
