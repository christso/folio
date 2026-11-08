import { createHash } from 'node:crypto';
import { documentHistoryKey } from '../shared/documentPersistence.js';

export function documentHistoryHash(snapshot: Uint8Array): string {
  return createHash('sha256').update(documentHistoryKey(snapshot)).digest('hex');
}
