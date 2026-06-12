import fs from 'fs';
import { config } from './config';
import { logger } from './logger';
import { Store } from './store';
import { createApp } from './server/app';
import { Registry } from './wa/registry';

async function main(): Promise<void> {
  // Ensure storage dirs exist.
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.sessionsDir, { recursive: true });

  const store = new Store(config.dbPath);
  const registry = new Registry(store);
  const app = createApp(registry);

  const server = app.listen(config.port, config.host, () => {
    logger.info(`waweb listening on http://${config.host}:${config.port}`);
  });

  // Reconnect saved profiles in the background — don't block the HTTP server.
  registry.loadAll().catch((err) => logger.error({ err }, 'failed to reload profiles'));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close();
    try {
      await registry.destroyAll();
      store.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
