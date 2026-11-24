import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../components/PairCode', () => ({ default: () => <div>pair-code-stub</div> }));
vi.mock('../api', () => ({
  revokeDevice: vi.fn(),
  getBoxes: vi.fn(),
  patchBox: vi.fn(),
  deleteBox: vi.fn(),
}));
vi.mock('../feedbackSnippet', () => ({
  keyFingerprint: vi.fn(async () => 'FP22charsFP22charsFP22'),
  snippetFor: (boxId: string, fp: string) => `<script data-key="fbk1_${boxId}.${fp}"></script>`,
}));

import { getBoxes, patchBox, deleteBox, type FeedbackBox } from '../api';
import DevicePicker from '../components/DevicePicker';
import { useStore } from '../store';

const box = (over: Partial<FeedbackBox> = {}): FeedbackBox => ({
  boxId: 'box1',
  label: 'Marketing site',
  allowedOrigins: ['https://example.com', 'https://www.example.com'],
  publicKey: 'pk',
  state: 'open',
  pending: 3,
  pendingBytes: 100,
  createdAt: '2026-11-01T00:00:00Z',
  lastReceivedAt: null,
  deviceId: 'aaaaaa111',
  ...over,
});

const writeText = vi.fn(async () => undefined);

beforeEach(() => {
  vi.mocked(getBoxes).mockReset();
  vi.mocked(patchBox).mockReset();
  vi.mocked(deleteBox).mockReset();
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  useStore.getState().reset();
  useStore.setState({
    devices: [{ deviceId: 'aaaaaa111', email: 'a@b.c', issuedAt: 1, isOnline: true }],
    deviceMeta: { aaaaaa111: { name: 'Work Mac', platform: 'darwin', version: '0.126.0', seenAt: 1 } },
    activeDeviceId: 'aaaaaa111',
  });
});

const renderPicker = () => render(<DevicePicker onClose={() => {}} />);

describe('WebsitesList in DevicePicker', () => {
  it('renders nothing when the account has no widgets', async () => {
    vi.mocked(getBoxes).mockResolvedValue({ ok: true, data: [] });
    renderPicker();
    await waitFor(() => expect(getBoxes).toHaveBeenCalled());
    expect(screen.queryByTestId('websites-list')).toBeNull();
    expect(screen.queryByText(/Websites/)).toBeNull();
  });

  it('renders nothing when the list read fails', async () => {
    vi.mocked(getBoxes).mockResolvedValue({ ok: false, status: 401, error: 'unauthorized' });
    renderPicker();
    await waitFor(() => expect(getBoxes).toHaveBeenCalled());
    expect(screen.queryByTestId('websites-list')).toBeNull();
  });

  it('is one collapsed Websites (n) row by default, below the devices list', async () => {
    vi.mocked(getBoxes).mockResolvedValue({ ok: true, data: [box(), box({ boxId: 'box2', label: 'Docs' })] });
    renderPicker();
    const toggle = await screen.findByTestId('websites-toggle');
    expect(toggle).toHaveTextContent('Websites (2)');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('websites-body')).toBeNull();
    expect(screen.queryByText('Marketing site')).toBeNull();
    // below the devices list
    const row = screen.getByTestId('device-row-aaaaaa111');
    expect(row.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('expanded rows show label, sites, state, pending and owning desktop, plus the desktop hint', async () => {
    vi.mocked(getBoxes).mockResolvedValue({ ok: true, data: [box()] });
    renderPicker();
    fireEvent.click(await screen.findByTestId('websites-toggle'));
    const row = screen.getByTestId('website-row-box1');
    expect(row).toHaveTextContent('Marketing site');
    expect(row).toHaveTextContent('https://example.com, https://www.example.com');
    expect(screen.getByTestId('website-state-box1')).toHaveTextContent('open');
    expect(row).toHaveTextContent('3 pending');
    expect(row).toHaveTextContent('Work Mac');
    expect(screen.getByText(/created from Session Manager on the desktop \(Project Home > Feedback, or ask your agent\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create|new widget|add/i })).toBeNull();
  });

  it('copies the embed snippet', async () => {
    vi.mocked(getBoxes).mockResolvedValue({ ok: true, data: [box()] });
    renderPicker();
    fireEvent.click(await screen.findByTestId('websites-toggle'));
    fireEvent.click(screen.getByTestId('website-copy-box1'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('<script data-key="fbk1_box1.FP22charsFP22charsFP22"></script>'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('pauses and resumes through patchBox', async () => {
    vi.mocked(getBoxes).mockResolvedValue({ ok: true, data: [box()] });
    vi.mocked(patchBox).mockResolvedValueOnce({ ok: true, data: box({ state: 'paused' }) });
    renderPicker();
    fireEvent.click(await screen.findByTestId('websites-toggle'));
    fireEvent.click(screen.getByTestId('website-pause-box1'));
    await waitFor(() => expect(screen.getByTestId('website-state-box1')).toHaveTextContent('paused'));
    expect(patchBox).toHaveBeenCalledWith('box1', { state: 'paused' });
    expect(screen.getByTestId('website-pause-box1')).toHaveTextContent('Resume');

    vi.mocked(patchBox).mockResolvedValueOnce({ ok: true, data: box({ state: 'open' }) });
    fireEvent.click(screen.getByTestId('website-pause-box1'));
    await waitFor(() => expect(screen.getByTestId('website-state-box1')).toHaveTextContent('open'));
    expect(patchBox).toHaveBeenLastCalledWith('box1', { state: 'open' });
  });

  it('shows the relay error when pause fails', async () => {
    vi.mocked(getBoxes).mockResolvedValue({ ok: true, data: [box()] });
    vi.mocked(patchBox).mockResolvedValueOnce({ ok: false, status: 500, error: 'boom' });
    renderPicker();
    fireEvent.click(await screen.findByTestId('websites-toggle'));
    fireEvent.click(screen.getByTestId('website-pause-box1'));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByTestId('website-state-box1')).toHaveTextContent('open');
  });

  it('deletes only after confirm, then hides the section when none remain', async () => {
    vi.mocked(getBoxes).mockResolvedValue({ ok: true, data: [box()] });
    vi.mocked(deleteBox).mockResolvedValue({ ok: true, data: null });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    renderPicker();
    fireEvent.click(await screen.findByTestId('websites-toggle'));
    fireEvent.click(screen.getByTestId('website-delete-box1'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteBox).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByTestId('website-delete-box1'));
    await waitFor(() => expect(deleteBox).toHaveBeenCalledWith('box1'));
    await waitFor(() => expect(screen.queryByTestId('websites-list')).toBeNull());
    confirm.mockRestore();
  });
});
