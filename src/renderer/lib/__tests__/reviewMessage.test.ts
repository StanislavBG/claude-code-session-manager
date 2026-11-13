import { describe, expect, it } from 'vitest';
import { composeReviewMessage, REVIEW_MESSAGE_MAX_BYTES, type ReviewComment } from '../reviewMessage';

let seq = 0;
function c(over: Partial<ReviewComment> = {}): ReviewComment {
  seq += 1;
  return {
    id: `c${seq}`,
    sectionKey: 'session:live',
    sectionLabel: 'Uncommitted session changes',
    commit: null,
    path: 'src/a.ts',
    side: 'new',
    startLine: 1,
    endLine: 1,
    lineText: 'const a = 1;',
    body: 'fix this',
    createdAt: seq,
    ...over,
  };
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('composeReviewMessage', () => {
  it('returns empty string with no comments and no note', () => {
    expect(composeReviewMessage({ comments: [], note: '' })).toBe('');
    expect(composeReviewMessage({ comments: [c({ body: '   ' })], note: '  \n ' })).toBe('');
    expect(composeReviewMessage({ comments: [] })).toBe('');
  });

  it('renders a note-only message', () => {
    const msg = composeReviewMessage({ comments: [c({ body: '' })], note: '  Please tidy up.  ' });
    expect(msg.startsWith(
      "Review comments on this session's changes: 0 comment(s) on 0 file(s). Address each one, then reply with what you changed.",
    )).toBe(true);
    expect(msg).toContain('\n\nPlease tidy up.');
    expect(msg).not.toContain('Please tidy up.  ');
    expect(msg).not.toContain('###');
  });

  it('groups by section (first appearance), then path, then startLine', () => {
    const landed = { sectionKey: 'prd:12', sectionLabel: 'PRD 12', commit: 'abcdef1234567890' };
    const comments = [
      c({ ...landed, path: 'src/z.ts', startLine: 9, body: 'L-z9' }),
      c({ path: 'src/b.ts', startLine: 20, body: 'S-b20' }),
      c({ ...landed, path: 'src/m.ts', startLine: 3, body: 'L-m3' }),
      c({ path: 'src/a.ts', startLine: 7, body: 'S-a7' }),
      c({ path: 'src/b.ts', startLine: 2, body: 'S-b2' }),
      c({ path: 'src/a.ts', startLine: 1, body: '' }),
    ];
    const msg = composeReviewMessage({ comments, note: 'overall' });
    expect(msg.startsWith("Review comments on this session's changes: 5 comment(s) on 4 file(s).")).toBe(true);
    const order = ['PRD 12', '### src/m.ts', 'L-m3', '### src/z.ts', 'L-z9',
      'Uncommitted session changes', '### src/a.ts', 'S-a7', '### src/b.ts', 'S-b2', 'S-b20'];
    let at = -1;
    for (const token of order) {
      const i = msg.indexOf(token, at + 1);
      expect(i, token).toBeGreaterThan(at);
      at = i;
    }
    expect(msg.indexOf('overall')).toBeLessThan(msg.indexOf('PRD 12'));
  });

  it('says where the code is for live vs landed sections', () => {
    const msg = composeReviewMessage({
      comments: [
        c({ body: 'live one' }),
        c({ sectionKey: 'prd:7', sectionLabel: 'PRD 7', commit: '0123456789abcdef', body: 'landed one' }),
      ],
    });
    expect(msg).toContain('in your worktree (not yet merged)');
    expect(msg).toContain('landed on the base branch at 01234567');
    expect(msg).not.toContain('012345678');
    expect(msg).toContain('may not exist in your worktree');
  });

  it('labels single lines and ranges, with old-side wording', () => {
    const msg = composeReviewMessage({
      comments: [
        c({ startLine: 42, endLine: 42, body: 'single' }),
        c({ startLine: 50, endLine: 53, body: 'range' }),
        c({ side: 'old', startLine: 60, endLine: 61, body: 'removed' }),
      ],
    });
    expect(msg).toMatch(/line 42\b[^\n]*\n/);
    expect(msg).toContain('lines 50-53');
    expect(msg).toMatch(/old lines 60-61 \(removed code\)/);
    expect(msg).not.toMatch(/old line 42/);
  });

  it('uses a fence longer than any backtick run in the code', () => {
    const msg = composeReviewMessage({ comments: [c({ lineText: 'x = ```` y ` z', body: 'b' })] });
    expect(msg).toContain('`````\nx = ```` y ` z\n`````');
    const plain = composeReviewMessage({ comments: [c({ lineText: 'plain', body: 'b' })] });
    expect(plain).toContain('```\nplain\n```');
  });

  it('clamps the quoted line to 500 characters', () => {
    const msg = composeReviewMessage({ comments: [c({ lineText: 'a'.repeat(2000), body: 'long' })] });
    const fenced = msg.match(/```\n([^\n]*)\n```/);
    expect(fenced).not.toBeNull();
    expect(Array.from(fenced![1]).length).toBe(500);
    expect(msg).not.toContain('a'.repeat(501));
  });

  it('trims the body', () => {
    const msg = composeReviewMessage({ comments: [c({ body: '  \n trimmed body \n ' })] });
    expect(msg).toContain('\ntrimmed body');
    expect(msg.endsWith('trimmed body')).toBe(true);
  });

  it('drops quotes first when over the byte budget', () => {
    // 100 comments × ~500 multi-byte quote chars (3 bytes each) ≈ 150 KB of quotes; bodies small.
    const comments = Array.from({ length: 100 }, (_, i) =>
      c({ path: `src/f${i}.ts`, lineText: '€'.repeat(600), body: `body ${i} ü` }));
    const msg = composeReviewMessage({ comments });
    expect(bytes(msg)).toBeLessThanOrEqual(REVIEW_MESSAGE_MAX_BYTES);
    expect(REVIEW_MESSAGE_MAX_BYTES).toBe(90000);
    expect(msg).not.toContain('€');
    for (let i = 0; i < 100; i++) expect(msg).toContain(`body ${i} ü`);
    expect(msg).not.toMatch(/omitted/);
  });

  it('drops trailing comments after quotes and says how many', () => {
    const comments = Array.from({ length: 40 }, (_, i) =>
      c({ path: `src/f${String(i).padStart(2, '0')}.ts`, body: `B${String(i).padStart(2, '0')} ${'日本語'.repeat(1000)}` }));
    const msg = composeReviewMessage({ comments, note: 'note ✓' });
    expect(bytes(msg)).toBeLessThanOrEqual(REVIEW_MESSAGE_MAX_BYTES);
    expect(msg).toContain('B00 ');
    expect(msg).not.toContain('B39 ');
    const m = msg.match(/(\d+) more comment\(s\) omitted/);
    expect(m).not.toBeNull();
    const kept = comments.filter((x) => msg.includes(`${x.body.slice(0, 4)}`)).length;
    expect(kept + Number(m![1])).toBe(40);
    expect(msg.trimEnd().split('\n').pop()).toMatch(/omitted/);
    expect(msg).toContain('40 comment(s) on 40 file(s)');
  });

  it('never exceeds the budget even with a huge note', () => {
    const msg = composeReviewMessage({ comments: [c()], note: 'ö'.repeat(100000) });
    expect(bytes(msg)).toBeLessThanOrEqual(REVIEW_MESSAGE_MAX_BYTES);
    expect(msg.startsWith('Review comments')).toBe(true);
  });
});
