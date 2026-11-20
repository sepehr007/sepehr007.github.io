import crypto from "node:crypto";
import Redis from "ioredis";

const state = {
  client: null,
  ready: false,
  error: "",
  errorLogged: false,
  connecting: null,
  url: ""
};

const memory = new Map();
const MAX_MEMORY_ENTRIES = 10000;
const SESSION_PREFIX = "wt:sess:";
const USER_SESSIONS_PREFIX = "wt:usr-sess:";
const cache = new Map();
const MAX_CACHE_ENTRIES = 5000;
const limitMemory = new Map();
const MAX_LIMIT_KEYS = 5000;

const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

export function redisReady() {
  return state.ready && state.client?.status === "ready";
}

export function redisState() {
  return {
    ready: redisReady(),
    mode: redisReady() ? "redis" : "memory",
    status: state.client?.status || "disabled",
    error: state.error
  };
}

export function getRedis() {
  return state.client;
}

export async function connectRedis(url = process.env.REDIS_URL) {
  if (!url) {
    state.error = "REDIS_URL is not set";
    console.warn("[redis] REDIS_URL is not set - using in-memory sessions, cache and rate limits");
    return null;
  }
  if (state.client) return state.client;
  if (state.connecting) return state.connecting;

  state.url = url;
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 500, 10000)
  });
  state.client = client;

  client.on("ready", () => {
    state.ready = true;
    state.error = "";
    state.errorLogged = false;
    console.log("[redis] connected");
  });
  client.on("error", (err) => {
    state.ready = false;
    state.error = err.message;
    if (!state.errorLogged) {
      state.errorLogged = true;
      console.error("[redis] error:", err.message, "- falling back to in-memory mode");
    }
  });
  client.on("end", () => {
    state.ready = false;
  });

  state.connecting = (async () => {
    try {
      await client.connect();
      await client.ping();
      state.ready = true;
      state.error = "";
      return client;
    } catch (err) {
      state.error = err.message;
      console.error("[redis] connect failed:", err.message, "- using in-memory fallback");
      return null;
    } finally {
      state.connecting = null;
    }
  })();

  return state.connecting;
}

export async function disconnectRedis() {
  const client = state.client;
  state.client = null;
  state.ready = false;
  state.connecting = null;
  if (!client) return;
  try {
    await client.quit();
  } catch {
    try {
      client.disconnect();
    } catch {}
  }
}

function pruneMap(map, max) {
  if (map.size <= max) return;
  const overflow = map.size - max;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++removed >= overflow) break;
  }
}

