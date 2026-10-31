import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../components/ProjectsScreen', () => ({ default: () => <div>projects-screen</div> }));
vi.mock('../components/PairCode', () => ({ default: () => <div>pair-code-stub</div> }));

vi.mock('../api', () => ({ revokeDevice: vi.fn() }));

import { revokeDevice } from '../api';
import Cockpit from '../components/Cockpit';
import { useStore } from '../store';

const dev = (deviceId: string, isOnline: boolean) => ({ deviceId, email: 'a@b.c', issuedAt: 1, isOnline });

beforeEach(() => {
  vi.mocked(revokeDevice).mockReset().mockResolvedValue(undefined as any);
  localStorage.clear();
  useStore.getState().reset();
  useStore.setState({
    awaitingDesktopConfirm: false,
    pendingSas: null,
    devices: [dev('aaaaaa111', true), dev('bbbbbb222', true), dev('cccccc333', false)],
    deviceMeta: {
      aaaaaa111: { name: 'Work Mac', platform: 'darwin', version: null, seenAt: 1 },
      cccccc333: { name: 'Old PC', platform: 'win32', version: null, seenAt: 1 },
    },
    activeDeviceId: 'aaaaaa111',
  });
});

describe('DevicePicker', () => {
  it('shows labels with fallback, Current marker, and platform', () => {
    render(<Cockpit socket={null} deviceId="aaaaaa111" />);
    expect(screen.getByTestId('device-switcher')).toHaveTextContent('Work Mac');
    fireEvent.click(screen.getByTestId('device-switcher'));
    expect(screen.getByText('Computer bbbbbb')).toBeInTheDocument();
    expect(screen.getByText(/macOS/)).toBeInTheDocument();
    expect(screen.getByText(/Windows/)).toBeInTheDocument();
    expect(screen.getAllByText('Current')).toHaveLength(1);
    expect(screen.getByTestId('device-row-aaaaaa111')).toHaveTextContent('Current');
  });

  it('switches to an online device and closes', () => {
    render(<Cockpit socket={null} deviceId="aaaaaa111" />);
    fireEvent.click(screen.getByTestId('device-switcher'));
    fireEvent.click(screen.getByTestId('device-row-bbbbbb222'));
    expect(useStore.getState().activeDeviceId).toBe('bbbbbb222');
    expect(localStorage.getItem('sm-active-device-v1')).toBe('bbbbbb222');
    expect(screen.queryByTestId('device-picker')).toBeNull();
  });

  it('disables offline rows', () => {
    render(<Cockpit socket={null} deviceId="aaaaaa111" />);
    fireEvent.click(screen.getByTestId('device-switcher'));
    const row = screen.getByTestId('device-row-cccccc333');
    expect(row).toBeDisabled();
    fireEvent.click(row);
    expect(useStore.getState().activeDeviceId).toBe('aaaaaa111');
  });

  it('reveals PairCode and closes', () => {
    render(<Cockpit socket={null} deviceId="aaaaaa111" />);
    fireEvent.click(screen.getByTestId('device-switcher'));
    fireEvent.click(screen.getByText('Pair another computer'));
    expect(screen.getByText('pair-code-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByTestId('device-picker')).toBeNull();
  });

  describe('Remove', () => {
    const open = (refresh = vi.fn().mockResolvedValue(undefined)) => {
      render(<Cockpit socket={null} deviceId="aaaaaa111" onRefreshDevices={refresh} />);
      fireEvent.click(screen.getByTestId('device-switcher'));
      return refresh;
    };

    it('renders on online, offline and current rows', () => {
      open();
      for (const id of ['aaaaaa111', 'bbbbbb222', 'cccccc333']) {
        expect(screen.getByTestId(`device-remove-${id}`)).toBeInTheDocument();
      }
    });

    it('cancel makes no API call', () => {
      const refresh = open();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      fireEvent.click(screen.getByTestId('device-remove-bbbbbb222'));
      expect(revokeDevice).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    });

    it('confirm revokes then refreshes, with offline/online wording', async () => {
      const refresh = open();
      const c = vi.spyOn(window, 'confirm').mockReturnValue(true);
      fireEvent.click(screen.getByTestId('device-remove-cccccc333'));
      expect(c.mock.calls[0][0]).toMatch(/Old PC/);
      expect(c.mock.calls[0][0]).toMatch(/paired again later/);
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      expect(revokeDevice).toHaveBeenCalledWith('cccccc333');
      expect(vi.mocked(revokeDevice).mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
      fireEvent.click(screen.getByTestId('device-remove-bbbbbb222'));
      expect(c.mock.calls[1][0]).toMatch(/Settings → Phone remote/);
    });

    it('shows an alert when revoke rejects and keeps the sheet open', async () => {
      open();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.mocked(revokeDevice).mockRejectedValue(new Error('boom'));
      fireEvent.click(screen.getByTestId('device-remove-bbbbbb222'));
      expect(await screen.findByRole('alert')).toHaveTextContent('boom');
      expect(screen.getByTestId('device-picker')).toBeInTheDocument();
    });

    it('closes the sheet after removing the current computer', async () => {
      open();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      fireEvent.click(screen.getByTestId('device-remove-aaaaaa111'));
      await waitFor(() => expect(screen.queryByTestId('device-picker')).toBeNull());
    });
  });
});
