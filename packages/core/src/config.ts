import { z } from 'zod';

/** Env booleans arrive as strings; only "true"/"1" enable a flag. */
const flag = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('1d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  MARKET_DATA_PROVIDER: z.enum(['yahoo', 'fake']).default('yahoo'),
  QUOTE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(15),
  QUOTE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  STARTING_CASH: z.coerce.number().positive().default(1_000_000),
  /** sync = execute in-process (Stage 1 / tests); queue = publish to BullMQ */
  EXECUTION_MODE: z.enum(['sync', 'queue']).default('queue'),
  EOD_CRON: z.string().default('0 16 * * 1-5'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_ORDERS_PER_MIN: z.coerce.number().int().positive().default(120),
  /** Run the BullMQ consumers + schedulers inside the API process (single free-tier service). */
  RUN_WORKER: flag,
  /** Apply migrations before the API starts listening (for hosts without a release/pre-deploy step). */
  MIGRATE_ON_START: flag,
  /** After start-up, idempotently sync the NIFTY 50, ingest missing candles and create the demo account. */
  SEED_ON_START: flag,
  SEED_HISTORY_DAYS: z.coerce.number().int().positive().default(730),
  /** Enables POST /internal/jobs/:job for an external scheduler (e.g. GitHub Actions cron). */
  CRON_SECRET: z.string().min(24, 'CRON_SECRET must be at least 24 characters').optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
