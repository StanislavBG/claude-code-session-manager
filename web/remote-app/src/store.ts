import { create } from 'zustand';
import type { SessionTarget } from './components/SessionScreen';
import type {
  MeResponse, Device, Screen, SessionState, SessionSummary,
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

  // Live per-tab state / summary
  stateByTab: Record<string, SessionState>;
  summaryByTab: Record<string, SessionSummary>;

  // E2E security state
  /** SAS pending user confirmation: { deviceId, sas } or null. */
  pendingSas: { deviceId: string; sas: string } | null;
  /** True from SAS display until the desktop confirms (event:remote:ready). */
  awaitingDesktopConfirm: boolean;
  /** Device IDs whose relay-served pubKey diverged from the pinned value (TOFU). */
  keyMismatchDeviceIds: string[];

  setMe: (me: MeResponse | null) => void;
  setDevices: (devices: Device[]) => void;
  setDeviceOnline: (deviceId: string, isOnline: boolean) => void;
  setActiveDevice: (deviceId: string | null) => void;
  setWsConnected: (v: boolean) => void;
  setScreen: (s: Screen) => void;

  goProjects: () => void;
  goSessions: (cwd: string, title: string) => void;
  goSession: (cwd: string, title: string, target: SessionTarget) => void;
  bumpRefresh: () => void;
  setTabState: (tabId: string, state: SessionState) => void;
  setTabSummary: (s: SessionSummary) => void;
  reset: () => void;

  setPendingSas: (v: { deviceId: string; sas: string } | null) => void;
  clearPendingSas: () => void;
  /** Desktop signalled readiness (or the fallback fired): stop waiting and re-fetch. */
  markRemoteReady: () => void;
  addKeyMismatch: (deviceId: string) => void;
}

export const useStore = create<AppState>((set) => ({
  me: null,
  devices: [],
  activeDeviceId: null,
  wsConnected: false,
  screen: { kind: 'login' },

  route: { view: 'projects' },
  refreshKey: 0,
  stateByTab: {},
  summaryByTab: {},

  pendingSas: null,
  awaitingDesktopConfirm: false,
  keyMismatchDeviceIds: [],

  setMe: (me) => set({ me }),
  setDevices: (devices) => set({ devices }),
  setDeviceOnline: (deviceId, isOnline) =>
    set((s) => ({ devices: s.devices.map((d) => (d.deviceId === deviceId ? { ...d, isOnline } : d)) })),
  setActiveDevice: (activeDeviceId) => set({ activeDeviceId }),
  setWsConnected: (wsConnected) => set({ wsConnected }),
  setScreen: (screen) => set({ screen }),

  goProjects: () => set({ route: { view: 'projects' } }),
  goSessions: (cwd, title) => set({ route: { view: 'sessions', cwd, title } }),
  goSession: (cwd, title, target) => set({ route: { view: 'session', cwd, title, target } }),
  bumpRefresh: () => set((s) => ({ refreshKey: s.refreshKey + 1 })),
  setTabState: (tabId, state) =>
    set((s) => ({ stateByTab: { ...s.stateByTab, [tabId]: state } })),
  setTabSummary: (summary) =>
    set((s) => ({ summaryByTab: { ...s.summaryByTab, [summary.tabId]: summary } })),
  reset: () => set({
    route: { view: 'projects' }, stateByTab: {}, summaryByTab: {},
    activeDeviceId: null, awaitingDesktopConfirm: false,
  }),

  setPendingSas: (pendingSas) =>
    set(pendingSas ? { pendingSas, awaitingDesktopConfirm: true } : { pendingSas }),
  clearPendingSas: () => set({ pendingSas: null }),
  markRemoteReady: () => set((s) => ({ awaitingDesktopConfirm: false, refreshKey: s.refreshKey + 1 })),
  addKeyMismatch: (deviceId) =>
    set((s) => ({
      keyMismatchDeviceIds: s.keyMismatchDeviceIds.includes(deviceId)
        ? s.keyMismatchDeviceIds
        : [...s.keyMismatchDeviceIds, deviceId],
    })),
}));
