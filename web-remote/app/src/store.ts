import { create } from 'zustand';
import type { MeResponse, Device, Screen } from './types';

interface AppState {
  me: MeResponse | null;
  devices: Device[];
  wsConnected: boolean;
  screen: Screen;

  setMe: (me: MeResponse | null) => void;
  setDevices: (devices: Device[]) => void;
  setDeviceOnline: (deviceId: string, isOnline: boolean) => void;
  setWsConnected: (v: boolean) => void;
  setScreen: (s: Screen) => void;
}

export const useStore = create<AppState>((set) => ({
  me: null,
  devices: [],
  wsConnected: false,
  screen: { kind: 'login' },

  setMe: (me) => set({ me }),
  setDevices: (devices) => set({ devices }),
  setDeviceOnline: (deviceId, isOnline) =>
    set((state) => ({
      devices: state.devices.map((d) =>
        d.deviceId === deviceId ? { ...d, isOnline } : d,
      ),
    })),
  setWsConnected: (wsConnected) => set({ wsConnected }),
  setScreen: (screen) => set({ screen }),
}));
