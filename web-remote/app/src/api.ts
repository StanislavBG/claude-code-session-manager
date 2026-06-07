import type {
  MeResponse,
  DevicesResponse,
  OtpResponse,
  WsTicketResponse,
} from './types';

// Hard-coded relay base, configurable at build time via VITE_RELAY_URL (v1).
export const RELAY_BASE =
  (import.meta.env.VITE_RELAY_URL as string | undefined) ??
  'https://relay.session-manager.bilko.run';

// Map http→ws and https→wss explicitly; never silently downgrade in production.
export const WSS_URL = RELAY_BASE.startsWith('http://')
  ? RELAY_BASE.replace('http://', 'ws://')
  : RELAY_BASE.replace('https://', 'wss://');

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API ${status}: ${JSON.stringify(body)}`);
  }
}

async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${RELAY_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export function redirectToLogin(): void {
  window.location.href = `${RELAY_BASE}/auth/google`;
}

export async function getMe(): Promise<MeResponse | null> {
  try {
    return await apiFetch<MeResponse>('/api/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export async function getDevices(): Promise<DevicesResponse> {
  return apiFetch<DevicesResponse>('/api/devices');
}

export async function requestOtp(): Promise<OtpResponse> {
  return apiFetch<OtpResponse>('/api/otp', { method: 'POST' });
}

export async function getWsTicket(): Promise<WsTicketResponse> {
  return apiFetch<WsTicketResponse>('/api/ws-ticket', { method: 'POST' });
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await apiFetch<unknown>(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  });
}

export async function signOut(): Promise<void> {
  await apiFetch<unknown>('/api/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/';
}
