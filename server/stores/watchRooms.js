import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { getDatabase, transaction, recordModerationAction } from "../database/index.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const VISIBILITIES = ["public", "unlisted", "private"];
const JOIN_MODES = ["open", "approval", "invite", "password"];
const GUEST_ROLES = ["administrator", "moderator", "member", "guest"];
const ROLE_RANK = { guest: 0, member: 1, moderator: 2, administrator: 3, host: 4 };
const PERM_KEYS = ["video", "queue", "chat", "settings", "invites", "moderation", "remove", "mute", "admin"];
const ROLE_PERMS = {
  host: { video: true, queue: true, chat: true, settings: true, invites: true, moderation: true, remove: true, mute: true, admin: true },
  administrator: { video: true, queue: true, chat: true, settings: true, invites: true, moderation: true, remove: true, mute: true, admin: true },
  moderator: { video: true, queue: true, chat: true, moderation: true, remove: true, mute: true },
  member: {},
  guest: {}
};

const STALE_MS = 24 * 60 * 60 * 1000;
const STALE_MEMBER_MS = 2 * 60 * 60 * 1000;
const STALE_ROOM_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CAPACITY = 48;
const MAX_ICON_BYTES = 300 * 1024;
const ROOM_ACCESS_MS = 30 * 60_000;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MEDIA_URL_RE = /^(https:\/\/|assets\/|data:image\/(png|jpe?g|webp);base64,)/i;

export class RoomError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RoomError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new RoomError(status, code, message);
}

function nowMs() {
  return Date.now();
}

function hasRoomAccess(db, roomCode, userId) {
  const row = db
    .prepare("SELECT expires_at FROM room_access WHERE room_code = ? AND user_id = ?")
    .get(String(roomCode || "").toUpperCase(), String(userId));
  if (!row) return false;
  if (Number(row.expires_at) <= Date.now()) {
    db.prepare("DELETE FROM room_access WHERE room_code = ? AND user_id = ?").run(
      String(roomCode || "").toUpperCase(),
      String(userId)
    );
    return false;
  }
  return true;
}

