import crypto from "node:crypto";
import { getDatabase, transaction, pageLimit, recordModerationAction } from "../database/index.js";

export const STAFF_ROLES = Object.freeze(["moderator", "administrator", "owner", "super_owner"]);
const LIBRARY_KINDS = ["saved", "favorite", "recent", "upload", "subtitle"];
const REPORT_TARGETS = ["user", "message", "room", "server", "content", "activity"];
const REPORT_STATUSES = ["open", "reviewing", "resolved", "dismissed"];
const REQUEST_STATUSES = ["pending", "accepted", "rejected", "cancelled"];
const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"];
const TICKET_STATUSES = ["open", "pending", "resolved", "closed"];
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const HISTORY_CAP = 200;
const LIBRARY_CAP = 300;
const DM_PAGE_MAX = 50;

export class SocialError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "SocialError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new SocialError(status, code, message);
}

export function isStaff(role) {
  return STAFF_ROLES.includes(String(role || ""));
}

function nowMs() {
  return Date.now();
}

function safeJson(raw, fallback = {}) {
  try {
    const value = JSON.parse(raw || "");
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function cleanText(value, max = 200) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function likeArg(value) {
  return `%${String(value || "").replace(/[\\%_]/g, "\\$&")}%`;
}

function pair(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? [left, right] : [right, left];
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegative(value, fallback = 0) {
  return Math.max(0, toNumber(value, fallback));
}

async function conn() {
  const db = await getDatabase();
  if (!db) fail(503, "database_unavailable", "Database is not connected yet.");
  return db;
}

export function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    nick: row.nick || row.username,
    avatar: row.avatar || "",
    lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null
  };
}

export async function sqlTouchUser(userId) {
  const db = await getDatabase();
  if (!db) return false;
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(nowMs(), String(userId));
  return true;
}

function userRowById(db, userId) {
  return db
    .prepare("SELECT id, username, username_lower, nick, avatar, role, status, last_seen_at FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(String(userId));
}

function userRowByUsername(db, username) {
  const name = cleanText(username, 24);
  if (!name) return null;
  return db
    .prepare("SELECT id, username, username_lower, nick, avatar, role, status, last_seen_at FROM users WHERE username_lower = ? AND deleted_at IS NULL")
    .get(name.toLowerCase());
}

function requireUser(db, userId) {
  const row = userRowById(db, userId);
  if (!row) fail(404, "user_not_found", "That account does not exist.");
  return row;
}

function requireTargetUser(db, username, selfId) {
  const row = userRowByUsername(db, username);
  if (!row) fail(404, "user_not_found", "That account does not exist.");
  if (String(row.id) === String(selfId)) fail(400, "invalid_target", "You cannot do that to yourself.");
  return row;
}

function isBlockedBetween(db, a, b) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS hit FROM blocks
         WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
         LIMIT 1`
      )
      .get(String(a), String(b), String(b), String(a))
  );
}

function assertNotBlocked(db, a, b) {
  if (isBlockedBetween(db, a, b)) fail(403, "blocked", "Interaction is blocked between these accounts.");
}

function isFriend(db, a, b) {
  const [x, y] = pair(a, b);
  return Boolean(db.prepare("SELECT 1 AS hit FROM friendships WHERE user_a = ? AND user_b = ?").get(x, y));
}

function friendshipRequest(db, fromUser, toUser) {
  return db
    .prepare(
      `SELECT * FROM friend_requests
       WHERE from_user = ? AND to_user = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(String(fromUser), String(toUser));
}

/* ------------------------------------------------------------------ people */

export async function sqlFindUserByUsername(username) {
  const db = await conn();
  const row = userRowByUsername(db, username);
  return row ? mapUser(row) : null;
}

export async function sqlListPeople(userId, q = "", limit = 20) {
  const db = await conn();
  const size = pageLimit(limit, 20, 50);
  const term = cleanText(q, 80);
  const base = `
    SELECT u.id, u.username, u.nick, u.avatar,
      CASE
        WHEN p.user_id IS NULL THEN u.last_seen_at
        WHEN p.last_active_visibility = 'nobody' THEN NULL
        WHEN p.last_active_visibility = 'friends'
          AND NOT EXISTS(SELECT 1 FROM friendships f2 WHERE (f2.user_a = ? AND f2.user_b = u.id) OR (f2.user_a = u.id AND f2.user_b = ?))
          THEN NULL
        ELSE u.last_seen_at
      END AS last_seen_at,
      EXISTS(SELECT 1 FROM friendships f WHERE (f.user_a = ? AND f.user_b = u.id) OR (f.user_a = u.id AND f.user_b = ?)) AS is_friend,
      EXISTS(SELECT 1 FROM friend_requests r WHERE r.from_user = ? AND r.to_user = u.id AND r.status = 'pending') AS pending_out,
      EXISTS(SELECT 1 FROM friend_requests r WHERE r.from_user = u.id AND r.to_user = ? AND r.status = 'pending') AS pending_in,
      EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?)) AS blocked
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE u.id <> ? AND u.deleted_at IS NULL AND u.status = 'active'
      AND COALESCE(p.visibility, 'public') = 'public'`;
  const params = [userId, userId, userId, userId, userId, userId, userId, userId, userId];
  let sql = base;
  if (term) {
    sql += " AND (u.username_lower LIKE ? ESCAPE '\\' OR lower(u.nick) LIKE ? ESCAPE '\\')";
    params.push(likeArg(term.toLowerCase()), likeArg(term.toLowerCase()));
  }
  sql += " ORDER BY u.username_lower ASC LIMIT ?";
  params.push(size);
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => ({
      ...mapUser(row),
      isFriend: Boolean(row.is_friend),
      requestPending: Boolean(row.pending_out),
      requestIncoming: Boolean(row.pending_in),
      blocked: Boolean(row.blocked)
    }));
}

export async function sqlListFriends(userId) {
  const db = await conn();
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.nick, u.avatar, f.created_at AS friend_since,
         CASE WHEN p.last_active_visibility = 'nobody' THEN NULL ELSE u.last_seen_at END AS last_seen_at
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE (f.user_a = ? OR f.user_b = ?) AND u.deleted_at IS NULL
       ORDER BY u.username_lower ASC`
    )
    .all(String(userId), String(userId), String(userId));
  return rows.map((row) => ({ ...mapUser(row), friendSince: Number(row.friend_since || 0) }));
}

export async function sqlListFriendRequests(userId) {
  const db = await conn();
  const rows = db
    .prepare(
      `SELECT * FROM friend_requests
       WHERE (to_user = ? OR from_user = ?) AND status = 'pending'
       ORDER BY created_at DESC LIMIT 100`
    )
    .all(String(userId), String(userId));
  const users = new Map();
  const summary = (id) => {
    if (!users.has(id)) users.set(id, mapUser(userRowById(db, id)));
    return users.get(id);
  };
  return rows.map((row) => ({
    id: row.id,
    from: summary(row.from_user),
    to: summary(row.to_user),
    message: row.message || "",
    status: row.status,
    createdAt: Number(row.created_at || 0),
    respondedAt: row.responded_at ? Number(row.responded_at) : null,
    incoming: String(row.to_user) === String(userId)
  }));
}

export async function sqlSendFriendRequest(userId, username, message = "") {
  const db = await conn();
  const target = requireTargetUser(db, username, userId);
  const me = requireUser(db, userId);
  assertNotBlocked(db, userId, target.id);
  const privacy = db.prepare("SELECT visibility FROM profiles WHERE user_id = ?").get(String(target.id));
  if (privacy?.visibility === "private") {
    fail(403, "private_profile", "This user's profile is private and does not accept friend requests.");
  }
  if (isFriend(db, userId, target.id)) fail(409, "already_friends", "You are already friends.");
  if (friendshipRequest(db, userId, target.id)) fail(409, "request_pending", "A friend request is already pending.");
  if (friendshipRequest(db, target.id, userId)) fail(409, "request_pending", "They already sent you a friend request. Check your requests.");
  const id = crypto.randomUUID();
  const now = nowMs();
  const body = cleanText(message, 300);
  try {
    db.prepare(
      `INSERT INTO friend_requests (id, from_user, to_user, message, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    ).run(id, String(userId), String(target.id), body, now);
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE")) {
      fail(409, "request_pending", "A friend request is already pending.");
    }
    throw err;
  }
  return {
    id,
    from: mapUser(me),
    to: mapUser(target),
    message: body,
    status: "pending",
    createdAt: now
  };
}

