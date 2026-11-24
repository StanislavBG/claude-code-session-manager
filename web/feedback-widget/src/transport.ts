// transport — the one network path for reports ("Host contract v1",
// session-manager-operations/architecture/site-feedback.md).
//
// Sealed (default): GET <relayBase>/api/sm-relay/boxes/<boxId>/key, refuse on a fingerprint
// mismatch, seal the multipart body to the box key and POST the envelope.
// Plain (`endpoint` set): POST the handoff's multipart body unchanged to the site's own endpoint.
// Both POSTs use XHR so the UI gets upload progress.

import { parseKey, type BoxKey } from './host';
import type { MultipartBody } from './report';
import { keyFingerprint, sealEnvelope } from './seal';

export const DEFAULT_RELAY_BASE = 'https://bilko.run';
export const DEFAULT_TIMEOUT_MS = 20_000;
const RELAY_PREFIX = '/api/sm-relay/boxes/';

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface SendOptions {
  /** `fbk1_<boxId>.<fingerprint>` or its parsed form. Required unless `endpoint` is set. */
  key?: string | BoxKey | null;
  multipart: MultipartBody;
  /** Same value on every retry of one report (the relay dedupes on it). */
  clientReportId: string;
  relayBase?: string;
  /** Custom endpoint: plain multipart POST, no sealing. */
  endpoint?: string;
  /** Sent as X-Feedback-Project on plain sends. */
  project?: string;
  onProgress?: (p: UploadProgress) => void;
  timeoutMs?: number;
}

export type SendResult =
  | { ok: true; id?: string }
  | { ok: false; kind: 'key_mismatch' }
  | { ok: false; kind: 'retryable' }
  | { ok: false; kind: 'rejected'; status: number };

const RETRYABLE: SendResult = { ok: false, kind: 'retryable' };

/** 2xx ok; 0 (network/CORS/timeout), 5xx, 408, 429 retryable; any other 4xx (or odd status) rejected. */
export function classifyStatus(status: number, bodyText: string): SendResult {
  if (status >= 200 && status < 300) {
    let id: string | undefined;
    try {
      const j: unknown = JSON.parse(bodyText);
      if (j && typeof j === 'object' && typeof (j as { id?: unknown }).id === 'string') {
        id = (j as { id: string }).id;
      }
    } catch {
      /* non-JSON 2xx body is still a success */
    }
    return id === undefined ? { ok: true } : { ok: true, id };
  }
  if (status === 0 || status >= 500 || status === 408 || status === 429) return RETRYABLE;
  return { ok: false, kind: 'rejected', status };
}

interface XhrOutcome {
  /** 0 = network error, CORS refusal or timeout. */
  status: number;
  body: string;
  timedOut: boolean;
  /** True once any upload progress was seen (the CORS preflight passed). */
  uploaded: boolean;
}

function xhrPost(
  url: string,
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
  timeoutMs: number,
  onProgress?: (p: UploadProgress) => void,
): Promise<XhrOutcome> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let uploaded = false;
    let settled = false;
    const done = (o: Omit<XhrOutcome, 'uploaded'>): void => {
      if (settled) return;
      settled = true;
      resolve({ ...o, uploaded });
    };
    xhr.open('POST', url, true);
    xhr.timeout = timeoutMs;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.loaded > 0) uploaded = true;
      onProgress?.({ loaded: e.loaded, total: e.lengthComputable ? e.total : body.length });
    };
    xhr.onload = () => done({ status: xhr.status, body: xhr.responseText, timedOut: false });
    xhr.onerror = () => done({ status: 0, body: '', timedOut: false });
    xhr.onabort = () => done({ status: 0, body: '', timedOut: false });
    xhr.ontimeout = () => done({ status: 0, body: '', timedOut: true });
    try {
      xhr.send(body);
    } catch {
      done({ status: 0, body: '', timedOut: false });
    }
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

async function sendPlain(o: SendOptions & { endpoint: string }, timeoutMs: number): Promise<SendResult> {
  const headers: Record<string, string> = { 'Content-Type': o.multipart.contentType };
  if (o.project) headers['X-Feedback-Project'] = o.project;
  const r = await xhrPost(o.endpoint, o.multipart.body, headers, timeoutMs, o.onProgress);
  return classifyStatus(r.status, r.body);
}

async function sendSealed(box: BoxKey, o: SendOptions, timeoutMs: number): Promise<SendResult> {
  const boxUrl = trimBase(o.relayBase ?? DEFAULT_RELAY_BASE) + RELAY_PREFIX + encodeURIComponent(box.boxId);
  const keyUrl = boxUrl + '/key';

  const res = await fetchWithTimeout(keyUrl, { method: 'GET', credentials: 'omit' }, timeoutMs);
  if (!res) return RETRYABLE;
  const text = await res.text().catch(() => '');
  if (!res.ok) return classifyStatus(res.status, text);
  let publicKey: unknown;
  try {
    publicKey = (JSON.parse(text) as { publicKey?: unknown }).publicKey;
  } catch {
    return RETRYABLE;
  }
  if (typeof publicKey !== 'string' || !publicKey) return RETRYABLE;

  // Pinning: the fingerprint in data-key must match the key the relay serves, or nothing leaves.
  let fp: string;
  try {
    fp = await keyFingerprint(publicKey);
  } catch {
    return { ok: false, kind: 'key_mismatch' };
  }
  if (fp !== box.fingerprint) return { ok: false, kind: 'key_mismatch' };

  let envelope: Uint8Array;
  try {
    envelope = await sealEnvelope(o.multipart.body, o.multipart.contentType, publicKey, box.boxId);
  } catch {
    return { ok: false, kind: 'key_mismatch' };
  }

  const r = await xhrPost(
    boxUrl + '/envelopes',
    new Uint8Array(envelope),
    {
      'Content-Type': 'application/octet-stream',
      'X-Sm-Envelope': '1',
      'X-Sm-Report-Id': o.clientReportId,
    },
    timeoutMs,
    o.onProgress,
  );
  // Status 0 (offline, timeout, a proxy or CORS failure) is always retryable, even when the
  // public key route answered a moment ago: a transient failure must never delete a report.
  // The outbox's 5-try limit bounds a POST that is refused for good.
  return classifyStatus(r.status, r.body);
}

/** Send one report. Never throws. */
export async function sendReport(o: SendOptions): Promise<SendResult> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    if (o.endpoint) return await sendPlain({ ...o, endpoint: o.endpoint }, timeoutMs);
    const box = typeof o.key === 'string' ? parseKey(o.key) : (o.key ?? null);
    if (!box) return { ok: false, kind: 'key_mismatch' };
    return await sendSealed(box, o, timeoutMs);
  } catch {
    return RETRYABLE;
  }
}
