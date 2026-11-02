import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as git from './git.js';

/**
 * Production, 15.09: 7 of 12 git spaces had the status `error` with the
 * lastError "commit -m merge with conflicts failed" on every sync tick.
 * mergeFetchedRemote treated ANY `git merge` error as a conflict, and
 * performSync then called commitConflictState — and `git commit` failed with
 * "nothing to commit", because the merge never started at all. The real cause
 * (e.g. "refusing to merge unrelated histories") got lost. This is pure git
 * logic, without a database.
 */

const run = promisify(execFile);
const roots: string[] = [];

async function sh(cwd: string, ...args: string[]): Promise<void> {
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
}

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-merge-'));
  roots.push(dir);
  return dir;
}

async function repoWithCommit(dir: string, file: string, text: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await sh(dir, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(dir, file), text, 'utf8');
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', `add ${file}`);
}

afterAll(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('mergeFetchedRemote', () => {
  it('a real conflict returns { conflict: true }', async () => {
    const root = await tempDir();
    const remote = path.join(root, 'remote.git');
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);

    const a = path.join(root, 'a');
    await repoWithCommit(a, 'f.md', 'base\n');
    await sh(a, 'remote', 'add', 'origin', remote);
    await sh(a, 'push', '-q', 'origin', 'main');

    const b = path.join(root, 'b');
    await run('git', ['clone', '-q', remote, b]);

    await fs.writeFile(path.join(a, 'f.md'), 'from A\n', 'utf8');
    await sh(a, 'commit', '-qam', 'A');
    await sh(a, 'push', '-q', 'origin', 'main');

    await fs.writeFile(path.join(b, 'f.md'), 'from B\n', 'utf8');
    await sh(b, 'commit', '-qam', 'B');
    await sh(b, 'fetch', '-q', 'origin');

    await expect(git.mergeFetchedRemote(b, 'main')).resolves.toEqual({ conflict: true });
  });

  it('a failed merge WITHOUT a conflict throws the real git error and does not pretend to be a conflict', async () => {
    const root = await tempDir();
    const remote = path.join(root, 'remote.git');
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);

    const a = path.join(root, 'a');
    await repoWithCommit(a, 'a.md', 'A\n');
    await sh(a, 'remote', 'add', 'origin', remote);
    await sh(a, 'push', '-q', 'origin', 'main');

    // An independent history — this is what happens when two spaces bootstrapped the same empty repository.
    const c = path.join(root, 'c');
    await repoWithCommit(c, 'c.md', 'C\n');
    await sh(c, 'remote', 'add', 'origin', remote);
    await sh(c, 'fetch', '-q', 'origin');

    await expect(git.mergeFetchedRemote(c, 'main')).rejects.toThrow(/unrelated histories/);
    // And the working tree stays usable: no unfinished merge.
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: c });
    expect(stdout.trim()).toBe('');
  });
});

/**
 * The real cause of "stuck" spaces in production (15.09), which the previous
 * catch-all hid: `git merge` creates a merge commit, and the container has no
 * git identity at all — "Committer identity unknown". On a developer's
 * machine git guesses the name from the system itself, so the test turns on
 * user.useConfigOnly and cuts off the global profile: that is exactly how
 * the container behaves.
 */
describe('mergeFetchedRemote without a git identity in the environment', () => {
  const saved: Record<string, string | undefined> = {};
  const isolate = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.useConfigOnly',
    GIT_CONFIG_VALUE_0: 'true',
  };

  it('creates the merge commit on behalf of Folio instead of "Committer identity unknown"', async () => {
    const root = await tempDir();
    const remote = path.join(root, 'remote.git');
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);

    const a = path.join(root, 'a');
    await repoWithCommit(a, 'base.md', 'base\n');
    await sh(a, 'remote', 'add', 'origin', remote);
    await sh(a, 'push', '-q', 'origin', 'main');

    const b = path.join(root, 'b');
    await run('git', ['clone', '-q', remote, b]);

    // A divergence WITHOUT a conflict: different files — a fast-forward is impossible, a merge commit is needed.
    await fs.writeFile(path.join(a, 'remote-side.md'), 'A\n', 'utf8');
    await sh(a, 'add', '-A');
    await sh(a, 'commit', '-qm', 'remote side');
    await sh(a, 'push', '-q', 'origin', 'main');

    await fs.writeFile(path.join(b, 'local-side.md'), 'B\n', 'utf8');
    await sh(b, 'add', '-A');
    await sh(b, 'commit', '-qm', 'local side');
    await sh(b, 'fetch', '-q', 'origin');

    for (const [key, value] of Object.entries(isolate)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      await expect(git.mergeFetchedRemote(b, 'main')).resolves.toEqual({ conflict: false });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const { stdout } = await run('git', ['log', '-1', '--format=%P|%cn'], { cwd: b });
    const [parents, committer] = stdout.trim().split('|');
    expect(parents.split(' ')).toHaveLength(2); // a real merge commit
    expect(committer).toBeTruthy();
  });
});

