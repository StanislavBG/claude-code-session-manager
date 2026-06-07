import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mock the API module — no real network calls in unit tests
vi.mock('../api', () => ({
  getMe: vi.fn(),
  getDevices: vi.fn(),
  redirectToLogin: vi.fn(),
  signOut: vi.fn(),
  RELAY_BASE: 'https://relay.session-manager.bilko.run',
  WSS_URL: 'wss://relay.session-manager.bilko.run',
}));

// Mock the WebSocket constructor so we never open real connections
vi.stubGlobal('WebSocket', class {
  readyState = 3;
  close = vi.fn();
  send = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  onopen: null = null;
  onclose: null = null;
  onmessage: null = null;
  onerror: null = null;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
});

import * as api from '../api';
import App from '../App';
import { useStore } from '../store';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset Zustand store to initial state between tests
  useStore.setState({
    me: null,
    devices: [],
    wsConnected: false,
    screen: { kind: 'login' },
  });
});

describe('Auth gate', () => {
  it('shows login page when no session exists', async () => {
    vi.mocked(api.getMe).mockResolvedValue(null);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
  });

  it('login page contains a sign-in button', async () => {
    vi.mocked(api.getMe).mockResolvedValue(null);

    render(<App />);

    await waitFor(() => {
      const btn = screen.getByTestId('google-signin-btn');
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveAccessibleName(/sign in with google/i);
    });
  });

  it('sign-in button calls redirectToLogin when clicked', async () => {
    vi.mocked(api.getMe).mockResolvedValue(null);
    const { redirectToLogin } = await import('../api');

    render(<App />);

    await waitFor(() => screen.getByTestId('google-signin-btn'));
    screen.getByTestId('google-signin-btn').click();

    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it('shows device list when session exists', async () => {
    vi.mocked(api.getMe).mockResolvedValue({ userId: 'u1', email: 'test@example.com' });
    vi.mocked(api.getDevices).mockResolvedValue({ devices: [] });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('device-list')).toBeInTheDocument();
    });
  });

  it('login page is not shown when session exists', async () => {
    vi.mocked(api.getMe).mockResolvedValue({ userId: 'u1', email: 'test@example.com' });
    vi.mocked(api.getDevices).mockResolvedValue({ devices: [] });

    render(<App />);

    await waitFor(() => screen.getByTestId('device-list'));
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });
});

describe('Mobile layout invariants', () => {
  it('login page sets data-testid for automation', async () => {
    vi.mocked(api.getMe).mockResolvedValue(null);
    render(<App />);

    await waitFor(() => {
      const page = screen.getByTestId('login-page');
      expect(page).toBeInTheDocument();
    });
  });

  it('device list has add-device button', async () => {
    vi.mocked(api.getMe).mockResolvedValue({ userId: 'u1', email: 'test@example.com' });
    vi.mocked(api.getDevices).mockResolvedValue({ devices: [] });

    render(<App />);

    await waitFor(() => {
      const btn = screen.getByTestId('add-device-btn');
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveAccessibleName(/add a new device/i);
    });
  });
});
