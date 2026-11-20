import { dbReady } from "../db.js";
import { getDatabase, get } from "../database/index.js";
import { requireAuth } from "./auth.js";
import { audit } from "../audit.js";
import { resolveFeatureState, isEnabled } from "../features.js";
import { sqlPlanQuota } from "../stores/billing.js";
import {
  RoomError,
  createRoom,
  getRoom,
  listMyRooms,
  listRecentRooms,
  joinRoom,
  leaveRoom,
  touchRoom,
  listMembers,
  updateRoom,
  setMemberRole,
  kickMember,
  transferManager,
  closeRoom
} from "../stores/watchRooms.js";
import { sqlCreateInvite, sqlListInvites, sqlRevokeInvite } from "../stores/social.js";
import { discoverRooms, suggestRooms, recommendRooms } from "../stores/discover.js";
import { deliverNotice } from "../notify.js";

const AUTH = [requireAuth];

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

function body(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

function handle(fn) {
  return async (req, reply) => {
    if (dbReady()) {
      return fail(reply, 503, "database_unavailable", "Room management needs the SQLite deployment.");
    }
    const db = await getDatabase();
    if (!db) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    try {
      return await fn(req, reply);
    } catch (err) {
      if (err instanceof RoomError) return fail(reply, err.status, err.code, err.message);
      if (String(err?.message || "") === "database_not_open") {
        return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
      }
      throw err;
    }
  };
}

function notifyRoom(req, code, payload) {
  try {
    req.server.notifyRoom?.(String(code || "").toUpperCase(), payload);
  } catch {}
}

function notifyUser(req, userId, event, data) {
  try {
    req.server.notifyUser?.(userId, { type: "room", event, data });
  } catch {}
}

async function flags(req) {
  return resolveFeatureState({ userId: req.auth.userId, role: req.auth.role });
}

export default async function roomRoutes(app) {
  app.get("/discover", { preHandler: AUTH }, handle(async (req, reply) => {
    const state = await flags(req);
    if (!isEnabled(state, "features.publicDiscovery")) {
      return fail(reply, 403, "discovery_closed", "Room discovery is disabled by the site owner.");
    }
    const result = await discoverRooms(req.auth.userId, {
      q: req.query?.q,
      sort: req.query?.sort,
      page: req.query?.page,
      limit: req.query?.limit,
      filter: req.query?.filter
    });
    return { ok: true, ...result };
  }));

  app.get("/suggest", { preHandler: AUTH }, handle(async (req, reply) => {
    const state = await flags(req);
    if (!isEnabled(state, "features.publicDiscovery")) {
      return fail(reply, 403, "discovery_closed", "Room discovery is disabled by the site owner.");
    }
    const suggestions = await suggestRooms(req.auth.userId, req.query?.q, req.query?.limit);
    return { ok: true, suggestions };
  }));

  app.get("/recommend", { preHandler: AUTH }, handle(async (req, reply) => {
    const state = await flags(req);
    if (!isEnabled(state, "features.publicDiscovery")) {
      return fail(reply, 403, "discovery_closed", "Room discovery is disabled by the site owner.");
    }
    const rooms = await recommendRooms(req.auth.userId, req.query?.limit);
    return { ok: true, rooms, generatedAt: Date.now() };
  }));

  app.get("/mine", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, rooms: await listMyRooms(req.auth.userId) };
  }));

  app.get("/recent", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, rooms: await listRecentRooms(req.auth.userId, req.query?.limit) };
  }));

  app.post("/", { preHandler: AUTH }, handle(async (req, reply) => {
    const payload = body(req);
    const state = await flags(req);
    if (!isEnabled(state, "access.roomCreate")) {
      return fail(reply, 403, "rooms_closed", "Creating rooms is closed by the site owner.");
    }
    const wantsPrivate = payload.visibility === "private" || payload.visibility === "unlisted" || String(payload.password || "").length > 0;
    if (wantsPrivate && !isEnabled(state, "features.roomPrivate")) {
      return fail(reply, 403, "private_rooms_closed", "Private rooms are disabled by the site owner.");
    }
    if (!wantsPrivate && !isEnabled(state, "features.roomPublic")) {
      return fail(reply, 403, "public_rooms_closed", "Public rooms are disabled by the site owner.");
    }
    const quota = await sqlPlanQuota(req.auth.userId, "rooms.max");
    if (quota != null) {
      const used = get("SELECT COUNT(*) AS n FROM rooms WHERE host_id = ? AND is_active = 1 AND deleted_at IS NULL", req.auth.userId);
      if (Number(used?.n || 0) >= quota) {
        return fail(reply, 403, "quota_rooms", `پلن فعلی اجازهٔ ${quota} اتاق فعال می‌دهد؛ اول یکی از اتاق‌ها را ببند.`);
      }
    }
    const room = await createRoom(req.auth.userId, req.auth.role, payload);
    await audit("room.create", req, {
      targetType: "room",
      targetId: room.code,
      meta: { visibility: room.visibility, capacity: room.capacity, hasPassword: room.hasPassword }
    });
    notifyRoom(req, room.code, { type: "room-event", event: "created", code: room.code });
    return reply.code(201).send({ ok: true, room });
  }));

  app.get("/:code", { preHandler: AUTH }, handle(async (req) => {
    const room = await getRoom(req.params.code, req.auth.userId, req.auth.role);
    return { ok: true, room };
  }));

  app.patch("/:code", { preHandler: AUTH }, handle(async (req) => {
    const room = await updateRoom(req.auth.userId, req.auth.role, req.params.code, body(req));
    await audit("room.update", req, { targetType: "room", targetId: room.code });
    notifyRoom(req, room.code, { type: "room-event", event: "updated", code: room.code });
    return { ok: true, room };
  }));

  app.delete("/:code", { preHandler: AUTH }, handle(async (req) => {
    const code = String(req.params.code || "").toUpperCase();
    const room = await getRoom(code, req.auth.userId, req.auth.role);
    await closeRoom(req.auth.userId, req.auth.role, code, { password: body(req).password });
    await audit("room.close", req, { targetType: "room", targetId: code });
    notifyRoom(req, code, { type: "room-event", event: "closed", code, name: room.name });
    return { ok: true };
  }));

  app.post("/:code/join", { preHandler: AUTH }, handle(async (req, reply) => {
    const state = await flags(req);
    if (!isEnabled(state, "access.roomJoin")) {
      return fail(reply, 403, "rooms_closed", "Joining rooms is closed by the site owner.");
    }
    const payload = body(req);
    const result = await joinRoom(req.auth.userId, req.auth.role, req.params.code, {
      password: payload.password,
      inviteCode: payload.inviteCode
    });
    notifyRoom(req, result.room.code, { type: "room-event", event: "joined", code: result.room.code });
    if (result.room.manager?.id && result.room.manager.id !== req.auth.userId) {
      notifyUser(req, result.room.manager.id, "guest-joined", { code: result.room.code, memberCount: result.memberCount });
      await deliverNotice(req.server, result.room.manager.id, {
        kind: "room_activity",
        title: "عضو تازه در اتاق",
        body: `${req.auth.username || "کاربر"} به «${result.room.name || result.room.code}» پیوست.`,
        link: "room.html?code=" + encodeURIComponent(result.room.code),
        dedupeKey: `room_join:${result.room.code}:${req.auth.userId}`,
        dedupeWindowMs: 10 * 60_000,
        room: result.room.code
      });
    }
    return { ok: true, ...result };
  }));

  app.post("/:code/leave", { preHandler: AUTH }, handle(async (req) => {
    const result = await leaveRoom(req.auth.userId, req.params.code);
    notifyRoom(req, req.params.code, { type: "room-event", event: "left", code: req.params.code });
    return { ok: true, ...result };
  }));

  app.post("/:code/touch", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, ...(await touchRoom(req.auth.userId, req.params.code)) };
  }));

  app.get("/:code/members", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, members: await listMembers(req.params.code) };
  }));

  app.post("/:code/members/:userId/role", { preHandler: AUTH }, handle(async (req) => {
    const result = await setMemberRole(req.auth.userId, req.auth.role, req.params.code, req.params.userId, body(req).role);
    await audit("room.member_role", req, {
      targetType: "room",
      targetId: String(req.params.code || "").toUpperCase(),
      meta: { member: req.params.userId, role: body(req).role }
    });
    notifyUser(req, req.params.userId, "role", { code: req.params.code, role: body(req).role });
    notifyRoom(req, req.params.code, { type: "room-event", event: "member-role", code: req.params.code });
    return { ok: true, ...result };
  }));

  app.post("/:code/members/:userId/kick", { preHandler: AUTH }, handle(async (req) => {
    const result = await kickMember(req.auth.userId, req.auth.role, req.params.code, req.params.userId);
    await audit("room.member_kick", req, {
      targetType: "room",
      targetId: String(req.params.code || "").toUpperCase(),
      meta: { member: req.params.userId }
    });
    notifyUser(req, req.params.userId, "removed", { code: req.params.code });
    notifyRoom(req, req.params.code, { type: "room-event", event: "member-removed", code: req.params.code });
    return { ok: true, ...result };
  }));

  app.post("/:code/transfer", { preHandler: AUTH }, handle(async (req) => {
    const payload = body(req);
    const result = await transferManager(req.auth.userId, req.auth.role, req.params.code, {
      targetId: payload.userId,
      password: payload.password
    });
    await audit("room.transfer", req, {
      targetType: "room",
      targetId: result.room.code,
      meta: { to: result.to.username }
    });
    notifyUser(req, result.from, "manager-transferred", { code: result.room.code, to: result.to.username });
    notifyUser(req, result.to.id, "manager-promoted", { code: result.room.code, from: req.auth.userId });
    notifyRoom(req, result.room.code, {
      type: "room-event",
      event: "manager",
      code: result.room.code,
      manager: result.to
    });
    return { ok: true, ...result };
  }));

  app.post("/:code/invites", { preHandler: AUTH }, handle(async (req, reply) => {
    const payload = body(req);
    const invite = await sqlCreateInvite(req.auth.userId, req.auth.role, {
      roomCode: req.params.code,
      expiresInHours: payload.expiresInHours,
      maxUses: payload.maxUses
    });
    await audit("invite.create", req, {
      targetType: "invite",
      targetId: invite.id,
      meta: { roomCode: invite.roomCode, maxUses: invite.maxUses }
    });
    return reply.code(201).send({ ok: true, invite });
  }));

  app.get("/:code/invites", { preHandler: AUTH }, handle(async (req) => {
    const code = String(req.params.code || "").toUpperCase();
    const all = await sqlListInvites(req.auth.userId, 50);
    return { ok: true, invites: all.filter((invite) => String(invite.roomCode || "").toUpperCase() === code) };
  }));

  app.delete("/:code/invites/:id", { preHandler: AUTH }, handle(async (req) => {
    const invite = await sqlRevokeInvite(req.auth.userId, req.params.id);
    await audit("invite.revoke", req, { targetType: "invite", targetId: invite.id });
    return { ok: true, invite };
  }));
}
