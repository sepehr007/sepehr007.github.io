import { dbReady } from "./db.js";
import { getDatabase } from "./database/index.js";

function activeMode() {
  return !dbReady();
}

export async function saveDbSession({ jti, userId, role = "user", ip = "", userAgent = "", expiresAt }) {
  if (!jti || !userId || !activeMode()) return false;
  const db = await getDatabase();
  if (!db) return false;
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (jti, user_id, role, ip, user_agent, created_at, expires_at, last_seen_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(jti) DO UPDATE SET
       role = excluded.role,
       ip = excluded.ip,
       user_agent = excluded.user_agent,
       expires_at = excluded.expires_at,
       revoked_at = NULL`
  ).run(
    String(jti),
    String(userId),
    String(role || "user"),
    String(ip || "").slice(0, 80),
    String(userAgent || "").slice(0, 220),
    now,
    Number(expiresAt) || now + 7 * 24 * 60 * 60 * 1000,
    now
  );
  return true;
}

export async function getDbSession(jti) {
  if (!jti || !activeMode()) return null;
  const db = await getDatabase();
  if (!db) return null;
  const row = db
    .prepare("SELECT * FROM sessions WHERE jti = ? AND revoked_at IS NULL AND expires_at > ?")
    .get(String(jti), Date.now());
  if (!row) return null;
  return {
    userId: String(row.user_id),
    role: row.role || "user",
    ip: row.ip || "",
    ua: row.user_agent || "",
    expiresAt: Number(row.expires_at)
  };
}

export async function touchDbSession(jti) {
  if (!jti || !activeMode()) return false;
  const db = await getDatabase();
  if (!db) return false;
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE jti = ?").run(Date.now(), String(jti));
  return true;
}

export async function revokeDbSession(jti) {
  if (!jti || !activeMode()) return false;
  const db = await getDatabase();
  if (!db) return false;
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL").run(Date.now(), String(jti));
  return true;
}

export async function revokeDbUserSessions(userId) {
  if (!userId || !activeMode()) return 0;
  const db = await getDatabase();
  if (!db) return 0;
  const info = db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(Date.now(), String(userId));
  return Number(info.changes || 0);
}
