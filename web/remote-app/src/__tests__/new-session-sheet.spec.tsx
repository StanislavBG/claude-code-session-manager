import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewSessionSheet from '../components/NewSessionSheet';

const PORTFOLIO = {
  id: 'startup-portfolio-fcec18',
  label: 'Portfolio Optimization',
  agentName: 'architect',
  tag: 'feature',
  prompt: 'Mode {{mode}} focus {{focus}} {{instructions}} {{data}}',
  projects: ['/p/alpha'],
  inputs: [
    { name: 'mode', label: 'Mode', default: 'auto', required: true, options: ['auto', 'early-check', 'review'] },
    { name: 'focus', label: 'Focus', default: 'none' },
    { name: 'instructions', label: 'Instructions', default: 'none' },
    { name: 'data', label: 'Data', default: 'none' },
  ],
};

let OPTIONS: any = {
  macroInputs: true,
  agents: [{ name: 'dev-lead' }, { name: 'architect' }],
  tags: ['feature', 'bugfix'],
  macros: [
    { id: 'm1', label: 'Build it', agentName: 'dev-lead', tag: 'feature', prompt: 'Build the project', projects: ['/p/alpha'] },
    { id: 'm2', label: 'Global', agentName: 'architect', tag: 'bugfix', prompt: 'Plan', projects: ['*'] },
    { id: 'm3', label: 'Other', agentName: 'architect', tag: 'bugfix', prompt: 'x', projects: ['/p/beta'] },
    { id: 'm4', label: 'Hidden', agentName: 'architect', tag: 'bugfix', prompt: 'x', projects: [] },
    PORTFOLIO,
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
      macroId: 'm1',
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

  const createPayload = (sendCommand: any) =>
    sendCommand.mock.calls.find((c: any[]) => c[0] === 'cmd:session:create')?.[2];

  it('hides macros with empty projects', async () => {
    setup(() => Promise.resolve({ payload: { ok: true } }));
    await screen.findByText('Build it');
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  it('untouched Portfolio macro sends macroId + the four defaults', async () => {
    const { sendCommand, onClose } = setup(() => Promise.resolve({ payload: { ok: true } }));
    fireEvent.click(await screen.findByText('Portfolio Optimization'));
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('auto');
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const p = createPayload(sendCommand);
    expect(p.macroId).toBe('startup-portfolio-fcec18');
    expect(p.inputs).toEqual({ mode: 'auto', focus: 'none', instructions: 'none', data: 'none' });
  });

  it('sends edited Mode and typed Focus', async () => {
    const { sendCommand, onClose } = setup(() => Promise.resolve({ payload: { ok: true } }));
    fireEvent.click(await screen.findByText('Portfolio Optimization'));
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'review' } });
    fireEvent.change(screen.getByLabelText('Focus'), { target: { value: 'pricing' } });
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(createPayload(sendCommand).inputs).toEqual({ mode: 'review', focus: 'pricing', instructions: 'none', data: 'none' });
  });

  it('no-inputs macro sends macroId only', async () => {
    const { sendCommand, onClose } = setup(() => Promise.resolve({ payload: { ok: true } }));
    fireEvent.click(await screen.findByText('Global'));
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const p = createPayload(sendCommand);
    expect(p.macroId).toBe('m2');
    expect('inputs' in p).toBe(false);
  });

  it('manual session sends neither macroId nor inputs', async () => {
    const { sendCommand, onClose } = setup(() => Promise.resolve({ payload: { ok: true } }));
    await screen.findByText('Build it');
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'dev-lead' } });
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'feature' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'do it' } });
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const p = createPayload(sendCommand);
    expect('macroId' in p).toBe(false);
    expect('inputs' in p).toBe(false);
  });

  it('blocks Start on an old desktop without macroInputs', async () => {
    const saved = OPTIONS;
    OPTIONS = { ...OPTIONS, macroInputs: undefined };
    try {
      setup(() => Promise.resolve({ payload: { ok: true } }));
      fireEvent.click(await screen.findByText('Portfolio Optimization'));
      expect(screen.getByText("Update Session Manager on your computer to use this macro's inputs from the phone.")).toBeInTheDocument();
      expect(screen.getByText('Start')).toBeDisabled();
    } finally {
      OPTIONS = saved;
    }
  });
});
