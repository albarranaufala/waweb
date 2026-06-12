import { Router } from 'express';
import { config } from '../../config';
import { badRequest, notFound } from '../../errors';
import { Registry } from '../../wa/registry';
import { asyncHandler } from '../middleware';

/**
 * Profile lifecycle:
 *   GET    /profiles          list
 *   GET    /profiles/:id      detail
 *   POST   /profiles          create + start client (returns QR)
 *   GET    /profiles/:id/qr   poll QR + auth status
 *   DELETE /profiles/:id      remove (?logout=true unlinks the device first)
 */
export function profilesRouter(registry: Registry): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({ profiles: registry.all().map((p) => p.summary()) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const pc = registry.get(req.params.id);
      if (!pc) throw notFound(`no profile ${req.params.id}`);
      res.json(pc.detail());
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) throw badRequest('"name" is required');

      const pc = await registry.createProfile(name);
      // Give the client a moment to emit its first QR (or restore a session)
      // so the response is immediately useful.
      await pc.waitForQrOrReady(config.qrWaitMs);

      res.status(201).json({
        ...pc.detail(),
        qr: pc.qr(),
        hint: 'Scan the QR (qr.dataUrl / qr.ascii). Poll GET /profiles/:id/qr until state=connected.',
      });
    }),
  );

  router.get(
    '/:id/qr',
    asyncHandler(async (req, res) => {
      const pc = registry.get(req.params.id);
      if (!pc) throw notFound(`no profile ${req.params.id}`);
      res.json(pc.qr());
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const logout = String(req.query.logout ?? '').toLowerCase() === 'true';
      const removed = await registry.removeProfile(req.params.id, logout);
      if (!removed) throw notFound(`no profile ${req.params.id}`);
      res.json({ removed: true, id: req.params.id, loggedOut: logout });
    }),
  );

  return router;
}
