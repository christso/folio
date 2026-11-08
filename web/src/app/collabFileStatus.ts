import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { WebsocketProvider } from 'y-websocket';
import { DOCUMENT_FILE_STATUS_MESSAGE, DOCUMENT_FILE_REQUEST_MESSAGE, documentFileStatusSchema, type DocumentFileStatus } from '@shared/contracts';
import { documentHistoryKey } from '@shared/documentPersistence';

export interface FileSaveSnapshot { state: 'unconfirmed' | 'saving' | 'saved' | 'error' }
export interface DocumentFileTracker {
  isConfirmed(): boolean;
  getSnapshot(): FileSaveSnapshot;
  subscribe(fn: () => void): () => void;
  whenConfirmed(timeoutMs: number): Promise<boolean>;
  retry(): void;
  dispose(): void;
}

/** File/snapshot confirmation is deliberately separate from server receipt. */
export function trackDocumentFileStatus(provider: WebsocketProvider, doc: Y.Doc, id: string): DocumentFileTracker {
  const listeners = new Set<() => void>();
  let snapshot: FileSaveSnapshot = { state: 'unconfirmed' };
  let receipt: DocumentFileStatus | undefined;
  let local: { revision: string; history: string } | undefined;
  let failed = false;
  let generation = 0;
  let disposed = false;
  let lastRetry = -Infinity;
  const set = (state: FileSaveSnapshot['state']) => {
    if (snapshot.state === state) return;
    snapshot = { state };
    for (const fn of [...listeners]) { try { fn(); } catch (e) { console.error('[collab] file-status listener failed', e); } }
  };
  const confirmed = () => provider.wsconnected && receipt?.state === 'saved' && local !== undefined && receipt.revision === local.revision && receipt.history === local.history;
  const recompute = () => {
    if (confirmed()) { failed = false; set('saved'); }
    else set(failed ? 'error' : provider.wsconnected ? 'saving' : 'unconfirmed');
  };
  const digest = async (text: string) => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
  };
  const changed = () => {
    const current = ++generation;
    local = undefined;
    recompute(); // invalidate synchronously, before asynchronous hashing
    const body = doc.getText('content').toString();
    const history = documentHistoryKey(Y.encodeStateAsUpdate(doc));
    void Promise.all([digest(JSON.stringify([id, body])), digest(history)]).then(([revision, history]) => {
      if (disposed || generation !== current) return;
      local = { revision: `body-v1:${revision}`, history };
      recompute();
    }).catch(() => { if (!disposed && generation === current) set(failed ? 'error' : 'unconfirmed'); });
  };
  const request = (action: 'status' | 'retry') => {
    if (!provider.wsconnected || provider.ws?.readyState !== 1) return;
    const frame = encoding.createEncoder();
    encoding.writeVarUint(frame, DOCUMENT_FILE_REQUEST_MESSAGE);
    encoding.writeVarString(frame, JSON.stringify({ version: 1, action }));
    try { provider.ws.send(encoding.toUint8Array(frame)); } catch { /* disconnected; retain unconfirmed state */ }
  };
  const previous = provider.messageHandlers?.[DOCUMENT_FILE_STATUS_MESSAGE];
  const handler = (_encoder: encoding.Encoder, decoder: decoding.Decoder) => {
    // BroadcastChannel peers are not persistence authorities. y-websocket
    // passes emitSynced=false for their frames; see the installed handler below.
    try {
      const raw = decoding.readVarString(decoder);
      if (raw.length > 1024) return;
      const parsed = documentFileStatusSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      receipt = parsed.data;
      if (receipt.state === 'error') failed = true;
      recompute();
    } catch { /* malformed or older server: never infer a save */ }
  };
  const installed = (encoder: encoding.Encoder, decoder: decoding.Decoder, _provider: WebsocketProvider, emitSynced: boolean) => {
    if (emitSynced) handler(encoder, decoder);
  };
  if (provider.messageHandlers) provider.messageHandlers[DOCUMENT_FILE_STATUS_MESSAGE] = installed;
  const status = () => { receipt = undefined; changed(); if (provider.wsconnected) request('status'); };
  provider.on('status', status);
  doc.on('update', changed);
  changed();
  if (provider.wsconnected) request('status');
  const probe = setInterval(() => { if (snapshot.state !== 'saved') request('status'); }, 3000);
  return {
    isConfirmed: () => snapshot.state === 'saved' && provider.wsconnected,
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    whenConfirmed(timeoutMs) {
      if (snapshot.state === 'saved' && provider.wsconnected) return Promise.resolve(true);
      return new Promise(resolve => {
        const done = (value: boolean) => { clearTimeout(timer); listeners.delete(check); resolve(value); };
        const check = () => { if (snapshot.state === 'saved' && provider.wsconnected) done(true); };
        const timer = setTimeout(() => done(false), timeoutMs);
        listeners.add(check); request('status');
      });
    },
    retry() { if (Date.now() - lastRetry < 1000) return; lastRetry = Date.now(); request('retry'); },
    dispose() {
      disposed = true; generation++; clearInterval(probe);
      doc.off('update', changed); provider.off('status', status);
      if (provider.messageHandlers?.[DOCUMENT_FILE_STATUS_MESSAGE] === installed) provider.messageHandlers[DOCUMENT_FILE_STATUS_MESSAGE] = previous;
      listeners.clear();
    },
  };
}
