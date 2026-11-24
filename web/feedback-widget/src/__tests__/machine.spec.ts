import { describe, expect, it } from 'vitest';
import {
  type Event,
  type Flow,
  type State,
  type Success,
  frameVisible,
  hintVisible,
  initialState,
  launcherVisible,
  marksVisible,
  panelVisible,
  reduce,
  sendLabel,
  toolbarVisible,
} from '../ui/machine';

function run(state: State, ...events: Event[]): State {
  return events.reduce(reduce, state);
}

function opened(flow: Flow = 'annotate', success: Success = 'receipt'): State {
  return reduce(initialState({ flow, success }), { type: 'open' });
}

function withDraft(s: State, title = 'Broken button'): State {
  return reduce(s, { type: 'draft', title });
}

describe('initialState', () => {
  it('starts idle with every flag clear and the default config', () => {
    const s = initialState();
    expect(s.mode).toBe('idle');
    expect(s.config).toEqual({ flow: 'annotate', success: 'receipt' });
    expect(s).toMatchObject({
      confirm: false,
      folding: false,
      toast: false,
      ping: false,
      popover: null,
      textEdit: false,
      drawing: false,
      hover: null,
      marks: [],
      draft: { title: '', body: '' },
      titleError: false,
    });
  });
});

describe('section 2 transition table', () => {
  it('idle → open: annotate, tool Pin, marks/draft reset, toolbar position reset, new capture', () => {
    const before = run(
      initialState(),
      { type: 'open' },
      { type: 'setTool', tool: 'box' },
      { type: 'addMark', id: 'm1' },
      { type: 'draft', title: 'x', body: 'y' },
      { type: 'moveToolbar', pos: { x: 10, y: 20 } },
      { type: 'closeRequest' },
      { type: 'discard' },
    );
    const s = reduce(before, { type: 'open' });
    expect(s.mode).toBe('annotate');
    expect(s.tool).toBe('pin');
    expect(s.marks).toEqual([]);
    expect(s.draft).toEqual({ title: '', body: '' });
    expect(s.toolbarPos).toBeNull();
    expect(s.session).toBe(before.session + 1);
  });

  it('open is ignored when the widget is already open', () => {
    const s = opened();
    expect(reduce(s, { type: 'open' })).toBe(s);
  });

  it('annotate → Describe (flow annotate): review and requests Title focus', () => {
    const a = opened();
    const s = reduce(a, { type: 'describe' });
    expect(s.mode).toBe('review');
    expect(s.focusTitleSeq).toBe(a.focusTitleSeq + 1);
  });

  it('Describe does nothing outside flow annotate', () => {
    expect(reduce(opened('docked'), { type: 'describe' }).mode).toBe('annotate');
    expect(reduce(opened('note'), { type: 'describe' }).mode).toBe('annotate');
  });

  it('review → ← Marks: annotate with the draft kept', () => {
    const s = run(opened(), { type: 'addMark', id: 'm1' }, { type: 'describe' }, { type: 'draft', title: 'Hi there' }, { type: 'backToMarks' });
    expect(s.mode).toBe('annotate');
    expect(s.draft.title).toBe('Hi there');
    expect(s.marks).toHaveLength(1);
  });

  it('close request with marks or text → confirm', () => {
    expect(run(opened(), { type: 'addMark', id: 'm1' }, { type: 'closeRequest' }).confirm).toBe(true);
    expect(run(opened(), { type: 'describe' }, { type: 'draft', body: 'words' }, { type: 'closeRequest' }).confirm).toBe(true);
    const err = run(withDraft(opened()), { type: 'describe' }, { type: 'send' }, { type: 'sendFail' }, { type: 'closeRequest' });
    expect(err.mode).toBe('error');
    expect(err.confirm).toBe(true);
  });

  it('close request with nothing → idle', () => {
    expect(reduce(opened(), { type: 'closeRequest' }).mode).toBe('idle');
    expect(run(opened(), { type: 'describe' }, { type: 'draft', title: '   ' }, { type: 'closeRequest' }).mode).toBe('idle');
  });

  it('confirm → Keep editing: dialog closes, mode unchanged', () => {
    const s = run(opened(), { type: 'addMark', id: 'm1' }, { type: 'closeRequest' }, { type: 'keepEditing' });
    expect(s.confirm).toBe(false);
    expect(s.mode).toBe('annotate');
    expect(s.marks).toHaveLength(1);
  });

  it('confirm → Discard: idle, everything reset', () => {
    const s = run(opened(), { type: 'addMark', id: 'm1' }, { type: 'draft', title: 'abc' }, { type: 'closeRequest' }, { type: 'discard' });
    expect(s.mode).toBe('idle');
    expect(s.confirm).toBe(false);
    expect(s.marks).toEqual([]);
    expect(s.draft).toEqual({ title: '', body: '' });
  });

  it('Send with trimmed title < 3 → title error + Title focus, no sending', () => {
    const r = run(opened(), { type: 'describe' }, { type: 'draft', title: ' ab ' });
    const s = reduce(r, { type: 'send' });
    expect(s.mode).toBe('review');
    expect(s.titleError).toBe(true);
    expect(s.focusTitleSeq).toBe(r.focusTitleSeq + 1);
  });

  it('Send with a valid title while the panel is visible → sending', () => {
    const s = run(withDraft(opened()), { type: 'describe' }, { type: 'send' });
    expect(s.mode).toBe('sending');
    expect(s.titleError).toBe(false);
  });

  it('Send is ignored when the panel is not visible', () => {
    const a = withDraft(opened());
    expect(reduce(a, { type: 'send' })).toBe(a);
  });

  it('sending → 2xx (receipt): sent with the server id', () => {
    const s = run(withDraft(opened()), { type: 'describe' }, { type: 'send' }, { type: 'sendOk', id: 'FB-2048' });
    expect(s.mode).toBe('sent');
    expect(s.reportId).toBe('FB-2048');
  });

  it('sending → 2xx (toast): idle + toast, draft kept', () => {
    const s = run(withDraft(opened('annotate', 'toast')), { type: 'describe' }, { type: 'send' }, { type: 'sendOk', id: 'FB-1' });
    expect(s.mode).toBe('idle');
    expect(s.toast).toBe(true);
    expect(s.draft.title).toBe('Broken button');
    const expired = reduce(s, { type: 'toastExpired' });
    expect(expired.toast).toBe(false);
    expect(expired.draft.title).toBe('');
  });

  it('sending → 2xx (fold): folding → idle + ping → ping ends', () => {
    const f = run(withDraft(opened('annotate', 'fold')), { type: 'describe' }, { type: 'send' }, { type: 'sendOk' });
    expect(f.folding).toBe(true);
    expect(f.reportId).toBeNull();
    const done = reduce(f, { type: 'foldDone' });
    expect(done.mode).toBe('idle');
    expect(done.folding).toBe(false);
    expect(done.ping).toBe(true);
    expect(reduce(done, { type: 'pingDone' }).ping).toBe(false);
  });

  it('sending → failure: error, Send label becomes Retry now', () => {
    const sending = run(withDraft(opened()), { type: 'describe' }, { type: 'send' });
    expect(sendLabel(sending)).toBe('Send');
    const s = reduce(sending, { type: 'sendFail', rejected: true });
    expect(s.mode).toBe('error');
    expect(s.errorKind).toBe('rejected');
    expect(sendLabel(s)).toBe('Retry now');
    expect(reduce(s, { type: 'send' }).mode).toBe('sending');
  });

  it('sent → Done: idle', () => {
    const s = run(withDraft(opened()), { type: 'describe' }, { type: 'send' }, { type: 'sendOk' }, { type: 'done' });
    expect(s.mode).toBe('idle');
    expect(s.draft.title).toBe('');
  });

  it('sent → Send another: idle then open again with a new capture', () => {
    const sent = run(withDraft(opened()), { type: 'describe' }, { type: 'send' }, { type: 'sendOk' });
    const s = reduce(sent, { type: 'sendAnother' });
    expect(s.mode).toBe('annotate');
    expect(s.session).toBe(sent.session + 1);
    expect(s.draft.title).toBe('');
    expect(s.reportId).toBeNull();
  });

  it('toast → Undo: review (flow annotate), draft intact', () => {
    const s = run(withDraft(opened('annotate', 'toast')), { type: 'addMark', id: 'm1' }, { type: 'describe' }, { type: 'send' }, { type: 'sendOk' }, { type: 'undoSend' });
    expect(s.mode).toBe('review');
    expect(s.toast).toBe(false);
    expect(s.draft.title).toBe('Broken button');
    expect(s.marks).toHaveLength(1);
  });

  it('toast → Undo: annotate (other flows), draft intact', () => {
    for (const flow of ['docked', 'note'] as const) {
      const s = run(withDraft(opened(flow, 'toast')), { type: 'addMark', id: 'm1' }, { type: 'send' }, { type: 'sendOk' }, { type: 'undoSend' });
      expect(s.mode).toBe('annotate');
      expect(s.draft.title).toBe('Broken button');
    }
  });
});

