import { Redis } from 'ioredis';
import { FakePriceProvider, YahooPriceProvider, bootstrapData, createPool, loadConfig, rootLogger } from '../index';

/** `npm run seed`: the same idempotent bootstrap the API can run on start-up (SEED_ON_START=true). */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, 5);
  const redis = new Redis(config.REDIS_URL);
  try {
    const provider = config.MARKET_DATA_PROVIDER === 'fake' ? new FakePriceProvider() : new YahooPriceProvider();
    await bootstrapData({ pool, redis, provider, config });
  } finally {
    await pool.end();
    await redis.quit();
  }
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'seed failed');
  process.exit(1);
});
