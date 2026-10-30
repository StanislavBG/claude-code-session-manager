// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { IFRAME_SANDBOX, buildSrcDoc } from '../components/RemoteRenderer';

const PROBE = "parent.postMessage({ type: 'sm-ipc', channel: 'probe', id: 1, args: [] }, '*');";
const HTML = '<!doctype html><html><head></head><body><script type="module" src="./app.js"></script></body></html>';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch(); // fail, never skip
}, 30_000);
afterAll(async () => { await browser?.close(); });

async function parentPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.route('https://sm-parent.test/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('https://sm-parent.test/');
  return page;
}

describe('RemoteRenderer boot in a real opaque-origin sandbox', () => {
  it('delivers the probe via sm-boot-ready / sm-boot', async () => {
    const page = await parentPage();
    const srcdoc = buildSrcDoc(HTML, new Map());
    const got = await page.evaluate(({ srcdoc, sandbox, code }) => new Promise<boolean>((resolve) => {
      const f = document.createElement('iframe');
      window.addEventListener('message', (e) => {
        if (e.source !== f.contentWindow) return;
        if (e.data?.type === 'sm-boot-ready') f.contentWindow!.postMessage({ type: 'sm-boot', scripts: [{ module: true, code }] }, '*');
        else if (e.data?.type === 'sm-ipc' && e.data.channel === 'probe') resolve(true);
      });
      setTimeout(() => resolve(false), 5000);
      f.setAttribute('sandbox', sandbox);
      f.srcdoc = srcdoc;
      document.body.appendChild(f);
    }), { srcdoc, sandbox: IFRAME_SANDBOX, code: PROBE });
    await page.close();
    expect(got).toBe(true);
  }, 10_000);

  it('the pre-fix parent-origin blob: module src never delivers the probe', async () => {
    const page = await parentPage();
    const got = await page.evaluate(({ sandbox, code }) => new Promise<boolean>((resolve) => {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const f = document.createElement('iframe');
      window.addEventListener('message', (e) => {
        if (e.source === f.contentWindow && e.data?.type === 'sm-ipc') resolve(true);
      });
      setTimeout(() => resolve(false), 3000);
      f.setAttribute('sandbox', sandbox);
      f.srcdoc = `<!doctype html><html><head></head><body><script type="module" src="${url}"></script></body></html>`;
      document.body.appendChild(f);
    }), { sandbox: IFRAME_SANDBOX, code: PROBE });
    await page.close();
    expect(got).toBe(false);
  }, 10_000);
});
