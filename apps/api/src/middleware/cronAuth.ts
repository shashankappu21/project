import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { Errors } from '@nse/core';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Guards internal job triggers with a shared secret (Authorization: Bearer <CRON_SECRET>).
 * Without a configured secret the routes behave as if they don't exist. Hashing both sides
 * first makes the comparison constant-time regardless of input length.
 */
export function requireCronSecret(secret: string | undefined): RequestHandler {
  const expected = secret ? digest(secret) : null;
  return (req, _res, next) => {
    if (!expected) return next(Errors.notFound(`Route ${req.method} ${req.path}`));
    const [scheme, token] = (req.header('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token || !timingSafeEqual(digest(token), expected)) {
      return next(Errors.unauthorized('Invalid cron secret'));
    }
    next();
  };
}
