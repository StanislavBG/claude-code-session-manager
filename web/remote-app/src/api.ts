import type {
  MeResponse,
  DevicesResponse,
  OtpResponse,
  WsTicketResponse,
} from './types';

// v2: relay is same-origin on bilko.run. REST under /api/sm-relay; WS at
// /projects/session-manager/relay. Auth is the host Clerk session (Bearer token),
// not a cookie — App.tsx injects a token getter from Clerk's useAuth().getToken.
export const RELAY_API_BASE = '/api/sm-relay';
export const RELAY_WSS_URL =
  (typeof window !== 'undefined' ? `wss://${window.location.host}` : 'wss://bilko.run') +
  '/projects/session-manager/relay';

let _getToken: (() => Promise<string | null>) | null = null;
/** App wires Clerk's getToken here so every relay call carries the session JWT. */
export function setTokenGetter(fn: () => Promise<string | null>): void {
  _getToken = fn;
}

class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`API ${status}: ${JSON.stringify(body)}`);
  }
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = _getToken ? await _getToken() : null;
  // Only declare a JSON content-type when we actually send a body. Bodyless
  // POSTs (/otp, /ws-ticket) with Content-Type: application/json make the relay
  // run JSON.parse('') on the empty body → 500 "Unexpected end of JSON input".
  const hasBody = options?.body != null;
  const res = await fetch(`${RELAY_API_BASE}${path}`, {
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers ?? {}),
    },
  });
  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export async function getMe(): Promise<MeResponse | null> {
  try {
    return await apiFetch<MeResponse>('/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export async function getDevices(): Promise<DevicesResponse> {
  return apiFetch<DevicesResponse>('/devices');
}

export async function requestOtp(): Promise<OtpResponse> {
  return apiFetch<OtpResponse>('/otp', { method: 'POST' });
}

export async function getWsTicket(): Promise<WsTicketResponse> {
  return apiFetch<WsTicketResponse>('/ws-ticket', { method: 'POST' });
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await apiFetch<unknown>(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
}

export { ApiError };

// ── Feedback boxes (site feedback widget) ────────────────────────────────────
// GET/PATCH/DELETE /boxes accept the Clerk session (site-feedback.md host contract).
// Creating a box stays on the desktop — its private key is made there.

export type FeedbackBoxState = 'open' | 'paused';

export interface FeedbackBox {
  boxId: string;
  label: string;
  allowedOrigins: string[];
  publicKey: string;
  state: FeedbackBoxState;
  pending: number;
  pendingBytes: number;
  createdAt: string;
  lastReceivedAt: string | null;
  deviceId: string;
}

export interface FeedbackBoxPatch {
  label?: string;
  allowedOrigins?: string[];
  state?: FeedbackBoxState;
}

/** Success carries the data; failure carries the relay's `{ error }` code and HTTP status. */
export type BoxResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

function relayErrorCode(e: unknown): { status: number; error: string } {
  if (e instanceof ApiError) {
    const b = e.body as { error?: unknown } | null;
    const code = b && typeof b.error === 'string' ? b.error : `http_${e.status}`;
    return { status: e.status, error: code };
  }
  return { status: 0, error: 'network_error' };
}

async function boxCall<T>(path: string, options?: RequestInit): Promise<BoxResult<T>> {
  try {
    return { ok: true, data: await apiFetch<T>(path, options) };
  } catch (e) {
    return { ok: false, ...relayErrorCode(e) };
  }
}

export async function getBoxes(): Promise<BoxResult<FeedbackBox[]>> {
  const r = await boxCall<{ boxes?: FeedbackBox[] }>('/boxes');
  return r.ok ? { ok: true, data: Array.isArray(r.data?.boxes) ? r.data.boxes : [] } : r;
}

export async function patchBox(boxId: string, patch: FeedbackBoxPatch): Promise<BoxResult<FeedbackBox>> {
  const body: FeedbackBoxPatch = {};
  if (patch.label !== undefined) body.label = patch.label;
  if (patch.allowedOrigins !== undefined) body.allowedOrigins = patch.allowedOrigins;
  if (patch.state !== undefined) body.state = patch.state;
  return boxCall<FeedbackBox>(`/boxes/${encodeURIComponent(boxId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteBox(boxId: string): Promise<BoxResult<null>> {
  const r = await boxCall<unknown>(`/boxes/${encodeURIComponent(boxId)}`, { method: 'DELETE' });
  return r.ok ? { ok: true, data: null } : r;
}
