import "dotenv/config";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import websocket from "@fastify/websocket";
import { connectDB, dbReady, dbState, disconnectDB } from "./db.js";
import { storeState } from "./userStore.js";
import { connectRedis, redisState, createRateLimiter, disconnectRedis } from "./redis.js";
import { appConfig, configWarnings, publicConfig } from "./config.js";
import { resolveFeatureState, isEnabled, summarizeFeatures, featureStatus } from "./features.js";
import { publicPlatformSettings, settingNumber } from "./platformSettings.js";
import { mailState } from "./mailer.js";
import { smsState } from "./sms.js";
import authRoutes, { authenticateToken, verificationRequired } from "./routes/auth.js";
import lobbyRoutes from "./routes/lobbies.js";
import billingRoutes from "./routes/billing.js";
import adminRoutes from "./routes/admin.js";
import platformRoutes from "./routes/platform.js";
import adminOpsRoutes from "./routes/adminOps.js";
import adminBillingRoutes from "./routes/adminBilling.js";
import socialRoutes from "./routes/social.js";
import roomRoutes from "./routes/rooms.js";
import publicPageRoutes from "./routes/publicPages.js";
import analyticsRoutes from "./routes/analytics.js";
import adminAnalyticsRoutes from "./routes/adminAnalytics.js";
import adminStorageRoutes from "./routes/adminStorage.js";
import uploadRoutes from "./routes/uploads.js";
import fileRoutes from "./routes/files.js";
import { sweepMedia } from "./storage.js";
import { scheduleOwnerBootstrap } from "./ownerBootstrap.js";
import { sqlSweepExpired } from "./stores/billing.js";
import { emitEvent } from "./automation.js";
import { startMaintenance, getDatabase, databaseState, stopMaintenance, closeDatabase } from "./database/index.js";
import { Room } from "./models/Room.js";
import { Message } from "./models/Message.js";
import { PlaybackState } from "./models/PlaybackState.js";
import { sqlRecentMessages, sqlAddMessage, sqlSavePlaybackState } from "./stores/rooms.js";

const PORT = appConfig.port;
const HOST = appConfig.host;
const ROOM_RE = /^[A-Z0-9-]{4,16}$/;
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX = 10;
const WS_VERSION = 1;
const WS_MAX_FRAME = 64 * 1024;
const WS_RT_MAX = 32 * 1024;
const WS_FLOOD_MAX = 60;
const WS_FLOOD_WINDOW_MS = 10_000;
const WS_BUFFER_MAX = 200;
const WS_REPLAY_MAX = 100;
const WS_HEARTBEAT_MS = 30_000;
const CHAT_CID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PLAYBACK_ACTIONS = new Set(["play", "pause", "seek", "state", "rate", "ended", "stop"]);

function cleanRoom(value) {
  const room = String(value || "").trim().toUpperCase();
  return ROOM_RE.test(room) ? room : "";
}

function cleanText(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanName(value) {
  return cleanText(value, 30) || "مهمان";
}

const socialSockets = new Map();
let roomNotifier = null;

export function notifyRoom(roomCode, payload) {
  if (!roomNotifier) return 0;
  return roomNotifier(String(roomCode || "").toUpperCase(), payload);
}

export function notifyUser(userId, payload) {
  const key = String(userId || "");
  const set = socialSockets.get(key);
  if (!set || set.size === 0) return 0;
  const raw = JSON.stringify(payload);
  let delivered = 0;
  for (const ws of set) {
    if (ws.readyState !== 1) {
      set.delete(ws);
      continue;
    }
    try {
      ws.send(raw);
      delivered += 1;
    } catch {
      set.delete(ws);
    }
  }
  if (set.size === 0) socialSockets.delete(key);
  return delivered;
}

function detachSocialSocket(ws, userId) {
  const key = String(userId || "");
  if (!key) return;
  const set = socialSockets.get(key);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) socialSockets.delete(key);
}

const WS_ACCESS_MESSAGES = {
  room_locked: "This room is private or password protected. Join it with an account first.",
  approval_pending: "Your join request is waiting for the Manager's approval.",
  approval_required: "This room needs the Manager's approval before you can join.",
  room_full: "This room is full right now.",
  room_closed: "This room has been closed.",
  room_not_found: "That room does not exist.",
  database_unavailable: "Database is not connected yet."
};

