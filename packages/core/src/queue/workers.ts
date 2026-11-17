import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Pool } from '../db/pool';
import { getLogger, runWithContext } from '../logger';
import { isNseOpen } from '../market/marketHours';
import type { MarketDataService } from '../market/marketDataService';
import { instrumentsRepo } from '../repositories/instrumentsRepo';
import type { ExecuteOrderJob } from '../services/dispatcher';
import type { EodService } from '../services/eodService';
import type { ExecutionService } from '../services/executionService';
import type { OrderService } from '../services/orderService';
import { ORDER_QUEUE, SCHEDULED_QUEUE, type EodJobData } from './queues';

export interface WorkerDeps {
  pool: Pool;
  execution: ExecutionService;
  eod: EodService;
  marketData: MarketDataService;
  orders: OrderService;
}

export interface WorkerOptions {
  connection: ConnectionOptions;
  prefix?: string;
  concurrency?: number;
  /** VALIDATED orders older than this are re-dispatched by the reconciler. */
  staleAfterMs?: number;
  /** Outside NSE hours prices barely move: refresh at most this often (default 10 min). */
  offHoursPollMs?: number;
}

/**
 * Two consumers:
 *  - order-execution: fills/opens orders the API validated (high concurrency; per-user
 *    serialisation is guaranteed by the row lock inside ExecutionService, not by the queue)
 *  - scheduled: repeatable jobs (EOD close, quote polling, reconciliation), concurrency 1
 */
export function createWorkers(deps: WorkerDeps, opts: WorkerOptions): { workers: Worker[]; close(): Promise<void> } {
  let symbols: string[] | null = null;
  let lastPoll = 0;
  const activeSymbols = async () => (symbols ??= (await instrumentsRepo.listActive(deps.pool)).map((i) => i.symbol));

  const orderWorker = new Worker<ExecuteOrderJob>(
    ORDER_QUEUE,
    (job: Job<ExecuteOrderJob>) =>
      // The API's request id rides on the job so worker logs join up with the API's.
      runWithContext({ requestId: job.data.requestId ?? `job-${job.id}` }, async () => {
        const result = await deps.execution.executeOrder(job.data.orderId, job.data.requestId);
        return { status: result?.status ?? 'MISSING' };
      }),
    { connection: opts.connection, prefix: opts.prefix, concurrency: opts.concurrency ?? 16 },
  );

  const scheduledWorker = new Worker<EodJobData>(
    SCHEDULED_QUEUE,
    (job: Job<EodJobData>) =>
      runWithContext({ requestId: `${job.name}-${job.id}` }, async () => {
        switch (job.name) {
          case 'eod-close':
            return deps.eod.run(job.data?.date);
          case 'quote-poll': {
            // Be polite to the data provider (and to free-tier Redis quotas) when the market is shut.
            const now = Date.now();
            if (!isNseOpen(new Date(now)) && now - lastPoll < (opts.offHoursPollMs ?? 10 * 60_000)) {
              return { skipped: 'market closed' };
            }
            lastPoll = now;
            const quotes = await deps.marketData.refresh(await activeSymbols(), { publish: true });
            return { quotes: quotes.length };
          }
          case 'reconcile':
            return { redispatched: await deps.orders.redispatchStale(opts.staleAfterMs ?? 30_000) };
          default:
            throw new Error(`Unknown scheduled job ${job.name}`);
        }
      }),
    { connection: opts.connection, prefix: opts.prefix, concurrency: 1 },
  );

  for (const w of [orderWorker, scheduledWorker]) {
    w.on('failed', (job, err) =>
      getLogger().error({ err, jobId: job?.id, name: job?.name, attempts: job?.attemptsMade }, 'job failed'),
    );
    w.on('error', (err) => getLogger().error({ err }, 'worker error'));
  }

  return {
    workers: [orderWorker, scheduledWorker],
    async close() {
      await Promise.all([orderWorker.close(), scheduledWorker.close()]);
    },
  };
}