function grantRoomAccess(db, roomCode, userId) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO room_access (room_code, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(room_code, user_id) DO UPDATE SET
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`
  ).run(String(roomCode || "").toUpperCase(), String(userId), now + ROOM_ACCESS_MS, now);
}

function clearRoomAccess(db, roomCode) {
  db.prepare("DELETE FROM room_access WHERE room_code = ?").run(String(roomCode || "").toUpperCase());
}

function cleanText(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanMultiline(value, max = 2000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function cleanColor(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (!COLOR_RE.test(raw)) fail(400, "invalid_color", "Color must be a hex value like #6c5cff.");
  return raw.toLowerCase();
}

function cleanMediaUrl(value, field) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.length > MAX_ICON_BYTES && raw.startsWith("data:")) {
    fail(413, "image_too_large", "That image is too large. Keep it under 300 KB.");
  }
  if (!MEDIA_URL_RE.test(raw)) {
    fail(400, "invalid_url", `${field} must be an https URL or an uploaded image.`);
  }
  return raw.slice(0, 500000);
}

function cleanCode(value) {
  return cleanText(value, 16).toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

async function conn() {
  const db = await getDatabase();
  if (!db) fail(503, "database_unavailable", "Database is not connected yet.");
  return db;
}

function activeMembers(db, roomId) {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM room_memberships WHERE room_id = ? AND left_at IS NULL")
    .get(String(roomId));
  return Number(row?.n || 0);
}

function mapRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.room_code,
    name: row.name || "",
    description: row.description || "",
    rules: row.rules || "",
    color: row.color || "",
    iconUrl: row.icon_url || "",
    visibility: row.visibility || "public",
    joinMode: row.join_mode || (row.password_hash ? "password" : row.visibility === "private" ? "invite" : "open"),
    hasPassword: Boolean(row.password_hash),
    capacity: Number(row.capacity || 6),
    memberCount: Number(row.active_members ?? row.member_count ?? 0),
    manager: {
      id: row.host_id,
      username: row.manager_username || "",
      nick: row.manager_nick || "",
      avatar: row.manager_avatar || ""
    },
    isActive: Boolean(row.is_active),
    lastActivityAt: Number(row.last_activity_at || 0),
    createdAt: Number(row.created_at || 0),
    closedAt: row.closed_at ? Number(row.closed_at) : null
  };
}

const ROOM_SELECT = `
  SELECT r.*,
    u.username AS manager_username,
    u.nick AS manager_nick,
    u.avatar AS manager_avatar,
    (SELECT COUNT(*) FROM room_memberships m WHERE m.room_id = r.id AND m.left_at IS NULL) AS active_members
  FROM rooms r
  LEFT JOIN users u ON u.id = r.host_id
`;

function roomRow(db, code) {
  return db.prepare(`${ROOM_SELECT} WHERE r.room_code = ?`).get(String(code || "").toUpperCase());
}

function roleRow(db, roomId, userId) {
  return db
    .prepare("SELECT role, permissions_json, left_at FROM room_memberships WHERE room_id = ? AND user_id = ?")
    .get(String(roomId), String(userId));
}

function isStaff(role) {
  return ["moderator", "administrator", "owner", "super_owner"].includes(String(role || ""));
}

function rankOf(role) {
  return ROLE_RANK[String(role || "guest")] ?? 0;
}

function parsePermissions(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function effectivePerms(role, custom = {}) {
  const base = { ...(ROLE_PERMS[String(role || "guest")] || {}) };
  for (const key of PERM_KEYS) {
    if (typeof custom[key] === "boolean") base[key] = custom[key];
  }
  return base;
}

function memberAccess(db, row, userId, staffRole = "") {
  const manager = String(row.host_id) === String(userId) || isStaff(staffRole);
  const member = roleRow(db, row.id, userId);
  const role = manager ? "host" : member && !member.left_at ? member.role : "";
  const perms = effectivePerms(role, parsePermissions(member?.permissions_json));
  return {
    manager,
    member: Boolean(member && !member.left_at),
    role,
    rank: manager ? ROLE_RANK.host : rankOf(role),
    perms: manager ? ROLE_PERMS.host : perms
  };
}

function requireRoomCap(access, cap, message) {
  if (access.manager) return;
  if (!access.perms?.[cap]) fail(403, "forbidden", message);
}

function normalizePermissions(patch = {}) {
  const clean = {};
  for (const key of PERM_KEYS) {
    if (typeof patch[key] === "boolean") clean[key] = patch[key];
  }
  return clean;
}


function touchVisit(db, roomId, userId) {
  const now = nowMs();
  db.prepare(
    `INSERT INTO room_visits (user_id, room_id, last_visited_at, visits)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(user_id, room_id) DO UPDATE SET
       last_visited_at = excluded.last_visited_at,
       visits = room_visits.visits + 1`
  ).run(String(userId), String(roomId), now);
}

function setMemberCount(db, roomId) {
  const count = activeMembers(db, roomId);
  db.prepare("UPDATE rooms SET member_count = ? WHERE id = ?").run(count, String(roomId));
  return count;
}

function addSystemMessage(db, roomId, content, meta = {}) {
  if (!roomId || !content) return;
  db.prepare(
    `INSERT INTO messages (id, room_id, user_id, username, content, type, meta_json, created_at)
     VALUES (?, ?, NULL, '', ?, 'system', ?, ?)`
  ).run(crypto.randomUUID(), String(roomId), String(content).slice(0, 2000), JSON.stringify(meta || {}), nowMs());
}

async function makeCode(db) {
  for (let i = 0; i < 12; i++) {
    const bytes = crypto.randomBytes(6);
    let code = "";
    for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    const hit = db.prepare("SELECT 1 AS ok FROM rooms WHERE room_code = ? UNION SELECT 1 FROM lobbies WHERE code = ? LIMIT 1").get(code, code);
    if (!hit) return code;
  }
  return `R${Date.now().toString(36).slice(-5).toUpperCase()}`;
}

let lastCleanupAt = 0;

export async function cleanupStaleRooms({ force = false } = {}) {
  const db = await getDatabase();
  if (!db) return 0;
  const now = nowMs();
  if (!force && now - lastCleanupAt < 60_000) return 0;
  lastCleanupAt = now;
  const cutoff = now - STALE_MS;
  const maxCutoff = now - STALE_ROOM_MAX_MS;
  const memberCutoff = now - STALE_MEMBER_MS;
  let closed = 0;
  transaction((connection) => {
    connection
      .prepare(
        `UPDATE room_memberships SET left_at = ?
         WHERE left_at IS NULL AND COALESCE(last_seen_at, joined_at) < ?`
      )
      .run(memberCutoff, memberCutoff);
    connection
      .prepare(
        `UPDATE rooms SET member_count = (
           SELECT COUNT(*) FROM room_memberships m WHERE m.room_id = rooms.id AND m.left_at IS NULL
         ) WHERE deleted_at IS NULL`
      )
      .run();
    const stale = connection
      .prepare(
        `SELECT r.id FROM rooms r
         WHERE r.is_active = 1 AND r.deleted_at IS NULL
           AND (
             r.last_activity_at < ?
             OR (r.last_activity_at < ? AND NOT EXISTS (
               SELECT 1 FROM room_memberships m WHERE m.room_id = r.id AND m.left_at IS NULL
             ))
           )`
      )
      .all(maxCutoff, cutoff);
    if (!stale.length) return;
    const markRoom = connection.prepare("UPDATE rooms SET is_active = 0, closed_at = ?, updated_at = ? WHERE id = ?");
    const markInvites = connection.prepare("UPDATE invitations SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL");
    const markRequests = connection.prepare("UPDATE room_join_requests SET status = 'cancelled', decided_at = ? WHERE room_id = ? AND status = 'pending'");
    for (const row of stale) {
      markRoom.run(now, now, row.id);
      markInvites.run(now, row.id);
      markRequests.run(now, row.id);
      closed += 1;
    }
  });
  return closed;
}

export async function maybeCleanup() {
  try {
    await cleanupStaleRooms();
  } catch {}
}

export async function createRoom(userId, staffRole, payload = {}) {
  const db = await conn();
  const name = cleanText(payload.name, 80);
  if (!name) fail(400, "name_required", "Room name is required.");
  const description = cleanMultiline(payload.description, 600);
  const rules = cleanMultiline(payload.rules, 2000);
  const color = cleanColor(payload.color);
  const iconUrl = cleanMediaUrl(payload.iconUrl, "Icon");
  const passwordInput = String(payload.password || "").slice(0, 64);
  let joinMode = JOIN_MODES.includes(payload.joinMode) ? payload.joinMode : "";
  if (!joinMode) {
    joinMode = passwordInput ? "password" : payload.visibility === "private" ? "invite" : "open";
  }
  if (joinMode === "password" && passwordInput.length < 4) {
    fail(400, "weak_password", "Room password must be at least 4 characters.");
  }
  const rawPassword = joinMode === "password" ? passwordInput : "";
  const hasPassword = rawPassword.length >= 4;
  const visibility = joinMode === "invite"
    ? "private"
    : VISIBILITIES.includes(payload.visibility) ? payload.visibility : "public";
  const capacity = Math.max(2, Math.min(MAX_CAPACITY, Math.round(Number(payload.capacity) || 6)));
  const code = cleanCode(payload.code) || (await makeCode(db));
  const passwordHash = hasPassword ? await bcrypt.hash(rawPassword, 10) : "";
  const id = crypto.randomUUID();
  const now = nowMs();
  try {
    transaction((connection) => {
      connection
        .prepare(
          `INSERT INTO rooms
           (id, room_code, name, host_id, kind, is_active, privacy, password_hash, capacity, lang, theme,
            member_count, last_activity_at, created_at, description, rules, icon_url, color, visibility, join_mode, updated_at)
           VALUES (?, ?, ?, ?, 'lobby', 1, ?, ?, ?, 'fa', 'dark', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id, code, name, String(userId), hasPassword ? "password" : "public", passwordHash, capacity,
          now, now, description, rules, iconUrl, color, visibility, joinMode, now
        );
      connection
        .prepare(
          `INSERT INTO room_settings (room_id, capacity, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(room_id) DO UPDATE SET capacity = excluded.capacity, updated_at = excluded.updated_at`
        )
        .run(id, capacity, now);
      connection
        .prepare(
          `INSERT INTO room_memberships (id, room_id, user_id, role, joined_at, last_seen_at)
           VALUES (?, ?, ?, 'host', ?, ?)`
        )
        .run(crypto.randomUUID(), id, String(userId), now, now);
      touchVisit(connection, id, userId);
    });
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE")) fail(409, "already_exists", "That room code is taken. Try another.");
    throw err;
  }
  return getRoom(code, userId, staffRole);
}

