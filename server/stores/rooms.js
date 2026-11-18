import crypto from "node:crypto";
import { getDatabase } from "../database/index.js";

function safeJson(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id || "",
    username: row.username || "",
    content: row.content,
    type: row.type || "text",
    meta: safeJson(row.meta_json),
    createdAt: new Date(Number(row.created_at))
  };
}

export async function sqlFindRoomByCode(code) {
  const db = await getDatabase();
  if (!db) return null;
  const row = db
    .prepare("SELECT id, room_code, name, host_id, is_active FROM rooms WHERE room_code = ? AND deleted_at IS NULL")
    .get(String(code || "").toUpperCase());
  if (!row) return null;
  return { id: row.id, roomCode: row.room_code, name: row.name, hostId: row.host_id, isActive: Boolean(row.is_active) };
}

export async function sqlRecentMessages(roomId, limit = 50) {
  const db = await getDatabase();
  if (!db) return [];
  const size = Math.min(200, Math.max(1, Number(limit) || 50));
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE room_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(String(roomId), size);
  return rows.reverse().map(mapMessage);
}

export async function sqlAddMessage({ roomId, userId = null, username = "", content, type = "text", meta = {} }) {
  const db = await getDatabase();
  if (!db) return null;
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO messages (id, room_id, user_id, username, content, type, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, String(roomId), userId ? String(userId) : null, username || "", content, type, JSON.stringify(meta || {}), now);
  return mapMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(id));
}

export async function sqlSavePlaybackState({ roomId, mediaUrl = "", mediaType = "", position = 0, paused = true, rate = 1, userId = null }) {
  const db = await getDatabase();
  if (!db) return false;
  const value = Number(position);
  db.prepare(
    `INSERT INTO playback_states (room_id, media_url, media_type, position, paused, rate, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(room_id) DO UPDATE SET
       media_url = excluded.media_url,
       media_type = excluded.media_type,
       position = excluded.position,
       paused = excluded.paused,
       rate = excluded.rate,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).run(
    String(roomId),
    String(mediaUrl || "").slice(0, 2000),
    String(mediaType || "").slice(0, 40),
    Number.isFinite(value) && value > 0 ? value : 0,
    paused ? 1 : 0,
    Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 1,
    userId ? String(userId) : null,
    Date.now()
  );
  return true;
}
