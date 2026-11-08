import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import Fastify from 'fastify';
import * as cookies from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as Y from 'yjs';
import WS from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as collab from './collab.js';
import * as storage from './storage.js';
import * as auth from './auth/store.js';
import * as session from './auth/session.js';
import * as gitSync from './gitSync.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { query } from './db/pool.js';
import { registerRoutes } from './routes.js';
import { buildFolioMcpServer } from './mcp.js';
import { HttpError } from './errors.js';
import { bodyRevision } from './documentEdits.js';
import * as pageAccess from './pageAccess.js';
import { buildAssistantTools } from './assistant/tools.js';
import { trackDocumentFileStatus } from '../web/src/app/collabFileStatus.js';
import type { User } from '../shared/contracts.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const require = createRequire(import.meta.url);
const yc = require('yjs') as typeof Y;
const { docs } = require('y-websocket/bin/utils') as { docs: Map<string, Y.Doc> };
let teardown: () => Promise<void>;
let space: string;
let user: User;
const author = { name: 'Robot', email: 'robot@example.com' };
const app = Fastify();
let writeToken: string;
let readToken: string;
let cookie: string;
let client: Client;
let port: number;

beforeAll(async () => {
  teardown = await setUpTestSchema();
  user = await auth.createUser({ email: 'editor@example.com', name: 'Editor', passwordHash: 'x', isAdmin: false });
  space = (await storage.createSpace(`Guarded Editing ${Date.now()}`, null)).slug;
  await auth.setMembership(space, user.id, 'admin');
  writeToken = (await auth.createApiToken(user.id, 'write', ['write'])).token;
  readToken = (await auth.createApiToken(user.id, 'read', ['read'])).token;
  cookie = `folio_session=${(await auth.createSession(user.id)).token}`;
  app.decorateRequest('authUser', null);
  app.setErrorHandler((e, _request, reply) => reply.status(e instanceof HttpError ? e.status : 500).send({ error: e instanceof Error ? e.message : 'internal error' }));
  await app.register(cookies.default);
  await app.register(async (scope) => { scope.addHook('onRequest', session.requireSession); registerRoutes(scope); });
  await app.ready();
  collab.initCollab();
  collab.attachToServer(app.server);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
  const server = buildFolioMcpServer({ user, scopes: ['write'], tokenId: 'synthetic-token' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'guarded-edit-test', version: '1' });
  await Promise.all([client.connect(ct), server.connect(st)]);
});
afterAll(async () => {
  await client?.close();
  await collab.flushAll();
  for (const doc of docs.values()) doc.destroy();
  docs.clear();
  await app.close();
  await deleteTestSpace(space);
  await teardown();
});

async function page(body = '# Page\n\nalpha beta gamma\n') {
  const p = await storage.createPage({ space, parentPath: '', title: 'Page', kind: 'doc' });
  await storage.writeDocBody(p.id, body);
  return p;
}
const headers = () => ({ authorization: `Bearer ${writeToken}` });
async function read(id: string) { return (await app.inject({ method: 'GET', url: `/api/pages/${id}`, headers: headers() })).json(); }
async function call(args: Record<string, unknown>) { return client.callTool({ name: 'update_page', arguments: args }); }