export async function sqlRespondFriendRequest(userId, requestId, accept) {
  const db = await conn();
  const request = db.prepare("SELECT * FROM friend_requests WHERE id = ?").get(String(requestId));
  if (!request) fail(404, "request_not_found", "That friend request does not exist.");
  if (String(request.to_user) !== String(userId)) fail(403, "forbidden", "Only the recipient can answer this request.");
  if (request.status !== "pending") fail(409, "request_not_pending", "This request was already answered.");
  const now = nowMs();
  const status = accept ? "accepted" : "rejected";
  transaction((connection) => {
    connection
      .prepare("UPDATE friend_requests SET status = ?, responded_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, now, String(requestId));
    if (accept) {
      const [a, b] = pair(request.from_user, request.to_user);
      connection
        .prepare("INSERT OR IGNORE INTO friendships (id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)")
        .run(crypto.randomUUID(), a, b, now);
    }
  });
  return {
    id: request.id,
    from: mapUser(userRowById(db, request.from_user)),
    to: mapUser(userRowById(db, request.to_user)),
    message: request.message || "",
    status,
    createdAt: Number(request.created_at || 0),
    respondedAt: now
  };
}

export async function sqlCancelFriendRequest(userId, requestId) {
  const db = await conn();
  const request = db.prepare("SELECT * FROM friend_requests WHERE id = ?").get(String(requestId));
  if (!request) fail(404, "request_not_found", "That friend request does not exist.");
  if (String(request.from_user) !== String(userId)) fail(403, "forbidden", "Only the sender can cancel this request.");
  if (request.status !== "pending") fail(409, "request_not_pending", "This request is no longer pending.");
  db.prepare("UPDATE friend_requests SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(String(requestId));
  return { id: requestId, status: "cancelled" };
}

export async function sqlRemoveFriend(userId, username) {
  const db = await conn();
  const target = userRowByUsername(db, username);
  if (!target) fail(404, "user_not_found", "That account does not exist.");
  const [a, b] = pair(userId, target.id);
  const info = db.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").run(a, b);
  if (!Number(info.changes || 0)) fail(404, "not_friends", "You are not friends with this account.");
  return { ok: true, removed: target.username };
}

export async function sqlListBlocks(userId) {
  const db = await conn();
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.nick, u.avatar, u.last_seen_at, b.created_at AS blocked_at
       FROM blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ? ORDER BY b.created_at DESC`
    )
    .all(String(userId));
  return rows.map((row) => ({ ...mapUser(row), blockedAt: Number(row.blocked_at || 0) }));
}

export async function sqlBlockUser(userId, username) {
  const db = await conn();
  const target = requireTargetUser(db, username, userId);
  const [a, b] = pair(userId, target.id);
  const now = nowMs();
  transaction((connection) => {
    connection
      .prepare("INSERT OR IGNORE INTO blocks (id, blocker_id, blocked_id, created_at) VALUES (?, ?, ?, ?)")
      .run(crypto.randomUUID(), String(userId), String(target.id), now);
    connection.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").run(a, b);
    connection
      .prepare(
        `UPDATE friend_requests SET status = 'cancelled', responded_at = ?
         WHERE status = 'pending' AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))`
      )
      .run(now, String(userId), String(target.id), String(target.id), String(userId));
  });
  return { ok: true, blocked: mapUser(target), blockedAt: now };
}

export async function sqlUnblockUser(userId, username) {
  const db = await conn();
  const target = userRowByUsername(db, username);
  if (!target) fail(404, "user_not_found", "That account does not exist.");
  const info = db
    .prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?")
    .run(String(userId), String(target.id));
  if (!Number(info.changes || 0)) fail(404, "not_blocked", "This account is not blocked.");
  return { ok: true, unblocked: target.username };
}

/* ---------------------------------------------------------------------- DM */

function conversationRow(db, conversationId) {
  return db.prepare("SELECT * FROM dm_conversations WHERE id = ?").get(String(conversationId));
}

function conversationFor(db, userId, conversationId) {
  const row = conversationRow(db, conversationId);
  if (!row) fail(404, "conversation_not_found", "That conversation does not exist.");
  if (String(row.user_a) !== String(userId) && String(row.user_b) !== String(userId)) {
    fail(403, "forbidden", "You are not part of this conversation.");
  }
  return row;
}

function conversationPeer(row, userId) {
  return String(row.user_a) === String(userId) ? row.user_b : row.user_a;
}

function reactionMap(db, messageIds, userId) {
  const map = new Map();
  if (!messageIds.length) return map;
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT message_id, emoji, COUNT(*) AS total, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
       FROM dm_reactions WHERE message_id IN (${placeholders})
       GROUP BY message_id, emoji ORDER BY emoji ASC`
    )
    .all(String(userId), ...messageIds);
  for (const row of rows) {
    if (!map.has(row.message_id)) map.set(row.message_id, []);
    map.get(row.message_id).push({ emoji: row.emoji, count: Number(row.total || 0), mine: Boolean(row.mine) });
  }
  return map;
}

function mapDmMessage(row, userId, reactions = []) {
  const attachment = safeJson(row.attachment_json, null);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body || "",
    attachment: attachment || null,
    editedAt: row.edited_at ? Number(row.edited_at) : null,
    deletedAt: row.deleted_at ? Number(row.deleted_at) : null,
    createdAt: Number(row.created_at || 0),
    reactions
  };
}

function lastMessageFor(db, conversationId) {
  const row = db
    .prepare(
      `SELECT id, sender_id, body, deleted_at, created_at FROM dm_messages
       WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(String(conversationId));
  if (!row) return null;
  return {
    id: row.id,
    senderId: row.sender_id,
    body: row.deleted_at ? "" : row.body || "",
    deleted: Boolean(row.deleted_at),
    createdAt: Number(row.created_at || 0)
  };
}

function mapConversation(db, row, userId, peerRow = null) {
  const peer = mapUser(peerRow || userRowById(db, conversationPeer(row, userId)));
  const pref = db
    .prepare("SELECT muted, archived FROM dm_prefs WHERE conversation_id = ? AND user_id = ?")
    .get(row.id, String(userId));
  const read = db
    .prepare("SELECT last_read_at FROM dm_reads WHERE conversation_id = ? AND user_id = ?")
    .get(row.id, String(userId));
  const unread = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM dm_messages
         WHERE conversation_id = ? AND sender_id <> ? AND created_at > ?`
      )
      .get(row.id, String(userId), Number(read?.last_read_at || 0))?.n || 0
  );
  return {
    id: row.id,
    peer,
    lastMessage: lastMessageFor(db, row.id),
    unread,
    muted: Boolean(pref?.muted),
    archived: Boolean(pref?.archived),
    updatedAt: Number(row.updated_at || row.created_at || 0),
    createdAt: Number(row.created_at || 0)
  };
}

export async function sqlListConversations(userId, limit = 50) {
  const db = await conn();
  const size = pageLimit(limit, 50, 50);
  const rows = db
    .prepare(
      `SELECT * FROM dm_conversations
       WHERE user_a = ? OR user_b = ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(String(userId), String(userId), size);
  return rows.map((row) => mapConversation(db, row, userId));
}

export async function sqlOpenConversation(userId, username) {
  const db = await conn();
  const target = requireTargetUser(db, username, userId);
  assertNotBlocked(db, userId, target.id);
  const [a, b] = pair(userId, target.id);
  let row = db.prepare("SELECT * FROM dm_conversations WHERE user_a = ? AND user_b = ?").get(a, b);
  if (!row) {
    const now = nowMs();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO dm_conversations (id, user_a, user_b, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      a,
      b,
      now,
      now
    );
    row = conversationRow(db, id);
  }
  return mapConversation(db, row, userId, target);
}

export async function sqlListDmMessages(userId, conversationId, before = 0, limit = 30) {
  const db = await conn();
  conversationFor(db, userId, conversationId);
  const size = pageLimit(limit, 30, DM_PAGE_MAX);
  let beforeAt = 0;
  if (before) {
    const numeric = Number(before);
    if (Number.isFinite(numeric) && numeric > 0) beforeAt = numeric;
    else {
      const ref = db.prepare("SELECT created_at FROM dm_messages WHERE id = ?").get(String(before));
      beforeAt = ref ? Number(ref.created_at || 0) : 0;
    }
  }
  const rows = beforeAt
    ? db
        .prepare(
          `SELECT * FROM dm_messages WHERE conversation_id = ? AND created_at < ?
           ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .all(String(conversationId), beforeAt, size)
    : db
        .prepare(
          `SELECT * FROM dm_messages WHERE conversation_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .all(String(conversationId), size);
  const ordered = rows.reverse();
  const reactions = reactionMap(
    db,
    ordered.map((row) => row.id),
    userId
  );
  return ordered.map((row) => mapDmMessage(row, userId, reactions.get(row.id) || []));
}

export async function sqlSendDmMessage(userId, conversationId, body, attachment) {
  const db = await conn();
  const conversation = conversationFor(db, userId, conversationId);
  const peerId = conversationPeer(conversation, userId);
  assertNotBlocked(db, userId, peerId);
  const text = cleanText(body, 4000);
  let attachmentJson = "";
  if (attachment !== undefined && attachment !== null && attachment !== "") {
    if (typeof attachment !== "object") fail(400, "invalid_attachment", "Attachment must be an object.");
    const serialized = JSON.stringify(attachment);
    if (serialized.length > 20000) fail(400, "invalid_attachment", "Attachment is too large.");
    attachmentJson = serialized;
  }
  if (!text && !attachmentJson) fail(400, "empty_message", "Message body cannot be empty.");
  const id = crypto.randomUUID();
  const now = nowMs();
  transaction((connection) => {
    connection
      .prepare(
        `INSERT INTO dm_messages (id, conversation_id, sender_id, body, attachment_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, String(conversationId), String(userId), text, attachmentJson, now);
    connection.prepare("UPDATE dm_conversations SET updated_at = ? WHERE id = ?").run(now, String(conversationId));
  });
  return mapDmMessage(db.prepare("SELECT * FROM dm_messages WHERE id = ?").get(id), userId, []);
}

function dmMessageWithConversation(db, messageId, userId) {
  const row = db.prepare("SELECT * FROM dm_messages WHERE id = ?").get(String(messageId));
  if (!row) fail(404, "message_not_found", "That message does not exist.");
  const conversation = conversationFor(db, userId, row.conversation_id);
  return { row, conversation };
}

