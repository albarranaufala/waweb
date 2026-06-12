import pino from 'pino';
import { config } from './config';

/**
 * Root structured logger. Use {@link profileLogger} for per-profile child
 * loggers so every WhatsApp client's output carries its profile id.
 */
export const logger = pino({
  level: config.logLevel,
  ...(config.logPretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export function profileLogger(profileId: string, name?: string) {
  return logger.child({ profileId, profile: name });
}

export type Logger = typeof logger;
