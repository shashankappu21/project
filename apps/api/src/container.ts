import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  AuthService,
  ExecutionService,
  FakePriceProvider,
  InstrumentService,
  MarketDataService,
  OrderService,
  PortfolioService,
  QueueDispatcher,
  SyncDispatcher,
  YahooPriceProvider,
  createOrderQueue,
  createPool,
  createScheduledQueue,
  redisOrderNotifier,
  type Config,
  type EodJobData,
  type OrderDispatcher,
  type Pool,
  type PriceProvider,
} from '@nse/core';

/** Composition root: the only place that knows which concrete implementations are wired together. */
export interface Container {
  config: Config;
  pool: Pool;
  redis: Redis;
  provider: PriceProvider;
  marketData: MarketDataService;
  auth: AuthService;
  orders: OrderService;
  portfolio: PortfolioService;
  instruments: InstrumentService;
  /** BullMQ queue for scheduled jobs (EOD, quote polling, reconcile); created on first use. */
  scheduledQueue(): Queue<EodJobData>;
  close(): Promise<void>;
}

export function buildContainer(config: Config, overrides: { dispatcher?: OrderDispatcher } = {}): Container {
  const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
  const provider: PriceProvider = config.MARKET_DATA_PROVIDER === 'fake' ? new FakePriceProvider() : new YahooPriceProvider();
  const marketData = new MarketDataService(redis, provider, config.QUOTE_CACHE_TTL_SECONDS);

  // queue: publish to BullMQ for the worker; sync: execute in-process (tests, single-process dev).
  const orderQueue = config.EXECUTION_MODE === 'queue' && !overrides.dispatcher ? createOrderQueue(config.REDIS_URL) : null;
  const dispatcher =
    overrides.dispatcher ??
    (orderQueue
      ? new QueueDispatcher(orderQueue)
      : new SyncDispatcher(new ExecutionService(pool, marketData, redisOrderNotifier(redis))));

  let scheduled: Queue<EodJobData> | null = null;

  return {
    config,
    pool,
    redis,
    provider,
    marketData,
    auth: new AuthService(pool, config),
    orders: new OrderService(pool, marketData, dispatcher),
    portfolio: new PortfolioService(pool, marketData),
    instruments: new InstrumentService(pool, marketData),
    scheduledQueue() {
      scheduled ??= createScheduledQueue(config.REDIS_URL);
      return scheduled;
    },
    async close() {
      await orderQueue?.close();
      await scheduled?.close();
      await Promise.allSettled([pool.end(), redis.quit()]);
    },
  };
}