/**
 * "Take the version from Git" (owner ask): nobody is ever going to resolve
 * the conflicts of a git-native space by hand, so instead of resolving — a
 * full reset to the remote with a backup branch. The same scenario of a real
 * conflict as in the first test of this file, only after commitConflictState
 * we call resetToRemote instead of leaving the markers as they are.
 */
describe('resetToRemote', () => {
  it('the working tree matches the remote, backupRef contains the conflict markers', async () => {
    const root = await tempDir();
    const remote = path.join(root, 'remote.git');
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);

    const a = path.join(root, 'a');
    await repoWithCommit(a, 'f.md', 'base\n');
    await sh(a, 'remote', 'add', 'origin', remote);
    await sh(a, 'push', '-q', 'origin', 'main');

    const b = path.join(root, 'b');
    await run('git', ['clone', '-q', remote, b]);

    await fs.writeFile(path.join(a, 'f.md'), 'from A\n', 'utf8');
    await sh(a, 'commit', '-qam', 'A');
    await sh(a, 'push', '-q', 'origin', 'main');

    await fs.writeFile(path.join(b, 'f.md'), 'from B\n', 'utf8');
    await sh(b, 'commit', '-qam', 'B');
    await sh(b, 'fetch', '-q', 'origin');

    const { conflict } = await git.mergeFetchedRemote(b, 'main');
    expect(conflict).toBe(true);
    await git.commitConflictState(b);

    // Trivial listConflictedFiles assertion on the same fixture (round
    // "conflicts must be visible" — the whole-working-tree scan performSync
    // now uses instead of the rootPath-scoped hasConflictMarkers).
    await expect(git.listConflictedFiles(b)).resolves.toEqual(['f.md']);

    const { backupRef, changed } = await git.resetToRemote(b, 'main');

    expect(changed).toContain('f.md');
    expect(backupRef).toBeTruthy();

    const fileContent = await fs.readFile(path.join(b, 'f.md'), 'utf8');
    expect(fileContent).toBe('from A\n'); // origin/main ("a"'s pushed content) wins, local B is gone

    const { stdout: statusOut } = await run('git', ['status', '--porcelain'], { cwd: b });
    expect(statusOut.trim()).toBe('');

    // The discarded conflict state survives on the backup branch.
    const { stdout: backupContent } = await run('git', ['show', `${backupRef}:f.md`], { cwd: b });
    expect(backupContent).toContain('<<<<<<<');
  });
});

describe('conflicts without text markers', () => {
  it.each(['local deletion', 'remote deletion', 'binary replacement'])(
    '%s stays blocked across retries, unrelated commits and a new process until resolved',
    async (scenario) => {
      const root = await tempDir();
      const remote = path.join(root, 'remote.git');
      const a = path.join(root, 'a');
      const b = path.join(root, 'b');
      const file = scenario === 'binary replacement' ? 'attachment.pdf' : 'page.md';
      const content = (label: string): Buffer => Buffer.from(scenario === 'binary replacement' ? `%PDF-1.4\n\0${label}\n` : `${label}\n`);
      await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
      await repoWithCommit(a, file, 'base\n');
      if (scenario === 'binary replacement') {
        await fs.writeFile(path.join(a, file), content('base'));
        await sh(a, 'commit', '-qam', 'binary base');
      }
      await sh(a, 'remote', 'add', 'origin', remote);
      await sh(a, 'push', '-q', 'origin', 'main');
      await run('git', ['clone', '-q', remote, b]);

      if (scenario === 'remote deletion') await fs.rm(path.join(a, file));
      else await fs.writeFile(path.join(a, file), content('remote edit'));
      await sh(a, 'commit', '-qam', 'remote change');
      await sh(a, 'push', '-q', 'origin', 'main');
      const { stdout: remoteBefore } = await run('git', ['rev-parse', 'main'], { cwd: remote });

      if (scenario === 'local deletion') await fs.rm(path.join(b, file));
      else await fs.writeFile(path.join(b, file), content('local edit'));
      await sh(b, 'commit', '-qam', 'local change');
      await sh(b, 'fetch', '-q', 'origin');
      expect(await git.mergeFetchedRemote(b, 'main')).toEqual({ conflict: true });
      await git.commitConflictState(b);
      expect(await git.listConflictedFiles(b)).toEqual([file]);

      await fs.writeFile(path.join(b, 'unrelated.md'), 'Unrelated edit\n');
      await git.commitAll(b, 'unrelated edit', { name: 'Tester', email: 'tester@example.test' });
      expect(await git.mergeFetchedRemote(b, 'main')).toEqual({ conflict: false });
      expect(await git.listConflictedFiles(b)).toEqual([file]);
      await expect(git.push(b, 'main')).rejects.toThrow(/unresolved.*conflict/i);
      expect((await run('git', ['rev-parse', 'main'], { cwd: remote })).stdout).toBe(remoteBefore);

      const script = `import { listConflictedFiles } from ${JSON.stringify(new URL('./git.ts', import.meta.url).href)}; console.log(JSON.stringify(await listConflictedFiles(process.argv[1])));`;
      const restarted = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, b]);
      expect(JSON.parse(restarted.stdout)).toEqual([file]);

      // An uncommitted edit is not yet safe to push. Only a committed
      // change to this particular conflict can release its hold.
      await fs.writeFile(path.join(b, file), content('checked resolution'));
      await expect(git.push(b, 'main')).rejects.toThrow(/unresolved.*conflict/i);
      await git.commitAll(b, 'resolve conflict', { name: 'Tester', email: 'tester@example.test' });
      expect(await git.listConflictedFiles(b)).toEqual([]);
      await git.push(b, 'main');
      const published = await run('git', ['show', `main:${file}`], { cwd: remote, encoding: 'buffer' });
      expect(published.stdout).toEqual(content('checked resolution'));
      await fs.writeFile(path.join(b, file), content(scenario === 'local deletion' ? 'remote edit' : 'local edit'));
      await git.commitAll(b, 'later ordinary edit', { name: 'Tester', email: 'tester@example.test' });
      expect(await git.listConflictedFiles(b)).toEqual([]);
    },
    30_000,
  );
});

