import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import { Store } from '../store';
import { ConnectionState } from '../types';
import { ProfileClient, PersistHook } from './profileClient';

/**
 * In-memory registry of live whatsapp-web.js clients, keyed by profile id, plus
 * the SQLite metadata behind them. There is exactly one ProfileClient per id for
 * the lifetime of the process.
 */
export class Registry {
  private readonly clients = new Map<string, ProfileClient>();

  constructor(private readonly store: Store) {}

  private persist: PersistHook = (id, fields) => {
    this.store.update(id, fields);
  };

  /** Reconnect every saved profile on boot (LocalAuth restores the session). */
  async loadAll(): Promise<void> {
    const records = this.store.all();
    logger.info({ count: records.length }, 'reloading saved profiles');
    for (const r of records) {
      const pc = new ProfileClient({
        id: r.id,
        name: r.name,
        persist: this.persist,
        phoneNumber: r.phoneNumber,
        lastConnectedAt: r.lastConnectedAt,
      });
      this.clients.set(r.id, pc);
      // Don't block boot on each Chromium launch; reconnect in the background.
      void pc.initialize();
    }
  }

  /** Create a new profile, persist it, and start its client. */
  async createProfile(name: string): Promise<ProfileClient> {
    const id = randomUUID();
    this.store.create({
      id,
      name,
      phoneNumber: null,
      state: ConnectionState.Connecting,
      lastConnectedAt: null,
      lastError: null,
      createdAt: Date.now(),
    });
    const pc = new ProfileClient({ id, name, persist: this.persist });
    this.clients.set(id, pc);
    await pc.initialize();
    return pc;
  }

  /** Rebuild a profile's client to surface a fresh QR (after a forced logout). */
  async relinkProfile(id: string): Promise<ProfileClient | undefined> {
    const pc = this.clients.get(id);
    if (!pc) return undefined;
    await pc.relink();
    await pc.waitForQrOrReady(config.qrWaitMs);
    return pc;
  }

  get(id: string): ProfileClient | undefined {
    return this.clients.get(id);
  }

  all(): ProfileClient[] {
    return [...this.clients.values()];
  }

  /**
   * Remove a profile. With `logout`, unlink the device from WhatsApp first so the
   * phone no longer shows it as a linked device. Then destroy the client, drop the
   * SQLite row, and delete the on-disk session.
   */
  async removeProfile(id: string, logout: boolean): Promise<boolean> {
    const pc = this.clients.get(id);
    const record = this.store.get(id);
    if (!pc && !record) return false;

    if (pc) {
      if (logout) await pc.logout();
      await pc.destroy();
      this.clients.delete(id);
    }
    this.store.delete(id);
    await this.removeSessionDir(id);
    logger.info({ profileId: id, logout }, 'profile removed');
    return true;
  }

  /** LocalAuth stores each session under `<sessionsDir>/session-<clientId>`. */
  private async removeSessionDir(id: string): Promise<void> {
    const dir = path.join(config.sessionsDir, `session-${id}`);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, dir }, 'failed to remove session dir');
    }
  }

  /** Destroy every client cleanly (graceful shutdown). */
  async destroyAll(): Promise<void> {
    logger.info({ count: this.clients.size }, 'destroying all clients');
    await Promise.allSettled(this.all().map((pc) => pc.destroy()));
    this.clients.clear();
  }
}