function registerRealtime(app) {
  const rooms = new Map();
  const allClients = new Set();

  const send = (ws, payload) => {
    if (ws.readyState !== 1) return false;
    if (typeof ws.bufferedAmount === "number" && ws.bufferedAmount > 1024 * 1024) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  const roomState = (room) => {
    let st = rooms.get(room);
    if (!st) {
      st = { clients: new Set(), seq: 0, buffer: [], cids: new Map(), playbackSavedAt: 0, emptyAt: 0 };
      rooms.set(room, st);
    }
    return st;
  };

  const memberList = (st) => [...st.clients].map((client) => ({
    id: client.id,
    name: client.name,
    identified: Boolean(client.userId),
    status: { ...client.status }
  }));

  const emit = (room, payload, { except = null, buffer = false } = {}) => {
    const st = rooms.get(room);
    if (!st) return 0;
    const event = { ...payload, room, v: WS_VERSION, seq: (st.seq += 1), at: Date.now() };
    if (buffer) {
      st.buffer.push(event);
      if (st.buffer.length > WS_BUFFER_MAX) st.buffer.shift();
    }
    let delivered = 0;
    for (const client of st.clients) {
      if (client === except) continue;
      if (send(client.ws, event)) delivered += 1;
    }
    return delivered;
  };

  roomNotifier = (room, payload) => emit(room, payload, { buffer: true });

  const leaveRoom = (client) => {
    const room = client.room;
    if (!room) return;
    const st = rooms.get(room);
    if (st) {
      st.clients.delete(client);
      emit(room, { type: "presence", members: memberList(st) });
      if (st.clients.size === 0) st.emptyAt = Date.now();
    }
    client.room = "";
    client.roomId = "";
    client.mutedUntil = 0;
  };

  const roomFeature = async (room = "") => {
    const state = await resolveFeatureState(room ? { room } : {});
    return {
      state,
      realtime: () => isEnabled(state, "features.realtimeEnabled"),
      join: () => isEnabled(state, "access.roomJoin"),
      create: () => isEnabled(state, "access.roomCreate"),
      chat: () => isEnabled(state, "features.chat"),
      playback: () => isEnabled(state, "features.sharedPlayback")
    };
  };

  const roomAccess = async (room, client) => {
    if (dbReady()) return { ok: true, roomId: "" };
    let db;
    try {
      db = await getDatabase();
    } catch {
      return { ok: false, code: "database_unavailable" };
    }
    if (!db) return { ok: true, roomId: "" };
    const row = db
      .prepare(
        `SELECT id, host_id, capacity, visibility, password_hash, is_active, deleted_at, join_mode
         FROM rooms WHERE room_code = ?`
      )
      .get(String(room).toUpperCase());
    if (!row) return { ok: true, roomId: "" };
    if (row.deleted_at) return { ok: false, code: "room_not_found" };
    if (!row.is_active) return { ok: false, code: "room_closed" };
    const member = client.userId
      ? db
          .prepare(
            "SELECT role, muted_until FROM room_memberships WHERE room_id = ? AND user_id = ? AND left_at IS NULL"
          )
          .get(row.id, String(client.userId))
      : null;
    const isHost = Boolean(client.userId) && String(row.host_id) === String(client.userId);
    const joinMode = row.join_mode
      || (row.password_hash ? "password" : row.visibility === "private" ? "invite" : "open");
    if (joinMode === "invite" && !isHost && !member) return { ok: false, code: "room_locked" };
    if (joinMode === "approval" && !isHost && !member) {
      const request = client.userId
        ? db
            .prepare("SELECT status FROM room_join_requests WHERE room_id = ? AND user_id = ?")
            .get(row.id, String(client.userId))
        : null;
      if (request?.status !== "approved") {
        return { ok: false, code: request?.status === "pending" ? "approval_pending" : "approval_required" };
      }
    }
    const gated = joinMode === "password" || Boolean(row.password_hash);
    if (gated && !isHost && !member) return { ok: false, code: "room_locked" };
    if (!isHost && !member) {
      const active = db
        .prepare("SELECT COUNT(*) AS n FROM room_memberships WHERE room_id = ? AND left_at IS NULL")
        .get(row.id);
      if (Number(active?.n || 0) >= Number(row.capacity || 6)) return { ok: false, code: "room_full" };
    }
    return { ok: true, roomId: row.id, mutedUntil: Number(member?.muted_until || 0) };
  };

  const refreshMute = async (client) => {
    if (!client.userId || !client.roomId) return 0;
    if (Date.now() - client.muteCheckedAt < 15_000) return client.mutedUntil;
    client.muteCheckedAt = Date.now();
    try {
      const db = await getDatabase();
      const row = db
        ?.prepare("SELECT muted_until FROM room_memberships WHERE room_id = ? AND user_id = ?")
        .get(client.roomId, String(client.userId));
      client.mutedUntil = Number(row?.muted_until || 0);
    } catch {}
    return client.mutedUntil;
  };

  app.get("/ws", { websocket: true }, (connection, req) => {
    const ws = connection?.socket ?? connection;
    const client = {
      id: crypto.randomUUID().slice(0, 8),
      name: "مهمان",
      username: "",
      role: "guest",
      room: "",
      roomId: "",
      userId: "",
      status: { muted: false, video: false, speaking: false },
      mutedUntil: 0,
      muteCheckedAt: 0,
      alive: true,
      strikes: 0,
      events: [],
      hits: [],
      queue: Promise.resolve(),
      ws
    };
    allClients.add(client);

    send(ws, { type: "hello", v: WS_VERSION, serverTime: Date.now(), heartbeatMs: WS_HEARTBEAT_MS });

    const handleMessage = async (raw) => {
      const size = Number(raw?.length ?? raw?.byteLength ?? 0);
      if (size > WS_MAX_FRAME) {
        send(ws, { type: "error", code: "frame_too_large", message: "Message is too large." });
        try {
          ws.close(1009, "frame_too_large");
        } catch {}
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: "error", code: "bad_json", message: "Messages must be JSON." });
      }
      const type = cleanText(msg?.type, 20);

      const now = Date.now();
      client.events = client.events.filter((t) => now - t < WS_FLOOD_WINDOW_MS);
      if (client.events.length >= WS_FLOOD_MAX) {
        client.strikes += 1;
        if (client.strikes >= 3) {
          try {
            ws.close(1008, "flood");
          } catch {}
          return;
        }
        return send(ws, { type: "error", code: "flood", message: "Too many events. Slow down." });
      }
      client.events.push(now);

      try {
        if (type === "ping") {
          client.alive = true;
          return send(ws, { type: "pong", at: Date.now(), v: WS_VERSION });
        }

        if (type === "identify") {
          const token = cleanText(msg.token, 4096);
          const auth = token ? await authenticateToken(token) : null;
          if (!auth?.userId) {
            return send(ws, { type: "error", code: "invalid_token", message: "Identify requires a valid session token." });
          }
          if ((await verificationRequired()) && Number(auth.verified) === 0) {
            return send(ws, {
              type: "error",
              code: "verification_required",
              message: "Verify your email or phone before joining rooms."
            });
          }
          detachSocialSocket(ws, client.userId);
          client.userId = String(auth.userId);
          client.username = String(auth.username || "");
          client.role = auth.role || "user";
          if (client.name === "مهمان" && client.username) client.name = cleanName(client.username);
          client.muteCheckedAt = 0;
          let sockets = socialSockets.get(client.userId);
          if (!sockets) {
            sockets = new Set();
            socialSockets.set(client.userId, sockets);
          }
          sockets.add(ws);
          return send(ws, {
            type: "identified",
            userId: client.userId,
            username: client.username,
            role: client.role
          });
        }

        if (type === "join") {
          const room = cleanRoom(msg.room);
          if (!room) {
            return send(ws, {
              type: "error",
              code: "invalid_room",
              message: "Room code must be 4-16 characters (A-Z, 0-9, dash)."
            });
          }
          const flags = await roomFeature(room);
          if (!flags.realtime()) {
            return send(ws, { type: "error", code: "realtime_disabled", message: "Realtime is disabled by the site owner." });
          }
          if (!flags.join()) {
            return send(ws, { type: "error", code: "rooms_closed", message: "Joining rooms is closed by the site owner." });
          }
          const access = await roomAccess(room, client);
          if (!access.ok) {
            return send(ws, {
              type: "error",
              code: access.code,
              message: WS_ACCESS_MESSAGES[access.code] || "You cannot join this room."
            });
          }
          if (client.room && client.room !== room) leaveRoom(client);
          const requested = cleanText(msg.name, 30);
          if (requested) client.name = requested;
          else if (client.name === "مهمان" && client.username) client.name = cleanName(client.username);

          const st = roomState(room);
          st.clients.add(client);
          st.emptyAt = 0;
          client.room = room;
          client.roomId = access.roomId || client.roomId;
          client.mutedUntil = access.mutedUntil || 0;
          client.muteCheckedAt = Date.now();

          send(ws, { type: "joined", room, self: client.id, seq: st.seq, members: memberList(st) });

          const since = Number(msg.since);
          if (Number.isFinite(since) && since >= 0 && since < st.seq) {
            const replay = st.buffer.filter((event) => event.seq > since).slice(-WS_REPLAY_MAX);
            send(ws, { type: "resumed", room, from: since, seq: st.seq, replayed: replay.length });
            for (const event of replay) send(ws, event);
          }

          emit(room, { type: "presence", members: memberList(st) }, { except: client });

          if (dbReady()) {
            const roomDoc = await Room.findOne({ roomCode: room }).lean();
            if (roomDoc) {
              client.roomId = String(roomDoc._id);
              const history = await Message.find({ roomId: roomDoc._id })
                .sort({ createdAt: -1 })
                .limit(50)
                .lean();
              send(ws, {
                type: "history",
                room,
                messages: history.reverse().map((m) => ({
                  id: String(m._id),
                  username: m.username,
                  content: m.content,
                  type: m.type,
                  createdAt: m.createdAt
                }))
              });
            }
          } else if (client.roomId) {
            const history = await sqlRecentMessages(client.roomId, 50);
            send(ws, {
              type: "history",
              room,
              messages: history.map((m) => ({
                id: m.id,
                username: m.username,
                content: m.content,
                type: m.type,
                createdAt: m.createdAt
              }))
            });
          }
          return undefined;
        }

        if (type === "leave") {
          leaveRoom(client);
          return send(ws, { type: "left" });
        }

        if (!client.room) {
          return send(ws, { type: "error", code: "not_joined", message: "Join a room first." });
        }

        if (type === "rt") {
          const st = rooms.get(client.room);
          if (!st) return undefined;
          const data = msg.data;
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            return send(ws, { type: "error", code: "bad_relay", message: "Relay payload must be a JSON object." });
          }
          let raw = "";
          try { raw = JSON.stringify(data); } catch {}
          if (!raw || raw.length > WS_RT_MAX) {
            return send(ws, { type: "error", code: "relay_too_large", message: "Relay payload is too large." });
          }
          const out = { type: "rt", from: client.id, data };
          const to = cleanText(msg.to, 32);
          if (to && to !== "*") {
            let delivered = false;
            for (const peer of st.clients) {
              if (peer.id === to) { send(peer.ws, out); delivered = true; break; }
            }
            if (!delivered) app.log.warn({ rtTo: to, from: client.id, room: client.room, size: raw.length, clients: st.clients.size }, "rt relay target missing");
          } else {
            for (const peer of st.clients) {
              if (peer !== client) send(peer.ws, out);
            }
          }
          return undefined;
        }

        if (type === "status") {
          client.status = {
            muted: Boolean(msg.muted),
            video: Boolean(msg.video),
            speaking: Boolean(msg.speaking)
          };
          const st = rooms.get(client.room);
          if (st) emit(client.room, { type: "presence", members: memberList(st) });
          return undefined;
        }

        if (type === "chat") {
          const flags = await roomFeature(client.room);
          if (!flags.chat()) {
            return send(ws, { type: "error", code: "chat_disabled", message: "Chat is disabled by the site owner." });
          }
          const mutedUntil = await refreshMute(client);
          if (mutedUntil && Date.now() < mutedUntil) {
            return send(ws, { type: "error", code: "muted", message: "You are muted in this room." });
          }
          const now = Date.now();
          const windowMs = await settingNumber("limits.chatWindowMs", CHAT_WINDOW_MS);
          const maxPerWindow = await settingNumber("limits.chatPerWindow", CHAT_MAX);
          client.hits = client.hits.filter((t) => now - t < windowMs);
          if (client.hits.length >= maxPerWindow) {
            return send(ws, {
              type: "error",
              code: "chat_rate_limited",
              message: "Slow down a little."
            });
          }
          client.hits.push(now);

          const maxLength = Math.max(100, Math.round(await settingNumber("chat.maxLength", 2000)));
          const content = cleanText(msg.content, maxLength);
          if (!content) {
            return send(ws, { type: "error", code: "empty_message", message: "Message is empty." });
          }
          const cid = cleanText(msg.cid, 64);
          const st = rooms.get(client.room);
          const cidKey = cid && CHAT_CID_RE.test(cid) ? `${client.userId || client.id}:${cid}` : "";
          if (st && cidKey) {
            const seen = st.cids.get(cidKey);
            if (seen) {
              return send(ws, { type: "chat-ack", cid, id: seen.id, seq: seen.seq, duplicate: true });
            }
          }

          const message = {
            id: crypto.randomUUID(),
            room: client.room,
            username: client.name,
            content,
            type: "text",
            createdAt: new Date().toISOString()
          };
          emit(client.room, { type: "chat", message }, { buffer: true });
          const seq = st ? st.seq : 0;
          if (st && cidKey) {
            st.cids.set(cidKey, { id: message.id, seq, at: Date.now() });
            if (st.cids.size > 500) {
              for (const [key, rec] of st.cids) if (Date.now() - rec.at > 120_000) st.cids.delete(key);
            }
          }
          send(ws, { type: "chat-ack", cid: cidKey ? cid : "", id: message.id, seq });

          if (client.roomId) {
            if (dbReady()) {
              Message.create({
                roomId: client.roomId,
                username: client.name,
                content,
                type: "text"
              }).catch((err) => app.log.warn({ err }, "chat message persist failed"));
            } else {
              sqlAddMessage({
                roomId: client.roomId,
                userId: client.userId || null,
                username: client.name,
                content,
                type: "text",
                meta: cid ? { cid } : {}
              }).catch((err) => app.log.warn({ err }, "chat message persist failed"));
            }
          }
          return undefined;
        }

        if (type === "playback") {
          const flags = await roomFeature(client.room);
          if (!flags.playback()) {
            return send(ws, { type: "error", code: "playback_disabled", message: "Shared playback is disabled by the site owner." });
          }
          const action = cleanText(msg.action, 20);
          if (!PLAYBACK_ACTIONS.has(action)) {
            return send(ws, { type: "error", code: "invalid_action", message: "Unknown playback action." });
          }
          const payload = {
            type: "playback",
            action,
            time: Number.isFinite(Number(msg.time)) ? Math.min(7 * 86400, Math.max(0, Number(msg.time))) : 0,
            paused: Boolean(msg.paused),
            rate: Number.isFinite(Number(msg.rate)) && Number(msg.rate) > 0 ? Math.min(4, Math.max(0.25, Number(msg.rate))) : 1,
            from: client.id,
            at: Date.now()
          };
          const st = rooms.get(client.room);
          if (client.roomId && st) {
            const now = Date.now();
            if (payload.action !== "state" || now - st.playbackSavedAt > 900) {
              st.playbackSavedAt = now;
              if (dbReady()) {
                PlaybackState.updateOne(
                  { roomCode: client.room },
                  {
                    $set: {
                      position: payload.time,
                      paused: payload.paused,
                      rate: payload.rate,
                      updatedAt: new Date()
                    }
                  },
                  { upsert: true }
                ).catch((err) => app.log.warn({ err }, "playback state persist failed"));
              } else {
                sqlSavePlaybackState({
                  roomId: client.roomId,
                  position: payload.time,
                  paused: payload.paused,
                  rate: payload.rate,
                  userId: client.userId || null
                }).catch((err) => app.log.warn({ err }, "playback state persist failed"));
              }
            }
          }
          emit(client.room, payload, { except: client, buffer: true });
          return undefined;
        }

        return send(ws, { type: "error", code: "unknown_type", message: `Unknown message type: ${type || "(none)"}` });
      } catch (err) {
        req.log.error({ err }, "websocket handler failed");
        send(ws, { type: "error", code: "server_error", message: "Server error." });
        return undefined;
      }
    };

    ws.on("message", (raw) => {
      client.queue = client.queue
        .then(() => handleMessage(raw))
        .catch((err) => req.log.error({ err }, "websocket message handler failed"));
    });

    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("close", () => {
      allClients.delete(client);
      leaveRoom(client);
      detachSocialSocket(ws, client.userId);
    });
    ws.on("error", () => {
      allClients.delete(client);
      leaveRoom(client);
      detachSocialSocket(ws, client.userId);
    });
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of allClients) {
      if (client.ws.readyState !== 1) {
        allClients.delete(client);
        continue;
      }
      if (!client.alive) {
        try {
          if (typeof client.ws.terminate === "function") client.ws.terminate();
          else client.ws.close(1001, "timeout");
        } catch {}
        allClients.delete(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {}
    }
    for (const [room, st] of rooms) {
      for (const [key, rec] of st.cids) {
        if (now - rec.at > 120_000) st.cids.delete(key);
      }
      if (st.clients.size === 0) {
        if (!st.emptyAt) st.emptyAt = now;
        else if (now - st.emptyAt > 600_000) rooms.delete(room);
      } else {
        st.emptyAt = 0;
      }
    }
  }, WS_HEARTBEAT_MS);
  heartbeat.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    for (const client of allClients) {
      try {
        client.ws.close(1001, "Server shutting down");
      } catch {}
    }
    allClients.clear();
    rooms.clear();
    socialSockets.clear();
    roomNotifier = null;
  });
}