describe('guarded editing through actual storage, REST and MCP', () => {
  it('allows one of two competing bots and persists body and snapshot with unrelated text intact', async () => {
    const p = await page();
    const before = await read(p.id);
    expect(before.revision).toBe(bodyRevision(p.id, before.markdown));
    const edit = (text: string) => app.inject({ method: 'PUT', url: `/api/pages/${p.id}`, headers: headers(), payload: {
      expectedRevision: before.revision, edits: [{ from: 14, to: 18, expectedText: 'beta', text }],
    } });
    const results = await Promise.all([edit('first'), edit('second')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const accepted = results.find((r) => r.statusCode === 200)!.json();
    expect(accepted).toMatchObject({ changed: true, persistence: 'file', publication: 'pending' });
    const body = (await read(p.id)).markdown;
    expect(body).toMatch(/^# Page\n\nalpha (first|second) gamma\n$/);
    expect(await storage.readFreshDocBody(p.id)).toBe(body);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, (await collab.loadSnapshot(p.id))!);
    expect(restored.getText('content').toString()).toBe(body);
    expect(accepted.revision).toBe(bodyRevision(p.id, body));
  });

  it('rejects typing received while a bot is awaiting preparation; keeps attribution for stale and no-op calls', async () => {
    const p = await page();
    const before = await read(p.id);
    gitSync.recordEditor(space, author);
    const requireEntry = storage.requireEntry;
    let typed = false;
    const spy = vi.spyOn(storage, 'requireEntry').mockImplementation(async (id) => {
      const entry = await requireEntry(id);
      if (id === p.id && !typed) { typed = true; docs.get(id)!.getText('content').insert(0, 'Browser\n'); }
      return entry;
    });
    try {
      await expect(collab.editDocumentBody(p.id, { expectedRevision: before.revision, markdown: 'overwrite' }, { name: 'Bot', email: 'bot@example.com' })).rejects.toMatchObject({ status: 409 });
    } finally { spy.mockRestore(); }
    const current = await read(p.id);
    const result = await collab.editDocumentBody(p.id, { expectedRevision: current.revision, markdown: current.markdown }, { name: 'Bot', email: 'bot@example.com' });
    expect(result.changed).toBe(false);
    expect(gitSync.authorFor(space)).toEqual(author);
    expect(await storage.readFreshDocBody(p.id)).toContain('Browser\n# Page');
  });

  it('preserves foreign frontmatter and unrelated offline character identities in a replacement', async () => {
    const p = await page();
    const entry = await storage.requireEntry(p.id);
    const raw = await fs.readFile(entry.absPath, 'utf8');
    await fs.writeFile(entry.absPath, raw.replace('---\n', '---\n# Keep this comment\nsource: "original"\n'));
    const before = await read(p.id);
    const offline = new Y.Doc();
    Y.applyUpdate(offline, (await collab.loadSnapshot(p.id))!);
    const vector = Y.encodeStateVector(offline);
    const offlineText = offline.getText('content');
    // A disconnected editor deletes text outside the bot's replacement.
    offlineText.delete(8, 6);
    const result = await collab.editDocumentBody(p.id, { expectedRevision: before.revision, markdown: before.markdown.replace('beta', 'BETA') }, author);
    expect(result.changed).toBe(true);
    yc.applyUpdate(docs.get(p.id)!, Y.encodeStateAsUpdate(offline, vector));
    await collab.flushDoc(p.id);
    expect((await read(p.id)).markdown).toBe('# Page\n\nBETA gamma\n');
    expect(await fs.readFile(entry.absPath, 'utf8')).toContain('# Keep this comment\nsource: "original"\n');
    offline.destroy();
  });

  it('edits an MDX paragraph while preserving opaque syntax, frontmatter and the MDX path', async () => {
    const p = await page();
    const entry = await storage.requireEntry(p.id);
    const file = entry.absPath.replace(/\.md$/, '.mdx');
    const frontmatter = `---\nid: ${p.id}\ntitle: External guide\nsource: "original"\n---\n`;
    const body = 'import Card from "./Card.astro";\n\n# Guide\n\nA short paragraph.\n\n<Card label="Example">{2 + 2}</Card>\n';
    await fs.rename(entry.absPath, file);
    await fs.writeFile(file, frontmatter + body);
    await storage.scanSpace(space);
    const before = await read(p.id);
    const from = before.markdown.indexOf('short');
    await collab.editDocumentBody(p.id, { expectedRevision: before.revision, edits: [
      { from, to: from + 5, expectedText: 'short', text: 'clear' },
    ] }, author);
    expect(await fs.readFile(file, 'utf8')).toBe(frontmatter + body.replace('short', 'clear'));
    expect((await storage.requireEntry(p.id)).relPath).toMatch(/\.mdx$/);
    await expect(collab.editDocumentBody(p.id, { expectedRevision: before.revision, markdown: 'stale' }, author)).rejects.toMatchObject({ status: 409 });
  });

  it('uses the restored cold snapshot for reads, including exact final newline and pending edits', async () => {
    const p = await page();
    const saved = new Y.Doc();
    saved.getText('content').insert(0, '# Page\n\nsnapshot ahead');
    await collab.storeSnapshot(p.id, saved, await storage.readFreshDocBody(p.id));
    const before = await read(p.id);
    expect(before.markdown).toBe('# Page\n\nsnapshot ahead');
    expect((await collab.editDocumentBody(p.id, { expectedRevision: before.revision, markdown: before.markdown }, author)).changed).toBe(false);
    const reopened = new Y.Doc();
    await collab.bindState(p.id, reopened);
    expect(reopened.getText('content').toString()).toBe(before.markdown);
    reopened.destroy(); saved.destroy();
  });

  it('keeps cold comment anchoring and a guarded save on the same room and preserves the anchor', async () => {
    const body = '# Page\n\nalpha beta gamma\n';
    const p = await page(body);
    const write = storage.writeDocBodyIfChanged;
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(storage, 'writeDocBodyIfChanged').mockImplementation(async (...args) => {
      if (args[0] === p.id) { entered(); await hold; }
      return write(...args);
    });
    const anchoring = collab.anchorQuote(p.id, 'beta');
    const saving = collab.editDocumentBody(p.id, { expectedRevision: bodyRevision(p.id, body), edits: [
      { from: 8, to: 13, expectedText: 'alpha', text: 'ALPHA' },
    ] }, author);
    let anchor: Awaited<typeof anchoring>;
    try {
      await blocked;
      const room = docs.get(p.id);
      release();
      [anchor] = await Promise.all([anchoring, saving]);
      expect(docs.get(p.id)).toBe(room);
      expect((await read(p.id)).markdown).toBe(body.replace('alpha', 'ALPHA'));
    } finally { release(); spy.mockRestore(); await Promise.allSettled([anchoring, saving]); }
    const restored = new Y.Doc();
    Y.applyUpdate(restored, (await collab.loadSnapshot(p.id))!);
    const resolve = (b64: string) => Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Buffer.from(b64, 'base64')), restored)!.index;
    expect(restored.getText('content').toString().slice(resolve(anchor!.anchorFrom), resolve(anchor!.anchorTo))).toBe('beta');
    restored.destroy();
  });

  it('refuses corrupt snapshots without replacing them or leaving a failed room open', async () => {
    const p = await page();
    await query('INSERT INTO ydoc_state(page_id,snapshot) VALUES($1,$2)', [p.id, Buffer.from([255])]);
    await expect(collab.readDocumentBody(p.id)).rejects.toThrow();
    expect(docs.has(p.id)).toBe(false);
    expect([...(await collab.loadSnapshot(p.id))!]).toEqual([255]);
  });

  it('fails closed on snapshot lookup failure, then resumes the original identities', async () => {
    const p = await page();
    const saved = new Y.Doc();
    saved.getText('content').insert(0, '# Page\n\nprior snapshot');
    await collab.storeSnapshot(p.id, saved, await storage.readFreshDocBody(p.id));
    const snapshot = await collab.loadSnapshot(p.id);
    await query('ALTER TABLE ydoc_state RENAME TO unavailable_ydoc_state');
    try {
      await expect(collab.readDocumentBody(p.id)).rejects.toThrow();
      expect(docs.has(p.id)).toBe(false);
    } finally { await query('ALTER TABLE unavailable_ydoc_state RENAME TO ydoc_state'); }
    expect(await collab.loadSnapshot(p.id)).toEqual(snapshot);
    expect((await read(p.id)).markdown).toBe('# Page\n\nprior snapshot');
    saved.destroy();
  });

  it('reclaims an idle API-only room and retains its snapshot for the next read', async () => {
    const p = await page();
    let before;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      before = await read(p.id);
      docs.get(p.id)!.getMap('auxiliary').set('note', 'Keep this root');
      await collab.editDocumentBody(p.id, { expectedRevision: before.revision, markdown: before.markdown + 'Kept body\n' }, author);
      before = await read(p.id);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(docs.has(p.id)).toBe(false);
    } finally { vi.useRealTimers(); }
    expect(await read(p.id)).toMatchObject({ markdown: before.markdown, revision: before.revision });
    expect(docs.get(p.id)!.getMap('auxiliary').get('note')).toBe('Keep this root');
  });

  it('reports persistence failure without hiding the accepted live edit; retry is guarded', async () => {
    const p = await page();
    const before = await read(p.id);
    const entry = await storage.requireEntry(p.id);
    const dir = entry.absPath.slice(0, entry.absPath.lastIndexOf('/'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.chmod(dir, 0o555);
    try {
      await expect(collab.editDocumentBody(p.id, { expectedRevision: before.revision, markdown: '# Page\n\naccepted' }, author)).rejects.toMatchObject({ status: 503, code: 'body_persistence_failed' });
      expect((await read(p.id)).markdown).toContain('accepted');
      expect(await storage.readFreshDocBody(p.id)).toBe(before.markdown);
      await expect(collab.editDocumentBody(p.id, { expectedRevision: before.revision, markdown: '# Page\n\naccepted' }, author)).rejects.toMatchObject({ status: 409 });
    } finally { await fs.chmod(dir, 0o755); errors.mockRestore(); }
    await collab.flushDoc(p.id);
    expect(await storage.readFreshDocBody(p.id)).toContain('accepted');
  });

  it('schedules a file change despite snapshot failure and reclaims the room after recovery', async () => {
    const p = await page();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    collab.setPersistRetryBaseMsForTests(1);
    const activity = vi.spyOn(gitSync, 'noteActivity');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let constrained = false;
    try {
      const before = await read(p.id);
      const snapshot = Buffer.from((await collab.loadSnapshot(p.id))!).toString('hex');
      // Refuse only a changed snapshot for this synthetic page; file writes work.
      await query(`ALTER TABLE ydoc_state ADD CONSTRAINT synthetic_snapshot_failure CHECK (page_id <> '${p.id}' OR snapshot = decode('${snapshot}', 'hex'))`);
      constrained = true;
      await expect(collab.editDocumentBody(p.id, { expectedRevision: before.revision, markdown: '# Page\n\nfile saved' }, author)).rejects.toMatchObject({ status: 503 });
      expect(await storage.readFreshDocBody(p.id)).toContain('file saved');
      expect(activity).toHaveBeenCalledWith(space);
      await vi.waitFor(() => expect(errors.mock.calls.some((call) => String(call[0]).includes('giving up writing page'))).toBe(true), { timeout: 20_000 });
      await query('ALTER TABLE ydoc_state DROP CONSTRAINT synthetic_snapshot_failure');
      constrained = false;
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(async () => {
        const restored = new Y.Doc();
        Y.applyUpdate(restored, (await collab.loadSnapshot(p.id))!);
        expect(restored.getText('content').toString()).toContain('file saved');
        restored.destroy();
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(docs.has(p.id)).toBe(false);
    } finally {
      if (constrained) await query('ALTER TABLE ydoc_state DROP CONSTRAINT synthetic_snapshot_failure');
      activity.mockRestore(); errors.mockRestore();
      collab.setPersistRetryBaseMsForTests(2_000);
      vi.useRealTimers();
    }
  });

  it('holds legacy metadata and replacement writers until a cold read finishes seeding', async () => {
    const p = await page();
    const freshRead = storage.readFreshDocBody;
    const original = await freshRead(p.id);
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(storage, 'readFreshDocBody').mockImplementation(async (id) => {
      if (id === p.id) { entered(); await hold; }
      return freshRead(id);
    });
    try {
      const reading = read(p.id);
      await blocked;
      let metadataFinished = false;
      let legacyFinished = false;
      const metadata = app.inject({ method: 'PUT', url: `/api/pages/${p.id}`, headers: { cookie }, payload: { icon: '📄' } }).then((r) => { metadataFinished = true; return r; });
      const legacy = collab.editDocBody(p.id, '# Page\n\nLegacy text\n').then(() => { legacyFinished = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(metadataFinished).toBe(false);
      expect(legacyFinished).toBe(false);
      expect(await freshRead(p.id)).toBe(original);
      release();
      await Promise.all([reading, metadata, legacy]);
      await collab.flushDoc(p.id);
      expect(await freshRead(p.id)).toBe('# Page\n\nLegacy text\n');
    } finally { release(); spy.mockRestore(); }
  });

  it('exposes the same guarded contract over real MCP transport and preserves legacy browser metadata PUT', async () => {
    const p = await page();
    const before = await read(p.id);
    const missing = await call({ id: p.id, markdown: 'overwrite' });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toContain('revision_required');
    const result = await call({ id: p.id, expectedRevision: before.revision, markdown: '# Page\n\nMCP body\n' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ id: p.id, changed: true, persistence: 'file' });
    expect((await call({ id: p.id, expectedRevision: before.revision, markdown: 'stale' })).isError).toBe(true);
    const unguarded = await app.inject({ method: 'PUT', url: `/api/pages/${p.id}`, headers: headers(), payload: { markdown: 'unguarded' } });
    expect(unguarded.statusCode).toBe(428);
    const metadata = await app.inject({ method: 'PUT', url: `/api/pages/${p.id}`, headers: { cookie }, payload: { icon: '📄' } });
    expect(metadata.statusCode).toBe(200);
    expect((await read(p.id)).markdown).toBe('# Page\n\nMCP body\n');
  });

  it('offers exact quotation editing over real MCP and REST without stale offset rebasing', async () => {
    const p = await page();
    const stale = await read(p.id);
    docs.get(p.id)!.getText('content').insert(0, 'Another author\n');
    const accepted = await client.callTool({ name: 'replace_page_text', arguments: { id: p.id, oldText: 'alpha beta gamma', newText: 'alpha reviewed gamma' } });
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent).toMatchObject({ persistence: 'file', publication: 'pending' });
    expect((await read(p.id)).markdown).toBe('Another author\n# Page\n\nalpha reviewed gamma\n');
    expect((await client.callTool({ name: 'replace_page_text', arguments: { id: p.id, oldText: 'alpha beta gamma', newText: 'alpha reviewed gamma' } })).isError).toBe(true);
    expect((await call({ id: p.id, expectedRevision: stale.revision, markdown: stale.markdown })).isError).toBe(true);
    const denied = await app.inject({ method: 'POST', url: `/api/pages/${p.id}/replace-text`, headers: { authorization: `Bearer ${readToken}` }, payload: { oldText: 'reviewed', newText: 'denied' } });
    expect(denied.statusCode).toBe(403);
    const rest = await app.inject({ method: 'POST', url: `/api/pages/${p.id}/replace-text`, headers: headers(), payload: { oldText: 'alpha reviewed gamma', newText: 'alpha final gamma' } });
    expect(rest.statusCode).toBe(200); expect(rest.json()).toMatchObject({ persistence: 'file', changed: true });
  });

  it('the supported assistant rereads complete conflict context and stops both body tools at its page/run budget', async () => {
    const p = await page();
    const before = await read(p.id);
    const handle = await buildAssistantTools(user, 'agent', { space, pageId: p.id, runId: 'synthetic-run', conversationId: 'synthetic-conversation' });
    const execute = (name: string, args: Record<string, unknown>) => handle.tools[name].execute(args as never, {} as never);
    try {
      docs.get(p.id)!.getText('content').insert(0, 'Peer text\n');
      const conflict = await execute('update_page', { id: p.id, expectedRevision: before.revision, markdown: 'stale' });
      expect(conflict).toMatchObject({ isError: true });
      expect(JSON.stringify(conflict)).toContain('reconsider_required');
      expect(JSON.stringify(conflict)).toContain('Peer text');
      const current = await read(p.id);
      const reconsidered = await execute('update_page', { id: p.id, expectedRevision: current.revision, markdown: current.markdown.replace('beta', 'reviewed') });
      expect(JSON.parse(String(reconsidered))).toMatchObject({ persistence: 'file' });
      await execute('replace_page_text', { id: p.id, oldText: 'missing quotation', newText: 'never' });
      const stopped = await execute('update_page', { id: p.id, expectedRevision: (await read(p.id)).revision, markdown: 'must not apply' });
      expect(JSON.stringify(stopped)).toContain('edit_retry_budget_exhausted');
      expect((await read(p.id)).markdown).toContain('Peer text');
      expect((await read(p.id)).markdown).not.toContain('must not apply');
    } finally { await handle.close(); }
  });

  it('withholds revisions from oversized assistant conflict rereads', async () => {
    const p = await page('# Page\n\n' + 'x'.repeat(130_000));
    const stale = await read(p.id);
    docs.get(p.id)!.getText('content').insert(0, 'Peer\n');
    const handle = await buildAssistantTools(user, 'agent', { space, pageId: p.id, runId: 'synthetic-run', conversationId: 'synthetic-conversation' });
    try {
      const result = await handle.tools.update_page.execute({ id: p.id, expectedRevision: stale.revision, markdown: 'stale' } as never, {} as never);
      expect(JSON.stringify(result)).toContain('reconsider_read_unavailable');
      expect(JSON.stringify(result)).not.toContain('body-v1:');
    } finally { await handle.close(); }
  });

  it('blocks assistant replay after uncertain persistence until an explicit complete read, then confirms a no-op recovery', async () => {
    const p = await page();
    const handle = await buildAssistantTools(user, 'agent', { space, pageId: p.id, runId: 'synthetic-run', conversationId: 'synthetic-conversation' });
    const args = { id: p.id, oldText: 'alpha beta gamma', newText: 'alpha accepted gamma' };
    const write = storage.writeDocBodyIfChanged;
    const failed = vi.spyOn(storage, 'writeDocBodyIfChanged').mockImplementation(async (...args) => { if (args[0] === p.id) throw new Error('Synthetic file failure'); return write(...args); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await handle.tools.replace_page_text.execute(args as never, {} as never);
      expect(JSON.stringify(result)).toContain('body_persistence_failed');
      const replay = await handle.tools.replace_page_text.execute(args as never, {} as never);
      expect(JSON.stringify(replay)).toContain('edit_outcome_unknown');
    } finally { failed.mockRestore(); errors.mockRestore(); }
    try {
      const current = JSON.parse(String(await handle.tools.read_page.execute({ id: p.id } as never, {} as never)));
      expect(current.markdown).toContain('alpha accepted gamma');
      const saved = await handle.tools.update_page.execute({ id: p.id, expectedRevision: current.revision, markdown: current.markdown } as never, {} as never);
      expect(JSON.parse(String(saved))).toMatchObject({ changed: false, persistence: 'file', publication: 'pending' });
      expect((await read(p.id)).markdown.match(/accepted/g)).toHaveLength(1);
    } finally { await handle.close(); }
  });

  it('stops repeated uncertain assistant saves even after explicit reads and switching body tools', async () => {
    const p = await page();
    const handle = await buildAssistantTools(user, 'agent', { space, pageId: p.id, runId: 'synthetic-run', conversationId: 'synthetic-conversation' });
    const write = storage.writeDocBodyIfChanged;
    const failed = vi.spyOn(storage, 'writeDocBodyIfChanged').mockImplementation(async (...args) => { if (args[0] === p.id) throw new Error('Synthetic file failure'); return write(...args); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handle.tools.replace_page_text.execute({ id: p.id, oldText: 'alpha beta gamma', newText: 'alpha accepted gamma' } as never, {} as never);
      const current = JSON.parse(String(await handle.tools.read_page.execute({ id: p.id } as never, {} as never)));
      const second = await handle.tools.update_page.execute({ id: p.id, expectedRevision: current.revision, markdown: current.markdown } as never, {} as never);
      expect(JSON.stringify(second)).toContain('body_persistence_failed');
      await handle.tools.read_page.execute({ id: p.id } as never, {} as never);
      const stopped = await handle.tools.replace_page_text.execute({ id: p.id, oldText: 'alpha accepted gamma', newText: 'must not apply' } as never, {} as never);
      expect(JSON.stringify(stopped)).toContain('two uncertain outcomes');
      expect((await read(p.id)).markdown).not.toContain('must not apply');
    } finally { failed.mockRestore(); errors.mockRestore(); await collab.flushDoc(p.id); await handle.close(); }
  });

  it('returns a complete large document and usable revision to external MCP clients', async () => {
    const p = await page('# Page\n\n' + 'x'.repeat(130_000) + '\nTail\n');
    const result = await client.callTool({ name: 'read_page', arguments: { id: p.id } });
    const before = result.structuredContent as { markdown: string; revision: string };
    expect(before.markdown.length).toBeGreaterThan(130_000);
    expect(before.revision).toBe(bodyRevision(p.id, before.markdown));
    const from = before.markdown.indexOf('Tail');
    expect((await call({ id: p.id, expectedRevision: before.revision, edits: [{ from, to: from + 4, expectedText: 'Tail', text: 'Edited tail' }] })).isError).not.toBe(true);
    expect(await storage.readFreshDocBody(p.id)).toBe(before.markdown.replace('Tail', 'Edited tail'));
  });

  it('denies read scopes and private/ancestor-restricted pages without conflict content', async () => {
    const p = await page();
    const before = await read(p.id);
    const payload = { expectedRevision: before.revision, markdown: 'blocked' };
    expect((await app.inject({ method: 'PUT', url: `/api/pages/${p.id}`, headers: { authorization: `Bearer ${readToken}` }, payload })).statusCode).toBe(403);
    const hidden = await storage.createSpace(`Private ${Date.now()}`, null);
    try {
      const privatePage = await storage.createPage({ space: hidden.slug, parentPath: '', title: 'Hidden', kind: 'doc' });
      expect((await app.inject({ method: 'PUT', url: `/api/pages/${privatePage.id}`, headers: headers(), payload })).statusCode).toBe(403);
    } finally { await deleteTestSpace(hidden.slug); }
    const outsider = await auth.createUser({ email: 'other@example.com', name: 'Other', passwordHash: 'x', isAdmin: false });
    await auth.setMembership(space, outsider.id, 'editor');
    await pageAccess.setAccess(user, await storage.requireEntry(p.id), 'restricted', []);
    const deniedToken = (await auth.createApiToken(outsider.id, 'denied', ['write'])).token;
    const denied = await app.inject({ method: 'PUT', url: `/api/pages/${p.id}`, headers: { authorization: `Bearer ${deniedToken}` }, payload });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('revision');
    expect((await read(p.id)).markdown).toBe(before.markdown);
    const child = await storage.createPage({ space, parentPath: p.path.replace(/\.md$/, ''), title: 'Child', kind: 'doc' });
    const inherited = await app.inject({ method: 'PUT', url: `/api/pages/${child.id}`, headers: { authorization: `Bearer ${deniedToken}` }, payload });
    expect(inherited.statusCode).toBe(403);
  });

  it('reports storage failure over the authorized socket and confirms recovery without replacing the live room', async () => {
    const p = await page();
    const doc = new Y.Doc();
    const cookieWs = class extends WS {
      constructor(url: string, protocols?: string | string[]) { super(url, protocols, { headers: { Cookie: cookie } }); }
    } as unknown as typeof globalThis.WebSocket;
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, p.id, doc, { WebSocketPolyfill: cookieWs, disableBc: true });
    const file = trackDocumentFileStatus(provider, doc, p.id);
    try {
      await vi.waitFor(() => expect(file.isConfirmed()).toBe(true));
      const room = docs.get(p.id);
      const write = storage.writeDocBodyIfChanged;
      const failed = vi.spyOn(storage, 'writeDocBodyIfChanged').mockImplementation(async (...args) => {
        if (args[0] === p.id) throw new Error('Synthetic file failure');
        return write(...args);
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        collab.setPersistRetryBaseMsForTests(1);
        doc.getText('content').insert(doc.getText('content').length, 'Typed during failure\n');
        await vi.waitFor(() => expect(file.getSnapshot().state).toBe('error'));
        expect(file.isConfirmed()).toBe(false);
        expect(await storage.readFreshDocBody(p.id)).not.toContain('Typed during failure');
        await vi.waitFor(() => expect(errors.mock.calls.some(call => String(call[0]).includes('giving up writing page ' + p.id))).toBe(true), { timeout: 20_000 });
        expect(file.getSnapshot().state).toBe('error');
        expect(file.isConfirmed()).toBe(false);
      } finally { failed.mockRestore(); errors.mockRestore(); }
      file.retry();
      await vi.waitFor(() => expect(file.isConfirmed()).toBe(true));
      expect(docs.get(p.id)).toBe(room);
      expect(await storage.readFreshDocBody(p.id)).toContain('Typed during failure');
    } finally { collab.setPersistRetryBaseMsForTests(2_000); file.dispose(); provider.destroy(); doc.destroy(); }
  });

  it('keeps bot edits and browser typing over the real collaboration socket, including a close/reopen', async () => {
    const p = await page();
    const doc = new Y.Doc();
    const cookieWs = class extends WS {
      constructor(url: string, protocols?: string | string[]) { super(url, protocols, { headers: { Cookie: cookie } }); }
    } as unknown as typeof globalThis.WebSocket;
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, p.id, doc, { WebSocketPolyfill: cookieWs, disableBc: true });
    try {
      await vi.waitFor(() => expect(provider.synced).toBe(true));
      const before = await read(p.id);
      await collab.editDocumentBody(p.id, { expectedRevision: before.revision, edits: [{ from: 14, to: 18, expectedText: 'beta', text: 'BOT' }] }, author);
      await vi.waitFor(() => expect(doc.getText('content').toString()).toContain('alpha BOT gamma'));
      doc.getText('content').insert(doc.getText('content').length, 'Browser suffix\n');
      await vi.waitFor(() => expect(collab.getLiveText(p.id)).toContain('Browser suffix'));
      const current = await read(p.id);
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const write = storage.writeDocBodyIfChanged;
      const spy = vi.spyOn(storage, 'writeDocBodyIfChanged').mockImplementation(async (...args) => {
        if (args[0] === p.id) { entered(); await hold; }
        return write(...args);
      });
      let reopened;
      try {
        const saving = collab.editDocumentBody(p.id, { expectedRevision: current.revision, markdown: current.markdown + 'Bot suffix\n' }, author);
        await blocked;
        provider.disconnect();
        await vi.waitFor(() => expect(docs.has(p.id)).toBe(false));
        let readFinished = false;
        const reopening = read(p.id).then((value) => { readFinished = true; return value; });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(readFinished).toBe(false);
        release();
        await saving;
        reopened = await reopening;
      } finally { release(); spy.mockRestore(); }
      expect(reopened.markdown).toBe('# Page\n\nalpha BOT gamma\nBrowser suffix\nBot suffix\n');
      provider.connect();
      await vi.waitFor(() => expect(provider.synced).toBe(true));
      expect(doc.getText('content').toString()).toBe(reopened.markdown);
    } finally { provider.destroy(); doc.destroy(); }
  });
});
