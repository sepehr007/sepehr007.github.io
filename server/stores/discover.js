import { getDatabase } from "../database/index.js";
import { RoomError, maybeCleanup } from "./watchRooms.js";

const SORTS = ["activity", "members", "newest", "name"];
const FILTERS = ["open", "nopass", "active"];

function fail(status, code, message) {
  throw new RoomError(status, code, message);
}

function cleanText(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function likeArg(value) {
  return `%${String(value || "").replace(/[\\%_]/g, "\\$&")}%`;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pageSize(value, fallback = 12, max = 40) {
  return Math.min(max, Math.max(1, Math.round(toNumber(value, fallback))));
}

async function conn() {
  const db = await getDatabase();
  if (!db) fail(503, "database_unavailable", "Database is not connected yet.");
  return db;
}

const PUBLIC_WHERE = "r.visibility = 'public' AND r.is_active = 1 AND r.deleted_at IS NULL";
const ACTIVE_MEMBERS = "(SELECT COUNT(*) FROM room_memberships m WHERE m.room_id = r.id AND m.left_at IS NULL)";

const ROOM_SELECT = `
  SELECT r.*,
    u.username AS manager_username,
    u.nick AS manager_nick,
    u.avatar AS manager_avatar,
    ${ACTIVE_MEMBERS} AS active_members,
    EXISTS(SELECT 1 FROM room_memberships vm WHERE vm.room_id = r.id AND vm.user_id = ? AND vm.left_at IS NULL) AS joined,
    EXISTS(SELECT 1 FROM room_visits rv WHERE rv.room_id = r.id AND rv.user_id = ?) AS visited
  FROM rooms r
  LEFT JOIN users u ON u.id = r.host_id
`;

export function mapPublicRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.room_code,
    name: row.name || "",
    description: row.description || "",
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
    joined: Boolean(row.joined),
    visited: Boolean(row.visited)
  };
}

function sortSql(sort) {
  switch (sort) {
    case "members":
      return `${ACTIVE_MEMBERS} DESC, r.last_activity_at DESC`;
    case "newest":
      return "r.created_at DESC, r.last_activity_at DESC";
    case "name":
      return "lower(r.name) ASC, r.room_code ASC";
    default:
      return "r.last_activity_at DESC, r.created_at DESC";
  }
}

