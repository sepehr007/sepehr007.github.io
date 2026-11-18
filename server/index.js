import "dotenv/config";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { connectDB, dbReady, dbState, disconnectDB } from "./db.js";
import { storeState } from "./userStore.js";
import { connectRedis, redisReady, redisState, createRateLimiter } from "./redis.js";
import { loadFeatureState, isEnabled, summarizeFeatures } from "./features.js";
import { mailState } from "./mailer.js";
import { smsState } from "./sms.js";
import authRoutes from "./routes/auth.js";
import lobbyRoutes from "./routes/lobbies.js";
import billingRoutes from "./routes/billing.js";
import adminRoutes from "./routes/admin.js";
import { startMaintenance } from "./database/index.js";
import { Room } from "./models/Room.js";
import { Message } from "./models/Message.js";
import { PlaybackState } from "./models/PlaybackState.js";
import { ensureStore } from "./userStore.js";
import { sqlFindRoomByCode, sqlRecentMessages, sqlAddMessage, sqlSavePlaybackState } from "./stores/rooms.js";

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";
const IS_PROD = process.env.NODE_ENV === "production";
const ROOM_RE = /^[A-Z0-9-]{4,16}$/;
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX = 10;

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

function registerRealtime(app) {
  const rooms = new Map();
  const playbackSavedAt = new Map();

  const send = (ws, payload) => {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(payload));
      } catch {}
    }
  };

  const memberList = (set) => [...set].map((client) => ({ id: client.id, name: client.name }));

  const broadcast = (room, payload, except = null) => {
    const set = rooms.get(room);
    if (!set) return;
    const raw = JSON.stringify(payload);
    for (const client of set) {
      if (client === except || client.ws.readyState !== 1) continue;
      try {
        client.ws.send(raw);
      } catch {}
    }
  };

  const leaveRoom = (client) => {
    const room = client.room;
    if (!room) return;
    const set = rooms.get(room);
    if (set) {
      set.delete(client);
      broadcast(room, { type: "presence", room, members: memberList(set) });
      if (set.size === 0) rooms.delete(room);
    }
    client.room = "";
    client.roomId = "";
  };

  const roomFeature = async () => {
    const state = await loadFeatureState();
    return {
      realtime: () => isEnabled(state, "features.realtimeEnabled"),
      join: () => isEnabled(state, "access.roomJoin"),
      create: () => isEnabled(state, "access.roomCreate"),
      chat: () => isEnabled(state, "features.chat"),
      playback: () => isEnabled(state, "features.sharedPlayback")
    };
  };

  app.get("/ws", { websocket: true }, (connection, req) => {
    const ws = connection?.socket ?? connection;
    const client = {
      id: crypto.randomUUID().slice(0, 8),
      name: "مهمان",
      room: "",
      roomId: "",
      hits: [],
      ws
    };

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: "error", code: "bad_json", message: "Messages must be JSON." });
      }
      const type = cleanText(msg?.type, 20);

      try {
        if (type === "ping") {
          return send(ws, { type: "pong", at: Date.now() });
        }

        if (type === "join") {
          const flags = await roomFeature();
          if (!flags.realtime()) {
            return send(ws, { type: "error", code: "realtime_disabled", message: "Realtime is disabled by the site owner." });
          }
          if (!flags.join()) {
            return send(ws, { type: "error", code: "rooms_closed", message: "Joining rooms is closed by the site owner." });
          }
          const room = cleanRoom(msg.room);
          if (!room) {
            return send(ws, {
              type: "error",
              code: "invalid_room",
              message: "Room code must be 4-16 characters (A-Z, 0-9, dash)."
            });
          }
          if (client.room && client.room !== room) leaveRoom(client);
          client.name = cleanName(msg.name);

          let set = rooms.get(room);
          if (!set) {
            set = new Set();
            rooms.set(room, set);
          }
          set.add(client);
          client.room = room;

          send(ws, { type: "joined", room, self: client.id, members: memberList(set) });
          broadcast(room, { type: "presence", room, members: memberList(set) }, client);

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
          } else if (await ensureStore()) {
            const roomDoc = await sqlFindRoomByCode(room);
            if (roomDoc) {
              client.roomId = roomDoc.id;
              const history = await sqlRecentMessages(roomDoc.id, 50);
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

        if (type === "chat") {
          const flags = await roomFeature();
          if (!flags.chat()) {
            return send(ws, { type: "error", code: "chat_disabled", message: "Chat is disabled by the site owner." });
          }
          const now = Date.now();
          client.hits = client.hits.filter((t) => now - t < CHAT_WINDOW_MS);
          if (client.hits.length >= CHAT_MAX) {
            return send(ws, {
              type: "error",
              code: "chat_rate_limited",
              message: "Slow down a little."
            });
          }
          client.hits.push(now);

          const content = cleanText(msg.content, 2000);
          if (!content) {
            return send(ws, { type: "error", code: "empty_message", message: "Message is empty." });
          }

          const message = {
            id: crypto.randomUUID(),
            room: client.room,
            username: client.name,
            content,
            type: "text",
            createdAt: new Date().toISOString()
          };
          broadcast(client.room, { type: "chat", message });

          if (client.roomId) {
            if (dbReady()) {
              Message.create({
                roomId: client.roomId,
                username: client.name,
                content,
                type: "text"
              }).catch(() => {});
            } else {
              sqlAddMessage({
                roomId: client.roomId,
                username: client.name,
                content,
                type: "text"
              }).catch(() => {});
            }
          }
          return undefined;
        }

        if (type === "playback") {
          const flags = await roomFeature();
          if (!flags.playback()) {
            return send(ws, { type: "error", code: "playback_disabled", message: "Shared playback is disabled by the site owner." });
          }
          const payload = {
            type: "playback",
            room: client.room,
            action: cleanText(msg.action, 20),
            time: Number.isFinite(Number(msg.time)) ? Math.max(0, Number(msg.time)) : 0,
            paused: Boolean(msg.paused),
            rate: Number.isFinite(Number(msg.rate)) && Number(msg.rate) > 0 ? Number(msg.rate) : 1,
            from: client.id,
            at: Date.now()
          };
          if (client.roomId) {
            const now = Date.now();
            const last = playbackSavedAt.get(client.roomId) || 0;
            if (payload.action !== "state" || now - last > 900) {
              playbackSavedAt.set(client.roomId, now);
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
                ).catch(() => {});
              } else {
                sqlSavePlaybackState({
                  roomId: client.roomId,
                  position: payload.time,
                  paused: payload.paused,
                  rate: payload.rate
                }).catch(() => {});
              }
            }
          }
          return broadcast(client.room, payload, client);
        }

        return send(ws, { type: "error", code: "unknown_type", message: `Unknown message type: ${type || "(none)"}` });
      } catch (err) {
        req.log.error({ err }, "websocket handler failed");
        send(ws, { type: "error", code: "server_error", message: "Server error." });
        return undefined;
      }
    });

    ws.on("close", () => leaveRoom(client));
    ws.on("error", () => leaveRoom(client));
  });

  const heartbeat = setInterval(() => {
    for (const set of rooms.values()) {
      for (const client of set) {
        try {
          client.ws.ping();
        } catch {}
      }
    }
  }, 30000);
  heartbeat.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    for (const set of rooms.values()) {
      for (const client of set) {
        try {
          client.ws.close(1001, "Server shutting down");
        } catch {}
      }
    }
    rooms.clear();
  });
}

