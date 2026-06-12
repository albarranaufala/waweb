/**
 * Explicit connection lifecycle surfaced by the profile endpoints.
 *
 *  connecting    — client is booting / launching Chromium / reconnecting
 *  qr-pending    — waiting for the user to scan a QR (creds not yet present)
 *  authenticated — QR scanned / session restored; finishing handshake
 *  connected     — ready to send
 *  disconnected  — transient drop; backoff reconnect in progress
 *  logged-out    — WhatsApp unlinked the device; a fresh QR is required
 *  conflict      — the session was taken over by another WhatsApp Web instance
 */
export enum ConnectionState {
  Connecting = 'connecting',
  QrPending = 'qr-pending',
  Authenticated = 'authenticated',
  Connected = 'connected',
  Disconnected = 'disconnected',
  LoggedOut = 'logged-out',
  Conflict = 'conflict',
}

/** Row persisted in SQLite. Session credentials themselves live in LocalAuth files. */
export interface ProfileRecord {
  id: string;
  name: string;
  phoneNumber: string | null;
  state: ConnectionState;
  /** epoch ms of the last successful `ready`, or null. */
  lastConnectedAt: number | null;
  lastError: string | null;
  /** epoch ms. */
  createdAt: number;
}

export interface DeviceInfo {
  pushname?: string;
  platform?: string;
  wid?: string;
  phoneNumber?: string;
}

/** Normalized representation of a send request, after parsing/validation. */
export interface SendParams {
  target: string;
  text?: string;
  mentions?: string[];
  media?: import('whatsapp-web.js').MessageMedia;
  asDocument?: boolean;
  poll?: {
    question: string;
    options: string[];
    allowMultipleAnswers?: boolean;
  };
}
