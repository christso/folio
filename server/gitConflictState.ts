import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
interface ConflictState {
  version: 1;
  baseline: string | null;
  paths: string[];
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: dir, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function statePath(dir: string): Promise<string> {
  return path.resolve(dir, (await git(dir, ['rev-parse', '--git-path', 'folio-conflicts.json'])).trim());
}

async function read(dir: string): Promise<ConflictState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(await statePath(dir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const state = JSON.parse(raw) as ConflictState;
  if (
    state?.version !== 1 ||
    !(state.baseline === null || (typeof state.baseline === 'string' && /^[a-f0-9]{40,64}$/.test(state.baseline))) ||
    !Array.isArray(state.paths) ||
    state.paths.length === 0 ||
    !state.paths.every((p) => typeof p === 'string' && p.length > 0)
  ) {
    throw new Error('Invalid local Git conflict state; recover with Take the version from Git');
  }
  return state;
}

async function write(dir: string, state: ConflictState): Promise<void> {
  const target = await statePath(dir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Save paths BEFORE staging removes Git's unmerged index entries. */
export async function rememberUnmergedPaths(dir: string): Promise<void> {
  const paths = (await git(dir, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
  if (paths.length > 0) await write(dir, { version: 1, baseline: null, paths });
}

/** If the process stops before this step, baseline=null keeps publication blocked. */
export async function rememberConflictCommit(dir: string): Promise<void> {
  const state = await read(dir);
  if (state) await write(dir, { ...state, baseline: (await git(dir, ['rev-parse', 'HEAD'])).trim() });
}

/** A committed edit to the affected path is a resolution; unrelated edits are not. */
export async function unresolvedPaths(dir: string): Promise<string[]> {
  const state = await read(dir);
  if (!state) return [];
  if (!state.baseline) return state.paths;
  const changed = new Set((await git(dir, ['diff', '--name-only', '--no-renames', '-z', state.baseline, 'HEAD', '--', ...state.paths.map((p) => `:(literal)${p}`)])).split('\0'));
  return state.paths.filter((p) => !changed.has(p));
}

export async function clearConflictState(dir: string): Promise<void> {
  await fs.rm(await statePath(dir), { force: true });
}
