import { Router } from 'express';
import multer from 'multer';
import { MessageMedia } from 'whatsapp-web.js';
import { config } from '../../config';
import { badRequest, notFound } from '../../errors';
import { SendParams } from '../../types';
import { ProfileClient } from '../../wa/profileClient';
import { Registry } from '../../wa/registry';
import { asyncHandler } from '../middleware';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
});

/** Coerce a value that may arrive as a JSON string (multipart) or already-parsed (JSON body). */
function maybeJson<T>(value: unknown): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as unknown as T;
  }
}

function parseMentions(value: unknown): string[] | undefined {
  const v = maybeJson<unknown>(value);
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return undefined;
}

function parseBool(value: unknown): boolean {
  return value === true || /^(1|true|yes|on)$/i.test(String(value ?? ''));
}

/**
 * Build a MessageMedia from (in priority order):
 *   1. a multipart file upload (field name `media`)
 *   2. body.media = { url } | { base64, mimetype, filename } | "<url>" | "data:<mime>;base64,<...>"
 *   3. body.mediaUrl = "<url>"
 */
async function buildMedia(req: {
  file?: Express.Multer.File;
  body: Record<string, unknown>;
}): Promise<MessageMedia | undefined> {
  if (req.file) {
    return new MessageMedia(
      req.file.mimetype,
      req.file.buffer.toString('base64'),
      req.file.originalname,
    );
  }

  const mediaUrl = typeof req.body.mediaUrl === 'string' ? req.body.mediaUrl : undefined;
  if (mediaUrl) return ProfileClient.mediaFromUrl(mediaUrl);

  const media = maybeJson<
    string | { url?: string; base64?: string; data?: string; mimetype?: string; filename?: string }
  >(req.body.media);
  if (media === undefined) return undefined;

  if (typeof media === 'string') {
    if (/^https?:\/\//i.test(media)) return ProfileClient.mediaFromUrl(media);
    const m = /^data:([^;]+);base64,(.+)$/i.exec(media);
    if (m) return new MessageMedia(m[1], m[2]);
    throw badRequest('media string must be an http(s) URL or a data: URL');
  }

  if (media.url) return ProfileClient.mediaFromUrl(media.url);
  const data = media.base64 ?? media.data;
  if (data) {
    if (!media.mimetype) throw badRequest('media.mimetype is required with base64 data');
    return new MessageMedia(media.mimetype, data, media.filename);
  }
  throw badRequest('media must provide a url, or base64 data with a mimetype');
}

/**
 * Validate that the request is exactly one valid WhatsApp message:
 * one primary content of text | media(+caption) | poll. Mentions may accompany
 * text or a caption (not a poll).
 */
function validateExclusive(params: {
  hasText: boolean;
  hasMedia: boolean;
  hasPoll: boolean;
  hasMentions: boolean;
}): void {
  const primaries = [params.hasMedia, params.hasPoll].filter(Boolean).length;
  if (params.hasPoll && params.hasMedia) {
    throw badRequest('a message cannot be both a poll and media');
  }
  if (params.hasPoll && params.hasText) {
    throw badRequest('a poll carries its own question — do not also send "text"');
  }
  if (params.hasPoll && params.hasMentions) {
    throw badRequest('mentions are not supported on polls');
  }
  if (primaries === 0 && !params.hasText) {
    throw badRequest('provide exactly one of: text, media (with optional caption), or poll');
  }
}

/** Mounted at /profiles/:id/messages — accepts application/json and multipart/form-data. */
export function messagesRouter(registry: Registry): Router {
  const router = Router({ mergeParams: true });

  router.post(
    '/',
    upload.single('media'),
    asyncHandler(async (req, res) => {
      const pc = registry.get(req.params.id);
      if (!pc) throw notFound(`no profile ${req.params.id}`);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const target = typeof body.target === 'string' ? body.target : '';
      if (!target) throw badRequest('"target" is required');

      const text = typeof body.text === 'string' && body.text !== '' ? body.text : undefined;
      const mentions = parseMentions(body.mentions);
      const asDocument = parseBool(body.asDocument);
      const poll = maybeJson<SendParams['poll']>(body.poll);
      const media = await buildMedia({ file: req.file, body });

      if (poll) {
        if (!poll.question || !Array.isArray(poll.options) || poll.options.length < 2) {
          throw badRequest('poll requires a "question" and at least two "options"');
        }
      }

      validateExclusive({
        hasText: !!text,
        hasMedia: !!media,
        hasPoll: !!poll,
        hasMentions: !!mentions?.length,
      });

      const result = await pc.send({ target, text, mentions, media, asDocument, poll });
      // `sent` reflects WhatsApp's actual confirmation (ack), not just that the
      // request was accepted — an unconfirmed send (e.g. to a brand-new contact)
      // returns sent:false with a 202 so callers don't assume it arrived.
      res.status(result.delivered ? 201 : 202).json({ sent: result.delivered, message: result });
    }),
  );

  return router;
}