describe('Esc priority (section 3)', () => {
  it('discard dialog → text input → popover → back to markup → close request; sent → Done', () => {
    let s = run(opened(), { type: 'addMark', id: 'm1' }, { type: 'describe' }, { type: 'closeRequest' }, { type: 'popover', id: 'm1' }, { type: 'textEdit', on: true });
    s = reduce(s, { type: 'esc' });
    expect(s.confirm).toBe(false);
    s = reduce(s, { type: 'esc' });
    expect(s.textEdit).toBe(false);
    s = reduce(s, { type: 'esc' });
    expect(s.popover).toBeNull();
    s = reduce(s, { type: 'esc' });
    expect(s.mode).toBe('annotate');
    s = reduce(s, { type: 'esc' });
    expect(s.confirm).toBe(true);
    const sent = run(withDraft(opened()), { type: 'describe' }, { type: 'send' }, { type: 'sendOk' }, { type: 'esc' });
    expect(sent.mode).toBe('idle');
  });
});

describe('section 2 visibility rules', () => {
  const sending = (flow: Flow) => run(withDraft(opened(flow)), ...(flow === 'annotate' ? [{ type: 'describe' } as Event] : []), { type: 'send' });

  it('panel, flow annotate: only in review, sending, error, sent', () => {
    expect(panelVisible(initialState())).toBe(false);
    expect(panelVisible(opened())).toBe(false);
    const r = reduce(opened(), { type: 'describe' });
    expect(panelVisible(r)).toBe(true);
    const sg = sending('annotate');
    expect(panelVisible(sg)).toBe(true);
    expect(panelVisible(reduce(sg, { type: 'sendFail' }))).toBe(true);
    expect(panelVisible(reduce(sg, { type: 'sendOk' }))).toBe(true);
  });

  it('panel, flow docked: from open onward', () => {
    expect(panelVisible(initialState({ flow: 'docked' }))).toBe(false);
    expect(panelVisible(opened('docked'))).toBe(true);
    expect(panelVisible(sending('docked'))).toBe(true);
  });

  it('panel, flow note: once a mark exists, plus sending, error, sent', () => {
    const n = opened('note');
    expect(panelVisible(n)).toBe(false);
    expect(panelVisible(reduce(n, { type: 'addMark', id: 'm1' }))).toBe(true);
    const sg = run(withDraft(n), { type: 'addMark', id: 'm1' }, { type: 'send' }, { type: 'removeMark', id: 'm1' });
    expect(sg.mode).toBe('sending');
    expect(panelVisible(sg)).toBe(true);
    expect(panelVisible(reduce(sg, { type: 'sendFail' }))).toBe(true);
    expect(panelVisible(reduce(sg, { type: 'sendOk' }))).toBe(true);
  });

  it('toolbar: only in annotate', () => {
    expect(toolbarVisible(initialState())).toBe(false);
    expect(toolbarVisible(opened())).toBe(true);
    expect(toolbarVisible(reduce(opened(), { type: 'describe' }))).toBe(false);
    expect(toolbarVisible(sending('docked'))).toBe(false);
  });

  it('hint chip: only in annotate, hidden while confirm is open', () => {
    const a = reduce(opened(), { type: 'addMark', id: 'm1' });
    expect(hintVisible(a)).toBe(true);
    expect(hintVisible(reduce(a, { type: 'closeRequest' }))).toBe(false);
    expect(hintVisible(reduce(a, { type: 'describe' }))).toBe(false);
    expect(hintVisible(initialState())).toBe(false);
  });

  it('capture frame: whenever open, except in sent and folding', () => {
    expect(frameVisible(initialState())).toBe(false);
    expect(frameVisible(opened())).toBe(true);
    const sg = sending('annotate');
    expect(frameVisible(sg)).toBe(true);
    expect(frameVisible(reduce(sg, { type: 'sendFail' }))).toBe(true);
    expect(frameVisible(reduce(sg, { type: 'sendOk' }))).toBe(false);
    const fold = run(withDraft(opened('annotate', 'fold')), { type: 'describe' }, { type: 'send' }, { type: 'sendOk' });
    expect(frameVisible(fold)).toBe(false);
  });

  it('launcher: only in idle, and during folding', () => {
    expect(launcherVisible(initialState())).toBe(true);
    expect(launcherVisible(opened())).toBe(false);
    expect(launcherVisible(sending('annotate'))).toBe(false);
    const fold = run(withDraft(opened('annotate', 'fold')), { type: 'describe' }, { type: 'send' }, { type: 'sendOk' });
    expect(launcherVisible(fold)).toBe(true);
  });

  it('marks: whenever the widget is open', () => {
    expect(marksVisible(initialState())).toBe(false);
    expect(marksVisible(opened())).toBe(true);
    const sg = sending('annotate');
    expect(marksVisible(sg)).toBe(true);
    expect(marksVisible(reduce(sg, { type: 'sendOk' }))).toBe(true);
    expect(marksVisible(reduce(reduce(sg, { type: 'sendOk' }), { type: 'done' }))).toBe(false);
  });
});

describe('overlay flags', () => {
  it('popover, textEdit, drawing, hover, tool and marks are plain setters; undoMark drops the last mark', () => {
    const target = {};
    const s = run(
      opened(),
      { type: 'addMark', id: 'm1' },
      { type: 'addMark', id: 'm2' },
      { type: 'popover', id: 'm2' },
      { type: 'drawing', on: true },
      { type: 'hover', target },
      { type: 'setTool', tool: 'arrow' },
    );
    expect(s).toMatchObject({ popover: 'm2', drawing: true, tool: 'arrow' });
    expect(s.hover).toBe(target);
    const u = reduce(s, { type: 'undoMark' });
    expect(u.marks.map((m) => m.id)).toEqual(['m1']);
    expect(u.popover).toBeNull();
  });
});
