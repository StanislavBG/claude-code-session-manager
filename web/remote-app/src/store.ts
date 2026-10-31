import { create } from 'zustand';
import { loadDeviceMeta, saveDeviceMeta, savePreferredDevice, type DeviceMeta } from './devices';
import type { SessionTarget } from './components/SessionScreen';
import type {
  MeResponse, Device, Screen, SessionState,
} from './types';

export type Route =
  | { view: 'projects' }
  | { view: 'sessions'; cwd: string; title: string }
  | { view: 'session'; cwd: string; title: string; target: SessionTarget };

interface AppState {
  me: MeResponse | null;
  devices: Device[];
  activeDeviceId: string | null;   // the paired device we're driving
  wsConnected: boolean;
  screen: Screen;

  // Drill-down route: projects → a project's sessions → one session.
  route: Route;
  /** Bumped to make the visible screen re-fetch. */
  refreshKey: number;

  // Live per-tab state
  stateByTab: Record<string, SessionState>;

  // E2E security state
  /** SAS pending user confirmation: { deviceId, sas } or null. */
  pendingSas: { deviceId: string; sas: string } | null;
  /** True from SAS display until the desktop confirms (event:remote:ready). */
  awaitingDesktopConfirm: boolean;
  /** Desktop sent event:remote:ready for this connection: the key is pinned, no SAS needed. */
  remoteReady: boolean;
  /** The ready fallback expired for the active device: ask anyway (version skew). */
  readyFallbackExpired: boolean;
  /** Device IDs whose relay-served pubKey diverged from the pinned value (TOFU). */
  keyMismatchDeviceIds: string[];
  /** Desktops that signalled event:remote:ready on their current connection. */
  readyDeviceIds: string[];
  /** Cached desktop names/platform, hydrated from localStorage. */
  deviceMeta: Record<string, DeviceMeta>;

  setMe: (me: MeResponse | null) => void;
  setDevices: (devices: Device[]) => void;
  setDeviceOnline: (deviceId: string, isOnline: boolean) => void;
  setActiveDevice: (deviceId: string | null) => void;
  /** User-initiated switch: persist as preferred, then activate. */
  chooseDevice: (deviceId: string) => void;
  setDeviceMeta: (deviceId: string, meta: DeviceMeta) => void;
  setWsConnected: (v: boolean) => void;
  setScreen: (s: Screen) => void;

  goProjects: () => void;
  goSessions: (cwd: string, title: string) => void;
  goSession: (cwd: string, title: string, target: SessionTarget) => void;
  bumpRefresh: () => void;
  setTabState: (tabId: string, state: SessionState) => void;
  reset: () => void;

  setPendingSas: (v: { deviceId: string; sas: string } | null) => void;
  clearPendingSas: () => void;
  /** Desktop signalled readiness (or the fallback fired): stop waiting and re-fetch. */
  markRemoteReady: (deviceId?: string) => void;
  stopAwaitingDesktop: () => void;
  /** Connection dropped: a fresh handshake must show the SAS again unless re-confirmed ready. */
  clearRemoteReady: (deviceId?: string) => void;
  addKeyMismatch: (deviceId: string) => void;
  /** Drop a removed computer's in-memory state (ready, key mismatch, cached meta). */
  forgetDevice: (deviceId: string) => void;
}

