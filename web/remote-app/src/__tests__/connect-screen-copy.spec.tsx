import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({
  requestOtp: vi.fn().mockResolvedValue({ code: 'ABCD1234' }),
}));

import ConnectScreen from '../components/ConnectScreen';

describe('ConnectScreen pairing copy', () => {
  it('names Settings → Phone remote before and after generating a code', async () => {
    const { container } = render(<ConnectScreen socket={null} onRefresh={async () => {}} />);

    expect(screen.getByText('Settings → Phone remote')).toBeTruthy();
    expect(container.textContent).not.toContain('Configure → Remote');
    expect(container.textContent).not.toContain('Remote tab');

    fireEvent.click(screen.getByText('Generate pairing code'));
    await waitFor(() => expect(screen.getByText('Code expires in 5 minutes.')).toBeTruthy());

    expect(container.textContent).toContain('Settings → Phone remote');
    expect(container.textContent).toContain('Allow remote control from the web');
    expect(container.textContent).toContain('Pair Device…');
    expect(container.textContent).not.toContain('Configure → Remote');
    expect(container.textContent).not.toContain('Remote tab');
  });
});
