import * as Y from 'yjs';

/** Canonical history, independent of garbage collection and retained undo text. */
export function documentHistoryKey(update: Uint8Array): string {
  const vector = [...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update))].sort(([a], [b]) => a - b);
  const deleted = [...Y.decodeUpdate(update).ds.clients]
    .sort(([a], [b]) => a - b)
    .map(([client, ranges]) => [client, ranges.map(({ clock, len }) => [clock, len])]);
  return JSON.stringify([vector, deleted]);
}
