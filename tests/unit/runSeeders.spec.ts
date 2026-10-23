import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runSeedersSerially } = require('../../src/main/lib/runSeeders.cjs');

describe('runSeedersSerially', () => {
  it('runs seeders serially', async () => {
    const events: string[] = [];
    const mk = (name: string, ms: number) => ({
      name,
      run: async () => {
        events.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`end:${name}`);
      },
    });
    await runSeedersSerially([mk('a', 20), mk('b', 5), mk('c', 1)]);
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('one failure does not skip later seeders', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran: string[] = [];
    await runSeedersSerially([
      { name: 'first', run: async () => { ran.push('first'); } },
      { name: 'boom', run: async () => { throw new Error('nope'); } },
      { name: 'last', run: async () => { ran.push('last'); } },
    ]);
    expect(ran).toEqual(['first', 'last']);
    expect(err).toHaveBeenCalledWith('[seed] boom failed: nope');
    err.mockRestore();
  });
});