export async function getRoom(code, viewerId = "", staffRole = "") {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  const member = viewerId ? roleRow(db, row.id, viewerId) : null;
  const viewerRole = member && !member.left_at ? member.role : "";
  const access = viewerId ? memberAccess(db, row, viewerId, staffRole) : null;
  const canManage = Boolean(access?.manager);
  let viewerRequest = null;
  if (viewerId) {
    const request = db
      .prepare("SELECT status FROM room_join_requests WHERE room_id = ? AND user_id = ?")
      .get(row.id, String(viewerId));
    viewerRequest = request?.status || null;
  }
  const pendingRequests = canManage
    ? Number(
        db
          .prepare("SELECT COUNT(*) AS n FROM room_join_requests WHERE room_id = ? AND status = 'pending'")
          .get(row.id)?.n || 0
      )
    : 0;
  return {
    ...mapRoom(row),
    viewerRole,
    viewerPermissions: access?.perms || {},
    isMember: Boolean(viewerRole),
    viewerRequest,
    pendingRequests,
    canManage,
    canModerate: Boolean(viewerId) && (canManage || Boolean(access?.perms?.moderation))
  };
}

export async function listPublicRooms(viewerId = "", { q = "", limit = 40 } = {}) {
  const db = await conn();
  await maybeCleanup();
  const term = cleanText(q, 60);
  const size = Math.min(60, Math.max(1, Number(limit) || 40));
  const like = `%${term}%`;
  const rows = term
    ? db
        .prepare(
          `${ROOM_SELECT}
           WHERE r.visibility = 'public' AND r.is_active = 1 AND r.deleted_at IS NULL
             AND (r.name LIKE ? OR r.description LIKE ?)
           ORDER BY r.last_activity_at DESC LIMIT ?`
        )
        .all(like, like, size)
    : db
        .prepare(
          `${ROOM_SELECT}
           WHERE r.visibility = 'public' AND r.is_active = 1 AND r.deleted_at IS NULL
           ORDER BY r.last_activity_at DESC LIMIT ?`
        )
        .all(size);
  const joined = new Set();
  if (viewerId) {
    const marks = db
      .prepare("SELECT room_id FROM room_memberships WHERE user_id = ? AND left_at IS NULL")
      .all(String(viewerId));
    for (const mark of marks) joined.add(mark.room_id);
  }
  return rows.map((row) => ({ ...mapRoom(row), joined: joined.has(row.id) }));
}

export async function listMyRooms(userId) {
  const db = await conn();
  const rows = db
    .prepare(
      `${ROOM_SELECT}
       JOIN room_memberships mine ON mine.room_id = r.id
       WHERE mine.user_id = ? AND mine.left_at IS NULL AND r.deleted_at IS NULL
       ORDER BY r.last_activity_at DESC LIMIT 60`
    )
    .all(String(userId));
  return rows.map((row) => ({ ...mapRoom(row), viewerRole: undefined }));
}