function filterParts(filterRaw) {
  const wanted = new Set(
    String(filterRaw || "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => FILTERS.includes(token))
  );
  const clauses = [];
  if (wanted.has("open")) clauses.push(`${ACTIVE_MEMBERS} < r.capacity`);
  if (wanted.has("nopass")) clauses.push("COALESCE(r.password_hash, '') = ''");
  if (wanted.has("active")) clauses.push("r.last_activity_at >= ?");
  return { tokens: [...wanted], clauses, activeSince: Date.now() - 24 * 60 * 60 * 1000 };
}

export async function discoverRooms(viewerId, { q = "", sort = "activity", page = 1, limit = 12, filter = "" } = {}) {
  const db = await conn();
  await maybeCleanup();
  const term = cleanText(q, 60);
  const order = SORTS.includes(String(sort)) ? String(sort) : "activity";
  const size = pageSize(limit);
  const currentPage = Math.max(1, Math.min(1000, Math.floor(toNumber(page, 1))));
  const offset = (currentPage - 1) * size;
  const filters = filterParts(filter);

  const where = [PUBLIC_WHERE];
  const params = [];
  if (term) {
    where.push("(r.name LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR r.room_code LIKE ? ESCAPE '\\')");
    const like = likeArg(term);
    params.push(like, like, likeArg(term.toUpperCase()));
  }
  for (const clause of filters.clauses) {
    where.push(clause);
    if (clause.includes("?")) params.push(filters.activeSince);
  }
  const whereSql = where.join(" AND ");

  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM rooms r WHERE ${whereSql}`).get(...params);
  const rows = db
    .prepare(`${ROOM_SELECT} WHERE ${whereSql} ORDER BY ${sortSql(order)} LIMIT ? OFFSET ?`)
    .all(String(viewerId || ""), String(viewerId || ""), ...params, size, offset);

  const total = Number(totalRow?.n || 0);
  return {
    rooms: rows.map(mapPublicRoom),
    total,
    page: currentPage,
    limit: size,
    hasMore: offset + rows.length < total,
    sort: order,
    filters: filters.tokens
  };
}

export async function suggestRooms(viewerId, q, limit = 8) {
  const db = await conn();
  const term = cleanText(q, 60);
  if (term.length < 2) return [];
  const size = Math.min(12, Math.max(1, Math.round(toNumber(limit, 8))));
  const rows = db
    .prepare(
      `${ROOM_SELECT}
       WHERE ${PUBLIC_WHERE}
         AND (r.name LIKE ? ESCAPE '\\' OR r.room_code LIKE ? ESCAPE '\\' OR u.nick LIKE ? ESCAPE '\\')
       ORDER BY r.last_activity_at DESC LIMIT ?`
    )
    .all(String(viewerId || ""), String(viewerId || ""), likeArg(term), likeArg(term.toUpperCase()), likeArg(term), size);
  return rows.map((row) => {
    const room = mapPublicRoom(row);
    return {
      code: room.code,
      name: room.name,
      memberCount: room.memberCount,
      hasPassword: room.hasPassword
    };
  });
}

/* Recommendations only use data the viewer is already allowed to see:
   public active rooms, their own friendships and their own join state.
   A room is suggested only when at least one real reason exists. */
export async function recommendRooms(viewerId, limit = 6) {
  const db = await conn();
  const size = Math.min(12, Math.max(1, Math.round(toNumber(limit, 6))));
  const viewer = String(viewerId || "");
  const now = Date.now();

  const friendRows = db
    .prepare(
      `${ROOM_SELECT}
       JOIN friendships f
         ON (f.user_a = ? AND f.user_b = r.host_id) OR (f.user_b = ? AND f.user_a = r.host_id)
       WHERE ${PUBLIC_WHERE} AND r.host_id <> ?
         AND NOT EXISTS(SELECT 1 FROM room_memberships me WHERE me.room_id = r.id AND me.user_id = ? AND me.left_at IS NULL)
       ORDER BY r.last_activity_at DESC LIMIT ?`
    )
    .all(viewer, viewer, viewer, viewer, viewer, viewer, size);
  const friends = new Set(
    db
      .prepare(
        `SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS friend_id
         FROM friendships WHERE user_a = ? OR user_b = ?`
      )
      .all(viewer, viewer, viewer)
      .map((row) => row.friend_id)
  );

  const picked = new Map();
  for (const row of friendRows) {
    const room = mapPublicRoom(row);
    picked.set(room.id, {
      room,
      reason: "friend",
      friendNick: room.manager.nick || room.manager.username || ""
    });
  }

  if (picked.size < size) {
    const rows = db
      .prepare(
        `${ROOM_SELECT}
         WHERE ${PUBLIC_WHERE} AND r.host_id <> ?
           AND NOT EXISTS(SELECT 1 FROM room_memberships me WHERE me.room_id = r.id AND me.user_id = ? AND me.left_at IS NULL)
         ORDER BY ${ACTIVE_MEMBERS} DESC, r.last_activity_at DESC LIMIT ?`
      )
      .all(viewer, viewer, viewer, viewer, Math.max(size * 4, 16));
    for (const row of rows) {
      if (picked.size >= size) break;
      const room = mapPublicRoom(row);
      if (picked.has(room.id)) continue;
      let reason = "";
      if (friends.has(room.manager.id)) reason = "friend";
      else if (room.memberCount > 0 && now - room.lastActivityAt < 60 * 60 * 1000) reason = "live";
      else if (now - room.createdAt < 24 * 60 * 60 * 1000) reason = "fresh";
      if (!reason) continue;
      picked.set(room.id, {
        room,
        reason,
        friendNick: reason === "friend" ? room.manager.nick || room.manager.username || "" : ""
      });
    }
  }

  return [...picked.values()];
}
