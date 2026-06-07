import { useEffect, useRef } from 'react';
import { useStore } from './store';
import { getMe, getDevices } from './api';
import { RelaySocket } from './ws';
import LoginPage from './components/LoginPage';
import DeviceList from './components/DeviceList';
import PairingModal from './components/PairingModal';
import DeviceView from './components/DeviceView';
import type { Envelope } from './types';

export default function App() {
  const { me, screen, setMe, setDevices, setDeviceOnline, setWsConnected, setScreen } = useStore();
  const socketRef = useRef<RelaySocket | null>(null);

  // Bootstrap: check session, load devices
  useEffect(() => {
    getMe().then((user) => {
      setMe(user);
      if (user) {
        setScreen({ kind: 'devices' });
        return getDevices().then((r) => setDevices(r.devices));
      } else {
        setScreen({ kind: 'login' });
      }
    }).catch(console.error);
  }, [setMe, setDevices, setScreen]);

  // Connect WebSocket once authenticated
  useEffect(() => {
    if (!me) return;
    const socket = new RelaySocket((connected) => {
      setWsConnected(connected);
    });
    socketRef.current = socket;
    socket.connect().catch(console.error);

    const unsubDeviceStatus = socket.on(
      'event:device:status',
      (msg: Envelope) => {
        // relay sends status at the top level of the envelope, not in payload
        if (msg.deviceId && msg.status) {
          setDeviceOnline(msg.deviceId, msg.status === 'connected');
          // Initiate E2E when device comes online — fetch pubKey from store
          if (msg.status === 'connected') {
            const { devices: currentDevices } = useStore.getState();
            const dev = currentDevices.find((d) => d.deviceId === msg.deviceId);
            if (dev?.devicePubKey) {
              socket.initiateE2E(msg.deviceId, dev.devicePubKey).catch(console.warn);
            }
          }
        }
      },
    );

    return () => {
      unsubDeviceStatus();
      socket.destroy();
      socketRef.current = null;
    };
  }, [me, setWsConnected, setDeviceOnline]);

  const socket = socketRef.current;
  // Stable deviceId for the E2E effect — undefined when not in device view
  const activeDeviceId = screen.kind === 'device' ? screen.deviceId : undefined;

  // Initiate E2E when entering a device view (or when socket reconnects)
  useEffect(() => {
    if (!activeDeviceId || !socket) return;
    const { devices: devs } = useStore.getState();
    const dev = devs.find((d) => d.deviceId === activeDeviceId);
    if (dev?.devicePubKey && dev.isOnline) {
      socket.initiateE2E(activeDeviceId, dev.devicePubKey).catch(console.warn);
    }
  }, [activeDeviceId, socket]);

  if (screen.kind === 'login') {
    return <LoginPage />;
  }

  if (screen.kind === 'pairing') {
    return (
      <>
        <DeviceList socket={socket} />
        <PairingModal onClose={() => setScreen({ kind: 'devices' })} />
      </>
    );
  }

  if (screen.kind === 'device') {
    return (
      <DeviceView
        deviceId={screen.deviceId}
        tab={screen.tab}
        socket={socket}
      />
    );
  }

  // Default: devices
  return <DeviceList socket={socket} />;
}