export async function listRecentRooms(userId, limit = 12) {
  const db = await conn();
  const size = Math.min(30, Math.max(1, Number(limit) || 12));
  const rows = db
    .prepare(
      `${ROOM_SELECT}
       JOIN room_visits v ON v.room_id = r.id
       WHERE v.user_id = ? AND r.deleted_at IS NULL
       ORDER BY v.last_visited_at DESC LIMIT ?`
    )
    .all(String(userId), size);
  return rows.map((row) => mapRoom(row));
}

export async function joinRoom(userId, staffRole, code, { password = "", inviteCode = "" } = {}) {
  const db = await conn();
  const upper = cleanCode(code);
  const row = roomRow(db, upper);
  if (!row || row.deleted_at) fail(404, "room_not_found", "That room does not exist.");
  if (!row.is_active) fail(410, "room_closed", "This room has been closed.");

  let member = roleRow(db, row.id, userId);
  const staff = isStaff(staffRole);
  const alreadyIn = Boolean(member && !member.left_at);
  let grantedByInvite = false;

  if (!alreadyIn && inviteCode) {
    const { sqlAcceptInvite } = await import("./social.js");
    const accepted = await sqlAcceptInvite(userId, inviteCode);
    if (accepted.roomCode && accepted.roomCode !== row.room_code) {
      fail(403, "invite_mismatch", "That invite belongs to a different room.");
    }
    grantedByInvite = true;
    member = roleRow(db, row.id, userId);
  }

  const hostAllowed = String(row.host_id) === String(userId);
  const joinMode = row.join_mode
    || (row.password_hash ? "password" : row.visibility === "private" ? "invite" : "open");
  if (!grantedByInvite && !staff && !hostAllowed) {
    if (!alreadyIn && joinMode === "invite") {
      fail(403, "invite_required", "This room is invitation-only. Ask the Manager for an invite link.");
    }
    if (!alreadyIn && joinMode === "approval") {
      const request = db
        .prepare("SELECT status FROM room_join_requests WHERE room_id = ? AND user_id = ?")
        .get(row.id, String(userId));
      if (request?.status !== "approved") {
        if (request?.status === "pending") {
          fail(403, "approval_pending", "Your join request is waiting for the Manager's approval.");
        }
        fail(403, "approval_required", "This room needs the Manager's approval before you can join.");
      }
    }
    if (joinMode === "password" && row.password_hash) {
      const supplied = String(password || "");
      let ok = false;
      if (supplied) {
        ok = await bcrypt.compare(supplied, row.password_hash);
        if (ok) grantRoomAccess(db, row.room_code, userId);
      } else {
        ok = hasRoomAccess(db, row.room_code, userId);
      }
      if (!ok) fail(403, "wrong_password", "The room password is incorrect.");
    }
  }
  if (!alreadyIn && !grantedByInvite && !staff && !hostAllowed) {
    if (activeMembers(db, row.id) >= Number(row.capacity || 6)) {
      fail(409, "room_full", "This room is full right now.");
    }
  }

  const now = nowMs();
  let role = member && !member.left_at ? member.role : "guest";
  if (String(row.host_id) === String(userId)) role = "host";
  transaction((connection) => {
    connection
      .prepare(
        `INSERT INTO room_memberships (id, room_id, user_id, role, joined_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id, user_id) DO UPDATE SET
           left_at = NULL,
           last_seen_at = excluded.last_seen_at,
           role = CASE WHEN room_memberships.role = 'host' THEN 'host' ELSE room_memberships.role END`
      )
      .run(crypto.randomUUID(), row.id, String(userId), role, now, now);
    setMemberCount(connection, row.id);
    connection.prepare("UPDATE rooms SET last_activity_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.id);
    touchVisit(connection, row.id, userId);
  });
  const fresh = roomRow(db, upper);
  return {
    room: mapRoom(fresh),
    role,
    memberCount: Number(fresh.active_members || 0)
  };
}

export async function leaveRoom(userId, code) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  if (String(row.host_id) === String(userId)) {
    fail(409, "transfer_required", "Transfer management to another member before leaving.");
  }
  const now = nowMs();
  db.prepare("UPDATE room_memberships SET left_at = ? WHERE room_id = ? AND user_id = ? AND left_at IS NULL").run(
    now,
    row.id,
    String(userId)
  );
  const count = setMemberCount(db, row.id);
  db.prepare("UPDATE rooms SET last_activity_at = ? WHERE id = ?").run(now, row.id);
  return { ok: true, memberCount: count, roomId: row.id, roomCode: row.room_code };
}

