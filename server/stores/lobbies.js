import crypto from "node:crypto";
import { getDatabase, transaction } from "../database/index.js";

const LIFETIME_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function toDate(value) {
  return value ? new Date(Number(value)) : null;
}

export function mapLobby(row) {
  if (!row) return null;
  return {
    id: row.id,
    _id: row.id,
    code: row.code,
    owner: row.owner_id,
    ownerUsername: row.owner_username || "",
    name: row.name || "",
    capacity: Number(row.capacity || 6),
    privacy: row.privacy || "public",
    active: Boolean(row.active),
    closeReason: row.close_reason || "",
    closedAt: toDate(row.closed_at),
    lastActivityAt: toDate(row.last_activity_at),
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at)
  };
}

function makeCode() {
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

async function uniqueCode(db) {
  for (let i = 0; i < 10; i++) {
    const code = makeCode();
    const exists = db.prepare("SELECT 1 AS ok FROM lobbies WHERE code = ?").get(code);
    if (!exists) return code;
  }
  return `${makeCode()}${Date.now().toString(36).slice(-2).toUpperCase()}`.slice(0, 16);
}

export async function sqlListLobbies(userId, limit = 25) {
  const db = await getDatabase();
  if (!db) return [];
  const size = Math.min(100, Math.max(1, Number(limit) || 25));
  return db
    .prepare("SELECT * FROM lobbies WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(String(userId), size)
    .map(mapLobby);
}

export async function sqlActiveLobby(userId) {
  const db = await getDatabase();
  if (!db) return null;
  const now = Date.now();
  transaction((conn) => {
    conn
      .prepare("UPDATE lobbies SET active = 0, closed_at = ?, close_reason = 'expired' WHERE owner_id = ? AND active = 1 AND expires_at <= ?")
      .run(now, String(userId), now);
  });
  return mapLobby(
    db
      .prepare("SELECT * FROM lobbies WHERE owner_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1")
      .get(String(userId))
  );
}

export async function sqlCreateLobby({ code, name, capacity, privacy, userId, ownerUsername }) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const now = Date.now();
  const lobbyId = crypto.randomUUID();
  const roomId = crypto.randomUUID();
  const finalCode = String(code || "").toUpperCase() || (await uniqueCode(db));
  transaction((conn) => {
    conn
      .prepare("UPDATE lobbies SET active = 0, closed_at = ?, close_reason = 'replaced' WHERE owner_id = ? AND active = 1")
      .run(now, String(userId));
    conn
      .prepare(
        `INSERT INTO lobbies
         (id, code, owner_id, owner_username, name, capacity, privacy, active, last_activity_at, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(
        lobbyId,
        finalCode,
        String(userId),
        ownerUsername || "",
        name,
        capacity,
        privacy,
        now,
        now + LIFETIME_MS,
        now
      );
    conn
      .prepare(
        `INSERT INTO rooms
         (id, room_code, name, host_id, kind, is_active, privacy, capacity, last_activity_at, created_at)
         VALUES (?, ?, ?, ?, 'lobby', 1, ?, ?, ?, ?)
         ON CONFLICT(room_code) DO UPDATE SET
           name = excluded.name,
           host_id = excluded.host_id,
           kind = 'lobby',
           is_active = 1,
           privacy = excluded.privacy,
           capacity = excluded.capacity,
           member_count = 0,
           last_activity_at = excluded.last_activity_at,
           closed_at = NULL,
           deleted_at = NULL`
      )
      .run(roomId, finalCode, name, String(userId), privacy, capacity, now, now);
    const room = conn.prepare("SELECT id FROM rooms WHERE room_code = ?").get(finalCode);
    conn
      .prepare(
        `INSERT INTO room_settings (room_id, capacity, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET capacity = excluded.capacity, updated_at = excluded.updated_at`
      )
      .run(room.id, capacity, now);
  });
  return mapLobby(db.prepare("SELECT * FROM lobbies WHERE id = ?").get(lobbyId));
}

export async function sqlCloseLobby(code, userId, reason = "closed") {
  const db = await getDatabase();
  if (!db) return null;
  const now = Date.now();
  const upper = String(code || "").toUpperCase();
  transaction((conn) => {
    const info = conn
      .prepare("UPDATE lobbies SET active = 0, closed_at = ?, close_reason = ? WHERE code = ? AND owner_id = ? AND active = 1")
      .run(now, reason, upper, String(userId));
    if (Number(info.changes || 0) > 0) {
      conn
        .prepare("UPDATE rooms SET is_active = 0, closed_at = ? WHERE room_code = ? AND is_active = 1")
        .run(now, upper);
    }
  });
  return mapLobby(
    db.prepare("SELECT * FROM lobbies WHERE code = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1").get(upper, String(userId))
  );
}

export async function sqlTouchLobby(code, userId) {
  const db = await getDatabase();
  if (!db) return null;
  const now = Date.now();
  const upper = String(code || "").toUpperCase();
  const info = db
    .prepare("UPDATE lobbies SET last_activity_at = ?, expires_at = ? WHERE code = ? AND owner_id = ? AND active = 1")
    .run(now, now + LIFETIME_MS, upper, String(userId));
  if (Number(info.changes || 0) > 0) {
    db.prepare("UPDATE rooms SET last_activity_at = ? WHERE room_code = ?").run(now, upper);
  }
  return mapLobby(
    db.prepare("SELECT * FROM lobbies WHERE code = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1").get(upper, String(userId))
  );
}
