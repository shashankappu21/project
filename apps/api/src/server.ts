import { createServer } from 'node:http';
import { bootstrapData, loadConfig, migrate, rootLogger } from '@nse/core';
import { createApp } from './app';
import { buildContainer } from './container';
import { startInProcessWorker } from './inProcessWorker';
import { attachRealtime } from './ws/realtime';

async function main(): Promise<void> {
  const config = loadConfig();
  const container = buildContainer(config);
  if (config.MIGRATE_ON_START) {
    // Advisory-locked, so several instances starting together apply each migration once.
    rootLogger.info({ applied: await migrate(container.pool) }, 'migrations checked');
  }
  const app = createApp(container);
  const server = createServer(app);
  const realtime = attachRealtime(server, container);

  server.listen(config.PORT, () => {
    rootLogger.info({ port: config.PORT, executionMode: config.EXECUTION_MODE, provider: config.MARKET_DATA_PROVIDER }, 'api listening');
  });

  const worker = config.RUN_WORKER ? await startInProcessWorker(container) : null;
  if (config.SEED_ON_START) {
    // In the background: the health check must pass while candles are still being ingested.
    void bootstrapData({ pool: container.pool, redis: container.redis, provider: container.provider, config }).catch((err) =>
      rootLogger.error({ err }, 'bootstrap failed'),
    );
  }

  const shutdown = (signal: string) => {
    rootLogger.info({ signal }, 'shutting down');
    void realtime.close();
    void worker?.close();
    server.close(() => {
      void container.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