export async function requestJoin(userId, code, note = "") {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row || row.deleted_at) fail(404, "room_not_found", "That room does not exist.");
  if (!row.is_active) fail(410, "room_closed", "This room has been closed.");
  if (String(row.host_id) === String(userId)) fail(409, "is_manager", "You already manage this room.");
  const joinMode = row.join_mode || "open";
  if (joinMode !== "approval") fail(400, "approval_not_needed", "This room does not use join requests.");
  const member = roleRow(db, row.id, userId);
  if (member && !member.left_at) fail(409, "already_member", "You are already a member of this room.");
  const existing = db
    .prepare("SELECT status FROM room_join_requests WHERE room_id = ? AND user_id = ?")
    .get(row.id, String(userId));
  if (existing?.status === "approved" || existing?.status === "pending") {
    return { status: existing.status, room: mapRoom(row) };
  }
  if (activeMembers(db, row.id) >= Number(row.capacity || 6)) {
    fail(409, "room_full", "This room is full right now.");
  }
  const now = nowMs();
  db.prepare(
    `INSERT INTO room_join_requests (id, room_id, user_id, status, note, created_at, decided_at, decided_by)
     VALUES (?, ?, ?, 'pending', ?, ?, NULL, NULL)
     ON CONFLICT(room_id, user_id) DO UPDATE SET
       status = 'pending',
       note = excluded.note,
       created_at = excluded.created_at,
       decided_at = NULL,
       decided_by = NULL`
  ).run(crypto.randomUUID(), row.id, String(userId), cleanText(note, 200), now);
  return { status: "pending", room: mapRoom(roomRow(db, code)) };
}

export async function myJoinRequest(userId, code) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  const request = db
    .prepare("SELECT status, created_at, decided_at FROM room_join_requests WHERE room_id = ? AND user_id = ?")
    .get(row.id, String(userId));
  return request
    ? { status: request.status, requestedAt: Number(request.created_at || 0), decidedAt: request.decided_at ? Number(request.decided_at) : null }
    : { status: null };
}

export async function listJoinRequests(userId, staffRole, code) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  const access = memberAccess(db, row, userId, staffRole);
  requireRoomCap(access, "moderation", "Only the Manager or an authorized moderator can review join requests.");
  const rows = db
    .prepare(
      `SELECT q.user_id, q.status, q.note, q.created_at, u.username, u.nick, u.avatar
       FROM room_join_requests q
       JOIN users u ON u.id = q.user_id
       WHERE q.room_id = ? AND q.status = 'pending' AND u.deleted_at IS NULL
       ORDER BY q.created_at ASC LIMIT 100`
    )
    .all(row.id);
  return rows.map((item) => ({
    userId: item.user_id,
    username: item.username || "",
    nick: item.nick || "",
    avatar: item.avatar || "",
    note: item.note || "",
    requestedAt: Number(item.created_at || 0)
  }));
}

export async function decideJoinRequest(userId, staffRole, code, targetId, decision) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  const access = memberAccess(db, row, userId, staffRole);
  requireRoomCap(access, "moderation", "Only the Manager or an authorized moderator can review join requests.");
  if (!["approve", "deny"].includes(decision)) fail(400, "invalid_decision", "Decision must be approve or deny.");
  const target = db
    .prepare("SELECT status FROM room_join_requests WHERE room_id = ? AND user_id = ?")
    .get(row.id, String(targetId));
  if (!target || target.status !== "pending") fail(404, "request_missing", "That join request is no longer pending.");
  const next = decision === "approve" ? "approved" : "denied";
  const now = nowMs();
  db.prepare(
    "UPDATE room_join_requests SET status = ?, decided_at = ?, decided_by = ? WHERE room_id = ? AND user_id = ?"
  ).run(next, now, String(userId), row.id, String(targetId));
  addSystemMessage(db, row.id, decision === "approve" ? "A join request was approved." : "A join request was declined.", {
    event: "room.request",
    target: String(targetId),
    decision
  });
  db.prepare("UPDATE rooms SET last_activity_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.id);
  return { ok: true, status: next };
}

export async function touchRoom(userId, code) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row || !row.is_active) return null;
  const now = nowMs();
  const member = roleRow(db, row.id, userId);
  if (member && !member.left_at) {
    db.prepare("UPDATE room_memberships SET last_seen_at = ? WHERE room_id = ? AND user_id = ?").run(now, row.id, String(userId));
    touchVisit(db, row.id, userId);
  }
  db.prepare("UPDATE rooms SET last_activity_at = ? WHERE id = ?").run(now, row.id);
  return { ok: true, lastActivityAt: now };
}

export async function listMembers(code) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  const rows = db
    .prepare(
      `SELECT m.user_id, m.role, m.permissions_json, m.joined_at, m.last_seen_at, u.username, u.nick, u.avatar
       FROM room_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.room_id = ? AND m.left_at IS NULL AND u.deleted_at IS NULL
       ORDER BY CASE m.role WHEN 'host' THEN 0 WHEN 'administrator' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, m.joined_at ASC`
    )
    .all(row.id);
  return rows.map((member) => ({
    userId: member.user_id,
    role: member.role,
    permissions: effectivePerms(member.role, parsePermissions(member.permissions_json)),
    username: member.username || "",
    nick: member.nick || "",
    avatar: member.avatar || "",
    joinedAt: Number(member.joined_at || 0),
    lastSeenAt: member.last_seen_at ? Number(member.last_seen_at) : null
  }));
}