export async function buildServer() {
  if (appConfig.isDeployed && !appConfig.hasJwtSecret) {
    throw new Error("JWT_SECRET must be set when APP_ENV is staging or production");
  }

  const app = Fastify({
    logger: { level: appConfig.logLevel },
    trustProxy: appConfig.trustProxy,
    routerOptions: { ignoreTrailingSlash: true },
    bodyLimit: 1024 * 1024
  });

  app.decorate("notifyUser", notifyUser);
  app.decorate("notifyRoom", notifyRoom);

  for (const warning of configWarnings()) {
    if (warning.level === "error") app.log.error(`[config] ${warning.message}`);
    else if (warning.level === "warn") app.log.warn(`[config] ${warning.message}`);
    else app.log.info(`[config] ${warning.message}`);
  }

  const corsOrigin = appConfig.cors.allowAll
    ? true
    : appConfig.cors.origins.length
      ? [...appConfig.cors.origins]
      : false;

  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-File-Name", "X-File-Type", "X-File-Kind"],
    maxAge: 86400
  });

  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ["gzip", "deflate"],
    customTypes: /^application\/json/
  });

  await app.register(websocket, {
    options: { maxPayload: 512 * 1024 }
  });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch {
      const err = new Error("Request body is not valid JSON.");
      err.statusCode = 400;
      done(err);
    }
  });

  app.addContentTypeParser(
    [
      "application/octet-stream",
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "application/pdf",
      "text/plain",
      "text/vtt",
      "application/x-subrip",
      "video/mp4",
      "video/webm"
    ],
    { parseAs: "buffer", bodyLimit: 55 * 1024 * 1024 },
    (req, body, done) => done(null, body)
  );

  const limiter = createRateLimiter({
    max: appConfig.rateLimit.max,
    windowMs: appConfig.rateLimit.windowMs,
    skip: (req) => req.url.startsWith("/ws") || req.url === "/api/health" || req.url === "/api/ready"
  });
  app.addHook("onRequest", limiter);

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    if (appConfig.isDeployed) {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    if (req.url.startsWith("/api/")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.get("/api/health", async () => {
    await getDatabase();
    const storage = databaseState();
    return {
      ok: true,
      ready: storage.ready || dbReady(),
      service: "watch-together-api",
      ...publicConfig(),
      uptime: Math.round(process.uptime()),
      now: new Date().toISOString(),
      db: dbState(),
      userStore: storeState(),
      storage,
      mail: mailState(),
      sms: smsState(),
      redis: redisState(),
      capabilities: {
        persistentProcess: true,
        websockets: true,
        backgroundJobs: "in-process",
        mediaProcessing: "browser"
      }
    };
  });

  app.get("/api/ready", async (req, reply) => {
    await getDatabase();
    const store = storeState().mode;
    const ready = store === "sqlite" || store === "mongodb";
    return reply.code(ready ? 200 : 503).send({
      ok: ready,
      store,
      redis: redisState().mode,
      at: new Date().toISOString()
    });
  });

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(lobbyRoutes, { prefix: "/api/lobbies" });
  await app.register(billingRoutes, { prefix: "/api/billing" });
  await app.register(adminRoutes, { prefix: "/api/admin" });
  await app.register(platformRoutes, { prefix: "/api/admin" });
  await app.register(adminOpsRoutes, { prefix: "/api/admin" });
  await app.register(adminBillingRoutes, { prefix: "/api/admin" });
  await app.register(socialRoutes, { prefix: "/api/social" });
  await app.register(roomRoutes, { prefix: "/api/rooms" });
  await app.register(publicPageRoutes, { prefix: "/api/pages" });
  await app.register(analyticsRoutes, { prefix: "/api/analytics" });
  await app.register(adminAnalyticsRoutes, { prefix: "/api/admin" });
  await app.register(adminStorageRoutes, { prefix: "/api/admin" });
  await app.register(uploadRoutes, { prefix: "/api/uploads" });
  await app.register(fileRoutes, { prefix: "/api/files" });

  app.get("/api/features", async (req) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const auth = token ? await authenticateToken(token) : null;
    const state = auth
      ? await resolveFeatureState({ userId: auth.userId, role: auth.role })
      : await resolveFeatureState({ role: "guest" });
    const flags = {};
    for (const item of featureStatus(state)) flags[item.key] = item.enabled;
    return {
      ok: true,
      updatedAt: state.updatedAt,
      features: state.features,
      access: state.access,
      featureRules: state.featureRules,
      flags,
      status: featureStatus(state),
      effective: summarizeFeatures(state)
    };
  });

  app.get("/api/settings/public", async () => {
    const settings = await publicPlatformSettings();
    return { ok: true, ...settings };
  });

  registerRealtime(app);

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: "not_found", message: `Route ${req.method} ${req.url} not found.`, requestId: req.id })
  );

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "request failed");
    const status = Number(err?.statusCode) >= 400 && Number(err?.statusCode) < 600 ? Number(err.statusCode) : 500;
    return reply.code(status).send({
      error: status >= 500 ? "internal_error" : err.code || "request_failed",
      message: status >= 500 ? "Unexpected server error." : err.message,
      requestId: req.id
    });
  });

  return app;
}

