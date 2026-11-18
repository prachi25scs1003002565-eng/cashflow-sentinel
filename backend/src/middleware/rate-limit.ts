/**
 * Cashflow Sentinel — Rate Limiting Middleware
 * 
 * Provides an in-memory, bounded sliding-window rate limiter designed to protect
 * authentication endpoints (e.g., login, registration) against brute-force attacks,
 * credential stuffing, and event-loop exhaustion caused by intensive bcrypt operations.
 * 
 * ARCHITECTURE & DEPLOYMENT CONSIDERATIONS:
 * - This rate limiter uses a bounded in-memory store and operates strictly per-process.
 * - In multi-instance or clustered deployments (e.g. Kubernetes, multiple PM2 workers),
 *   rate limit counters are isolated to each process. For strict global rate limiting across
 *   distributed server instances, an external store (such as Redis) or edge-layer rate limiting
 *   (e.g., Cloudflare, Kong, AWS WAF, or Nginx) should be used.
 * - Timer safety: This implementation uses passive eviction on request and capacity-based
 *   pruning rather than an active setInterval timer, eliminating background timer leaks
 *   during tests or application shutdown.
 * - Client IP resolution: Uses Express `req.ip` (derived from the socket address unless Express
 *   `trust proxy` is explicitly configured). Does NOT trust arbitrary or spoofed X-Forwarded-For headers.
 */

import { Request, Response, NextFunction } from 'express';

export interface RateLimiterOptions {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum number of allowed requests within windowMs */
  max: number;
  /** User-facing error message */
  message?: string;
  /** Application error code (defaults to TOO_MANY_REQUESTS) */
  code?: string;
  /** Custom key extractor (defaults to client IP) */
  keyGenerator?: (req: Request) => string;
  /** Custom condition to skip rate limiting (e.g. test isolation) */
  skip?: (req: Request) => boolean;
  /** Maximum number of distinct tracking keys to keep in memory (default 5000) */
  maxEntries?: number;
  /** Optional clock function for deterministic testing (defaults to Date.now) */
  getTime?: () => number;
}

export interface RateLimiterMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
  /** Resets all tracked counters and keys (useful for test isolation) */
  reset(): void;
  /** Retrieves entry for a specific key */
  getEntry(key: string): { count: number; resetAt: number } | undefined;
  /** Returns the current count of tracked keys */
  size(): number;
}

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiterMiddleware {
  const windowMs = options.windowMs;
  const max = options.max;
  const message = options.message || 'Too many requests. Please try again later.';
  const code = options.code || 'TOO_MANY_REQUESTS';
  const keyGenerator =
    options.keyGenerator ||
    ((req: Request) => req.ip || req.socket?.remoteAddress || '127.0.0.1');
  const maxEntries = options.maxEntries || 5000;
  const getTime = options.getTime || (() => Date.now());

  const store = new Map<string, RateLimitRecord>();
  let requestCounter = 0;

  function pruneExpired(now: number): void {
    for (const [key, record] of store.entries()) {
      if (now > record.resetAt) {
        store.delete(key);
      }
    }
  }

  const middleware: RateLimiterMiddleware = Object.assign(
    (req: Request, res: Response, next: NextFunction) => {
      if (options.skip && options.skip(req)) {
        return next();
      }

      const now = getTime();
      requestCounter += 1;

      // Periodically prune expired entries (every 50 requests) without background timers
      if (requestCounter % 50 === 0) {
        pruneExpired(now);
      }

      // If store reaches maximum bounded capacity, prune expired keys
      if (store.size >= maxEntries) {
        pruneExpired(now);
        // If still at capacity, evict the oldest entry (first item in Map iteration)
        if (store.size >= maxEntries) {
          const oldestKey = store.keys().next().value;
          if (oldestKey !== undefined) {
            store.delete(oldestKey);
          }
        }
      }

      const key = keyGenerator(req);
      const record = store.get(key);

      if (!record || now > record.resetAt) {
        // Start a new rate-limit window for this client
        store.set(key, { count: 1, resetAt: now + windowMs });
        return next();
      }

      record.count += 1;

      if (record.count > max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
        res.setHeader('Retry-After', retryAfterSeconds.toString());

        const requestId = req.id || (req.headers['x-request-id'] as string) || `req_${now}`;

        return res.status(429).json({
          error: {
            code,
            message,
          },
          request_id: requestId,
        });
      }

      next();
    },
    {
      reset(): void {
        store.clear();
        requestCounter = 0;
      },
      getEntry(key: string): RateLimitRecord | undefined {
        return store.get(key);
      },
      size(): number {
        return store.size;
      },
    }
  );

  return middleware;
}
