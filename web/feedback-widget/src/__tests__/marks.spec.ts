import { describe, expect, it } from 'vitest';
import {
  MARK_COLORS,
  type Mark,
  arrowCommits,
  arrowHead,
  boxCommits,
  drawCommits,
  drawPath,
  number,
  sampleDrawPoint,
  shouldSample,
  textColorOn,
} from '../ui/marks';

const c = MARK_COLORS.rust;
const marks: Mark[] = [
  { id: 'a', kind: 'pin', color: c, x: 10, y: 10 },
  { id: 'b', kind: 'arrow', color: c, x1: 0, y1: 0, x2: 20, y2: 0 },
  { id: 'c', kind: 'box', color: c, x: 0, y: 0, w: 10, h: 10 },
  { id: 'd', kind: 'draw', color: c, points: [] },
  { id: 'e', kind: 'element', color: c, x: 0, y: 0, w: 5, h: 5, selector: '#x' },
  { id: 'f', kind: 'text', color: c, x: 0, y: 0, text: 'hi' },
  { id: 'g', kind: 'pin', color: c, x: 1, y: 1 },
];

describe('number()', () => {
  it('numbers pins, boxes and elements 1..k in creation order only', () => {
    const out = number(marks);
    expect(out.map((m) => [m.id, m.n])).toEqual([
      ['a', 1], ['b', undefined], ['c', 2], ['d', undefined], ['e', 3], ['f', undefined], ['g', 4],
    ]);
    expect(marks[0].n).toBeUndefined(); // input not mutated
  });

  it('renumbers after a delete', () => {
    const once = number(marks);
    const afterDelete = number(once.filter((m) => m.id !== 'c'));
    expect(afterDelete.filter((m) => m.n !== undefined).map((m) => [m.id, m.n])).toEqual([
      ['a', 1], ['e', 2], ['g', 3],
    ]);
  });
});

describe('creation thresholds', () => {
  it('box commits only at >= 8x8', () => {
    expect(boxCommits(8, 8)).toBe(true);
    expect(boxCommits(7.9, 8)).toBe(false);
    expect(boxCommits(8, 7.9)).toBe(false);
    expect(boxCommits(-8, -8)).toBe(true);
  });

  it('arrow commits only at length >= 14', () => {
    expect(arrowCommits(0, 0, 14, 0)).toBe(true);
    expect(arrowCommits(0, 0, 13.9, 0)).toBe(false);
    expect(arrowCommits(0, 0, 6, 8)).toBe(false); // L = 10
    expect(arrowCommits(0, 0, 9, 12)).toBe(true); // L = 15
  });

  it('draw samples only moves > 2.5 px and commits with >= 3 points', () => {
    expect(shouldSample(undefined, { x: 0, y: 0 })).toBe(true);
    expect(shouldSample({ x: 0, y: 0 }, { x: 2.5, y: 0 })).toBe(false);
    expect(shouldSample({ x: 0, y: 0 }, { x: 2.6, y: 0 })).toBe(true);
    let pts = sampleDrawPoint([], { x: 0, y: 0 });
    pts = sampleDrawPoint(pts, { x: 1, y: 1 }); // dropped
    pts = sampleDrawPoint(pts, { x: 3, y: 0 });
    expect(pts).toEqual([{ x: 0, y: 0 }, { x: 3, y: 0 }]);
    expect(drawCommits(pts)).toBe(false);
    pts = sampleDrawPoint(pts, { x: 6, y: 0 });
    expect(drawCommits(pts)).toBe(true);
  });
});

describe('drawPath()', () => {
  it('builds the quadratic-midpoint smoothed path', () => {
    expect(drawPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }])).toBe(
      'M0 0 Q10 0 10 5 Q10 10 15 10 L20 10',
    );
  });
  it('handles short inputs', () => {
    expect(drawPath([])).toBe('');
    expect(drawPath([{ x: 1, y: 2 }])).toBe('M1 2');
    expect(drawPath([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe('M1 2 L3 4');
  });
});

describe('arrowHead()', () => {
  it('uses 0.45·L when that is under 18, half-width 0.62×', () => {
    const h = arrowHead(0, 0, 20, 0);
    expect(h.length).toBeCloseTo(9);
    expect(h.halfWidth).toBeCloseTo(5.58);
    expect(h.tip).toEqual({ x: 20, y: 0 });
    expect(h.base.x).toBeCloseTo(11);
    expect(h.base.y).toBeCloseTo(0);
    expect(h.left.x).toBeCloseTo(11);
    expect(h.left.y).toBeCloseTo(5.58);
    expect(h.right.y).toBeCloseTo(-5.58);
    expect(h.path).toBe('M20 0 L11 5.58 L11 -5.58 Z');
  });

  it('caps head length at 18 and orients along the shaft', () => {
    const h = arrowHead(0, 0, 0, 100);
    expect(h.length).toBe(18);
    expect(h.halfWidth).toBeCloseTo(11.16);
    expect(h.base.x).toBeCloseTo(0);
    expect(h.base.y).toBeCloseTo(82);
    expect(Math.abs(h.left.x)).toBeCloseTo(11.16);
    expect(h.left.x).toBeCloseTo(-h.right.x);
    expect(h.left.y).toBeCloseTo(82);
  });
});

describe('textColorOn()', () => {
  it('exports the four mark colours', () => {
    expect(MARK_COLORS).toEqual({ rust: '#a83818', amber: '#f4b942', green: '#2e5a3e', ink: '#1a1612' });
  });
  it('maps each colour to its text colour', () => {
    expect(textColorOn(MARK_COLORS.rust)).toBe('#fff8ef');
    expect(textColorOn(MARK_COLORS.amber)).toBe('#1a1612');
    expect(textColorOn(MARK_COLORS.green)).toBe('#f5f0e6');
    expect(textColorOn(MARK_COLORS.ink)).toBe('#f5f0e6');
  });
});
