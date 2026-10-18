import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { api, tel } = vi.hoisted(() => ({
  api: {
    requestOtp: vi.fn(), revokeDevice: vi.fn(),
    requestClientOtp: vi.fn(), getClients: vi.fn(), revokeClient: vi.fn(),
  },
  tel: { track: vi.fn(), trackFlow: vi.fn(), trackScreen: vi.fn() },
}));

vi.mock('../api', () => ({ ...api, ApiError: class extends Error {} }));
vi.mock('../telemetry', () => tel);
vi.mock('../remoteApi', async () => {
  const actual = await vi.importActual<typeof import('../remoteApi')>('../remoteApi');
  return { ...actual, listProjects: vi.fn() };
});

import { listProjects } from '../remoteApi';
import { useStore } from '../store';
import ConnectScreen from '../components/ConnectScreen';
import DesktopClientsPanel from '../components/DesktopClientsPanel';
import ProjectsScreen from '../components/ProjectsScreen';

const dev = (deviceId: string, isOnline: boolean, issuedAt: number) => ({ deviceId, isOnline, issuedAt }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  api.getClients.mockResolvedValue({ clients: [{ clientId: 'c1', email: 'a@b.c', clientName: 'W', issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z' }] });
  useStore.setState({ devices: [] } as any);
});

describe('ConnectScreen tracking', () => {
  it('emits pair start + code-issued without the code', async () => {
    api.requestOtp.mockResolvedValue({ code: 'ABCD1234' });
    render(<ConnectScreen socket={null} onRefresh={async () => {}} />);
    const btn = screen.getByText('Generate pairing code').closest('button')!;
    expect(btn.getAttribute('data-track')).toBe('connect-generate-code');
    expect(screen.getByText('Refresh').getAttribute('data-track')).toBe('connect-refresh');
    fireEvent.click(btn);
    await waitFor(() => expect(tel.trackFlow).toHaveBeenCalledWith('pair', 'code-issued'));
    expect(tel.trackFlow).toHaveBeenCalledWith('pair', 'start');
    expect(JSON.stringify(tel.trackFlow.mock.calls)).not.toContain('ABCD1234');
  });

  it('emits pair fail with a fixed reason, never the error message', async () => {
    api.requestOtp.mockRejectedValue(new Error('secret-boom'));
    render(<ConnectScreen socket={null} onRefresh={async () => {}} />);
    fireEvent.click(screen.getByText('Generate pairing code'));
    await waitFor(() => expect(tel.trackFlow).toHaveBeenCalledWith('pair', 'fail', { reason: 'otp-error' }));
    expect(JSON.stringify(tel.trackFlow.mock.calls)).not.toContain('secret-boom');
  });

  it('tags pair-another, forget buttons', () => {
    useStore.setState({ devices: [dev('d1', false, 3), dev('d2', false, 2)] } as any);
    render(<ConnectScreen socket={null} onRefresh={async () => {}} />);
    expect(screen.getByText('Pair another computer').getAttribute('data-track')).toBe('connect-pair-another');
    expect(screen.getByText('Forget 2 offline').getAttribute('data-track')).toBe('connect-forget-offline');
    expect(screen.getAllByText('Forget')[0].getAttribute('data-track')).toBe('connect-forget-device');
  });
});

describe('DesktopClientsPanel tracking', () => {
  it('tags mint and revoke', async () => {
    render(<DesktopClientsPanel />);
    expect(screen.getByTestId('desktop-client-mint').getAttribute('data-track')).toBe('desktop-client-mint');
    expect((await screen.findByTestId('desktop-client-revoke')).getAttribute('data-track')).toBe('desktop-client-revoke');
  });
});

describe('ProjectsScreen tracking', () => {
  const socket = { sendCommand: vi.fn() } as any;
  it('tags project rows (redacted)', async () => {
    vi.mocked(listProjects).mockResolvedValue({ projects: [{ cwd: '/p/a', title: 'Alpha', mainTabId: 't', counts: { active: 1, proposed: 0, completed: 0 } }] } as any);
    render(<ProjectsScreen socket={socket} deviceId="d" refreshKey={0} onOpen={vi.fn()} />);
    const row = await screen.findByTestId('project-row');
    expect(row.getAttribute('data-track')).toBe('projects-open');
    expect(row.hasAttribute('data-track-redact')).toBe(true);
  });
  it('tags retry', async () => {
    vi.mocked(listProjects).mockRejectedValue(new Error('x'));
    render(<ProjectsScreen socket={socket} deviceId="d" refreshKey={0} onOpen={vi.fn()} />);
    expect((await screen.findByText('Retry')).getAttribute('data-track')).toBe('projects-retry');
  });
});
