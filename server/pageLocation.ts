import { expectedPageLocationSchema } from '../shared/contracts.js';
import { withSpaceFence } from './db/spaceFence.js';
import { DocumentEditError } from './documentEdits.js';
import * as storage from './storage.js';

/**
 * The caller still authorizes access. Coordinate an optional exact location
 * precondition with structural operations in this server process, including
 * while a cold document is restored. Do not call another space lock from fn.
 */
export async function withPageLocation<T>(id: string, expected: unknown, fn: () => Promise<T>): Promise<T> {
  if (expected === undefined) return fn();
  const parsed = expectedPageLocationSchema.safeParse(expected);
  if (!parsed.success) {
    throw new DocumentEditError(400, 'invalid_page_location', 'Provide both expected location space and path from the page metadata.');
  }
  return withSpaceFence(parsed.data.space, async () => {
    const entry = await storage.requireEntry(id);
    if (entry.space !== parsed.data.space || entry.relPath !== parsed.data.path) {
      throw new DocumentEditError(409, 'location_conflict', 'The page location changed. Resolve its location and reconsider the operation.');
    }
    return fn();
  });
}
