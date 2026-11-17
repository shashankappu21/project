import type { Redis } from 'ioredis';
import type { PlaceOrderInput } from '@nse/shared';
import type { Config } from '../config';
import { NIFTY_50 } from '../data/nifty50';
import type { Pool } from '../db/pool';
import { migrate } from '../db/migrate';
import { getLogger } from '../logger';
import { MarketDataService } from '../market/marketDataService';
import type { PriceProvider } from '../market/types';
import { instrumentsRepo } from '../repositories/instrumentsRepo';
import { pricesRepo } from '../repositories/pricesRepo';
import { usersRepo } from '../repositories/usersRepo';
import { AuthService } from './authService';
import { SyncDispatcher } from './dispatcher';
import { ExecutionService } from './executionService';
import { OrderService } from './orderService';
import { PriceIngestService } from './priceIngestService';

export const DEMO_USER = { email: 'demo@nsepaper.dev', password: 'Demo@12345', name: 'Demo Trader' };

/** Fixed Idempotency-Keys make re-running the bootstrap a no-op for the demo account's orders. */
export const DEMO_ORDERS: Array<{ key: string; input: PlaceOrderInput }> = [
  { key: 'seed-demo-0001', input: { symbol: 'RELIANCE', side: 'BUY', type: 'MARKET', quantity: 25 } },
  { key: 'seed-demo-0002', input: { symbol: 'TCS', side: 'BUY', type: 'MARKET', quantity: 10 } },
  { key: 'seed-demo-0003', input: { symbol: 'HDFCBANK', side: 'BUY', type: 'MARKET', quantity: 40 } },
  { key: 'seed-demo-0004', input: { symbol: 'INFY', side: 'BUY', type: 'MARKET', quantity: 30 } },
  { key: 'seed-demo-0005', input: { symbol: 'INFY', side: 'SELL', type: 'MARKET', quantity: 10 } },
  { key: 'seed-demo-0006', input: { symbol: 'ITC', side: 'BUY', type: 'LIMIT', quantity: 100, limitPrice: 380 } },
];

const DAY = 86_400_000;
/** Re-ingest a short window on every run so late corrections from the provider are picked up. */
const REFRESH_DAYS = 7;

export interface BootstrapResult {
  migrations: string[];
  retired: string[];
  bars: number;
  demoUserId: string;
}

/**
 * Idempotent data bootstrap shared by `npm run seed` and API start-up (SEED_ON_START):
 * migrations -> NIFTY 50 universe -> candles (only what is missing) -> demo account and orders.
 * Safe to run on every boot and from several processes (migrations are advisory-locked,
 * ingest upserts, demo orders use fixed Idempotency-Keys).
 */
export async function bootstrapData(deps: {
  pool: Pool;
  redis: Redis;
  provider: PriceProvider;
  config: Config;
  historyDays?: number;
}): Promise<BootstrapResult> {
  const { pool, redis, provider, config } = deps;
  const log = getLogger().child({ job: 'bootstrap' });

  const migrations = await migrate(pool);
  const retired = await instrumentsRepo.syncUniverse(pool, NIFTY_50);

  const latest = await pricesRepo.latestDate(pool);
  const from = latest
    ? new Date(Date.parse(latest) - REFRESH_DAYS * DAY)
    : new Date(Date.now() - (deps.historyDays ?? config.SEED_HISTORY_DAYS) * DAY);
  const { bars } = await new PriceIngestService(pool, provider).ingest(from, new Date());

  const marketData = new MarketDataService(redis, provider, config.QUOTE_CACHE_TTL_SECONDS);
  const auth = new AuthService(pool, config);
  const orders = new OrderService(pool, marketData, new SyncDispatcher(new ExecutionService(pool, marketData)));
  const existing = await usersRepo.findByEmail(pool, DEMO_USER.email);
  const demoUserId = existing ? existing.id : (await auth.register(DEMO_USER)).user.id;
  for (const { key, input } of DEMO_ORDERS) {
    await orders.placeOrder({ userId: demoUserId, input, idempotencyKey: key, requestId: 'bootstrap' });
  }

  log.info(
    { migrations, retired, bars, incremental: Boolean(latest), demo: DEMO_USER.email },
    'bootstrap complete',
  );
  return { migrations, retired, bars, demoUserId };
}
