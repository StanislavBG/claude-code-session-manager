import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const revokeDevice = vi.fn().mockResolvedValue(undefined);
vi.mock('../api', () => ({
  requestOtp: vi.fn().mockResolvedValue({ code: 'ABCD1234' }),
  revokeDevice: (id: string) => revokeDevice(id),
}));

import ConnectScreen from '../components/ConnectScreen';
import { useStore } from '../store';
import type { Device } from '../types';

const dev = (deviceId: string, issuedAt: number, isOnline = false): Device => ({
  deviceId, email: 'a@b.c', issuedAt, isOnline,
});

describe('ConnectScreen offline guidance', () => {
  beforeEach(() => {
    revokeDevice.mockClear();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    useStore.setState({ devices: [], activeDeviceId: null, deviceMeta: {} });
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('zero devices: primary pair button, no offline guidance', () => {
    useStore.setState({ devices: [] });
    render(<ConnectScreen socket={null} onRefresh={async () => {}} />);
    expect(screen.getByText('Generate pairing code')).toBeTruthy();
    expect(screen.queryByText(/desktop is offline/i)).toBeNull();
  });

  it('paired but offline: guidance first, pairing is secondary', async () => {
    useStore.setState({ devices: [dev('aaaaaaaaaaaaaaaa', 1)] });
    const { container } = render(<ConnectScreen socket={null} onRefresh={async () => {}} />);
    expect(screen.getByText(/desktop is offline/i)).toBeTruthy();
    expect(container.textContent).toContain('no need to pair again');
    expect(screen.queryByText('Generate pairing code')).toBeNull();
    fireEvent.click(screen.getByText('Pair another computer'));
    expect(screen.getByText('Generate pairing code')).toBeTruthy();
  });

  it('Forget confirms, revokes that id, then refreshes', async () => {
    useStore.setState({ devices: [dev('old-device-0001', 1), dev('new-device-0002', 2)] });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<ConnectScreen socket={null} onRefresh={onRefresh} />);
    // newest first → first Forget is the newest row
    fireEvent.click(screen.getAllByText('Forget')[1]);
    await waitFor(() => expect(revokeDevice).toHaveBeenCalledWith('old-device-0001'));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(window.confirm).toHaveBeenCalled();
  });

  it('Forget N offline revokes every offline device', async () => {
    useStore.setState({ devices: [dev('d1', 1), dev('d2', 2), dev('d3', 3, true)] });
    render(<ConnectScreen socket={null} onRefresh={async () => {}} />);
    fireEvent.click(screen.getByText('Forget 2 offline'));
    await waitFor(() => expect(revokeDevice).toHaveBeenCalledTimes(2));
    expect(revokeDevice).toHaveBeenCalledWith('d1');
    expect(revokeDevice).toHaveBeenCalledWith('d2');
  });

  it('online rows have no Forget; newest offline is labeled last paired', () => {
    useStore.setState({ devices: [dev('on-device', 5, true), dev('off-new', 4), dev('off-old', 1)] });
    render(<ConnectScreen socket={null} onRefresh={async () => {}} />);
    expect(screen.getAllByText('Forget')).toHaveLength(2);
    expect(screen.getAllByText('last paired')).toHaveLength(1);
    const rows = screen.getAllByTestId('device-row');
    expect(rows[0].textContent).toContain('online');
    expect(rows[0].textContent).not.toContain('Forget');
    expect(rows[1].textContent).toContain('last paired');
  });

  it('rows show name + OS, with a fallback label and no truncated id', () => {
    useStore.setState({
      devices: [dev('aaaaaaaaaaaaaaaa', 2, true), dev('bbbbbbbbbbbbbbbb', 1)],
      deviceMeta: { aaaaaaaaaaaaaaaa: { name: 'Work Mac', platform: 'darwin', version: null, seenAt: 1 } },
    });
    render(<ConnectScreen socket={null} onRefresh={async () => {}} />);
    const rows = screen.getAllByTestId('device-row');
    expect(rows[0].textContent).toContain('Work Mac');
    expect(rows[0].textContent).toContain('macOS');
    expect(rows[1].textContent).toContain('Computer bbbbbb');
    expect(rows[1].textContent).not.toContain('…');
  });

  it('active offline desktop is named in the heading; Open switches to an online one', () => {
    useStore.setState({
      devices: [dev('aaaaaaaaaaaaaaaa', 2, true), dev('bbbbbbbbbbbbbbbb', 1)],
      activeDeviceId: 'bbbbbbbbbbbbbbbb',
      deviceMeta: { bbbbbbbbbbbbbbbb: { name: 'Home Laptop', platform: 'linux', version: null, seenAt: 1 } },
    });
    render(<ConnectScreen socket={null} onRefresh={async () => {}} />);
    expect(screen.getByText('Home Laptop is offline')).toBeTruthy();
    expect(screen.getAllByText('Open')).toHaveLength(1);
    fireEvent.click(screen.getByText('Open'));
    expect(useStore.getState().activeDeviceId).toBe('aaaaaaaaaaaaaaaa');
    expect(localStorage.getItem('sm-active-device-v1')).toBe('aaaaaaaaaaaaaaaa');
  });
});
