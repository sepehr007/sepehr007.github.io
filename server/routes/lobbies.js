import crypto from "node:crypto";
import { Lobby } from "../models/Lobby.js";
import { Room } from "../models/Room.js";
import { User } from "../models/User.js";
import { dbReady } from "../db.js";
import { requireAuth } from "./auth.js";

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
    if (!dbReady()) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    const lobbies = await Lobby.find({ owner: req.auth.userId })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean();
    return { ok: true, lobbies };
  });

  app.get("/active", { preHandler: requireAuth }, async (req, reply) => {
    if (!dbReady()) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
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
    if (!dbReady()) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    let code = cleanText(body.code, 16).toUpperCase();
    if (code && !CODE_RE.test(code)) return fail(reply, 400, "invalid_code", "Lobby code is invalid.");
    if (!code) code = await uniqueCode();
    const name = cleanText(body.name, 60) || "لابی من";
    const capacity = Math.max(2, Math.min(24, Number(body.capacity) || 6));
    const privacy = body.privacy === "password" ? "password" : "public";

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
    return reply.code(201).send({ ok: true, lobby });
  });

  app.patch("/:code/close", { preHandler: requireAuth }, async (req, reply) => {
    if (!dbReady()) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    const code = cleanText(req.params.code, 16).toUpperCase();
    const reason = cleanText(req.body?.reason, 40) || "closed";
    const lobby = await Lobby.findOneAndUpdate(
      { code, owner: req.auth.userId, active: true },
      { $set: { active: false, closedAt: new Date(), closeReason: reason } },
      { new: true }
    );
    if (!lobby) return { ok: true, lobby: null };
    await Room.updateMany({ roomCode: code, isActive: true }, { $set: { isActive: false } });
    return { ok: true, lobby };
  });

  app.post("/:code/touch", { preHandler: requireAuth }, async (req, reply) => {
    if (!dbReady()) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    const code = cleanText(req.params.code, 16).toUpperCase();
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