export const useStore = create<AppState>((set, get) => ({
  me: null,
  devices: [],
  activeDeviceId: null,
  wsConnected: false,
  screen: { kind: 'login' },

  route: { view: 'projects' },
  refreshKey: 0,
  stateByTab: {},

  pendingSas: null,
  awaitingDesktopConfirm: false,
  remoteReady: false,
  readyFallbackExpired: false,
  keyMismatchDeviceIds: [],
  readyDeviceIds: [],
  deviceMeta: {},

  setMe: (me) => set({ me }),
  setDevices: (devices) =>
    set((s) => {
      let deviceMeta = s.deviceMeta;
      for (const d of devices) {
        if (deviceMeta[d.deviceId]) continue;
        const m = loadDeviceMeta(d.deviceId);
        if (m) deviceMeta = { ...deviceMeta, [d.deviceId]: m };
      }
      return deviceMeta === s.deviceMeta ? { devices } : { devices, deviceMeta };
    }),
  setDeviceOnline: (deviceId, isOnline) =>
    set((s) => ({ devices: s.devices.map((d) => (d.deviceId === deviceId ? { ...d, isOnline } : d)) })),
  setActiveDevice: (activeDeviceId) =>
    set((s) => {
      if (s.activeDeviceId === activeDeviceId) return {};
      return {
        activeDeviceId,
        route: { view: 'projects' },
        stateByTab: {},
        pendingSas: null,
        awaitingDesktopConfirm: false,
        remoteReady: activeDeviceId !== null && s.readyDeviceIds.includes(activeDeviceId),
        readyFallbackExpired: false,
        refreshKey: s.refreshKey + 1,
      };
    }),
  chooseDevice: (deviceId) => {
    savePreferredDevice(deviceId);
    get().setActiveDevice(deviceId);
  },
  setDeviceMeta: (deviceId, meta) => {
    set((s) => ({ deviceMeta: { ...s.deviceMeta, [deviceId]: meta } }));
    saveDeviceMeta(deviceId, meta);
  },
  setWsConnected: (wsConnected) => set(wsConnected ? { wsConnected } : { wsConnected, remoteReady: false, readyFallbackExpired: false }),
  setScreen: (screen) => set({ screen }),

  goProjects: () => set({ route: { view: 'projects' } }),
  goSessions: (cwd, title) => set({ route: { view: 'sessions', cwd, title } }),
  goSession: (cwd, title, target) => set({ route: { view: 'session', cwd, title, target } }),
  bumpRefresh: () => set((s) => ({ refreshKey: s.refreshKey + 1 })),
  setTabState: (tabId, state) =>
    set((s) => ({ stateByTab: { ...s.stateByTab, [tabId]: state } })),
  reset: () => set({
    route: { view: 'projects' }, stateByTab: {},
    activeDeviceId: null, awaitingDesktopConfirm: false, remoteReady: false, readyFallbackExpired: false,
    readyDeviceIds: [],
  }),

  setPendingSas: (pendingSas) =>
    set((s) => {
      if (s.remoteReady && pendingSas) return {};
      return pendingSas ? { pendingSas, awaitingDesktopConfirm: true } : { pendingSas };
    }),
  clearPendingSas: () => set({ pendingSas: null }),
  markRemoteReady: (deviceId) => set((s) => {
    const readyDeviceIds = deviceId && !s.readyDeviceIds.includes(deviceId)
      ? [...s.readyDeviceIds, deviceId]
      : s.readyDeviceIds;
    if (deviceId !== undefined && deviceId !== s.activeDeviceId) return { readyDeviceIds };
    return {
      readyDeviceIds, remoteReady: true, readyFallbackExpired: false, pendingSas: null, awaitingDesktopConfirm: false,
      refreshKey: s.refreshKey + 1,
    };
  }),
  stopAwaitingDesktop: () => set((s) => ({
    awaitingDesktopConfirm: false, readyFallbackExpired: true, refreshKey: s.refreshKey + 1,
  })),
  clearRemoteReady: (deviceId) => set((s) => {
    if (deviceId === undefined) return { readyDeviceIds: [], remoteReady: false, readyFallbackExpired: false };
    const readyDeviceIds = s.readyDeviceIds.filter((id) => id !== deviceId);
    return deviceId === s.activeDeviceId ? { readyDeviceIds, remoteReady: false, readyFallbackExpired: false } : { readyDeviceIds };
  }),
  addKeyMismatch: (deviceId) =>
    set((s) => ({
      keyMismatchDeviceIds: s.keyMismatchDeviceIds.includes(deviceId)
        ? s.keyMismatchDeviceIds
        : [...s.keyMismatchDeviceIds, deviceId],
    })),
  forgetDevice: (deviceId) =>
    set((s) => {
      const { [deviceId]: _gone, ...deviceMeta } = s.deviceMeta;
      return {
        readyDeviceIds: s.readyDeviceIds.filter((id) => id !== deviceId),
        keyMismatchDeviceIds: s.keyMismatchDeviceIds.filter((id) => id !== deviceId),
        deviceMeta,
      };
    }),
}));
