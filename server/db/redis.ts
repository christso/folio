/**
 * Redis (ioredis): transient-only state — login rate-limiting and per-space
 * advisory locks (later: realtime presence/state). Never a system of record
 * (DEV-PLAN: "core data does not live in Redis"). Every function here degrades
 * gracefully when Redis is unreachable — a warning is logged once, and
 * callers fall back to in-memory coordination — rather than throwing,
 * per DEV-PLAN's explicit "Redis unavailable -> degrade with a warning, do
 * not fail".
 */
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { loadEnv } from '../env.js';
import { withSpaceFence } from './spaceFence.js';

let client: Redis | undefined;
let warnedUnavailable = false;

export function getRedis(): Redis {
  if (!client) {
    loadEnv();
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    client = new Redis(url, {
      // Fail fast per command instead of queueing behind a dead connection —
      // callers below treat a rejected command as "Redis is down right now".
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 500, 10_000),
      lazyConnect: false,
    });
    client.on('error', (err) => {
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        // eslint-disable-next-line no-console
        console.warn(`[redis] unavailable, degrading (in-memory rate limit and space coordination): ${err.message}`);
      }
    });
    client.on('ready', () => {
      warnedUnavailable = false;
    });
  }
  return client;
}

export function isRedisReady(): boolean {
  return client?.status === 'ready';
}

export async function closeRedis(): Promise<void> {
  if (client) {
    client.disconnect();
    client = undefined;
  }
}

// ---------------------------------------------------------------------------
// Login rate limiting: sliding window via a per-IP sorted set (score = ms
// timestamp). Mirrors the shape of the round-2 in-memory limiter so the two
// are interchangeable to callers.
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;

export interface RateLimitResult {
  limited: boolean;
  retryAfterSeconds?: number;
}

export async function checkLoginRateLimitRedis(ip: string): Promise<RateLimitResult> {
  const redis = getRedis();
  const key = `folio:ratelimit:login:${ip}`;
  const now = Date.now();
  await redis.zremrangebyscore(key, 0, now - RATE_LIMIT_WINDOW_MS);
  const count = await redis.zcard(key);

  if (count >= RATE_LIMIT_MAX_ATTEMPTS) {
    const oldest = await redis.zrange(key, '0', '0', 'WITHSCORES');
    const oldestScore = oldest.length >= 2 ? Number(oldest[1]) : now;
    const retryAfterMs = oldestScore + RATE_LIMIT_WINDOW_MS - now;
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  await redis.zadd(key, String(now), `${now}-${randomBytes(4).toString('hex')}`);
  await redis.pexpire(key, RATE_LIMIT_WINDOW_MS);
  return { limited: false };
}

// ---------------------------------------------------------------------------
// Per-space advisory locks: SET NX PX to acquire, a token-checked Lua script
// to release (never delete a lock you don't own — e.g. one that already
// expired and was re-acquired by someone else). Serializes structural
// mutations (create/move/rename/delete) per space; also the mechanism
// round 3's git sync loop will reuse for "one git operation at a time per
// space".
// ---------------------------------------------------------------------------

const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export interface SpaceLockOptions {
  ttlMs?: number;
  /** Max time to wait for the Redis advisory lock before using local exclusion only. */
  waitMs?: number;
}

/**
 * Always excludes other same-process structural operations on this space.
 * Redis additionally supplies a best-effort advisory lock across processes.
 * Redis loss, timeout or lease expiry never bypasses the local fence. Folio's
 * live collaboration model remains one server process, not replicated Yjs.
 */
export async function withSpaceLock<T>(space: string, fn: () => Promise<T>, options: SpaceLockOptions = {}): Promise<T> {
  return withSpaceFence(space, () => withAdvisorySpaceLock(space, fn, options));
}

async function withAdvisorySpaceLock<T>(space: string, fn: () => Promise<T>, options: SpaceLockOptions): Promise<T> {
  const ttlMs = options.ttlMs ?? 10_000;
  const waitMs = options.waitMs ?? 5_000;

  if (!isRedisReady()) return fn();

  const redis = getRedis();
  const key = `folio:lock:space:${space}`;
  const token = randomBytes(12).toString('hex');
  const deadline = Date.now() + waitMs;
  let acquired = false;

  try {
    while (Date.now() < deadline) {
      const res = await redis.set(key, token, 'PX', ttlMs, 'NX');
      if (res === 'OK') {
        acquired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch {
    return fn(); // Redis went away mid-wait — degrade rather than fail the request
  }

  if (!acquired) return fn(); // advisory timeout; the caller still holds the local fence

  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => {});
  }
}
