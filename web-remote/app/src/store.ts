import { create } from 'zustand';
import type {
  MeResponse, Device, Screen, SessionMeta, SessionState, SessionSummary,
} from './types';

interface AppState {
  me: MeResponse | null;
  devices: Device[];
  activeDeviceId: string | null;   // the paired device we're driving
  wsConnected: boolean;
  screen: Screen;

  // Session cockpit state (single source: event:session:list / state / summary)
  sessions: SessionMeta[];
  selectedTabId: string | null;
  stateByTab: Record<string, SessionState>;
  summaryByTab: Record<string, SessionSummary>;
  navOpen: boolean;

  setMe: (me: MeResponse | null) => void;
  setDevices: (devices: Device[]) => void;
  setDeviceOnline: (deviceId: string, isOnline: boolean) => void;
  setActiveDevice: (deviceId: string | null) => void;
  setWsConnected: (v: boolean) => void;
  setScreen: (s: Screen) => void;

  setSessions: (sessions: SessionMeta[]) => void;
  selectTab: (tabId: string | null) => void;
  setTabState: (tabId: string, state: SessionState) => void;
  setTabSummary: (s: SessionSummary) => void;
  setNavOpen: (v: boolean) => void;
  reset: () => void;
}

export const useStore = create<AppState>((set) => ({
  me: null,
  devices: [],
  activeDeviceId: null,
  wsConnected: false,
  screen: { kind: 'login' },

  sessions: [],
  selectedTabId: null,
  stateByTab: {},
  summaryByTab: {},
  navOpen: false,

  setMe: (me) => set({ me }),
  setDevices: (devices) => set({ devices }),
  setDeviceOnline: (deviceId, isOnline) =>
    set((s) => ({ devices: s.devices.map((d) => (d.deviceId === deviceId ? { ...d, isOnline } : d)) })),
  setActiveDevice: (activeDeviceId) => set({ activeDeviceId }),
  setWsConnected: (wsConnected) => set({ wsConnected }),
  setScreen: (screen) => set({ screen }),

  setSessions: (sessions) =>
    set((s) => {
      // Keep the current selection if it still exists, else pick the first session.
      const stillThere = sessions.some((x) => x.tabId === s.selectedTabId);
      const selectedTabId = stillThere ? s.selectedTabId : (sessions[0]?.tabId ?? null);
      return { sessions, selectedTabId };
    }),
  selectTab: (selectedTabId) => set({ selectedTabId, navOpen: false }),
  setTabState: (tabId, state) =>
    set((s) => ({ stateByTab: { ...s.stateByTab, [tabId]: state } })),
  setTabSummary: (summary) =>
    set((s) => ({ summaryByTab: { ...s.summaryByTab, [summary.tabId]: summary } })),
  setNavOpen: (navOpen) => set({ navOpen }),
  reset: () => set({
    sessions: [], selectedTabId: null, stateByTab: {}, summaryByTab: {},
    activeDeviceId: null, navOpen: false,
  }),
}));