export async function sqlEditDmMessage(userId, messageId, body) {
  const db = await conn();
  const { row } = dmMessageWithConversation(db, messageId, userId);
  if (String(row.sender_id) !== String(userId)) fail(403, "forbidden", "Only the sender can edit this message.");
  if (row.deleted_at) fail(409, "message_deleted", "This message was deleted.");
  const text = cleanText(body, 4000);
  if (!text) fail(400, "empty_message", "Message body cannot be empty.");
  const now = nowMs();
  db.prepare("UPDATE dm_messages SET body = ?, edited_at = ? WHERE id = ?").run(text, now, String(messageId));
  const updated = db.prepare("SELECT * FROM dm_messages WHERE id = ?").get(String(messageId));
  const reactions = reactionMap(db, [updated.id], userId).get(updated.id) || [];
  return mapDmMessage(updated, userId, reactions);
}

export async function sqlDeleteDmMessage(userId, messageId) {
  const db = await conn();
  const { row } = dmMessageWithConversation(db, messageId, userId);
  if (String(row.sender_id) !== String(userId)) fail(403, "forbidden", "Only the sender can delete this message.");
  if (!row.deleted_at) {
    db.prepare("UPDATE dm_messages SET deleted_at = ? WHERE id = ?").run(nowMs(), String(messageId));
  }
  return { ok: true, id: String(messageId) };
}

export async function sqlAddDmReaction(userId, messageId, emoji) {
  const db = await conn();
  dmMessageWithConversation(db, messageId, userId);
  const glyph = cleanText(emoji, 32);
  if (!glyph) fail(400, "invalid_emoji", "Emoji is required.");
  db.prepare(
    "INSERT OR IGNORE INTO dm_reactions (id, message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), String(messageId), String(userId), glyph, nowMs());
  return { ok: true, reactions: reactionMap(db, [String(messageId)], userId).get(String(messageId)) || [] };
}

export async function sqlRemoveDmReaction(userId, messageId, emoji) {
  const db = await conn();
  dmMessageWithConversation(db, messageId, userId);
  const glyph = cleanText(emoji, 32);
  db.prepare("DELETE FROM dm_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").run(
    String(messageId),
    String(userId),
    glyph
  );
  return { ok: true, reactions: reactionMap(db, [String(messageId)], userId).get(String(messageId)) || [] };
}

export async function sqlConversationPeerId(userId, conversationId) {
  const db = await conn();
  return conversationPeer(conversationFor(db, userId, conversationId), userId);
}

export async function sqlDmMessagePeerId(userId, messageId) {
  const db = await conn();
  const { conversation } = dmMessageWithConversation(db, messageId, userId);
  return conversationPeer(conversation, userId);
}

export async function sqlDmMessageReactions(userId, messageId) {
  const db = await conn();
  dmMessageWithConversation(db, messageId, userId);
  return reactionMap(db, [String(messageId)], userId).get(String(messageId)) || [];
}

export async function sqlMarkConversationRead(userId, conversationId) {
  const db = await conn();
  conversationFor(db, userId, conversationId);
  const now = nowMs();
  db.prepare(
    `INSERT INTO dm_reads (conversation_id, user_id, last_read_at) VALUES (?, ?, ?)
     ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at`
  ).run(String(conversationId), String(userId), now);
  return { ok: true, lastReadAt: now };
}

export async function sqlSetConversationPref(userId, conversationId, { muted, archived }) {
  const db = await conn();
  const row = conversationFor(db, userId, conversationId);
  const current = db
    .prepare("SELECT muted, archived FROM dm_prefs WHERE conversation_id = ? AND user_id = ?")
    .get(row.id, String(userId));
  const nextMuted = muted === undefined ? Boolean(current?.muted) : Boolean(muted);
  const nextArchived = archived === undefined ? Boolean(current?.archived) : Boolean(archived);
  db.prepare(
    `INSERT INTO dm_prefs (conversation_id, user_id, muted, archived) VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id, user_id) DO UPDATE SET muted = excluded.muted, archived = excluded.archived`
  ).run(row.id, String(userId), nextMuted ? 1 : 0, nextArchived ? 1 : 0);
  return mapConversation(db, row, userId);
}

/* ------------------------------------------------------------------ search */

const SEARCH_SCOPES = ["all", "users", "friends", "rooms", "messages"];
const SEARCH_SORTS = ["relevance", "recent", "name", "members"];
const SEARCH_ROOM_FILTERS = ["open", "nopass", "active"];

function roomFilters(raw) {
  const wanted = new Set(
    String(raw || "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => SEARCH_ROOM_FILTERS.includes(token))
  );
  return wanted;
}

function roomScore(row, term) {
  const needle = term.toLowerCase();
  const name = String(row.name || "").toLowerCase();
  const code = String(row.room_code || "").toLowerCase();
  const managerNick = String(row.manager_nick || "").toLowerCase();
  const managerUser = String(row.manager_username || "").toLowerCase();
  const description = String(row.description || "").toLowerCase();
  if (code === needle) return 100;
  if (name === needle) return 90;
  if (name.startsWith(needle)) return 80;
  if (code.startsWith(needle)) return 75;
  if (name.includes(needle)) return 65;
  if (managerNick === needle || managerUser === needle) return 60;
  if (managerNick.includes(needle) || managerUser.includes(needle)) return 45;
  if (code.includes(needle)) return 40;
  return 30;
}

export async function sqlSearch(userId, { q, type = "all", page = 1, limit = 20, sort = "relevance", filter = "" } = {}) {
  const db = await conn();
  const term = cleanText(q, 80);
  if (term.length < 2) fail(400, "invalid_query", "Search needs at least 2 characters.");
  const size = pageLimit(limit, 20, 50);
  const currentPage = Math.max(1, Math.min(1000, Math.floor(toNumber(page, 1))));
  const offset = (currentPage - 1) * size;
  const scope = SEARCH_SCOPES.includes(String(type)) ? String(type) : "all";
  const order = SEARCH_SORTS.includes(String(sort)) ? String(sort) : "relevance";
  const filters = roomFilters(filter);
  const pattern = likeArg(term.toLowerCase());
  const viewer = String(userId);
  const results = [];
  const grouped = { users: [], friends: [], rooms: [], messages: [] };
  const counts = { users: 0, friends: 0, rooms: 0, messages: 0 };

  if (scope === "all" || scope === "users") {
    const where = `u.deleted_at IS NULL AND u.status = 'active' AND u.id <> ?
      AND COALESCE(p.visibility, 'public') = 'public'
      AND (u.username_lower LIKE ? ESCAPE '\\' OR lower(u.nick) LIKE ? ESCAPE '\\')`;
    counts.users = Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE ${where}`)
        .get(viewer, pattern, pattern)?.n || 0
    );
    const orderSql =
      order === "recent"
        ? "COALESCE(u.last_seen_at, 0) DESC, u.username_lower ASC"
        : order === "relevance"
          ? "CASE WHEN u.username_lower = lower(?) THEN 0 WHEN lower(u.nick) = lower(?) THEN 1 WHEN u.username_lower LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END, u.username_lower ASC"
          : "u.username_lower ASC";
    const orderParams = order === "relevance" ? [term, term, `${term.toLowerCase()}%`] : [];
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.nick, u.avatar,
           CASE
             WHEN p.user_id IS NULL THEN u.last_seen_at
             WHEN p.last_active_visibility = 'nobody' THEN NULL
             WHEN p.last_active_visibility = 'friends'
               AND NOT EXISTS(SELECT 1 FROM friendships f WHERE (f.user_a = ? AND f.user_b = u.id) OR (f.user_a = u.id AND f.user_b = ?))
               THEN NULL
             ELSE u.last_seen_at
           END AS last_seen_at
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE ${where}
         ORDER BY ${orderSql} LIMIT ? OFFSET ?`
      )
      .all(viewer, viewer, viewer, pattern, pattern, ...orderParams, size, offset);
    grouped.users = rows.map(mapUser);
  }

  if (scope === "all" || scope === "friends") {
    const where = `(f.user_a = ? OR f.user_b = ?) AND u.deleted_at IS NULL
      AND (u.username_lower LIKE ? ESCAPE '\\' OR lower(u.nick) LIKE ? ESCAPE '\\')`;
    counts.friends = Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END WHERE ${where}`)
        .get(viewer, viewer, viewer, pattern, pattern)?.n || 0
    );
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.nick, u.avatar,
           CASE WHEN p.last_active_visibility = 'nobody' THEN NULL ELSE u.last_seen_at END AS last_seen_at
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE ${where}
         ORDER BY u.username_lower ASC LIMIT ? OFFSET ?`
      )
      .all(viewer, viewer, viewer, pattern, pattern, size, offset);
    grouped.friends = rows.map(mapUser);
  }

  if (scope === "all" || scope === "rooms") {
    const likeName = likeArg(term);
    const likeCode = likeArg(term.toUpperCase());
    const rows = db
      .prepare(
        `SELECT r.id, r.room_code, r.name, r.description, r.color, r.icon_url, r.capacity, r.member_count,
           r.last_activity_at, r.created_at, r.host_id, r.password_hash,
           u.username AS manager_username, u.nick AS manager_nick, u.avatar AS manager_avatar,
           (SELECT COUNT(*) FROM room_memberships m WHERE m.room_id = r.id AND m.left_at IS NULL) AS active_members,
           EXISTS(SELECT 1 FROM room_memberships vm WHERE vm.room_id = r.id AND vm.user_id = ? AND vm.left_at IS NULL) AS joined
         FROM rooms r
         LEFT JOIN users u ON u.id = r.host_id
         WHERE r.is_active = 1 AND r.deleted_at IS NULL AND r.visibility = 'public'
           AND (r.name LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR r.room_code LIKE ? ESCAPE '\\'
             OR u.nick LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')
         ORDER BY r.last_activity_at DESC LIMIT 200`
      )
      .all(viewer, likeName, likeName, likeCode, likeName, likeName);
    const activeSince = Date.now() - 24 * 60 * 60 * 1000;
    const filtered = rows
      .map((row) => ({ row, score: roomScore(row, term) }))
      .filter(({ row }) => {
        const members = Number(row.active_members || 0);
        if (filters.has("open") && members >= Number(row.capacity || 0)) return false;
        if (filters.has("nopass") && row.password_hash) return false;
        if (filters.has("active") && Number(row.last_activity_at || 0) < activeSince) return false;
        return true;
      });
    filtered.sort((a, b) => {
      if (order === "members") return Number(b.row.active_members || 0) - Number(a.row.active_members || 0);
      if (order === "name") return String(a.row.name || "").localeCompare(String(b.row.name || ""));
      if (order === "recent") return Number(b.row.last_activity_at || 0) - Number(a.row.last_activity_at || 0);
      if (b.score !== a.score) return b.score - a.score;
      return Number(b.row.last_activity_at || 0) - Number(a.row.last_activity_at || 0);
    });
    counts.rooms = filtered.length;
    grouped.rooms = filtered.slice(offset, offset + size).map(({ row, score }) => ({
      id: row.id,
      roomCode: row.room_code,
      code: row.room_code,
      name: row.name || "",
      description: row.description || "",
      color: row.color || "",
      iconUrl: row.icon_url || "",
      capacity: Number(row.capacity || 0),
      memberCount: Number(row.active_members ?? row.member_count ?? 0),
      hasPassword: Boolean(row.password_hash),
      lastActivityAt: Number(row.last_activity_at || 0),
      createdAt: Number(row.created_at || 0),
      joined: Boolean(row.joined),
      manager: {
        id: row.host_id,
        username: row.manager_username || "",
        nick: row.manager_nick || "",
        avatar: row.manager_avatar || ""
      },
      score
    }));
  }

  if (scope === "all" || scope === "messages") {
    const where = `m.deleted_at IS NULL AND r.is_active = 1 AND r.deleted_at IS NULL AND r.visibility = 'public'
      AND m.content LIKE ? ESCAPE '\\'`;
    counts.messages = Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM messages m JOIN rooms r ON r.id = m.room_id WHERE ${where}`)
        .get(pattern)?.n || 0
    );
    const rows = db
      .prepare(
        `SELECT m.id, m.room_id, m.user_id, m.username, m.content, m.created_at, r.room_code
         FROM messages m
         JOIN rooms r ON r.id = m.room_id
         WHERE ${where}
         ORDER BY m.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(pattern, size, offset);
    grouped.messages = rows.map((row) => ({
      id: row.id,
      roomId: row.room_id,
      roomCode: row.room_code,
      userId: row.user_id || "",
      username: row.username || "",
      content: row.content,
      createdAt: Number(row.created_at || 0)
    }));
  }

  for (const user of grouped.users) results.push({ type: "user", ...user });
  for (const friend of grouped.friends) results.push({ type: "friend", ...friend });
  for (const room of grouped.rooms) results.push({ type: "room", ...room });
  for (const message of grouped.messages) results.push({ type: "message", ...message });

  const activeCounts = [
    scope === "all" || scope === "users" ? counts.users : 0,
    scope === "all" || scope === "friends" ? counts.friends : 0,
    scope === "all" || scope === "rooms" ? counts.rooms : 0,
    scope === "all" || scope === "messages" ? counts.messages : 0
  ];
  const total = activeCounts.reduce((sum, value) => sum + value, 0);
  const hasMore = ["users", "friends", "rooms", "messages"].some((key) => {
    const inScope = scope === "all" || scope === key;
    if (!inScope) return false;
    const shown = grouped[key].length;
    return shown === size && counts[key] > offset + size;
  });
  return {
    query: term,
    type: scope,
    sort: order,
    page: currentPage,
    limit: size,
    total,
    counts,
    hasMore,
    results,
    ...grouped
  };
}

