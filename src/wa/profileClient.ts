import { Client, LocalAuth, MessageAck, MessageMedia, Poll, type Message } from 'whatsapp-web.js';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { config } from '../config';
import { profileLogger } from '../logger';
import { ApiError, conflict, unprocessable } from '../errors';
import { ConnectionState, DeviceInfo, SendParams } from '../types';
import { normalizeTarget, onlyDigits } from './chatId';

export interface ProfileSummary {
  id: string;
  name: string;
  phoneNumber?: string;
  state: ConnectionState;
}

export interface ProfileDetail extends ProfileSummary {
  lastConnectedAt: number | null;
  lastError: string | null;
  device: DeviceInfo | null;
  hasQr: boolean;
}

export interface QrPayload {
  state: ConnectionState;
  /** PNG data URL of the QR, or null if none is pending. */
  dataUrl: string | null;
  /** Terminal-renderable ASCII QR, or null. */
  ascii: string | null;
  phoneNumber?: string;
}

export interface ChatSummary {
  /** whatsapp-web.js chat id — may be `<n>@c.us`, `<n>@lid`, or `<id>@g.us`. */
  id: string;
  name: string;
  type: 'person' | 'group';
  isGroup: boolean;
  /**
   * Real phone number (digits only, e.g. `6285156348711`) for person chats, when
   * resolvable. For `@lid` chats this is looked up from the linked contact, so it
   * is the actual phone number — NOT the lid digits. `undefined` if unresolvable.
   */
  phoneNumber?: string;
  /** @deprecated alias of `phoneNumber`, kept for backward compatibility. */
  number?: string;
  unreadCount: number;
  /** epoch ms of the last message, or null. */
  lastMessageAt: number | null;
}

/** Hook the registry uses to persist state transitions to SQLite. */
export type PersistHook = (
  id: string,
  fields: {
    state?: ConnectionState;
    phoneNumber?: string | null;
    lastConnectedAt?: number | null;
    lastError?: string | null;
  },
) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min: number, max: number) =>
  Math.floor(min + Math.random() * Math.max(0, max - min));

function asciiQr(qr: string): Promise<string> {
  return new Promise((resolve) => qrcodeTerminal.generate(qr, { small: true }, resolve));
}

/** Human-readable label for a whatsapp-web.js MessageAck value. */
function ackName(ack: number): string {
  switch (ack) {
    case MessageAck.ACK_ERROR:
      return 'error';
    case MessageAck.ACK_PENDING:
      return 'pending';
    case MessageAck.ACK_SERVER:
      return 'server';
    case MessageAck.ACK_DEVICE:
      return 'device';
    case MessageAck.ACK_READ:
      return 'read';
    case MessageAck.ACK_PLAYED:
      return 'played';
    default:
      return `unknown(${ack})`;
  }
}

/**
 * Wraps a single whatsapp-web.js Client: owns its lifecycle, exposes the current
 * connection state + QR, and implements the send / chat operations.
 */
export class ProfileClient {
  readonly id: string;
  name: string;

  state: ConnectionState = ConnectionState.Connecting;
  phoneNumber?: string;
  device: DeviceInfo | null = null;
  lastConnectedAt: number | null = null;
  lastError: string | null = null;

  private client!: Client;
  private qrDataUrl: string | null = null;
  private qrAscii: string | null = null;

  private destroyed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly log;
  private readonly persist: PersistHook;

  constructor(opts: {
    id: string;
    name: string;
    persist: PersistHook;
    phoneNumber?: string | null;
    lastConnectedAt?: number | null;
  }) {
    this.id = opts.id;
    this.name = opts.name;
    this.persist = opts.persist;
    this.phoneNumber = opts.phoneNumber ?? undefined;
    this.lastConnectedAt = opts.lastConnectedAt ?? null;
    this.log = profileLogger(this.id, this.name);
    this.buildClient();
  }

  // ---- lifecycle -----------------------------------------------------------

