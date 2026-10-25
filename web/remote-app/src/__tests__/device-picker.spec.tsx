import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../components/ProjectsScreen', () => ({ default: () => <div>projects-screen</div> }));
vi.mock('../components/PairCode', () => ({ default: () => <div>pair-code-stub</div> }));

import Cockpit from '../components/Cockpit';
import { useStore } from '../store';

const dev = (deviceId: string, isOnline: boolean) => ({ deviceId, email: 'a@b.c', issuedAt: 1, isOnline });

beforeEach(() => {
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
});
