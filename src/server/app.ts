import express, { Express } from 'express';
import { Registry } from '../wa/registry';
import { errorHandler } from './middleware';
import { profilesRouter } from './routes/profiles';
import { messagesRouter } from './routes/messages';
import { chatsRouter } from './routes/chats';

/** Build the Express app. Routers are mounted so nested :id params resolve cleanly. */
export function createApp(registry: Registry): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Nested resources first (more specific paths), then the base profiles router.
  app.use('/profiles/:id/messages', messagesRouter(registry));
  app.use('/profiles/:id/chats', chatsRouter(registry));
  app.use('/profiles', profilesRouter(registry));

  app.use(errorHandler);
  return app;
}
