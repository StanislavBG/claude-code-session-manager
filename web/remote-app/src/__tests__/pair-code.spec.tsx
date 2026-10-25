import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({
  requestOtp: vi.fn(),
}));

import { requestOtp } from '../api';
import PairCode from '../components/PairCode';

describe('PairCode', () => {
  beforeEach(() => { vi.mocked(requestOtp).mockReset(); });

  it('generate shows the code cells and steps', async () => {
    vi.mocked(requestOtp).mockResolvedValue({ code: 'ABCD1234' } as any);
    const { container } = render(<PairCode />);
    fireEvent.click(screen.getByText('Generate pairing code'));
    await waitFor(() => expect(screen.getByText('Code expires in 5 minutes.')).toBeTruthy());
    for (const ch of 'ABCD1234') expect(container.textContent).toContain(ch);
    expect(container.querySelectorAll('span.select-all').length).toBe(8);
    expect(container.querySelectorAll('ol li').length).toBe(3);
    expect(container.textContent).toContain('Settings → Phone remote');
  });

  it('shows the error text when requestOtp rejects', async () => {
    vi.mocked(requestOtp).mockRejectedValue(new Error('relay down'));
    render(<PairCode />);
    fireEvent.click(screen.getByText('Generate pairing code'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('relay down'));
    expect(screen.queryByText('Code expires in 5 minutes.')).toBeNull();
  });
});
