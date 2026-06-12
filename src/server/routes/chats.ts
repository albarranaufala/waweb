import { Router } from 'express';
import { notFound } from '../../errors';
import { Registry } from '../../wa/registry';
import { asyncHandler } from '../middleware';

/**
 * Mounted at /profiles/:id/chats.
 *   GET /profiles/:id/chats          all chats (people + groups)
 *   GET /profiles/:id/chats?q=...     search by name / number
 */
export function chatsRouter(registry: Registry): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const pc = registry.get(req.params.id);
      if (!pc) throw notFound(`no profile ${req.params.id}`);
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const chats = await pc.getChats(q);
      res.json({ count: chats.length, query: q ?? null, chats });
    }),
  );

  return router;
}
