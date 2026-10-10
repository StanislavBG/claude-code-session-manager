import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewSessionSheet from '../components/NewSessionSheet';

const OPTIONS = {
  agents: [{ name: 'dev-lead' }, { name: 'architect' }],
  tags: ['feature', 'bugfix'],
  macros: [
    { id: 'm1', label: 'Build it', agentName: 'dev-lead', tag: 'feature', prompt: 'Build the project', projects: ['/p/alpha'] },
    { id: 'm2', label: 'Global', agentName: 'architect', tag: 'bugfix', prompt: 'Plan', projects: ['*'] },
    { id: 'm3', label: 'Other', agentName: 'architect', tag: 'bugfix', prompt: 'x', projects: ['/p/beta'] },
  ],
};

function setup(createImpl: () => Promise<any>) {
  const sendCommand = vi.fn((type: string) =>
    type === 'cmd:session:options' ? Promise.resolve({ payload: OPTIONS }) : createImpl(),
  );
  const onClose = vi.fn();
  render(<NewSessionSheet socket={{ sendCommand } as any} deviceId="dev1" cwd="/p/alpha" project="alpha" onClose={onClose} />);
  return { sendCommand, onClose };
}

describe('NewSessionSheet', () => {
  it('loads options and renders scoped macros', async () => {
    const { sendCommand } = setup(() => Promise.resolve({ payload: { ok: true } }));
    expect(await screen.findByText('Build it')).toBeInTheDocument();
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.queryByText('Other')).toBeNull();
    expect(sendCommand).toHaveBeenCalledWith('cmd:session:options', 'dev1', {});
    expect(screen.getByRole('option', { name: 'architect' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'bugfix' })).toBeInTheDocument();
    expect(screen.getByText('Start')).toBeDisabled();
  });

  it('macro tap prefills and Start sends the exact payload', async () => {
    const { sendCommand, onClose } = setup(() => Promise.resolve({ payload: { ok: true } }));
    fireEvent.click(await screen.findByText('Build it'));
    expect((screen.getByLabelText('Agent') as HTMLSelectElement).value).toBe('dev-lead');
    expect((screen.getByLabelText('Tag') as HTMLSelectElement).value).toBe('feature');
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Build it');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Build the project');
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sendCommand).toHaveBeenCalledWith('cmd:session:create', 'dev1', {
      cwd: '/p/alpha',
      agentName: 'dev-lead',
      tag: 'feature',
      title: 'Build it',
      prompt: 'Build the project',
    });
  });

  it('keeps the sheet open and shows the error on failure', async () => {
    const { onClose } = setup(() => Promise.reject(new Error('cwd is not an open project')));
    fireEvent.click(await screen.findByText('Build it'));
    fireEvent.click(screen.getByText('Start'));
    expect(await screen.findByText('cwd is not an open project')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Build the project');
  });
});
