import { describe, it, expect } from 'vitest';
import { splitAttachedLines } from '../attachedLines';

describe('splitAttachedLines', () => {
  it('peels trailing Attached lines after text', () => {
    const r = splitAttachedLines('look at this\n\nAttached: /home/me/.att/abc12345-shot.png\nAttached: /home/me/.att/x.jpg');
    expect(r.body).toBe('look at this');
    expect(r.attachments).toEqual([
      { path: '/home/me/.att/abc12345-shot.png', label: 'shot.png' },
      { path: '/home/me/.att/x.jpg', label: 'x.jpg' },
    ]);
  });

  it('handles a message that is only Attached lines', () => {
    const r = splitAttachedLines('Attached: /tmp/a/mwl49dj6-photo.heic\n');
    expect(r.body).toBe('');
    expect(r.attachments).toEqual([{ path: '/tmp/a/mwl49dj6-photo.heic', label: 'photo.heic' }]);
  });

  it('leaves text without Attached lines untouched', () => {
    const r = splitAttachedLines('hello\nthere');
    expect(r).toEqual({ body: 'hello\nthere', attachments: [] });
  });

  it('does not peel an Attached line in the middle', () => {
    const text = 'see\nAttached: /tmp/a.png\nand more text';
    expect(splitAttachedLines(text)).toEqual({ body: text, attachments: [] });
    const r = splitAttachedLines('see\nAttached: /tmp/a.png\nmore\n\nAttached: /tmp/b.png');
    expect(r.body).toBe('see\nAttached: /tmp/a.png\nmore');
    expect(r.attachments.map((a) => a.path)).toEqual(['/tmp/b.png']);
  });

  it('strips only a 6-12 char id prefix from the label', () => {
    const lbl = (p: string) => splitAttachedLines(`Attached: ${p}`).attachments[0].label;
    expect(lbl('/x/ABC123-pic.png')).toBe('pic.png');
    expect(lbl('/x/abc123def456-pic.png')).toBe('pic.png');
    expect(lbl('/x/abc-pic.png')).toBe('abc-pic.png');
    expect(lbl('/x/plain.png')).toBe('plain.png');
    expect(lbl('C:\\Users\\me\\a1b2c3d4-win.png')).toBe('win.png');
  });
});