export async function updateRoom(userId, staffRole, code, patch = {}) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  const access = memberAccess(db, row, userId, staffRole);
  requireRoomCap(access, "settings", "Only the Manager or an authorized administrator can change room settings.");
  if (!row.is_active) fail(410, "room_closed", "This room has been closed.");

  const sets = [];
  const values = [];
  const push = (column, value) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.name !== undefined) {
    const name = cleanText(patch.name, 80);
    if (!name) fail(400, "name_required", "Room name is required.");
    push("name", name);
  }
  if (patch.description !== undefined) push("description", cleanMultiline(patch.description, 600));
  if (patch.rules !== undefined) push("rules", cleanMultiline(patch.rules, 2000));
  if (patch.color !== undefined) push("color", cleanColor(patch.color));
  if (patch.iconUrl !== undefined) push("icon_url", cleanMediaUrl(patch.iconUrl, "Icon"));
  let joinModeValue = null;
  if (patch.joinMode !== undefined) {
    if (!JOIN_MODES.includes(patch.joinMode)) {
      fail(400, "invalid_join_mode", "Join mode must be open, approval, invite or password.");
    }
    joinModeValue = patch.joinMode;
    push("join_mode", joinModeValue);
  }
  let nextVisibility = null;
  if (joinModeValue === "invite") {
    nextVisibility = "private";
  } else if (patch.visibility !== undefined) {
    if (!VISIBILITIES.includes(patch.visibility)) fail(400, "invalid_visibility", "Visibility must be public, unlisted or private.");
    nextVisibility = patch.visibility;
  } else if (joinModeValue && row.visibility === "private") {
    nextVisibility = "public";
  }
  if (nextVisibility) push("visibility", nextVisibility);
  if (patch.capacity !== undefined) {
    const capacity = Math.max(2, Math.min(MAX_CAPACITY, Math.round(Number(patch.capacity) || 6)));
    push("capacity", capacity);
  }
  const passwordTouched = patch.password !== undefined || joinModeValue === "password";
  if (passwordTouched) {
    const raw = String(patch.password || "").slice(0, 64);
    const wantsPassword = joinModeValue ? joinModeValue === "password" : Boolean(raw);
    if (wantsPassword) {
      if (raw.length < 4) fail(400, "weak_password", "Room password must be at least 4 characters.");
      push("password_hash", await bcrypt.hash(raw, 10));
      push("privacy", "password");
      if (!joinModeValue) push("join_mode", "password");
    } else {
      push("password_hash", "");
      push("privacy", "public");
      if (!joinModeValue) push("join_mode", "open");
    }
    clearRoomAccess(db, row.room_code);
  } else if (joinModeValue && joinModeValue !== "password") {
    push("password_hash", "");
    push("privacy", "public");
    clearRoomAccess(db, row.room_code);
  }
  if (!sets.length) return getRoom(code, userId, staffRole);

  const now = nowMs();
  sets.push("updated_at = ?", "last_activity_at = ?");
  values.push(now, now);
  values.push(row.id);
  db.prepare(`UPDATE rooms SET ${sets.join(", ")} WHERE id = ?`).run(...values);

  if (patch.capacity !== undefined) {
    const capacity = Math.max(2, Math.min(MAX_CAPACITY, Math.round(Number(patch.capacity) || 6)));
    db.prepare(
      `INSERT INTO room_settings (room_id, capacity, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET capacity = excluded.capacity, updated_at = excluded.updated_at`
    ).run(row.id, capacity, now);
  }
  addSystemMessage(db, row.id, "Room settings were updated.", { event: "room.updated", by: userId });
  return getRoom(code, userId, staffRole);
}

export async function setMemberRole(userId, staffRole, code, targetId, role, permissions) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  if (!GUEST_ROLES.includes(role)) fail(400, "invalid_role", "Role must be administrator, moderator, member or guest.");
  if (String(targetId) === String(row.host_id)) fail(409, "is_manager", "Use transfer instead of changing the Manager's role.");
  const member = roleRow(db, row.id, targetId);
  if (!member || member.left_at) fail(404, "not_member", "That user is not in this room.");
  const access = memberAccess(db, row, userId, staffRole);
  if (!access.manager) {
    if (!access.perms.admin) fail(403, "forbidden", "Only the Manager or an administrator can change member roles.");
    if (rankOf(member.role) >= access.rank || rankOf(role) >= access.rank) {
      fail(403, "forbidden", "You can only change roles below your own level.");
    }
  }
  const now = nowMs();
  const cleanPerms = permissions && typeof permissions === "object" ? normalizePermissions(permissions) : null;
  if (cleanPerms) {
    db.prepare("UPDATE room_memberships SET role = ?, permissions_json = ? WHERE room_id = ? AND user_id = ?").run(
      role,
      JSON.stringify(cleanPerms),
      row.id,
      String(targetId)
    );
  } else {
    db.prepare("UPDATE room_memberships SET role = ? WHERE room_id = ? AND user_id = ?").run(role, row.id, String(targetId));
  }
  db.prepare("UPDATE rooms SET last_activity_at = ? WHERE id = ?").run(now, row.id);
  addSystemMessage(db, row.id, `A member's role changed to ${role}.`, { event: "member.role", target: String(targetId), role });
  recordModerationAction({
    moderatorId: userId,
    action: "role_change",
    targetType: "room_member",
    targetId,
    roomCode: row.room_code,
    reason: `role ${member.role} -> ${role}`,
    meta: { from: member.role, to: role, permissions: cleanPerms || undefined }
  });
  return { ok: true, role, permissions: effectivePerms(role, cleanPerms || parsePermissions(member.permissions_json)) };
}

