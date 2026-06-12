import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../errors';
import { logger } from '../logger';

/** Wrap an async route handler so rejected promises reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/** Final error middleware — renders ApiError status/messages, hides 500 internals' stacks. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = err instanceof ApiError ? err.status : 500;
  const message = err instanceof Error ? err.message : 'internal error';
  if (status >= 500) {
    logger.error({ err }, 'request failed');
  }
  res.status(status).json({ error: message });
}