async function start() {
  const app = await buildServer();
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`API listening on http://localhost:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  connectRedis().catch(() => {});
  connectDB()
    .catch(() => {})
    .finally(() => {
      if (!dbReady()) {
        startMaintenance(app.log).catch((err) => app.log.warn(`[db] maintenance unavailable: ${err.message}`));
      }
    });
  scheduleOwnerBootstrap(app.log);

  const expirySweep = setInterval(async () => {
    if (dbReady()) return;
    try {
      const due = await sqlSweepExpired();
      for (const item of due) emitEvent(app, "subscription.expired", { ...item });
    } catch (err) {
      app.log.warn(`[billing] expiry sweep failed: ${err.message}`);
    }
  }, 5 * 60_000);
  expirySweep.unref?.();

  const mediaSweep = setInterval(async () => {
    try {
      await sweepMedia();
    } catch (err) {
      app.log.warn(`[storage] media sweep failed: ${err.message}`);
    }
  }, 60_000);
  mediaSweep.unref?.();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.log.info(`Received ${signal}, shutting down`);
    clearInterval(expirySweep);
    clearInterval(mediaSweep);
    stopMaintenance();
    try {
      await app.close();
    } catch {}
    try {
      closeDatabase();
    } catch {}
    try {
      await disconnectRedis();
    } catch {}
    await disconnectDB();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  start().catch((err) => {
    console.error("[api] failed to start:", err);
    process.exit(1);
  });
}