export async function setMemberPermissions(userId, staffRole, code, targetId, permissions) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  if (String(targetId) === String(row.host_id)) fail(409, "is_manager", "The Manager always keeps every permission.");
  const member = roleRow(db, row.id, targetId);
  if (!member || member.left_at) fail(404, "not_member", "That user is not in this room.");
  const access = memberAccess(db, row, userId, staffRole);
  if (!access.manager) {
    if (!access.perms.admin) fail(403, "forbidden", "Only the Manager or an administrator can edit permissions.");
    if (rankOf(member.role) >= access.rank) fail(403, "forbidden", "You can only edit members below your own level.");
  }
  const cleanPerms = normalizePermissions(permissions || {});
  db.prepare("UPDATE room_memberships SET permissions_json = ? WHERE room_id = ? AND user_id = ?").run(
    JSON.stringify(cleanPerms),
    row.id,
    String(targetId)
  );
  const now = nowMs();
  db.prepare("UPDATE rooms SET last_activity_at = ? WHERE id = ?").run(now, row.id);
  addSystemMessage(db, row.id, "A member's permissions were updated.", { event: "member.perms", target: String(targetId) });
  recordModerationAction({
    moderatorId: userId,
    action: "permission_change",
    targetType: "room_member",
    targetId,
    roomCode: row.room_code,
    reason: "permissions updated",
    meta: { permissions: cleanPerms }
  });
  return { ok: true, permissions: effectivePerms(member.role, cleanPerms) };
}

export async function muteMember(userId, staffRole, code, targetId, muted = true) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  if (String(targetId) === String(row.host_id)) fail(409, "is_manager", "The Manager can't be muted.");
  const member = roleRow(db, row.id, targetId);
  if (!member || member.left_at) fail(404, "not_member", "That user is not in this room.");
  const access = memberAccess(db, row, userId, staffRole);
  requireRoomCap(access, "mute", "You don't have permission to mute members.");
  if (!access.manager && rankOf(member.role) >= access.rank) fail(403, "forbidden", "You can't mute someone at or above your level.");
  const until = muted ? nowMs() + 24 * 60 * 60_000 : null;
  db.prepare("UPDATE room_memberships SET muted_until = ? WHERE room_id = ? AND user_id = ?").run(until, row.id, String(targetId));
  recordModerationAction({
    moderatorId: userId,
    action: muted ? "mute" : "unmute",
    targetType: "room_member",
    targetId,
    roomCode: row.room_code,
    reason: muted ? "muted in room" : "unmuted in room"
  });
  return { ok: true, muted };
}

export async function kickMember(userId, staffRole, code, targetId) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  if (String(targetId) === String(row.host_id)) fail(409, "is_manager", "The Manager can't be removed. Transfer management first.");
  if (String(targetId) === String(userId)) fail(400, "self_kick", "You can't remove yourself.");
  const member = roleRow(db, row.id, targetId);
  if (!member || member.left_at) fail(404, "not_member", "That user is not in this room.");
  const access = memberAccess(db, row, userId, staffRole);
  requireRoomCap(access, "remove", "Only the Manager or an authorized moderator can remove members.");
  if (!access.manager && rankOf(member.role) >= access.rank) {
    fail(403, "forbidden", "You can't remove someone at or above your level.");
  }
  const now = nowMs();
  db.prepare("UPDATE room_memberships SET left_at = ? WHERE room_id = ? AND user_id = ?").run(now, row.id, String(targetId));
  const count = setMemberCount(db, row.id);
  db.prepare("UPDATE rooms SET last_activity_at = ? WHERE id = ?").run(now, row.id);
  addSystemMessage(db, row.id, "A member was removed from the room.", { event: "member.removed", target: String(targetId), by: String(userId) });
  recordModerationAction({
    moderatorId: userId,
    action: "kick",
    targetType: "room_member",
    targetId,
    roomCode: row.room_code,
    reason: "removed from room"
  });
  return { ok: true, memberCount: count };
}

export async function transferManager(userId, staffRole, code, { targetId, password } = {}) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  const isCurrent = String(row.host_id) === String(userId);
  if (!isCurrent && !isStaff(staffRole)) fail(403, "forbidden", "Only the Manager can transfer management.");
  if (!targetId) fail(400, "target_required", "Choose the member who becomes the new Manager.");
  if (String(targetId) === String(row.host_id)) fail(409, "is_manager", "That member is already the Manager.");

  const account = db.prepare("SELECT id, password_hash FROM users WHERE id = ? AND deleted_at IS NULL").get(String(userId));
  const ok = account?.password_hash ? await bcrypt.compare(String(password || ""), account.password_hash) : false;
  if (!ok) fail(403, "wrong_password", "Enter your account password to confirm the transfer.");

  const target = roleRow(db, row.id, targetId);
  if (!target || target.left_at) fail(409, "not_member", "The new Manager must be a member of this room right now.");
  const targetUser = db.prepare("SELECT id, username, nick FROM users WHERE id = ? AND deleted_at IS NULL").get(String(targetId));
  if (!targetUser) fail(404, "user_not_found", "That account is not available.");

  const now = nowMs();
  transaction((connection) => {
    connection.prepare("UPDATE rooms SET host_id = ?, updated_at = ?, last_activity_at = ? WHERE id = ?").run(
      String(targetId),
      now,
      now,
      row.id
    );
    connection
      .prepare("UPDATE room_memberships SET role = 'member' WHERE room_id = ? AND user_id = ? AND role = 'host'")
      .run(row.id, String(userId));
    connection
      .prepare(
        `UPDATE room_memberships SET role = 'host', left_at = NULL WHERE room_id = ? AND user_id = ?`
      )
      .run(row.id, String(targetId));
    addSystemMessage(connection, row.id, `Management was transferred to ${targetUser.nick || targetUser.username}.`, {
      event: "manager.transfer",
      from: String(userId),
      to: String(targetId)
    });
  });

  return {
    room: await getRoom(code, targetId, ""),
    from: userId,
    to: { id: targetUser.id, username: targetUser.username, nick: targetUser.nick || "" }
  };
}

