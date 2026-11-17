import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../container';
import { requireCronSecret } from '../middleware/cronAuth';
import { handler } from '../middleware/handler';

const JOBS = ['eod-close', 'quote-poll', 'reconcile'] as const;

/**
 * POST /internal/jobs/:job — lets an external scheduler (GitHub Actions cron) enqueue a scheduled
 * job. Needed when the host sleeps while idle: the request wakes the service, and the in-process
 * worker runs the job. Not part of the public API docs.
 */
export function internalRoutes(c: Container): Router {
  const r = Router();
  r.post(
    '/jobs/:job',
    requireCronSecret(c.config.CRON_SECRET),
    handler(
      {
        params: z.object({ job: z.enum(JOBS) }),
        body: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
      },
      async ({ params, body }, req, res) => {
        const job = await c
          .scheduledQueue()
          .add(params.job, params.job === 'eod-close' ? { date: body.date } : {}, {
            attempts: 2,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: 100,
            removeOnFail: 100,
          });
        res.status(202).json({ job: params.job, jobId: job.id, requestId: req.id });
      },
    ),
  );
  return r;
}
