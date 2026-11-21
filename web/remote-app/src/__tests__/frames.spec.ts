// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { chunkFrames, serializedBytes, SendBudget, FRAME_DATA_BYTES } from '../frames';

const req = createRequire(import.meta.url);
const desktop = req('../../../../src/main/lib/feedback-remote/remoteIpcDispatch.cjs') as {
  chunkFrames: (v: unknown, max?: number) => { ok: boolean; frames: { seq: number; total: number; data: string }[] };
  joinFrames: (frames: { seq: number; total: number; data: string }[]) => unknown;
};

const enc = new TextEncoder();
/** Bytes of a slice once it is re-stringified inside a frame (minus the surrounding quotes). */
const escapedBytes = (s: string) => enc.encode(JSON.stringify(s)).length - 2;
const rejoin = (frames: { data: string }[]) => JSON.parse(frames.map((f) => f.data).join(''));

function assertFrames(value: unknown, maxBytes: number) {
  const frames = chunkFrames(value, maxBytes);
  expect(frames.length).toBeGreaterThan(0);
  frames.forEach((f, i) => {
    expect(f.seq).toBe(i);
    expect(f.total).toBe(frames.length);
    expect(escapedBytes(f.data)).toBeLessThan(maxBytes);
  });
  expect(rejoin(frames)).toEqual(value);
  return frames;
}

describe('chunkFrames', () => {
  it('exports the desktop frame budget', () => {
    expect(FRAME_DATA_BYTES).toBe(180000);
  });

  it('splits a 600 KB string payload into frames within budget', () => {
    const value = { text: 'a'.repeat(600 * 1024) };
    expect(serializedBytes(value)).toBeGreaterThan(600 * 1024);
    const frames = assertFrames(value, FRAME_DATA_BYTES);
    expect(frames.length).toBeGreaterThanOrEqual(4);
  });

  it('budgets JSON-escaped quotes, backslashes, newlines and control bytes', () => {
    const value = { text: '"\\\n\r\t\b\f\u0001'.repeat(40000), nested: ['"q"', 'a\\b'] };
    const frames = assertFrames(value, 50000);
    expect(frames.length).toBeGreaterThan(1);
  });

  it('never splits a multi-byte (emoji) character', () => {
    const value = { text: '😀é中'.repeat(30000) };
    const frames = assertFrames(value, 10007);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(f.data).not.toContain('�');
  });

  it('yields one frame for a tiny value and null for undefined', () => {
    expect(chunkFrames(1)).toEqual([{ seq: 0, total: 1, data: '1' }]);
    expect(chunkFrames(undefined)).toEqual([{ seq: 0, total: 1, data: 'null' }]);
  });

  it('serializedBytes is the UTF-8 length of JSON.stringify', () => {
    expect(serializedBytes({ a: '😀' })).toBe(enc.encode(JSON.stringify({ a: '😀' })).length);
  });

  it('interops with the desktop joinFrames and matches the desktop chunkFrames', () => {
    const value = { text: '"\\\n😀'.repeat(50000), n: 42, list: [1, 'two', { three: true }] };
    const frames = chunkFrames(value, 30000);
    expect(frames.length).toBeGreaterThan(1);
    expect(desktop.joinFrames(frames)).toEqual(value);
    expect(frames).toEqual(desktop.chunkFrames(value, 30000).frames);
  });
});

describe('SendBudget', () => {
  function fakeClock() {
    let t = 0;
    const sleeps: number[] = [];
    return {
      now: () => t,
      sleeps,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    };
  }

  it('lets 50 takes through immediately and delays the 51st by one refill period', async () => {
    const clock = fakeClock();
    const budget = new SendBudget({ capacity: 50, refillMs: 1000, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 50; i++) await budget.take();
    expect(clock.sleeps).toEqual([]);
    expect(clock.now()).toBe(0);
    await budget.take();
    expect(clock.sleeps.length).toBeGreaterThan(0);
    expect(clock.now()).toBe(1000);
  });

  it('refills over elapsed time without sleeping', async () => {
    const clock = fakeClock();
    const budget = new SendBudget({ now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 50; i++) await budget.take();
    await clock.sleep(2000);
    clock.sleeps.length = 0;
    await budget.take();
    await budget.take();
    expect(clock.sleeps).toEqual([]);
  });

  it('note() consumes budget', async () => {
    const clock = fakeClock();
    const budget = new SendBudget({ capacity: 50, refillMs: 1000, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 50; i++) budget.note();
    await budget.take();
    expect(clock.now()).toBe(1000);
  });

  it('serializes concurrent takes so the bucket never overfills', async () => {
    const clock = fakeClock();
    const budget = new SendBudget({ capacity: 2, refillMs: 1000, now: clock.now, sleep: clock.sleep });
    await Promise.all([budget.take(), budget.take(), budget.take(), budget.take()]);
    expect(clock.now()).toBe(2000);
  });
});
