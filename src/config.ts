import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

const dataDir = path.resolve(str('DATA_DIR', './data'));

export const config = {
  /** Bind address — keep on localhost; the API has no auth. */
  host: str('HOST', '127.0.0.1'),
  port: int('PORT', 3000),

  /** Persistent storage. */
  dataDir,
  dbPath: path.join(dataDir, 'profiles.db'),
  /** LocalAuth session files live here (one `session-<id>` folder per profile). */
  sessionsDir: path.join(dataDir, 'sessions'),

  /** Anti-ban: randomized pre-send delay window + typing simulation. */
  messageDelayMinMs: int('MESSAGE_DELAY_MIN_MS', 800),
  messageDelayMaxMs: int('MESSAGE_DELAY_MAX_MS', 2500),
  typingSimulation: bool('TYPING_SIMULATION', true),

  /** Max multipart upload size, in megabytes. */
  maxUploadMb: int('MAX_UPLOAD_MB', 32),

  /** How long POST /profiles waits for the first QR (or restored session). */
  qrWaitMs: int('QR_WAIT_MS', 25_000),

  /** Reconnect backoff for transient disconnects. */
  reconnectBaseMs: int('RECONNECT_BASE_MS', 2_000),
  reconnectMaxMs: int('RECONNECT_MAX_MS', 60_000),
  reconnectMaxRetries: int('RECONNECT_MAX_RETRIES', 10),

  logLevel: str('LOG_LEVEL', 'info'),
  logPretty: bool('LOG_PRETTY', true),

  /** Optional system Chrome path; otherwise puppeteer's bundled Chromium is used. */
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
} as const;

export type Config = typeof config;
