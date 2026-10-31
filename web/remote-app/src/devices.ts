import type { Device } from './types';

export interface DeviceMeta {
  name: string;
  platform: string | null;
  version: string | null;
  seenAt: number;
}

export const PREFERRED_KEY = 'sm-active-device-v1';
export const META_PREFIX = 'sm-device-meta-v1-';
export const PIN_PREFIX = 'sm-e2e-pin-v1-';

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — ignore */
  }
}

function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function loadPreferredDevice(): string | null {
  const v = lsGet(PREFERRED_KEY);
  return v ? v : null;
}

export function savePreferredDevice(deviceId: string | null): void {
  if (deviceId) lsSet(PREFERRED_KEY, deviceId);
  else lsRemove(PREFERRED_KEY);
}

export function loadDeviceMeta(deviceId: string): DeviceMeta | null {
  const raw = lsGet(META_PREFIX + deviceId);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object') return null;
    const o = p as Record<string, unknown>;
    if (typeof o.name !== 'string') return null;
    return {
      name: o.name,
      platform: typeof o.platform === 'string' ? o.platform : null,
      version: typeof o.version === 'string' ? o.version : null,
      seenAt: typeof o.seenAt === 'number' ? o.seenAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveDeviceMeta(deviceId: string, meta: DeviceMeta): void {
  lsSet(META_PREFIX + deviceId, JSON.stringify(meta));
}

/** Drop everything this browser cached locally about a computer that no longer exists. */
export function forgetDeviceLocal(deviceId: string): void {
  lsRemove(PIN_PREFIX + deviceId);
  lsRemove(META_PREFIX + deviceId);
  if (lsGet(PREFERRED_KEY) === deviceId) lsRemove(PREFERRED_KEY);
}

export function pickActiveDevice(
  devices: Device[],
  activeId: string | null,
  preferredId: string | null,
): string | null {
  if (activeId && devices.some((d) => d.deviceId === activeId)) return activeId;
  if (preferredId) {
    const pref = devices.find((d) => d.deviceId === preferredId);
    if (pref && pref.isOnline) return pref.deviceId;
  }
  let best: Device | null = null;
  for (const d of devices) {
    if (d.isOnline && (!best || d.issuedAt > best.issuedAt)) best = d;
  }
  return best ? best.deviceId : null;
}

export function deviceLabel(deviceId: string, meta?: DeviceMeta | null): string {
  const name = meta?.name?.trim();
  return name ? name : 'Computer ' + deviceId.slice(0, 6);
}

export function platformLabel(platform?: string | null): string | null {
  if (!platform) return null;
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    default:
      return platform;
  }
}