export async function closeRoom(userId, staffRole, code, { password } = {}) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  if (String(row.host_id) !== String(userId) && !isStaff(staffRole)) {
    fail(403, "forbidden", "Only the Manager can close this room.");
  }
  const account = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(String(userId));
  const ok = account?.password_hash ? await bcrypt.compare(String(password || ""), account.password_hash) : false;
  if (!ok) fail(403, "wrong_password", "Enter your account password to close the room.");

  const now = nowMs();
  transaction((connection) => {
    connection
      .prepare("UPDATE rooms SET is_active = 0, closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?")
      .run(now, String(userId), now, row.id);
    connection.prepare("UPDATE room_memberships SET left_at = ? WHERE room_id = ? AND left_at IS NULL").run(now, row.id);
    connection.prepare("UPDATE room_memberships SET left_at = NULL, role = 'host' WHERE room_id = ? AND user_id = ?").run(row.id, String(row.host_id));
    connection.prepare("UPDATE invitations SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL").run(now, row.id);
    connection.prepare("UPDATE room_join_requests SET status = 'cancelled', decided_at = ? WHERE room_id = ? AND status = 'pending'").run(now, row.id);
    connection.prepare("UPDATE room_access SET expires_at = ? WHERE room_code = ?").run(now, row.room_code);
    connection.prepare("UPDATE rooms SET member_count = 1 WHERE id = ?").run(row.id);
    addSystemMessage(connection, row.id, "The room was closed by the Manager.", { event: "room.closed", by: String(userId) });
  });
  recordModerationAction({
    moderatorId: userId,
    action: "room_close",
    targetType: "room",
    targetId: row.id,
    roomCode: row.room_code,
    reason: "closed by manager"
  });
  return { ok: true };
}

export async function forceCloseRoom(code, byId = "") {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) return { ok: true, room: null };
  if (!row.is_active) return { ok: true, room: mapRoom(row) };
  const now = nowMs();
  transaction((connection) => {
    connection
      .prepare("UPDATE rooms SET is_active = 0, closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?")
      .run(now, String(byId || ""), now, row.id);
    connection.prepare("UPDATE room_memberships SET left_at = ? WHERE room_id = ? AND left_at IS NULL").run(now, row.id);
    connection.prepare("UPDATE room_memberships SET left_at = NULL, role = 'host' WHERE room_id = ? AND user_id = ?").run(row.id, String(row.host_id));
    connection.prepare("UPDATE invitations SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL").run(now, row.id);
    connection.prepare("UPDATE room_join_requests SET status = 'cancelled', decided_at = ? WHERE room_id = ? AND status = 'pending'").run(now, row.id);
    connection.prepare("UPDATE room_access SET expires_at = ? WHERE room_code = ?").run(now, row.room_code);
    connection.prepare("UPDATE rooms SET member_count = 1 WHERE id = ?").run(row.id);
    addSystemMessage(connection, row.id, "The room was closed by the site owner.", { event: "room.closed", by: String(byId || "") });
  });
  return { ok: true, room: { ...mapRoom(roomRow(db, code)), hostId: row.host_id } };
}

export async function deleteRoom(userId, staffRole, code) {
  const db = await conn();
  const row = roomRow(db, code);
  if (!row) fail(404, "room_not_found", "That room does not exist.");
  if (String(row.host_id) !== String(userId) && !isStaff(staffRole)) {
    fail(403, "forbidden", "Only the Manager or the site owner can delete this room.");
  }
  const now = nowMs();
  transaction((connection) => {
    connection
      .prepare(
        `UPDATE rooms SET is_active = 0, deleted_at = ?, deleted_by = ?, closed_at = COALESCE(closed_at, ?), updated_at = ?
         WHERE id = ?`
      )
      .run(now, String(userId), now, now, row.id);
    connection.prepare("UPDATE room_memberships SET left_at = ? WHERE room_id = ? AND left_at IS NULL").run(now, row.id);
    connection.prepare("UPDATE invitations SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL").run(now, row.id);
    connection.prepare("UPDATE room_join_requests SET status = 'cancelled', decided_at = ? WHERE room_id = ? AND status = 'pending'").run(now, row.id);
    connection.prepare("DELETE FROM room_access WHERE room_code = ?").run(row.room_code);
    connection.prepare("UPDATE rooms SET member_count = 0 WHERE id = ?").run(row.id);
  });
  recordModerationAction({
    moderatorId: userId,
    action: "room_delete",
    targetType: "room",
    targetId: row.id,
    roomCode: row.room_code,
    reason: "room deleted"
  });
  return { ok: true, code: row.room_code, name: row.name, hostId: row.host_id };
}
