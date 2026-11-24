// index.ts starts the outbox at script load, even when the widget declines to render.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, describe, expect, it, vi } from 'vitest';

const startSpy = vi.hoisted(() => vi.fn());
vi.mock('../outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../outbox')>();
  return {
    ...actual,
    startOutbox: () => {
      startSpy();
      actual.startOutbox();
    },
  };
});

afterAll(async () => {
  (await import('../outbox')).stopOutbox();
  (await import('../host')).resetForTests();
});

describe('index load', () => {
  it('runs startOutbox when the script loads', async () => {
    globalThis.indexedDB = new IDBFactory();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 }); // too narrow
    await import('../index');
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(document.getElementById('feedback-widget-host')).toBeNull();
    expect(typeof window.Feedback?.identify).toBe('function');
  });
});