export async function buildServer() {
  if (IS_PROD && !process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET must be set in production");
  }

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || "info" },
    trustProxy: true,
    ignoreTrailingSlash: true,
    bodyLimit: 1024 * 1024
  });

  const corsEnv = String(process.env.CORS_ORIGIN || "").trim();
  const corsOrigin = corsEnv ? corsEnv.split(",").map((s) => s.trim()).filter(Boolean) : true;

  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400
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

  const limiter = createRateLimiter({
    max: Number(process.env.RATE_LIMIT_MAX || 50),
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
    skip: (req) => req.url.startsWith("/ws") || req.url === "/api/health"
  });
  app.addHook("onRequest", limiter);

  app.get("/api/health", async () => ({
    ok: true,
    service: "watch-together-api",
    version: "0.1.0",
    uptime: Math.round(process.uptime()),
    now: new Date().toISOString(),
    db: dbState(),
    userStore: storeState(),
    mail: mailState(),
    sms: smsState(),
    redis: redisState()
  }));

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(lobbyRoutes, { prefix: "/api/lobbies" });
  await app.register(billingRoutes, { prefix: "/api/billing" });
  await app.register(adminRoutes, { prefix: "/api/admin" });

  app.get("/api/features", async () => {
    const state = await loadFeatureState();
    return {
      ok: true,
      updatedAt: state.updatedAt,
      features: state.features,
      access: state.access,
      featureRules: state.featureRules,
      effective: summarizeFeatures(state)
    };
  });

  registerRealtime(app);

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: "not_found", message: `Route ${req.method} ${req.url} not found.` })
  );

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "request failed");
    const status = Number(err?.statusCode) >= 400 && Number(err?.statusCode) < 600 ? Number(err.statusCode) : 500;
    return reply.code(status).send({
      error: status >= 500 ? "internal_error" : err.code || "request_failed",
      message: status >= 500 ? "Unexpected server error." : err.message
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

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.log.info(`Received ${signal}, shutting down`);
    try {
      await app.close();
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
