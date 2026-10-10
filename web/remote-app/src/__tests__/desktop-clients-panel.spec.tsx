import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { api, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(public readonly status: number, public readonly body: unknown) { super(`API ${status}`); }
  }
  return {
    MockApiError,
    api: { requestClientOtp: vi.fn(), getClients: vi.fn(), revokeClient: vi.fn() },
  };
});

vi.mock('../api', () => ({ ...api, ApiError: MockApiError }));

import DesktopClientsPanel from '../components/DesktopClientsPanel';

const client = { clientId: 'c1', email: 'a@b.c', clientName: 'Work laptop', issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  api.getClients.mockResolvedValue({ clients: [client] });
  api.revokeClient.mockResolvedValue(undefined);
});

describe('DesktopClientsPanel', () => {
  it('mint shows the code and instructions', async () => {
    api.requestClientOtp.mockResolvedValue({ code: 'ABCD1234' });
    render(<DesktopClientsPanel />);
    fireEvent.click(screen.getByTestId('desktop-client-mint'));
    expect((await screen.findByTestId('desktop-client-code')).textContent).toBe('ABCD1234');
    expect(screen.getByText(/Valid 5 minutes, single use\./)).toBeTruthy();
  });

  it('lists client rows', async () => {
    render(<DesktopClientsPanel />);
    const rows = await screen.findAllByTestId('desktop-client-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Work laptop');
  });

  it('revoke calls revokeClient with the id and reloads', async () => {
    render(<DesktopClientsPanel />);
    fireEvent.click(await screen.findByTestId('desktop-client-revoke'));
    await waitFor(() => expect(api.revokeClient).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(api.getClients).toHaveBeenCalledTimes(2));
  });

  it('429 on mint shows the rate-limit message', async () => {
    api.requestClientOtp.mockRejectedValue(new MockApiError(429, {}));
    render(<DesktopClientsPanel />);
    fireEvent.click(screen.getByTestId('desktop-client-mint'));
    expect(await screen.findByText('Too many codes — try again later.')).toBeTruthy();
  });
});
