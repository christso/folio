import { webcrypto } from 'node:crypto';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { WebsocketProvider } from 'y-websocket';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyRevision } from '../../../server/documentEdits.js';
import { documentHistoryHash } from '../../../server/documentPersistence.js';
import { DOCUMENT_FILE_STATUS_MESSAGE } from '../../../shared/contracts.js';
import { trackDocumentFileStatus } from './collabFileStatus';

function fixture() {
  vi.stubGlobal('crypto', webcrypto);
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const provider = {
    wsconnected: true, messageHandlers: [] as Array<(...args: any[]) => void>,
    ws: { readyState: 1, send: vi.fn<(frame: Uint8Array) => void>() },
    on: (name: string, fn: (...args: any[]) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    off: (name: string, fn: (...args: any[]) => void) => listeners.get(name)?.delete(fn),
  };
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'A');
  const file = trackDocumentFileStatus(provider as unknown as WebsocketProvider, doc, 'page');
  const status = (state: 'saving' | 'saved' | 'error', snapshot = Y.encodeStateAsUpdate(doc), body = doc.getText('content').toString(), fromSocket = true) => {
    const frame = encoding.createEncoder();
    encoding.writeVarString(frame, JSON.stringify({ version: 1, state, revision: bodyRevision('page', body), history: documentHistoryHash(snapshot) }));
    provider.messageHandlers[DOCUMENT_FILE_STATUS_MESSAGE](encoding.createEncoder(), decoding.createDecoder(encoding.toUint8Array(frame)), provider, fromSocket);
  };
  return { doc, file, status, provider, event: (name: string, ...args: any[]) => { for (const fn of listeners.get(name) ?? []) fn(...args); } };
}
afterEach(() => vi.unstubAllGlobals());

describe('document file confirmation', () => {
  it('does not confuse receipt or old save completion with the current body, including pure deletes and identical text with new identities', async () => {
    const { doc, file, status } = fixture();
    expect(file.isConfirmed()).toBe(false);
    status('saved'); await vi.waitFor(() => expect(file.isConfirmed()).toBe(true));
    const saved = Y.encodeStateAsUpdate(doc);
    doc.getText('content').insert(1, 'B');
    expect(file.isConfirmed()).toBe(false);
    status('saved', saved, 'A'); await new Promise(r => setTimeout(r, 20));
    expect(file.isConfirmed()).toBe(false);
    doc.getText('content').delete(1, 1);
    status('saved', saved, 'A'); await new Promise(r => setTimeout(r, 20));
    expect(file.isConfirmed()).toBe(false); // same body, different collaborative history
    status('saved'); await vi.waitFor(() => expect(file.isConfirmed()).toBe(true));
    file.dispose(); doc.destroy();
  });
  it('does not accept file receipts from browser peers and hashes retained undo history like a garbage-collected server', async () => {
    const { doc, file, status } = fixture();
    const undo = new Y.UndoManager(doc.getText('content'));
    doc.getText('content').delete(0, 1);
    const server = new Y.Doc(); Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    expect(documentHistoryHash(Y.encodeStateAsUpdate(server))).toBe(documentHistoryHash(Y.encodeStateAsUpdate(doc)));
    status('saved', Y.encodeStateAsUpdate(doc), '', false);
    await new Promise(r => setTimeout(r, 20)); expect(file.isConfirmed()).toBe(false);
    status('saved', Y.encodeStateAsUpdate(server), '');
    await vi.waitFor(() => expect(file.isConfirmed()).toBe(true));
    undo.destroy(); file.dispose(); doc.destroy(); server.destroy();
  });
  it('keeps failure through new typing and reconnect, then confirms only a matching recovery; retry sends no body', async () => {
    const { doc, file, status, provider, event } = fixture();
    status('error'); expect(file.getSnapshot().state).toBe('error');
    doc.getText('content').insert(1, 'B'); status('saving');
    expect(file.getSnapshot().state).toBe('error');
    provider.wsconnected = false; event('status', { status: 'disconnected' });
    provider.wsconnected = true; event('status', { status: 'connected' });
    expect(file.getSnapshot().state).toBe('error'); expect(file.isConfirmed()).toBe(false);
    file.retry(); expect(provider.ws.send).toHaveBeenCalled();
    const frame = provider.ws.send.mock.calls.at(-1)![0] as Uint8Array;
    const decoder = decoding.createDecoder(frame); decoding.readVarUint(decoder);
    expect(JSON.parse(decoding.readVarString(decoder))).toEqual({ version: 1, action: 'retry' });
    status('saved'); await vi.waitFor(() => expect(file.isConfirmed()).toBe(true));
    file.dispose(); doc.destroy();
  });
});