/* ----------------------------------------------------------------- reports */

function mapReport(row, notes = null, reporter = null) {
  if (!row) return null;
  return {
    id: row.id,
    reporter: reporter || { id: row.reporter_id },
    targetType: row.target_type,
    targetId: row.target_id || "",
    category: row.category || "",
    details: row.details || "",
    evidence: row.evidence || "",
    status: row.status,
    assignedTo: row.assigned_to || null,
    resolution: row.resolution || "",
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    ...(notes ? { notes } : {})
  };
}

export async function sqlCreateReport(userId, { targetType, targetId = "", category = "", details = "", evidence = "" }) {
  const db = await conn();
  const kind = cleanText(targetType, 20);
  if (!REPORT_TARGETS.includes(kind)) fail(400, "invalid_target_type", "Report target type is not supported.");
  const target = cleanText(targetId, 120);
  const cat = cleanText(category, 60) || "other";
  const text = cleanText(details, 4000);
  if (!text) fail(400, "invalid_details", "Describe what happened.");
  const proof = cleanText(evidence, 4000);
  const id = crypto.randomUUID();
  const now = nowMs();
  db.prepare(
    `INSERT INTO reports (id, reporter_id, target_type, target_id, category, details, evidence, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(id, String(userId), kind, target, cat, text, proof, now, now);
  return mapReport(db.prepare("SELECT * FROM reports WHERE id = ?").get(id), [], mapUser(userRowById(db, userId)));
}

export async function sqlListMyReports(userId, limit = 25) {
  const db = await conn();
  const size = pageLimit(limit, 25, 50);
  const rows = db
    .prepare("SELECT * FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(String(userId), size);
  return rows.map((row) => mapReport(row));
}

export async function sqlListReports(role, { status = "", limit = 25, offset = 0 } = {}) {
  const db = await conn();
  if (!isStaff(role)) fail(403, "forbidden", "Staff access is required.");
  const size = pageLimit(limit, 25, 50);
  const skip = Math.max(0, Math.floor(toNumber(offset, 0)));
  const where = status && REPORT_STATUSES.includes(String(status)) ? "WHERE status = ?" : "";
  const params = where ? [String(status), size, skip] : [size, skip];
  const rows = db
    .prepare(`SELECT * FROM reports ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM reports ${where}`).get(...(where ? [String(status)] : []))?.n || 0);
  const reporters = new Map();
  const summary = (id) => {
    if (!reporters.has(id)) reporters.set(id, mapUser(userRowById(db, id)));
    return reporters.get(id);
  };
  return {
    total,
    reports: rows.map((row) => mapReport(row, null, summary(row.reporter_id)))
  };
}

export async function sqlGetReport(userId, role, reportId) {
  const db = await conn();
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(String(reportId));
  if (!row) fail(404, "report_not_found", "That report does not exist.");
  if (String(row.reporter_id) !== String(userId) && !isStaff(role)) {
    fail(403, "forbidden", "You cannot view this report.");
  }
  const notes = db
    .prepare("SELECT * FROM moderation_notes WHERE report_id = ? ORDER BY created_at ASC")
    .all(String(reportId))
    .map((note) => ({
      id: note.id,
      author: mapUser(userRowById(db, note.author_id)),
      body: note.body,
      createdAt: Number(note.created_at || 0)
    }));
  return mapReport(row, notes, mapUser(userRowById(db, row.reporter_id)));
}

export async function sqlPatchReport(userId, role, reportId, { status, resolution, note, assignedTo } = {}) {
  const db = await conn();
  if (!isStaff(role)) fail(403, "forbidden", "Staff access is required.");
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(String(reportId));
  if (!row) fail(404, "report_not_found", "That report does not exist.");
  const nextStatus = status === undefined ? row.status : cleanText(status, 20);
  if (!REPORT_STATUSES.includes(nextStatus)) fail(400, "invalid_status", "Report status is not valid.");
  const nextResolution = resolution === undefined ? row.resolution : cleanText(resolution, 2000);
  const nextAssigned = assignedTo === undefined ? row.assigned_to : cleanText(assignedTo, 80) || null;
  const noteBody = cleanText(note, 2000);
  const now = nowMs();
  transaction((connection) => {
    connection
      .prepare("UPDATE reports SET status = ?, resolution = ?, assigned_to = ?, updated_at = ? WHERE id = ?")
      .run(nextStatus, nextResolution, nextAssigned, now, String(reportId));
    if (noteBody) {
      connection
        .prepare("INSERT INTO moderation_notes (id, report_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), String(reportId), String(userId), noteBody, now);
    }
  });
  if (nextStatus !== row.status && (nextStatus === "resolved" || nextStatus === "dismissed")) {
    recordModerationAction({
      moderatorId: userId,
      action: nextStatus === "resolved" ? "report_resolve" : "report_dismiss",
      targetType: "report",
      targetId: row.id,
      reason: nextResolution || nextStatus,
      meta: { reportTarget: row.target_type, reportTargetId: row.target_id }
    });
  }
  return sqlGetReport(userId, role, reportId);
}

/* ----------------------------------------------------------------- invites */

function inviteStatus(row, now = nowMs()) {
  if (row.revoked_at) return "revoked";
  if (Number(row.expires_at || 0) <= now) return "expired";
  if (Number(row.max_uses || 0) > 0 && Number(row.uses || 0) >= Number(row.max_uses)) return "exhausted";
  return "active";
}

function mapInvite(row, code = undefined) {
  if (!row) return null;
  const now = nowMs();
  return {
    id: row.id,
    ...(code ? { code } : {}),
    hint: row.code_hint || "",
    roomCode: row.room_code || null,
    serverId: row.server_id || null,
    expiresAt: Number(row.expires_at || 0),
    maxUses: Number(row.max_uses || 0),
    uses: Number(row.uses || 0),
    revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
    createdAt: Number(row.created_at || 0),
    status: inviteStatus(row, now)
  };
}

function inviteRow(db, id) {
  return db
    .prepare(
      `SELECT i.*, r.room_code FROM invitations i LEFT JOIN rooms r ON r.id = i.room_id WHERE i.id = ?`
    )
    .get(String(id));
}

function makeInviteCode() {
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (const byte of bytes) out += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  return out;
}

function canManageRoom(db, userId, role, roomRow) {
  if (isStaff(role)) return true;
  if (String(roomRow.host_id) === String(userId)) return true;
  return Boolean(
    db
      .prepare("SELECT 1 AS hit FROM room_memberships WHERE room_id = ? AND user_id = ? AND left_at IS NULL AND role IN ('host','moderator')")
      .get(roomRow.id, String(userId))
  );
}

export async function sqlCreateInvite(userId, role, { roomCode, serverId, expiresInHours, maxUses }) {
  const db = await conn();
  const room = roomCode
    ? db.prepare("SELECT * FROM rooms WHERE room_code = ? AND deleted_at IS NULL").get(cleanText(roomCode, 16).toUpperCase())
    : null;
  const server = serverId ? db.prepare("SELECT * FROM servers WHERE id = ? AND deleted_at IS NULL").get(String(serverId)) : null;
  if (!room && !server) fail(400, "invalid_target", "Provide a valid roomCode or serverId.");
  if (room && !canManageRoom(db, userId, role, room)) {
    fail(403, "forbidden", "Only the room host or staff can create invites.");
  }
  if (server && String(server.owner_id) !== String(userId) && !isStaff(role)) {
    fail(403, "forbidden", "Only the server owner can create invites.");
  }
  const nowCheck = nowMs();
  const active = Number(
    db
      .prepare("SELECT COUNT(*) AS n FROM invitations WHERE created_by = ? AND revoked_at IS NULL AND expires_at > ?")
      .get(String(userId), nowCheck)?.n || 0
  );
  if (active >= 50) fail(429, "invite_limit", "You already have 50 active invites. Revoke some first.");
  const recent = Number(
    db
      .prepare("SELECT COUNT(*) AS n FROM invitations WHERE created_by = ? AND created_at > ?")
      .get(String(userId), nowCheck - 24 * 3600_000)?.n || 0
  );
  if (recent >= 30) fail(429, "invite_rate_limit", "Too many invites created in the last 24 hours.");
  const hours = Math.min(720, Math.max(1, Math.round(toNumber(expiresInHours, 24))));
  const uses = Math.min(1000, Math.max(0, Math.round(toNumber(maxUses, 1))));
  const code = makeInviteCode();
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  const hint = `${code.slice(0, 4)}…`;
  const id = crypto.randomUUID();
  const now = nowMs();
  db.prepare(
    `INSERT INTO invitations
     (id, room_id, server_id, code_hash, code_hint, created_by, expires_at, max_uses, uses, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(id, room?.id || null, server?.id || null, codeHash, hint, String(userId), now + hours * 3600_000, uses, now);
  return mapInvite(inviteRow(db, id), code);
}

export async function sqlListInvites(userId, limit = 25) {
  const db = await conn();
  const size = pageLimit(limit, 25, 50);
  const rows = db
    .prepare(
      `SELECT i.*, r.room_code FROM invitations i LEFT JOIN rooms r ON r.id = i.room_id
       WHERE i.created_by = ? ORDER BY i.created_at DESC LIMIT ?`
    )
    .all(String(userId), size);
  return rows.map((row) => mapInvite(row));
}

export async function sqlRevokeInvite(userId, inviteId) {
  const db = await conn();
  const row = inviteRow(db, inviteId);
  if (!row) fail(404, "invite_not_found", "That invite does not exist.");
  if (String(row.created_by) !== String(userId)) fail(403, "forbidden", "Only the creator can revoke this invite.");
  if (!row.revoked_at) {
    db.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ?").run(nowMs(), String(inviteId));
  }
  return mapInvite(inviteRow(db, inviteId));
}

export async function sqlAcceptInvite(userId, rawCode) {
  const db = await conn();
  const code = cleanText(rawCode, 32).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) fail(400, "invite_invalid", "Invite code is invalid.");
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  const now = nowMs();
  let roomCode = null;
  let roomName = "";
  let inviterId = "";
  let inviteId = "";
  transaction((connection) => {
    const row = connection
      .prepare(
        `SELECT i.*, r.room_code FROM invitations i LEFT JOIN rooms r ON r.id = i.room_id
         WHERE i.code_hash = ?`
      )
      .get(codeHash);
    if (!row) fail(404, "invite_invalid", "Invite code is not valid.");
    if (row.revoked_at) fail(410, "invite_revoked", "This invite was revoked.");
    if (Number(row.expires_at || 0) <= now) fail(410, "invite_expired", "This invite has expired.");
    if (Number(row.max_uses || 0) > 0 && Number(row.uses || 0) >= Number(row.max_uses)) {
      fail(409, "invite_exhausted", "This invite has no uses left.");
    }
    const info = connection
      .prepare(
        `UPDATE invitations SET uses = uses + 1
         WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND (max_uses = 0 OR uses < max_uses)`
      )
      .run(row.id, now);
    if (!Number(info.changes || 0)) fail(409, "invite_exhausted", "This invite has no uses left.");
    if (row.room_id) {
      const room = connection
        .prepare("SELECT id, room_code, name, is_active, deleted_at FROM rooms WHERE id = ?")
        .get(row.room_id);
      if (!room || room.deleted_at || !room.is_active) fail(410, "invite_expired", "This room is no longer available.");
      connection
        .prepare(
          `INSERT INTO room_memberships (id, room_id, user_id, role, joined_at, last_seen_at)
           VALUES (?, ?, ?, 'member', ?, ?)
           ON CONFLICT(room_id, user_id) DO UPDATE SET
             joined_at = excluded.joined_at, left_at = NULL, last_seen_at = excluded.last_seen_at`
        )
        .run(crypto.randomUUID(), room.id, String(userId), now, now);
      connection
        .prepare(
          `UPDATE rooms SET member_count = (SELECT COUNT(*) FROM room_memberships WHERE room_id = ? AND left_at IS NULL)
           WHERE id = ?`
        )
        .run(room.id, room.id);
      roomCode = room.room_code;
      roomName = room.name || room.room_code;
    }
    inviterId = String(row.created_by || "");
    inviteId = row.id;
  });
  return { invite: mapInvite(inviteRow(db, inviteId)), roomCode, roomName, inviterId };
}

/* --------------------------------------------------------------- history */

function mapHistory(row) {
  return {
    id: row.id,
    mediaUrl: row.media_url || "",
    title: row.media_title || "",
    position: Number(row.position || 0),
    duration: Number(row.duration || 0),
    roomId: row.room_id || null,
    lastWatchedAt: Number(row.last_watched_at || 0)
  };
}

export async function sqlListHistory(userId, limit = 50) {
  const db = await conn();
  const size = pageLimit(limit, 50, 50);
  return db
    .prepare("SELECT * FROM playback_history WHERE user_id = ? ORDER BY last_watched_at DESC LIMIT ?")
    .all(String(userId), size)
    .map(mapHistory);
}

export async function sqlUpsertHistory(userId, { mediaUrl, title = "", position = 0, duration = 0, roomId = null }) {
  const db = await conn();
  const url = cleanText(mediaUrl, 2000);
  if (!url) fail(400, "invalid_url", "Media URL is required.");
  const label = cleanText(title, 200);
  const pos = nonNegative(position);
  const len = nonNegative(duration);
  const room = roomId ? String(roomId) : null;
  const now = nowMs();
  const existing = db
    .prepare("SELECT * FROM playback_history WHERE user_id = ? AND media_url = ? ORDER BY last_watched_at DESC LIMIT 1")
    .get(String(userId), url);
  let id;
  if (existing) {
    id = existing.id;
    db.prepare(
      `UPDATE playback_history
       SET position = ?, duration = ?, media_title = CASE WHEN ? <> '' THEN ? ELSE media_title END,
           room_id = COALESCE(?, room_id), last_watched_at = ?
       WHERE id = ?`
    ).run(pos, len, label, label, room, now, id);
  } else {
    id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO playback_history
       (id, user_id, room_id, media_url, media_title, position, duration, watched_seconds, last_watched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(id, String(userId), room, url, label, pos, len, now);
  }
  db.prepare(
    `DELETE FROM playback_history
     WHERE user_id = ? AND id NOT IN (
       SELECT id FROM playback_history WHERE user_id = ? ORDER BY last_watched_at DESC, id DESC LIMIT ?
     )`
  ).run(String(userId), String(userId), HISTORY_CAP);
  return mapHistory(db.prepare("SELECT * FROM playback_history WHERE id = ?").get(id));
}

export async function sqlDeleteHistory(userId, historyId) {
  const db = await conn();
  const info = db
    .prepare("DELETE FROM playback_history WHERE id = ? AND user_id = ?")
    .run(String(historyId), String(userId));
  if (!Number(info.changes || 0)) fail(404, "history_not_found", "That history entry does not exist.");
  return { ok: true, id: String(historyId) };
}

export async function sqlClearHistory(userId) {
  const db = await conn();
  const info = db.prepare("DELETE FROM playback_history WHERE user_id = ?").run(String(userId));
  return { ok: true, removed: Number(info.changes || 0) };
}

/* ------------------------------------------------------------------- polls */

function roomByCode(db, code) {
  const room = db
    .prepare("SELECT * FROM rooms WHERE room_code = ? AND deleted_at IS NULL")
    .get(cleanText(code, 16).toUpperCase());
  if (!room) fail(404, "room_not_found", "That room does not exist.");
  return room;
}

function canAccessRoom(db, userId, role, room) {
  if (isStaff(role)) return true;
  if (String(room.host_id) === String(userId)) return true;
  if (room.privacy === "public" && room.is_active) return true;
  return Boolean(
    db
      .prepare("SELECT 1 AS hit FROM room_memberships WHERE room_id = ? AND user_id = ? AND left_at IS NULL")
      .get(room.id, String(userId))
  );
}

function canManagePoll(db, userId, role, poll, room) {
  if (String(poll.created_by) === String(userId)) return true;
  if (room && String(room.host_id) === String(userId)) return true;
  return isStaff(role);
}

function mapPoll(db, row, userId) {
  const optionRows = db
    .prepare("SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position ASC, label ASC")
    .all(row.id);
  const voteRows = db.prepare("SELECT option_id, user_id FROM poll_votes WHERE poll_id = ?").all(row.id);
  const counts = new Map();
  for (const vote of voteRows) counts.set(vote.option_id, (counts.get(vote.option_id) || 0) + 1);
  const myVotes = new Set(voteRows.filter((vote) => String(vote.user_id) === String(userId)).map((vote) => vote.option_id));
  const revealVoters = !row.anonymous;
  const voterCache = new Map();
  const options = optionRows.map((option) => ({
    id: option.id,
    label: option.label,
    position: Number(option.position || 0),
    votes: counts.get(option.id) || 0,
    mine: myVotes.has(option.id),
    ...(revealVoters
      ? {
          voters: voteRows
            .filter((vote) => vote.option_id === option.id)
            .slice(0, 25)
            .map((vote) => {
              if (!voterCache.has(vote.user_id)) voterCache.set(vote.user_id, mapUser(userRowById(db, vote.user_id)));
              return voterCache.get(vote.user_id);
            })
        }
      : {})
  }));
  const now = nowMs();
  return {
    id: row.id,
    roomCode: row.room_code,
    question: row.question,
    multi: Boolean(row.multi),
    anonymous: Boolean(row.anonymous),
    closesAt: row.closes_at ? Number(row.closes_at) : null,
    closedAt: row.closed_at ? Number(row.closed_at) : null,
    createdBy: row.created_by,
    createdAt: Number(row.created_at || 0),
    options,
    totalVotes: voteRows.length,
    mine: myVotes.size > 0,
    myVotes: [...myVotes],
    closed: Boolean(row.closed_at) || Boolean(row.closes_at && Number(row.closes_at) <= now)
  };
}

export async function sqlListPolls(userId, role, roomCode) {
  const db = await conn();
  if (!cleanText(roomCode, 16)) fail(400, "missing_room", "Room code is required.");
  const room = roomByCode(db, roomCode);
  if (!canAccessRoom(db, userId, role, room)) fail(403, "forbidden", "You are not a member of this room.");
  return db
    .prepare("SELECT * FROM room_polls WHERE room_code = ? ORDER BY created_at DESC LIMIT 50")
    .all(room.room_code)
    .map((row) => mapPoll(db, row, userId));
}

/* Everyone who should hear about poll changes: host plus current members. */
export async function sqlPollAudience(roomCode) {
  const db = await conn();
  const room = roomByCode(db, roomCode);
  const ids = new Set();
  if (room.host_id) ids.add(String(room.host_id));
  for (const row of db
    .prepare("SELECT user_id FROM room_memberships WHERE room_id = ? AND left_at IS NULL")
    .all(room.id)) {
    ids.add(String(row.user_id));
  }
  return { ids: [...ids], roomCode: room.room_code, name: room.name || room.room_code };
}

export async function sqlCreatePoll(userId, role, { roomCode, question, options, multi = false, anonymous = true, closesInMinutes }) {
  const db = await conn();
  const room = roomByCode(db, roomCode);
  if (!canAccessRoom(db, userId, role, room)) fail(403, "forbidden", "You are not a member of this room.");
  const text = cleanText(question, 200);
  if (!text) fail(400, "invalid_question", "Poll question is required.");
  const labels = Array.isArray(options)
    ? options.map((option) => cleanText(option, 80)).filter(Boolean)
    : [];
  if (labels.length < 2 || labels.length > 10) fail(400, "invalid_options", "Polls need between 2 and 10 options.");
  if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) {
    fail(400, "invalid_options", "Poll options must be unique.");
  }
  const minutes = closesInMinutes === undefined || closesInMinutes === null || closesInMinutes === ""
    ? 0
    : Math.min(10080, Math.max(1, Math.round(toNumber(closesInMinutes, 0))));
  const id = crypto.randomUUID();
  const now = nowMs();
  transaction((connection) => {
    connection
      .prepare(
        `INSERT INTO room_polls (id, room_code, created_by, question, multi, anonymous, closes_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, room.room_code, String(userId), text, multi ? 1 : 0, anonymous ? 1 : 0, minutes ? now + minutes * 60_000 : null, now);
    const insert = connection.prepare("INSERT INTO poll_options (id, poll_id, label, position) VALUES (?, ?, ?, ?)");
    labels.forEach((label, index) => insert.run(crypto.randomUUID(), id, label, index));
  });
  return mapPoll(db, db.prepare("SELECT * FROM room_polls WHERE id = ?").get(id), userId);
}

export async function sqlVotePoll(userId, role, pollId, optionIds) {
  const db = await conn();
  const poll = db.prepare("SELECT * FROM room_polls WHERE id = ?").get(String(pollId));
  if (!poll) fail(404, "poll_not_found", "That poll does not exist.");
  const room = db.prepare("SELECT * FROM rooms WHERE room_code = ? AND deleted_at IS NULL").get(poll.room_code);
  if (!room || !canAccessRoom(db, userId, role, room)) fail(403, "forbidden", "You are not a member of this room.");
  const now = nowMs();
  if (poll.closed_at || (poll.closes_at && Number(poll.closes_at) <= now)) {
    if (!poll.closed_at) db.prepare("UPDATE room_polls SET closed_at = ? WHERE id = ?").run(now, poll.id);
    fail(409, "poll_closed", "This poll is closed.");
  }
  const ids = (Array.isArray(optionIds) ? optionIds : [optionIds]).map((id) => String(id || "")).filter(Boolean);
  const unique = [...new Set(ids)];
  if (!unique.length) fail(400, "invalid_options", "Choose at least one option.");
  if (!poll.multi && unique.length > 1) fail(400, "invalid_options", "This poll only allows one choice.");
  const valid = new Set(
    db.prepare("SELECT id FROM poll_options WHERE poll_id = ?").all(poll.id).map((row) => row.id)
  );
  for (const id of unique) {
    if (!valid.has(id)) fail(400, "invalid_options", "That option does not belong to this poll.");
  }
  transaction((connection) => {
    if (!poll.multi) {
      const existing = connection
        .prepare("SELECT 1 AS hit FROM poll_votes WHERE poll_id = ? AND user_id = ? LIMIT 1")
        .get(poll.id, String(userId));
      if (existing) fail(409, "already_voted", "You already voted in this poll.");
    }
    const insert = connection.prepare(
      "INSERT OR IGNORE INTO poll_votes (id, poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    for (const optionId of unique) insert.run(crypto.randomUUID(), poll.id, optionId, String(userId), now);
  });
  return mapPoll(db, db.prepare("SELECT * FROM room_polls WHERE id = ?").get(poll.id), userId);
}

function pollWithRoom(db, pollId) {
  const poll = db.prepare("SELECT * FROM room_polls WHERE id = ?").get(String(pollId));
  if (!poll) fail(404, "poll_not_found", "That poll does not exist.");
  const room = db.prepare("SELECT * FROM rooms WHERE room_code = ?").get(poll.room_code);
  return { poll, room };
}

export async function sqlClosePoll(userId, role, pollId) {
  const db = await conn();
  const { poll, room } = pollWithRoom(db, pollId);
  if (!canManagePoll(db, userId, role, poll, room)) fail(403, "forbidden", "Only the creator, room host or staff can close this poll.");
  if (!poll.closed_at) db.prepare("UPDATE room_polls SET closed_at = ? WHERE id = ?").run(nowMs(), poll.id);
  return mapPoll(db, db.prepare("SELECT * FROM room_polls WHERE id = ?").get(poll.id), userId);
}

export async function sqlDeletePoll(userId, role, pollId) {
  const db = await conn();
  const { poll, room } = pollWithRoom(db, pollId);
  if (!canManagePoll(db, userId, role, poll, room)) fail(403, "forbidden", "Only the creator, room host or staff can delete this poll.");
  db.prepare("DELETE FROM room_polls WHERE id = ?").run(poll.id);
  return { ok: true, id: poll.id, poll: { id: poll.id, roomCode: poll.room_code, question: poll.question } };
}

/* ----------------------------------------------------------------- library */

function mapLibrary(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title || "",
    url: row.url,
    meta: safeJson(row.meta_json, {}),
    lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null,
    createdAt: Number(row.created_at || 0)
  };
}

export async function sqlListLibrary(userId, kind = "", limit = 100) {
  const db = await conn();
  const size = pageLimit(limit, 100, 50);
  const filter = LIBRARY_KINDS.includes(String(kind)) ? "AND kind = ?" : "";
  const params = filter ? [String(userId), String(kind), size] : [String(userId), size];
  return db
    .prepare(`SELECT * FROM media_library WHERE user_id = ? ${filter} ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ?`)
    .all(...params)
    .map(mapLibrary);
}

export async function sqlAddLibraryItem(userId, { kind, title = "", url, meta = {} }) {
  const db = await conn();
  const type = cleanText(kind, 20);
  if (!LIBRARY_KINDS.includes(type)) fail(400, "invalid_kind", "Library kind is not supported.");
  const link = cleanText(url, 2000);
  if (!link) fail(400, "invalid_url", "URL is required.");
  const label = cleanText(title, 200);
  let metaJson = "{}";
  if (meta && typeof meta === "object") {
    const serialized = JSON.stringify(meta);
    if (serialized.length > 20000) fail(400, "invalid_meta", "Metadata is too large.");
    metaJson = serialized;
  }
  const id = crypto.randomUUID();
  const now = nowMs();
  db.prepare(
    `INSERT INTO media_library (id, user_id, kind, title, url, meta_json, last_used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, String(userId), type, label, link, metaJson, now, now);
  db.prepare(
    `DELETE FROM media_library WHERE user_id = ? AND id NOT IN (
       SELECT id FROM media_library WHERE user_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC LIMIT ?
     )`
  ).run(String(userId), String(userId), LIBRARY_CAP);
  return mapLibrary(db.prepare("SELECT * FROM media_library WHERE id = ?").get(id));
}

export async function sqlDeleteLibraryItem(userId, itemId) {
  const db = await conn();
  const info = db.prepare("DELETE FROM media_library WHERE id = ? AND user_id = ?").run(String(itemId), String(userId));
  if (!Number(info.changes || 0)) fail(404, "library_item_not_found", "That library item does not exist.");
  return { ok: true, id: String(itemId) };
}

/* ----------------------------------------------------------------- support */

const TICKET_STATUS_LABELS = {
  open: "باز",
  pending: "در انتظار",
  resolved: "حل‌شده",
  closed: "بسته"
};

function mapTicket(row, messages = null) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    assignedTo: row.assigned_to || null,
    assignee: row.assignee_username
      ? { id: row.assigned_to, username: row.assignee_username, nick: row.assignee_nick || row.assignee_username }
      : null,
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
    resolution: row.resolution || "",
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    ...(messages ? { messages } : {})
  };
}

function ticketWithAssignee(db, ticketId) {
  return db
    .prepare(
      `SELECT t.*, u.username AS assignee_username, u.nick AS assignee_nick
       FROM support_tickets t LEFT JOIN users u ON u.id = t.assigned_to
       WHERE t.id = ?`
    )
    .get(String(ticketId));
}

function ticketMessages(db, ticketId) {
  return db
    .prepare("SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC")
    .all(String(ticketId))
    .map((row) => ({
      id: row.id,
      author: mapUser(userRowById(db, row.author_id)),
      body: row.body,
      kind: row.kind || "message",
      attachment: safeJson(row.attachment_json, null),
      createdAt: Number(row.created_at || 0)
    }));
}

function cleanAttachment(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "object" || Array.isArray(raw)) fail(400, "invalid_attachment", "Attachment must be an object.");
  const name = cleanText(raw.name, 80) || "file";
  const type = cleanText(raw.type, 60).toLowerCase();
  const data = String(raw.data || "");
  const allowed =
    /^image\/(png|jpeg|webp|gif)$/.test(type) || type === "application/pdf" || type === "text/plain";
  if (!allowed) fail(400, "invalid_attachment", "Only PNG, JPEG, WebP, GIF, PDF or TXT attachments are allowed.");
  if (!data.startsWith(`data:${type};base64,`)) fail(400, "invalid_attachment", "Attachment data is invalid.");
  if (data.length > 560_000) fail(400, "attachment_too_large", "Attachments must be smaller than 400 KB.");
  return JSON.stringify({
    name,
    type,
    size: Number.isFinite(Number(raw.size)) ? Math.max(0, Math.round(Number(raw.size))) : Math.round((data.length * 3) / 4),
    url: data
  });
}

function saveSupportMessage(connection, ticketId, authorId, body, attachmentJson, kind = "message", at = nowMs()) {
  connection
    .prepare(
      `INSERT INTO support_messages (id, ticket_id, author_id, body, attachment_json, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(crypto.randomUUID(), String(ticketId), authorId ? String(authorId) : null, body, attachmentJson, kind, at);
}

export async function sqlCreateTicket(userId, { subject, category = "general", priority = "normal", body = "", attachment = null }) {
  const db = await conn();
  const title = cleanText(subject, 160);
  if (title.length < 3) fail(400, "invalid_subject", "Subject must be at least 3 characters.");
  const cat = cleanText(category, 40) || "general";
  const level = TICKET_PRIORITIES.includes(String(priority)) ? String(priority) : "normal";
  const text = cleanText(body, 4000);
  const attachmentJson = cleanAttachment(attachment);
  if (!text && !attachmentJson) fail(400, "empty_message", "Describe the issue in the ticket.");
  const id = crypto.randomUUID();
  const now = nowMs();
  transaction((connection) => {
    connection
      .prepare(
        `INSERT INTO support_tickets (id, user_id, subject, category, priority, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(id, String(userId), title, cat, level, now, now);
    saveSupportMessage(connection, id, userId, text, attachmentJson, "message", now);
  });
  return mapTicket(ticketWithAssignee(db, id), ticketMessages(db, id));
}

export async function sqlListTickets(userId, role, { status = "", limit = 25, offset = 0 } = {}) {
  const db = await conn();
  const size = pageLimit(limit, 25, 50);
  const skip = Math.max(0, Math.floor(toNumber(offset, 0)));
  const statusFilter = TICKET_STATUSES.includes(String(status)) ? "AND t.status = ?" : "";
  const statusParams = statusFilter ? [String(status)] : [];
  const rows = isStaff(role)
    ? db
        .prepare(
          `SELECT t.*, u.username AS assignee_username, u.nick AS assignee_nick
           FROM support_tickets t LEFT JOIN users u ON u.id = t.assigned_to
           WHERE 1 = 1 ${statusFilter} ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`
        )
        .all(...statusParams, size, skip)
    : db
        .prepare(
          `SELECT t.*, u.username AS assignee_username, u.nick AS assignee_nick
           FROM support_tickets t LEFT JOIN users u ON u.id = t.assigned_to
           WHERE t.user_id = ? ${statusFilter} ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`
        )
        .all(String(userId), ...statusParams, size, skip);
  const owners = new Map();
  return rows.map((row) => {
    if (!owners.has(row.user_id)) owners.set(row.user_id, mapUser(userRowById(db, row.user_id)));
    return { ...mapTicket(row), user: owners.get(row.user_id) };
  });
}

export async function sqlGetTicket(userId, role, ticketId) {
  const db = await conn();
  const row = ticketWithAssignee(db, ticketId);
  if (!row) fail(404, "ticket_not_found", "That support ticket does not exist.");
  if (String(row.user_id) !== String(userId) && !isStaff(role)) fail(403, "forbidden", "You cannot view this ticket.");
  return { ...mapTicket(row, ticketMessages(db, ticketId)), user: mapUser(userRowById(db, row.user_id)) };
}

export async function sqlAddTicketMessage(userId, role, ticketId, body, attachment = null) {
  const db = await conn();
  const row = db.prepare("SELECT * FROM support_tickets WHERE id = ?").get(String(ticketId));
  if (!row) fail(404, "ticket_not_found", "That support ticket does not exist.");
  if (String(row.user_id) !== String(userId) && !isStaff(role)) fail(403, "forbidden", "You cannot reply to this ticket.");
  if (row.status === "closed" && !isStaff(role)) fail(409, "ticket_closed", "This ticket is closed. Open a new one or ask staff to reopen it.");
  const text = cleanText(body, 4000);
  const attachmentJson = cleanAttachment(attachment);
  if (!text && !attachmentJson) fail(400, "empty_message", "Message body cannot be empty.");
  const now = nowMs();
  transaction((connection) => {
    saveSupportMessage(connection, row.id, userId, text, attachmentJson, "message", now);
    connection
      .prepare(
        "UPDATE support_tickets SET updated_at = ?, status = CASE WHEN status = 'closed' THEN 'pending' ELSE status END WHERE id = ?"
      )
      .run(now, row.id);
  });
  return sqlGetTicket(userId, role, row.id);
}

export async function sqlListSupportAgents() {
  const db = await conn();
  const placeholders = STAFF_ROLES.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM users WHERE role IN (${placeholders}) AND deleted_at IS NULL ORDER BY role DESC, username ASC LIMIT 50`
    )
    .all(...STAFF_ROLES)
    .map(mapUser);
}

export async function sqlListStaffIds() {
  const db = await conn();
  const placeholders = STAFF_ROLES.map(() => "?").join(",");
  return db
    .prepare(`SELECT id FROM users WHERE role IN (${placeholders}) AND deleted_at IS NULL LIMIT 100`)
    .all(...STAFF_ROLES)
    .map((row) => String(row.id));
}

/* Staff-only: priority / status / assignment / resolution. Returns the fresh
   ticket plus an `events` block so the route can notify the right people. */
export async function sqlPatchTicket(userId, role, ticketId, { status, priority, assignedTo, resolution } = {}) {
  const db = await conn();
  if (!isStaff(role)) fail(403, "forbidden", "Only staff can change ticket status.");
  const row = db.prepare("SELECT * FROM support_tickets WHERE id = ?").get(String(ticketId));
  if (!row) fail(404, "ticket_not_found", "That support ticket does not exist.");
  const nextStatus = status === undefined ? row.status : cleanText(status, 20);
  if (!TICKET_STATUSES.includes(nextStatus)) fail(400, "invalid_status", "Ticket status is not valid.");
  const nextPriority = priority === undefined ? row.priority : cleanText(priority, 20);
  if (!TICKET_PRIORITIES.includes(nextPriority)) fail(400, "invalid_priority", "Ticket priority is not valid.");
  let nextAssignee = row.assigned_to || null;
  if (assignedTo !== undefined) {
    const raw = String(assignedTo || "").trim();
    if (!raw) {
      nextAssignee = null;
    } else {
      const agent = db.prepare("SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL").get(raw);
      if (!agent || !isStaff(agent.role)) fail(400, "invalid_assignee", "Assign tickets to support staff only.");
      nextAssignee = String(agent.id);
    }
  }
  const nextResolution = resolution === undefined ? row.resolution || "" : cleanText(resolution, 2000);
  const now = nowMs();
  let resolvedAt = row.resolved_at ? Number(row.resolved_at) : null;
  if (nextStatus === "resolved" && row.status !== "resolved") resolvedAt = now;
  if (nextStatus !== "resolved") resolvedAt = null;

  const statusChanged = nextStatus !== row.status;
  const assigneeChanged = (nextAssignee || "") !== (row.assigned_to || "");
  const changes = [];
  if (statusChanged) changes.push(`وضعیت به «${TICKET_STATUS_LABELS[nextStatus]}» تغییر کرد.`);
  if (assigneeChanged) changes.push(nextAssignee ? "تیکت به یکی از کارکنان پشتیبانی ارجاع شد." : "ارجاع تیکت برداشته شد.");
  if (nextPriority !== row.priority) changes.push("اولویت تیکت به‌روزرسانی شد.");

  transaction((connection) => {
    connection
      .prepare(
        `UPDATE support_tickets
         SET status = ?, priority = ?, assigned_to = ?, resolved_at = ?, resolution = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(nextStatus, nextPriority, nextAssignee, resolvedAt, nextResolution, now, row.id);
    if (changes.length) saveSupportMessage(connection, row.id, userId, changes.join(" "), "", "system", now);
  });

  const ticket = await sqlGetTicket(userId, role, row.id);
  return {
    ...ticket,
    events: {
      statusChanged,
      previousStatus: row.status,
      assigneeChanged,
      assignedTo: nextAssignee,
      resolution: nextResolution
    }
  };
}