function memGet(map, key) {
  const rec = map.get(key);
  if (!rec) return null;
  if (rec.expiresAt && rec.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return rec.value;
}

function memSet(map, key, value, ttlSeconds, max) {
  pruneMap(map, max);
  map.set(key, {
    value,
    expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0
  });
}

function sessionIndex(userId) {
  const key = String(userId);
  if (!cache.has(`idx:${key}`)) cache.set(`idx:${key}`, { value: new Set(), expiresAt: 0 });
  return cache.get(`idx:${key}`).value;
}

export async function saveSession(jti, data, ttlSeconds) {
  if (!jti || !data?.userId) return false;
  const ttl = Math.max(1, Number(ttlSeconds) || 1);
  const payload = redisReady() ? data : { ...data, memoryOnly: true };

  memSet(memory, SESSION_PREFIX + jti, payload, ttl, MAX_MEMORY_ENTRIES);
  sessionIndex(data.userId).add(jti);

  if (redisReady()) {
    try {
      await state.client
        .multi()
        .set(SESSION_PREFIX + jti, JSON.stringify(payload), "EX", ttl)
        .sadd(USER_SESSIONS_PREFIX + data.userId, jti)
        .expire(USER_SESSIONS_PREFIX + data.userId, ttl)
        .exec();
    } catch (err) {
      state.error = err.message;
    }
  }
  return true;
}

export async function getSession(jti) {
  if (!jti) return null;
  const key = SESSION_PREFIX + jti;
  if (redisReady()) {
    try {
      const raw = await state.client.get(key);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      state.error = err.message;
    }
    const local = memGet(memory, key);
    return local?.memoryOnly ? local : null;
  }
  return memGet(memory, key);
}

export async function revokeSession(jti) {
  if (!jti) return false;
  const key = SESSION_PREFIX + jti;
  memGet(memory, key);
  memory.delete(key);
  cache.delete(key);
  if (redisReady()) {
    try {
      await state.client.del(key);
    } catch (err) {
      state.error = err.message;
    }
  }
  return true;
}

export async function listUserSessions(userId) {
  const out = [];
  const seen = new Set();
  const push = (jti, rec) => {
    if (!rec || seen.has(jti)) return;
    seen.add(jti);
    out.push({
      id: jti,
      ip: rec.ip || "",
      ua: rec.ua || "",
      role: rec.role || "user",
      expiresAt: rec.expiresAt || null
    });
  };
  for (const jti of sessionIndex(userId)) push(jti, memGet(memory, SESSION_PREFIX + jti));
  if (redisReady()) {
    try {
      const jtis = await state.client.smembers(USER_SESSIONS_PREFIX + userId);
      for (const jti of jtis) {
        if (seen.has(jti)) continue;
        const raw = await state.client.get(SESSION_PREFIX + jti);
        if (raw) {
          try {
            push(jti, JSON.parse(raw));
          } catch {}
        }
      }
    } catch (err) {
      state.error = err.message;
    }
  }
  return out;
}

export async function revokeUserSessions(userId) {
  if (!userId) return 0;
  let revoked = 0;
  const local = sessionIndex(userId);
  for (const jti of local) {
    memory.delete(SESSION_PREFIX + jti);
    revoked += 1;
  }
  local.clear();
  if (redisReady()) {
    try {
      const setKey = USER_SESSIONS_PREFIX + userId;
      const jtis = await state.client.smembers(setKey);
      if (jtis.length) {
        await state.client.del(...jtis.map((jti) => SESSION_PREFIX + jti));
        revoked = Math.max(revoked, jtis.length);
      }
      await state.client.del(setKey);
    } catch (err) {
      state.error = err.message;
    }
  }
  return revoked;
}

export async function cacheGet(key) {
  if (redisReady()) {
    try {
      const raw = await state.client.get(`wt:cache:${key}`);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      state.error = err.message;
    }
  }
  return memGet(cache, `cache:${key}`);
}

export async function cacheSet(key, value, ttlSeconds = 60) {
  const ttl = Math.max(1, Number(ttlSeconds) || 1);
  memSet(cache, `cache:${key}`, value, ttl, MAX_CACHE_ENTRIES);
  if (redisReady()) {
    try {
      await state.client.set(`wt:cache:${key}`, JSON.stringify(value), "EX", ttl);
    } catch (err) {
      state.error = err.message;
    }
  }
  return true;
}

export async function cacheDel(key) {
  cache.delete(`cache:${key}`);
  if (redisReady()) {
    try {
      await state.client.del(`wt:cache:${key}`);
    } catch (err) {
      state.error = err.message;
    }
  }
  return true;
}

export async function bumpCounter(key, windowMs = 60000) {
  const window = Math.max(1000, Number(windowMs) || 60000);
  const fullKey = `wt:cnt:${String(key)}`;
  if (redisReady()) {
    try {
      const [rawCount, rawTtl] = await state.client.eval(RATE_LIMIT_SCRIPT, 1, fullKey, String(window));
      return { count: Number(rawCount) || 0, resetMs: Number(rawTtl) > 0 ? Number(rawTtl) : window };
    } catch (err) {
      state.error = err.message;
    }
  }
  const entry = limitMemory.get(fullKey);
  if (!entry || entry.resetAt <= Date.now()) {
    limitMemory.set(fullKey, { count: 1, resetAt: Date.now() + window });
    pruneMap(limitMemory, MAX_LIMIT_KEYS);
    return { count: 1, resetMs: window };
  }
  entry.count += 1;
  return { count: entry.count, resetMs: Math.max(1, entry.resetAt - Date.now()) };
}

export async function readCounter(key) {
  const fullKey = `wt:cnt:${String(key)}`;
  if (redisReady()) {
    try {
      const raw = await state.client.get(fullKey);
      const ttl = await state.client.pttl(fullKey);
      return { count: Number(raw) || 0, resetMs: Number(ttl) > 0 ? Number(ttl) : 0 };
    } catch (err) {
      state.error = err.message;
    }
  }
  const entry = limitMemory.get(fullKey);
  if (!entry || entry.resetAt <= Date.now()) return { count: 0, resetMs: 0 };
  return { count: entry.count, resetMs: Math.max(1, entry.resetAt - Date.now()) };
}

export async function resetCounter(key) {
  const fullKey = `wt:cnt:${String(key)}`;
  limitMemory.delete(fullKey);
  if (redisReady()) {
    try {
      await state.client.del(fullKey);
    } catch (err) {
      state.error = err.message;
    }
  }
  return true;
}

export function createRateLimiter({
  max = 50,
  windowMs = 60000,
  prefix = "wt:rl:",
  skip = () => false,
  keyFor = null
} = {}) {
  const limit = Math.max(1, Number(max) || 50);
  const window = Math.max(1000, Number(windowMs) || 60000);

  function identity(req) {
    if (typeof keyFor === "function") {
      try {
        const custom = keyFor(req);
        if (custom) return String(custom);
      } catch {}
    }
    const header = String(req.headers?.authorization || "");
    const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token && token.length >= 16) {
      const digest = crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
      return `user:${digest}`;
    }
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    return `ip:${ip}`;
  }

  return async function rateLimitHook(req, reply) {
    try {
      if (skip(req)) return;

      const bucket = Math.floor(Date.now() / window);
      const key = `${prefix}${identity(req)}:${bucket}`;

      let count = 0;
      let resetMs = window;

      if (redisReady()) {
        try {
          const [rawCount, rawTtl] = await state.client.eval(RATE_LIMIT_SCRIPT, 1, key, String(window));
          count = Number(rawCount) || 0;
          resetMs = Number(rawTtl) > 0 ? Number(rawTtl) : window;
        } catch (err) {
          state.error = err.message;
        }
      }

      if (!redisReady() || count === 0) {
        const entry = limitMemory.get(key);
        if (!entry || entry.resetAt <= Date.now()) {
          limitMemory.set(key, { count: 1, resetAt: Date.now() + window });
          count = 1;
          resetMs = window;
          pruneMap(limitMemory, MAX_LIMIT_KEYS);
        } else {
          entry.count += 1;
          count = entry.count;
          resetMs = entry.resetAt - Date.now();
        }
      }

      const remaining = Math.max(0, limit - count);
      const resetSeconds = Math.max(1, Math.ceil(resetMs / 1000));

      reply.header("x-ratelimit-limit", String(limit));
      reply.header("x-ratelimit-remaining", String(remaining));
      reply.header("x-ratelimit-reset", String(resetSeconds));

      if (count > limit) {
        reply.header("retry-after", String(resetSeconds));
        return reply.code(429).send({
          error: "rate_limited",
          message: "Too many requests. Please slow down.",
          retryInSeconds: resetSeconds
        });
      }
    } catch (err) {
      req.log?.error?.({ err }, "rate limiter failed");
    }
  };
}
