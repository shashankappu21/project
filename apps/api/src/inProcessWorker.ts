import {
  EodService,
  ExecutionService,
  PriceIngestService,
  bullConnection,
  createWorkers,
  redisOrderNotifier,
  registerSchedules,
  rootLogger,
} from '@nse/core';
import type { Container } from './container';

/**
 * Runs the execution worker and job schedulers inside the API process. Used on hosts where a
 * separate always-on worker isn't available (e.g. one free web service). The code path is the
 * same one apps/worker runs; only the process boundary differs, so moving back to a dedicated
 * worker is a configuration change (RUN_WORKER=false + deploy apps/worker).
 */
export async function startInProcessWorker(c: Container): Promise<{ close(): Promise<void> }> {
  const execution = new ExecutionService(c.pool, c.marketData, redisOrderNotifier(c.redis));
  const eod = new EodService(c.pool, new PriceIngestService(c.pool, c.provider), execution);
  await registerSchedules(c.scheduledQueue(), c.config);
  const workers = createWorkers(
    { pool: c.pool, execution, eod, marketData: c.marketData, orders: c.orders },
    { connection: bullConnection(c.config.REDIS_URL) },
  );
  rootLogger.info('in-process worker started');
  return workers;
}