describe('conflict state recovery', () => {
  it('an interrupted conflict commit and corrupt state both block pushes until explicit recovery', async () => {
    const root = await tempDir();
    const remote = path.join(root, 'remote.git');
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await repoWithCommit(a, 'page.md', 'base\n');
    await sh(a, 'remote', 'add', 'origin', remote);
    await sh(a, 'push', '-q', 'origin', 'main');
    await run('git', ['clone', '-q', remote, b]);
    await fs.writeFile(path.join(a, 'page.md'), 'remote edit\n');
    await sh(a, 'commit', '-qam', 'remote');
    await sh(a, 'push', '-q', 'origin', 'main');
    await fs.rm(path.join(b, 'page.md'));
    await sh(b, 'commit', '-qam', 'delete');
    await sh(b, 'fetch', '-q', 'origin');
    expect(await git.mergeFetchedRemote(b, 'main')).toEqual({ conflict: true });
    const hook = path.join(b, '.git', 'hooks', 'pre-commit');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await expect(git.commitConflictState(b)).rejects.toThrow();
    await fs.rm(hook);
    expect(await git.listConflictedFiles(b)).toEqual(['page.md']);
    await expect(git.push(b, 'main')).rejects.toThrow(/unresolved.*conflict/i);
    await git.resetToRemote(b, 'main');
    expect(await git.listConflictedFiles(b)).toEqual([]);

    await fs.writeFile(path.join(b, '.git', 'folio-conflicts.json'), '{broken');
    await expect(git.push(b, 'main')).rejects.toThrow();
    await git.resetToRemote(b, 'main');
    expect(await git.listConflictedFiles(b)).toEqual([]);
  });
});

describe('interruption before conflict recording', () => {
  it('ordinary commitAll preserves an unmerged index before staging can erase it', async () => {
    const root = await tempDir();
    const remote = path.join(root, 'remote.git');
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await repoWithCommit(a, 'page.md', 'base\n');
    await sh(a, 'remote', 'add', 'origin', remote);
    await sh(a, 'push', '-q', 'origin', 'main');
    await run('git', ['clone', '-q', remote, b]);
    await fs.writeFile(path.join(a, 'page.md'), 'remote edit\n');
    await sh(a, 'commit', '-qam', 'remote');
    await sh(a, 'push', '-q', 'origin', 'main');
    await fs.rm(path.join(b, 'page.md'));
    await sh(b, 'commit', '-qam', 'delete');
    await sh(b, 'fetch', '-q', 'origin');
    expect(await git.mergeFetchedRemote(b, 'main')).toEqual({ conflict: true });
    // Re-entry after the merge, before commitConflictState ever ran.
    await git.commitAll(b, 'retry after interruption', { name: 'Tester', email: 'tester@example.test' });
    expect(await git.listConflictedFiles(b)).toEqual(['page.md']);
    await expect(git.push(b, 'main')).rejects.toThrow(/unresolved.*conflict/i);
  });
});
