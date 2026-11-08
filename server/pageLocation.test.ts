import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withSpaceLock } from './db/redis.js';
import { withPageLocation } from './pageLocation.js';

const location = vi.hoisted(() => ({ space: 'space-a', relPath: 'allowed/page.md' }));
vi.mock('./storage.js', () => ({ requireEntry: async () => ({ ...location }) }));
beforeEach(() => { location.relPath = 'allowed/page.md'; });
const expected = { space: 'space-a', path: 'allowed/page.md' };

describe('location guard and structural operations share one fence', () => {
  it('holds the checked location throughout an asynchronous document acquisition', async () => {
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const read = withPageLocation('page', expected, async () => {
      entered();
      await held;
      return location.relPath;
    });
    await inside;
    const move = withSpaceLock('space-a', async () => { location.relPath = 'outside/page.md'; });
    try {
      await new Promise<void>((r) => setImmediate(r));
      expect(location.relPath).toBe('allowed/page.md');
    } finally { release(); }
    expect(await read).toBe('allowed/page.md');
    await move;
    expect(location.relPath).toBe('outside/page.md');
  });

  it('rechecks location after an earlier queued move and returns no content', async () => {
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const move = withSpaceLock('space-a', async () => {
      entered(); await held;
      location.relPath = 'outside/page.md';
    });
    await inside;
    const read = withPageLocation('page', expected, async () => 'content must not be returned');
    const refusal = expect(read).rejects.toMatchObject({ code: 'location_conflict', status: 409 });
    release();
    await Promise.all([move, refusal]);
    // A failed precondition must release the fence for a legitimate new request.
    expect(await withPageLocation('page', { ...expected, path: location.relPath }, async () => 'current content')).toBe('current content');
  });

  it('rejects malformed preconditions without treating an absent guard as a scope grant', async () => {
    await expect(withPageLocation('page', { space: 'space-a' }, async () => 'body')).rejects.toMatchObject({ code: 'invalid_page_location' });
    expect(await withPageLocation('page', undefined, async () => 'existing authorized path')).toBe('existing authorized path');
  });
});