/* ----------------------------------------------------------- notifications */

export function mapNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body || "",
    link: row.link || "",
    read: Boolean(row.read_at),
    delivered: Boolean(row.delivered_at),
    createdAt: Number(row.created_at || 0)
  };
}

function minutesOfDay(value) {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value).trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (match) {
    const hours = Number(match[1]);
    const mins = Number(match[2]);
    if (hours > 23 || mins > 59) return null;
    return hours * 60 + mins;
  }
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0 || number > 1439) return null;
  return Math.floor(number);
}

function notificationPrefsRow(db, userId) {
  return db.prepare("SELECT * FROM notification_prefs WHERE user_id = ?").get(String(userId));
}

function quietWindowActive(row) {
  if (!row) return false;
  const from = row.quiet_from === null || row.quiet_from === undefined ? null : Number(row.quiet_from);
  const to = row.quiet_to === null || row.quiet_to === undefined ? null : Number(row.quiet_to);
  if (from === null || to === null || from === to) return false;
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

function scopeMuted(prefs, room, server) {
  if (room) {
    const rooms = prefs.rooms && typeof prefs.rooms === "object" ? prefs.rooms : {};
    const code = String(room).toUpperCase();
    if (rooms[code] === false) return true;
  }
  if (server) {
    const servers = prefs.servers && typeof prefs.servers === "object" ? prefs.servers : {};
    if (servers[String(server)] === false) return true;
  }
  return false;
}

/* Creates one notification unless the user muted the category (or the room /
   server), and dedupes identical events inside a time window. Quiet hours keep
   the item in history but stop the realtime push. Returns
   { id, push, ... } or null when nothing was stored. */
export function createNotification(db, userId, kind, title, body = "", link = "", options = {}) {
  try {
    const key = String(userId || "");
    if (!key) return null;
    const type = String(kind || "system").slice(0, 40);
    const prefsRow = notificationPrefsRow(db, key);
    const prefs = prefsRow ? safeJson(prefsRow.prefs_json, {}) : {};
    if (prefs.all === false || prefs[type] === false) return null;
    if (scopeMuted(prefs, options.room, options.server)) return null;
    const dedupeKey = String(options.dedupeKey || "").slice(0, 120);
    const windowMs = Math.max(30_000, Number(options.dedupeWindowMs) || 5 * 60_000);
    const now = nowMs();
    if (dedupeKey) {
      const dup = db
        .prepare(
          "SELECT 1 AS hit FROM notifications WHERE user_id = ? AND dedupe_key = ? AND created_at > ? LIMIT 1"
        )
        .get(key, dedupeKey, now - windowMs);
      if (dup) return null;
    }
    const id = crypto.randomUUID();
    const createdAt = now;
    const expiresAt = options.expiresAt ? Number(options.expiresAt) : now + 90 * 24 * 3600_000;
    db.prepare(
      `INSERT INTO notifications (id, user_id, kind, title, body, link, dedupe_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      key,
      type,
      String(title || "").slice(0, 160),
      String(body || "").slice(0, 600),
      String(link || "").slice(0, 300),
      dedupeKey,
      createdAt,
      expiresAt
    );
    return {
      id,
      kind: type,
      title: String(title || "").slice(0, 160),
      body: String(body || "").slice(0, 600),
      link: String(link || "").slice(0, 300),
      createdAt,
      push: !quietWindowActive(prefsRow)
    };
  } catch {
    return null;
  }
}

export function markNotificationDelivered(db, userId, notificationId) {
  try {
    db.prepare("UPDATE notifications SET delivered_at = ? WHERE id = ? AND user_id = ?").run(
      nowMs(),
      String(notificationId),
      String(userId)
    );
    return true;
  } catch {
    return false;
  }
}

export async function sqlCreateNotification(userId, kind, title, body = "", link = "", options = {}) {
  const db = await conn();
  return createNotification(db, userId, kind, title, body, link, options);
}

export async function sqlListNotifications(userId, { unread = false, limit = 30, before = 0 } = {}) {
  const db = await conn();
  const size = pageLimit(limit, 30, 50);
  const cursor = Math.max(0, Number(before) || 0);
  const where = unread ? "AND read_at IS NULL" : "";
  const rows = cursor
    ? db
        .prepare(
          `SELECT * FROM notifications WHERE user_id = ? ${where} AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .all(String(userId), cursor, size)
    : db
        .prepare(`SELECT * FROM notifications WHERE user_id = ? ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(String(userId), size);
  const unreadCount = Number(
    db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(String(userId))?.n || 0
  );
  return {
    unread: unreadCount,
    notifications: rows.map(mapNotification),
    nextBefore: rows.length === size ? Number(rows[rows.length - 1].created_at || 0) : null
  };
}

export async function sqlMarkNotificationsRead(userId, ids) {
  const db = await conn();
  const now = nowMs();
  const list = Array.isArray(ids) ? ids.map((id) => String(id || "")).filter(Boolean).slice(0, 200) : [];
  if (list.length) {
    const placeholders = list.map(() => "?").join(",");
    const info = db
      .prepare(
        `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders})`
      )
      .run(now, String(userId), ...list);
    return { ok: true, read: Number(info.changes || 0) };
  }
  const info = db
    .prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
    .run(now, String(userId));
  return { ok: true, read: Number(info.changes || 0) };
}

export async function sqlMarkAllNotificationsRead(userId) {
  return sqlMarkNotificationsRead(userId, []);
}

export async function sqlGetNotificationPrefs(userId) {
  const db = await conn();
  const row = notificationPrefsRow(db, userId);
  const prefs = row ? safeJson(row.prefs_json, {}) : {};
  return {
    prefs,
    rooms: prefs.rooms && typeof prefs.rooms === "object" ? prefs.rooms : {},
    servers: prefs.servers && typeof prefs.servers === "object" ? prefs.servers : {},
    quietFrom: row?.quiet_from === null || row?.quiet_from === undefined ? null : Number(row.quiet_from),
    quietTo: row?.quiet_to === null || row?.quiet_to === undefined ? null : Number(row.quiet_to),
    quietActive: quietWindowActive(row),
    updatedAt: row ? Number(row.updated_at || 0) : null
  };
}

export async function sqlPutNotificationPrefs(userId, { prefs = {}, quietFrom = null, quietTo = null } = {}) {
  const db = await conn();
  const clean = {};
  if (prefs && typeof prefs === "object" && !Array.isArray(prefs)) {
    for (const [key, value] of Object.entries(prefs).slice(0, 40)) {
      const name = cleanText(key, 40);
      if (!name) continue;
      if (name === "rooms" || name === "servers") {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const map = {};
          for (const [raw, muted] of Object.entries(value).slice(0, 100)) {
            const scope = cleanText(raw, 64);
            if (scope) map[name === "rooms" ? scope.toUpperCase() : scope] = Boolean(muted);
          }
          clean[name] = map;
        }
        continue;
      }
      clean[name] = Boolean(value);
    }
  }
  const from = minutesOfDay(quietFrom);
  const to = minutesOfDay(quietTo);
  const now = nowMs();
  db.prepare(
    `INSERT INTO notification_prefs (user_id, prefs_json, quiet_from, quiet_to, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       prefs_json = excluded.prefs_json, quiet_from = excluded.quiet_from,
       quiet_to = excluded.quiet_to, updated_at = excluded.updated_at`
  ).run(String(userId), JSON.stringify(clean), from, to, now);
  return sqlGetNotificationPrefs(userId);
}

export { REQUEST_STATUSES, REPORT_STATUSES, REPORT_TARGETS, LIBRARY_KINDS, TICKET_STATUSES, TICKET_PRIORITIES };
