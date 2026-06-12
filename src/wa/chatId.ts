import { badRequest } from '../errors';

export type TargetType = 'person' | 'group';

export interface NormalizedTarget {
  /** whatsapp-web.js chat id, e.g. `628123456789@c.us` or `12036304-150...@g.us`. */
  chatId: string;
  type: TargetType;
  /** Digits-only phone number, present for `person` targets. */
  number?: string;
}

/** Strip everything that isn't a digit. */
export function onlyDigits(input: string): string {
  return (input ?? '').replace(/\D/g, '');
}

/**
 * Normalize free-form input into a whatsapp-web.js chat id.
 *
 *   "+62 812-3456-789"          -> 628123456789@c.us  (person)
 *   "628123456789@c.us"         -> 628123456789@c.us  (person)
 *   "12036304-1500000000@g.us"  -> ...@g.us           (group)
 *   "12036304-1500000000"       -> ...@g.us           (group)
 *
 * Throws a 400 ApiError on malformed input.
 */
export function normalizeTarget(input: string): NormalizedTarget {
  if (typeof input !== 'string' || input.trim() === '') {
    throw badRequest('target is required');
  }
  const t = input.trim();

  // Explicit group id.
  if (t.endsWith('@g.us')) {
    if (!/^[\w-]+@g\.us$/.test(t)) throw badRequest(`invalid group id: ${input}`);
    return { chatId: t, type: 'group' };
  }

  // Explicit person id.
  if (t.endsWith('@c.us')) {
    const digits = onlyDigits(t);
    if (digits.length < 7 || digits.length > 15) throw badRequest(`invalid phone number: ${input}`);
    return { chatId: `${digits}@c.us`, type: 'person', number: digits };
  }

  // Bare group id (creator-timestamp form) without the suffix.
  if (/^\d+-\d+$/.test(t)) {
    return { chatId: `${t}@g.us`, type: 'group' };
  }

  // Otherwise treat as a phone number.
  const digits = onlyDigits(t);
  if (digits.length < 7 || digits.length > 15) {
    throw badRequest(`invalid phone number: ${input} (expected 7–15 digits, country code included)`);
  }
  return { chatId: `${digits}@c.us`, type: 'person', number: digits };
}
