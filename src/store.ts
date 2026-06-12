import Database from 'better-sqlite3';
import { ConnectionState, ProfileRecord } from './types';

interface Row {
  id: string;
  name: string;
  phone_number: string | null;
  state: string;
  last_connected_at: number | null;
  last_error: string | null;
  created_at: number;
}

function toRecord(r: Row): ProfileRecord {
  return {
    id: r.id,
    name: r.name,
    phoneNumber: r.phone_number,
    state: r.state as ConnectionState,
    lastConnectedAt: r.last_connected_at,
    lastError: r.last_error,
    createdAt: r.created_at,
  };
}

/**
 * SQLite-backed profile metadata. Session credentials are NOT stored here —
 * those are managed on disk by whatsapp-web.js LocalAuth.
 */
export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        phone_number      TEXT,
        state             TEXT NOT NULL,
        last_connected_at INTEGER,
        last_error        TEXT,
        created_at        INTEGER NOT NULL
      );
    `);
  }

  create(record: ProfileRecord): void {
    this.db
      .prepare(
        `INSERT INTO profiles (id, name, phone_number, state, last_connected_at, last_error, created_at)
         VALUES (@id, @name, @phoneNumber, @state, @lastConnectedAt, @lastError, @createdAt)`,
      )
      .run(record);
  }

  /** Patch a subset of mutable fields. Unknown/undefined keys are ignored. */
  update(id: string, fields: Partial<Omit<ProfileRecord, 'id' | 'createdAt'>>): void {
    const map: Record<string, string> = {
      name: 'name',
      phoneNumber: 'phone_number',
      state: 'state',
      lastConnectedAt: 'last_connected_at',
      lastError: 'last_error',
    };
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [key, col] of Object.entries(map)) {
      const val = (fields as Record<string, unknown>)[key];
      if (val !== undefined) {
        sets.push(`${col} = @${key}`);
        params[key] = val;
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  get(id: string): ProfileRecord | null {
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  all(): ProfileRecord[] {
    const rows = this.db.prepare('SELECT * FROM profiles ORDER BY created_at ASC').all() as Row[];
    return rows.map(toRecord);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
