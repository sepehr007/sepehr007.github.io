import crypto from "node:crypto";
import { Lobby } from "../models/Lobby.js";
import { Room } from "../models/Room.js";
import { User } from "../models/User.js";
import { dbReady } from "../db.js";
import { requireAuth } from "./auth.js";
import { ensureStore } from "../userStore.js";
import { sqlListLobbies, sqlActiveLobby, sqlCreateLobby, sqlCloseLobby, sqlTouchLobby } from "../stores/lobbies.js";
import { audit } from "../audit.js";
import { resolveFeatureState, isEnabled } from "../features.js";
import { settingNumber, settingValue } from "../platformSettings.js";
import { roomEntitlement } from "../entitlements.js";
import { createRoom, forceCloseRoom, RoomError } from "../stores/watchRooms.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-Z0-9-]{4,16}$/;
const LIFETIME_MS = 24 * 60 * 60 * 1000;

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

function cleanText(value, max = 120) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function makeCode() {
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

async function uniqueCode() {
  for (let i = 0; i < 10; i++) {
    const code = makeCode();
    const exists = await Lobby.exists({ code });
    if (!exists) return code;
  }
  return `${makeCode()}${Date.now().toString(36).slice(-2).toUpperCase()}`.slice(0, 16);
}

async function ownerName(userId) {
  const user = await User.findById(userId).select("username").lean();
  return user?.username || "";
}

async function closeActiveLobbies(userId, reason) {
  return Lobby.updateMany(
    { owner: userId, active: true },
    { $set: { active: false, closedAt: new Date(), closeReason: reason } }
  );
}

async function syncRoom(lobby, userId) {
  try {
    await Room.updateMany({ hostId: userId, isActive: true }, { $set: { isActive: false } });
    await Room.create({
      roomCode: lobby.code,
      name: lobby.name,
      hostId: userId,
      isActive: true,
      settings: {
        capacity: lobby.capacity,
        isPrivate: lobby.privacy === "password"
      },
      memberCount: 0,
      lastActivityAt: new Date()
    });
  } catch {}
}

export default async function lobbyRoutes(app) {
  app.get("/", { preHandler: requireAuth }, async (req, reply) => {
    if (!dbReady()) {
      if (!(await ensureStore())) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
      return { ok: true, lobbies: await sqlListLobbies(req.auth.userId) };
    }
    const lobbies = await Lobby.find({ owner: req.auth.userId })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean();
    return { ok: true, lobbies };
  });

  app.get("/active", { preHandler: requireAuth }, async (req, reply) => {
    if (!dbReady()) {
      if (!(await ensureStore())) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
      return { ok: true, lobby: await sqlActiveLobby(req.auth.userId) };
    }
    await Lobby.updateMany(
      { owner: req.auth.userId, active: true, expiresAt: { $lte: new Date() } },
      { $set: { active: false, closedAt: new Date(), closeReason: "expired" } }
    );
    const lobby = await Lobby.findOne({ owner: req.auth.userId, active: true })
      .sort({ createdAt: -1 })
      .lean();
    return { ok: true, lobby: lobby || null };
  });

  app.post("/", { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const access = await resolveFeatureState({ userId: req.auth.userId, role: req.auth.role });
    if (!isEnabled(access, "access.roomCreate")) {
      return fail(reply, 403, "rooms_closed", "Creating rooms is closed by the site owner.");
    }
    const wantsPassword = body.privacy === "password";
    if (wantsPassword && !isEnabled(access, "features.roomPrivate")) {
      return fail(reply, 403, "private_rooms_closed", "Private rooms are disabled by the site owner.");
    }
    if (!wantsPassword && !isEnabled(access, "features.roomPublic")) {
      return fail(reply, 403, "public_rooms_closed", "Public rooms are disabled by the site owner.");
    }
    const entitlement = await roomEntitlement(req.auth.userId, req.auth.role);
    if (!entitlement.premium) {
      return fail(reply, 403, "premium_required", "به اشتراک فعال نیاز داری تا بتوانی اتاق بسازی.");
    }
    let code = cleanText(body.code, 16).toUpperCase();
    if (code && !CODE_RE.test(code)) return fail(reply, 400, "invalid_code", "Lobby code is invalid.");
    const name = cleanText(body.name, 60) || "لابی من";
    const maxCapacity = Math.min(48, Math.max(2, Math.round(await settingNumber("limits.maxCapacity", 24))));
    const defaultCapacity = Math.min(maxCapacity, Math.max(2, Math.round(await settingNumber("limits.defaultCapacity", 6))));
    const capacity = Math.max(2, Math.min(maxCapacity, Number(body.capacity) || defaultCapacity));
    const fallbackPrivacy = (await settingValue("room.defaultPrivacy", "public")) === "password" ? "password" : "public";
    const privacy = wantsPassword ? "password" : fallbackPrivacy;

    if (!dbReady()) {
      if (!(await ensureStore())) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
      let lobby;
      try {
        lobby = await sqlCreateLobby({
          code,
          name,
          capacity,
          privacy,
          userId: req.auth.userId,
          ownerUsername: ""
        });
      } catch (err) {
        if (String(err?.message || "").includes("UNIQUE")) {
          return fail(reply, 409, "already_exists", "That lobby code or an active lobby already exists.");
        }
        throw err;
      }
      try {
        await createRoom(req.auth.userId, req.auth.role, {
          code: lobby.code,
          name,
          capacity,
          joinMode: privacy === "password" ? "password" : "open",
          password: String(body.password || ""),
          visibility: "public"
        });
      } catch (err) {
        await sqlCloseLobby(lobby.code, req.auth.userId, "create_failed").catch(() => {});
        if (err instanceof RoomError) return fail(reply, err.status, err.code, err.message);
        throw err;
      }
      await audit("lobby.create", req, {
        targetType: "lobby",
        targetId: lobby.code,
        meta: { capacity, privacy }
      });
      return reply.code(201).send({ ok: true, lobby });
    }

    if (!code) code = await uniqueCode();
    await closeActiveLobbies(req.auth.userId, "replaced");
    let lobby;
    try {
      lobby = await Lobby.create({
        code,
        owner: req.auth.userId,
        ownerUsername: await ownerName(req.auth.userId),
        name,
        capacity,
        privacy,
        active: true,
        lastActivityAt: new Date(),
        expiresAt: new Date(Date.now() + LIFETIME_MS)
      });
    } catch (err) {
      if (err?.code === 11000) {
        return fail(reply, 409, "already_exists", "That lobby code or an active lobby already exists.");
      }
      throw err;
    }
    await syncRoom(lobby, req.auth.userId);
    await audit("lobby.create", req, {
      targetType: "lobby",
      targetId: lobby.code,
      meta: { capacity, privacy }
    });
    return reply.code(201).send({ ok: true, lobby });
  });

  app.patch("/:code/close", { preHandler: requireAuth }, async (req, reply) => {
    const code = cleanText(req.params.code, 16).toUpperCase();
    const reason = cleanText(req.body?.reason, 40) || "closed";
    if (!dbReady()) {
      if (!(await ensureStore())) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
      const lobby = await sqlCloseLobby(code, req.auth.userId, reason);
      await forceCloseRoom(code, req.auth.userId).catch(() => {});
      try { req.server.notifyRoom?.(code, { type: "room-event", event: "closed", code }); } catch {}
      await audit("lobby.close", req, { targetType: "lobby", targetId: code, meta: { reason } });
      return { ok: true, lobby };
    }
    const lobby = await Lobby.findOneAndUpdate(
      { code, owner: req.auth.userId, active: true },
      { $set: { active: false, closedAt: new Date(), closeReason: reason } },
      { new: true }
    );
    if (!lobby) return { ok: true, lobby: null };
    await Room.updateMany({ roomCode: code, isActive: true }, { $set: { isActive: false } });
    try { req.server.notifyRoom?.(code, { type: "room-event", event: "closed", code }); } catch {}
    await audit("lobby.close", req, { targetType: "lobby", targetId: code, meta: { reason } });
    return { ok: true, lobby };
  });

  app.post("/:code/touch", { preHandler: requireAuth }, async (req, reply) => {
    const code = cleanText(req.params.code, 16).toUpperCase();
    if (!dbReady()) {
      if (!(await ensureStore())) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
      return { ok: true, lobby: await sqlTouchLobby(code, req.auth.userId) };
    }
    const now = new Date();
    const lobby = await Lobby.findOneAndUpdate(
      { code, owner: req.auth.userId, active: true },
      { $set: { lastActivityAt: now, expiresAt: new Date(Date.now() + LIFETIME_MS) } },
      { new: true }
    );
    if (lobby) await Room.updateOne({ roomCode: code }, { $set: { lastActivityAt: now } });
    return { ok: true, lobby: lobby || null };
  });
}
