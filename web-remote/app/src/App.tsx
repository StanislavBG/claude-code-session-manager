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
