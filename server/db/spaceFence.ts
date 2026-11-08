const tails = new Map<string, Promise<void>>();

/** Not reentrant. File writers use their independent per-document lock. */
export async function withSpaceFence<T>(space: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(space) ?? Promise.resolve();
  let release!: () => void;
  const owned = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => owned);
  tails.set(space, tail);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (tails.get(space) === tail) tails.delete(space);
  }
}
