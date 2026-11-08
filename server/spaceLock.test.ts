import { afterEach, describe, expect, it } from 'vitest';
import { closeRedis, withSpaceLock } from './db/redis.js';

afterEach(closeRedis);

describe('space mutations without Redis', () => {
  it('keeps a second operation outside the same space until the first finishes', async () => {
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = withSpaceLock('space-a', async () => { entered(); await held; });
    await inside;
    let secondEntered = false;
    const second = withSpaceLock('space-a', async () => { secondEntered = true; });
    try {
      await new Promise<void>((r) => setImmediate(r));
      expect(secondEntered).toBe(false);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(secondEntered).toBe(true);
  });

  it('allows another space to proceed and releases ownership after an error', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = withSpaceLock('space-a', async () => { await held; throw new Error('failed mutation'); });
    const failure = expect(first).rejects.toThrow('failed mutation');
    try {
      expect(await withSpaceLock('space-b', async () => 'independent')).toBe('independent');
    } finally { release(); }
    await failure;
    expect(await withSpaceLock('space-a', async () => 'recovered')).toBe('recovered');
  });
});