  private buildClient(): void {
    // Pin the WhatsApp Web version so WhatsApp's self-updating SPA can't drift
    // away from what whatsapp-web.js knows how to drive (the usual cause of
    // random forced logouts). Configurable / disableable via env.
    const webVersionCache =
      config.wwebCacheType === 'none'
        ? { type: 'none' as const }
        : config.wwebCacheType === 'local'
          ? { type: 'local' as const }
          : { type: 'remote' as const, remotePath: config.wwebRemotePath };

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: this.id, dataPath: config.sessionsDir }),
      webVersion: config.wwebVersion,
      webVersionCache,
      userAgent: config.waUserAgent,
      takeoverOnConflict: config.takeoverOnConflict,
      takeoverTimeoutMs: config.takeoverOnConflict ? 10_000 : 0,
      puppeteer: {
        headless: true,
        executablePath: config.puppeteerExecutablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
        ],
      },
    });
    this.bindEvents();
  }

  /** Kick off the Chromium client. Safe to call once per (re)build. */
  async initialize(): Promise<void> {
    this.setState(ConnectionState.Connecting);
    try {
      await this.client.initialize();
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.error({ err }, 'initialize failed');
      this.scheduleReconnect();
    }
  }

  private bindEvents(): void {
    this.client.on('qr', async (qr: string) => {
      try {
        this.qrDataUrl = await qrcode.toDataURL(qr);
        this.qrAscii = await asciiQr(qr);
      } catch (err) {
        this.log.warn({ err }, 'failed to render QR');
      }
      this.setState(ConnectionState.QrPending);
      this.log.info('QR ready — scan to link the device');
    });

    this.client.on('loading_screen', (percent: number, message: string) => {
      this.log.debug({ percent, message }, 'loading');
    });

    this.client.on('authenticated', () => {
      this.clearQr();
      this.setState(ConnectionState.Authenticated);
      this.log.info('authenticated');
    });

    this.client.on('auth_failure', (msg: string) => {
      this.lastError = msg;
      this.clearQr();
      this.setState(ConnectionState.LoggedOut);
      this.log.error({ msg }, 'auth failure — a fresh QR is required');
    });

    this.client.on('ready', () => {
      this.clearQr();
      this.reconnectAttempts = 0;
      this.lastConnectedAt = Date.now();
      this.lastError = null;
      try {
        const info = this.client.info;
        this.phoneNumber = info?.wid?.user;
        this.device = {
          pushname: info?.pushname,
          platform: info?.platform,
          wid: info?.wid?._serialized,
          phoneNumber: info?.wid?.user,
        };
      } catch (err) {
        this.log.warn({ err }, 'could not read client.info');
      }
      this.setState(ConnectionState.Connected);
      this.log.info({ phoneNumber: this.phoneNumber }, 'connected');
    });

    this.client.on('change_state', (s: string) => {
      this.log.debug({ waState: s }, 'change_state');
      if (String(s).toUpperCase() === 'CONFLICT') {
        this.setState(ConnectionState.Conflict);
      }
    });

    this.client.on('disconnected', (reason: string) => {
      this.handleDisconnect(reason);
    });

    // --- Extension point (OUT OF SCOPE v1) -------------------------------
    // Receiving/reading incoming messages. To add later:
    //   this.client.on('message', (msg) => { /* route inbound messages */ });
    // Group management (create/edit) would also be wired here.
    // ---------------------------------------------------------------------
  }

  private handleDisconnect(reason: string): void {
    this.device = null;
    const r = String(reason ?? '').toUpperCase();
    this.log.warn({ reason }, 'disconnected');

    if (r.includes('CONFLICT')) {
      this.setState(ConnectionState.Conflict);
      return;
    }
    // WhatsApp unlinked us — do NOT loop forever; require a fresh QR.
    if (r.includes('LOGOUT') || r.includes('UNPAIRED') || r.includes('UNLAUNCHED')) {
      this.lastError = `disconnected: ${reason}`;
      this.setState(ConnectionState.LoggedOut);
      return;
    }
    this.setState(ConnectionState.Disconnected);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    if (this.reconnectAttempts >= config.reconnectMaxRetries) {
      this.lastError = `gave up reconnecting after ${this.reconnectAttempts} attempts`;
      this.persist(this.id, { lastError: this.lastError });
      this.log.error(this.lastError);
      return;
    }
    const backoff = Math.min(
      config.reconnectBaseMs * 2 ** this.reconnectAttempts,
      config.reconnectMaxMs,
    );
    const delay = backoff + randomBetween(0, 1_000);
    this.reconnectAttempts += 1;
    this.log.info({ attempt: this.reconnectAttempts, delay }, 'scheduling reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reinitialize();
    }, delay);
  }

  private async reinitialize(): Promise<void> {
    if (this.destroyed) return;
    // Rebuild the client from scratch — the previous Chromium/page is gone.
    try {
      await this.client.destroy();
    } catch {
      /* ignore */
    }
    this.buildClient();
    await this.initialize();
  }

  // ---- state ---------------------------------------------------------------

  private setState(state: ConnectionState): void {
    this.state = state;
    this.persist(this.id, {
      state,
      phoneNumber: this.phoneNumber ?? null,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
    });
  }

  private clearQr(): void {
    this.qrDataUrl = null;
    this.qrAscii = null;
  }

  // ---- public accessors ----------------------------------------------------

  summary(): ProfileSummary {
    return { id: this.id, name: this.name, phoneNumber: this.phoneNumber, state: this.state };
  }

  detail(): ProfileDetail {
    return {
      ...this.summary(),
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      device: this.device,
      hasQr: this.qrDataUrl !== null,
    };
  }

  qr(): QrPayload {
    return {
      state: this.state,
      dataUrl: this.qrDataUrl,
      ascii: this.qrAscii,
      phoneNumber: this.phoneNumber,
    };
  }

  /**
   * Resolve once a QR is available or the client reaches a terminal-ish state
   * (connected / authenticated / logged-out), or the timeout elapses.
   * Used by POST /profiles to return something useful synchronously.
   */
  async waitForQrOrReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const done = () =>
      this.qrDataUrl !== null ||
      this.state === ConnectionState.Connected ||
      this.state === ConnectionState.Authenticated ||
      this.state === ConnectionState.LoggedOut;
    while (!done() && Date.now() < deadline && !this.destroyed) {
      await sleep(250);
    }
  }

  // ---- operations ----------------------------------------------------------

  /** Send exactly one message: text, media(+caption), or poll. */
  async send(params: SendParams): Promise<{
    id: string | null;
    timestamp: number | null;
    to: string;
    type: string | null;
    ack: number | null;
    /** Human-readable ack name (e.g. `server`, `device`, `error`, `pending`). */
    ackName: string;
    /**
     * Whether WhatsApp confirmed the message at least reached its servers
     * (ack >= 1) within the confirmation window. `false` means it stayed pending
     * or errored — it likely did NOT reach the recipient (common for brand-new
     * contacts / numbers never messaged before).
     */
    delivered: boolean;
  }> {
    if (this.state !== ConnectionState.Connected) {
      throw conflict(`profile is not connected (state=${this.state})`);
    }

    const target = normalizeTarget(params.target);
    let chatId = target.chatId;

    // Verify the target is registered / reachable on WhatsApp.
    if (target.type === 'person' && target.isLid) {
      // LIDs are opaque ids, not phone numbers — getNumberId() doesn't apply.
      // Address the `@lid` chat directly (it came from an existing contact/chat).
    } else if (target.type === 'person') {
      const numberId = await this.client.getNumberId(target.number!);
      if (!numberId) {
        throw unprocessable(`target ${params.target} is not registered on WhatsApp`);
      }
      chatId = numberId._serialized;
    } else {
      try {
        await this.client.getChatById(chatId);
      } catch {
        throw unprocessable(`group ${params.target} was not found for this profile`);
      }
    }

    // Resolve mentions -> contact ids, and confirm the @<number> token is present.
    const mentionIds: string[] = [];
    if (params.mentions?.length) {
      const displayed = params.text ?? '';
      for (const raw of params.mentions) {
        const digits = onlyDigits(raw);
        if (!digits) throw unprocessable(`invalid mention: ${raw}`);
        const id = await this.client.getNumberId(digits);
        if (!id) throw unprocessable(`mention ${raw} is not registered on WhatsApp`);
        if (!displayed.includes(`@${digits}`)) {
          throw unprocessable(
            `mention ${raw} requires an "@${digits}" token in the message text/caption, or it won't render`,
          );
        }
        mentionIds.push(id._serialized);
      }
    }

    // Typing indicator + randomized delay (anti-ban), then send.
    let chat: Awaited<ReturnType<Client['getChatById']>> | undefined;
    try {
      chat = await this.client.getChatById(chatId);
      if (config.typingSimulation) await chat.sendStateTyping();
    } catch (err) {
      this.log.debug({ err }, 'could not send typing state');
    }
    await sleep(randomBetween(config.messageDelayMinMs, config.messageDelayMaxMs));

    let result: Message;
    try {
      if (params.poll) {
        try {
          result = await this.client.sendMessage(
            chatId,
            new Poll(params.poll.question, params.poll.options, {
              allowMultipleAnswers: !!params.poll.allowMultipleAnswers,
              messageSecret: undefined,
            }),
          );
        } catch (err) {
          // Polls are version-sensitive — fail gracefully with a clear message.
          throw new ApiError(
            502,
            `poll send failed (whatsapp-web.js Poll may be incompatible with the linked WhatsApp version): ${(err as Error).message}`,
          );
        }
      } else if (params.media) {
        result = await this.client.sendMessage(chatId, params.media, {
          caption: params.text,
          mentions: mentionIds.length ? mentionIds : undefined,
          sendMediaAsDocument: !!params.asDocument,
        });
      } else {
        result = await this.client.sendMessage(chatId, params.text ?? '', {
          mentions: mentionIds.length ? mentionIds : undefined,
        });
      }
    } finally {
      try {
        await chat?.clearState();
      } catch {
        /* ignore */
      }
    }

    // whatsapp-web.js resolves sendMessage() as soon as the message is *queued*,
    // so a bare result is NOT proof of delivery — sends to brand-new contacts can
    // sit at ACK_PENDING (0) or fail to ACK_ERROR (-1) afterwards. Wait briefly for
    // the ack to advance to at least ACK_SERVER (reached WhatsApp's servers) so the
    // caller learns the real outcome instead of an optimistic "sent: true".
    const messageId = result.id?._serialized ?? null;
    const ack = await this.waitForAck(messageId, result.ack ?? 0, config.sendAckTimeoutMs);
    const delivered = ack >= MessageAck.ACK_SERVER;
    if (!delivered) {
      this.log.warn({ messageId, ack, to: chatId }, 'send not confirmed by WhatsApp');
    }

    return {
      id: messageId,
      timestamp: result.timestamp ? result.timestamp * 1000 : null,
      to: chatId,
      type: result.type ?? null,
      ack,
      ackName: ackName(ack),
      delivered,
    };
  }

  /**
   * Wait until the given message's ack reaches a terminal-enough state — either it
   * reached WhatsApp's servers (>= ACK_SERVER) or definitively failed (ACK_ERROR) —
   * or the timeout elapses. Returns the best ack observed. Resolves immediately if
   * the ack is already conclusive or no message id is available to track.
   */
  private async waitForAck(
    messageId: string | null,
    current: number,
    timeoutMs: number,
  ): Promise<number> {
    const conclusive = (ack: number) => ack >= MessageAck.ACK_SERVER || ack === MessageAck.ACK_ERROR;
    if (!messageId || conclusive(current)) return current;

    // The server ack can arrive during the awaited typing-state cleanup, before we
    // attach the listener below — so take one authoritative reading first.
    const fresh = await this.currentAck(messageId, current);
    if (conclusive(fresh)) return fresh;

    return new Promise((resolve) => {
      let best = fresh;
      let settled = false;
      const finish = (ack: number) => {
        if (settled) return;
        settled = true;
        this.client.off('message_ack', onAck);
        clearTimeout(timer);
        resolve(ack);
      };
      const onAck = (msg: Message, ack: number) => {
        if (msg.id?._serialized !== messageId) return;
        best = ack;
        if (conclusive(ack)) finish(ack);
      };
      this.client.on('message_ack', onAck);
      // On timeout, re-read once more in case the event was missed entirely.
      const timer = setTimeout(() => {
        void this.currentAck(messageId, best).then(finish);
      }, Math.max(0, timeoutMs));
    });
  }

  /** Best-effort read of a message's current ack, falling back on any error. */
  private async currentAck(messageId: string, fallback: number): Promise<number> {
    try {
      const msg = await this.client.getMessageById(messageId);
      return msg?.ack ?? fallback;
    } catch {
      return fallback;
    }
  }

  /** List chats (people + groups), optionally filtered by a name/number query. */
  async getChats(query?: string): Promise<ChatSummary[]> {
    if (this.state !== ConnectionState.Connected) {
      throw conflict(`profile is not connected (state=${this.state})`);
    }
    const chats = await this.client.getChats();

    // Resolve REAL phone numbers for person chats. For `@c.us` chats the id's user
    // part already IS the phone number. For `@lid` chats the user part is an opaque
    // lid, so we must look up the linked phone number — batched into a single
    // round-trip to keep this cheap and avoid per-chat WhatsApp queries.
    const lidIds = chats
      .filter((c) => !c.isGroup && c.id.server === 'lid')
      .map((c) => c.id._serialized);
    const phoneByLid = await this.resolveLidPhones(lidIds);

    let mapped: ChatSummary[] = chats.map((c) => {
      let phoneNumber: string | undefined;
      if (!c.isGroup) {
        phoneNumber =
          c.id.server === 'lid' ? phoneByLid.get(c.id._serialized) : c.id.user;
      }
      return {
        id: c.id._serialized,
        name: c.name ?? c.id.user,
        type: c.isGroup ? 'group' : 'person',
        isGroup: c.isGroup,
        phoneNumber,
        number: phoneNumber,
        unreadCount: c.unreadCount ?? 0,
        lastMessageAt: c.timestamp ? c.timestamp * 1000 : null,
      };
    });

    if (query && query.trim()) {
      const q = query.trim().toLowerCase();
      const qDigits = onlyDigits(q);
      mapped = mapped.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          (qDigits.length > 0 && (c.phoneNumber?.includes(qDigits) ?? false)),
      );
    }

    mapped.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
    return mapped;
  }

  /**
   * Map a batch of `@lid` ids to their real phone numbers (digits only), using
   * whatsapp-web.js's LID↔phone resolver in a single round-trip. Missing/unknown
   * lids are simply absent from the result map; resolution failures degrade to an
   * empty map rather than failing the whole chat list.
   */
  private async resolveLidPhones(lidIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!lidIds.length) return out;
    try {
      const pairs = await this.client.getContactLidAndPhone(lidIds);
      for (const { lid, pn } of pairs) {
        const digits = onlyDigits(pn ?? '');
        if (lid && digits) out.set(lid, digits);
      }
    } catch (err) {
      this.log.warn({ err }, 'failed to resolve LID phone numbers');
    }
    return out;
  }

  /** Build a MessageMedia from a remote URL. */
  static async mediaFromUrl(url: string): Promise<MessageMedia> {
    return MessageMedia.fromUrl(url, { unsafeMime: true });
  }

  /**
   * Recover a profile that ended up `logged-out` (or any stale state): tear down
   * the current Chromium and rebuild it so a fresh QR is surfaced — keeping the
   * same profile id and metadata. If a session still exists on disk it simply
   * reconnects without a QR.
   */
  async relink(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.client.destroy();
    } catch {
      /* ignore */
    }
    this.destroyed = false;
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.clearQr();
    this.buildClient();
    await this.initialize();
  }

  /** Unlink the device from WhatsApp (removes the session on disk too). */
  async logout(): Promise<void> {
    try {
      await this.client.logout();
      this.setState(ConnectionState.LoggedOut);
      this.log.info('logged out (device unlinked)');
    } catch (err) {
      this.log.warn({ err }, 'logout failed (continuing with teardown)');
    }
  }

  /** Tear down the Chromium client; no further reconnects. */
  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.client.destroy();
    } catch (err) {
      this.log.debug({ err }, 'destroy error (ignored)');
    }
  }
}
