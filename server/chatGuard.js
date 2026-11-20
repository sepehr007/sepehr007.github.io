import { getDatabase } from "./database/index.js";
import { settingNumber } from "./platformSettings.js";

const RATE_FALLBACK_MAX = 10;
const RATE_FALLBACK_WINDOW_MS = 5000;
const COOLDOWN_FALLBACK_MS = 8000;
const COOLDOWN_MAX_MS = 120000;
const STRIKE_DECAY_MS = 10 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 12000;
const DUPLICATE_LIMIT = 3;

const buckets = new Map();   // `${userKey}:${room}` -> { hits, texts }
const states = new Map();    // userKey -> { until, strikes, lastBlockAt, loading }

function userKey(client) {
  return client?.userId ? `u:${client.userId}` : `s:${client?.id || "anon"}`;
}

function normalize(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 500);
}

async function loadState(key, userId) {
  let state = states.get(key);
  if (state) {
    if (state.loading) await state.loading;
    return state;
  }
  state = { until: 0, strikes: 0, lastBlockAt: 0 };
  states.set(key, state);
  if (!userId) return state;
  const loading = (async () => {
    try {
      const db = await getDatabase();
      if (!db) return;
      const row = db
        .prepare("SELECT blocked_until, strikes, last_block_at FROM chat_guard WHERE user_id = ?")
        .get(String(userId));
      if (!row) return;
      state.until = Number(row.blocked_until) || 0;
      state.strikes = Number(row.strikes) || 0;
      state.lastBlockAt = Number(row.last_block_at) || 0;
    } catch {}
  })();
  state.loading = loading;
  await loading;
  state.loading = null;
  return state;
}

function persist(key, userId, state) {
  if (!userId) return;
  getDatabase()
    .then((db) => {
      if (!db) return;
      db.prepare(
        `INSERT INTO chat_guard (user_id, blocked_until, strikes, last_block_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           blocked_until = excluded.blocked_until,
           strikes = excluded.strikes,
           last_block_at = excluded.last_block_at,
           updated_at = excluded.updated_at`
      ).run(String(userId), state.until, state.strikes, state.lastBlockAt, Date.now());
    })
    .catch(() => {});
}

export async function chatGuardStatus(client) {
  const key = userKey(client);
  const state = await loadState(key, client?.userId);
  const now = Date.now();
  if (state.strikes && state.lastBlockAt && now - state.lastBlockAt > STRIKE_DECAY_MS) {
    state.strikes = 0;
    persist(key, client?.userId, state);
  }
  if (state.until && state.until <= now) {
    state.until = 0;
    persist(key, client?.userId, state);
  }
  return { retryAfter: Math.max(0, state.until - now), strikes: state.strikes };
}

/**
 * Per-user chat anti-spam guard. Never shares a bucket between users, so one
 * person's cooldown cannot stop anyone else from writing. Cooldowns persist in
 * SQLite, which keeps them effective across page reloads and server restarts.
 */
export async function checkChat(client, room, text) {
  const key = userKey(client);
  const state = await loadState(key, client?.userId);
  const now = Date.now();

  if (state.strikes && state.lastBlockAt && now - state.lastBlockAt > STRIKE_DECAY_MS) {
    state.strikes = 0;
    persist(key, client?.userId, state);
  }
  if (state.until > now) {
    return {
      ok: false,
      code: "chat_cooldown",
      retryAfter: state.until - now,
      strikes: state.strikes
    };
  }
  if (state.until) {
    state.until = 0;
    persist(key, client?.userId, state);
  }

  const windowMs = Math.min(60000, Math.max(500, Math.round(await settingNumber("limits.chatWindowMs", RATE_FALLBACK_WINDOW_MS))));
  const maxPerWindow = Math.min(60, Math.max(2, Math.round(await settingNumber("limits.chatPerWindow", RATE_FALLBACK_MAX))));
  const bucketKey = `${key}:${String(room || "").toUpperCase()}`;
  let bucket = buckets.get(bucketKey);
  if (!bucket) {
    bucket = { hits: [], texts: [] };
    buckets.set(bucketKey, bucket);
  }

  bucket.hits = bucket.hits.filter((at) => now - at < windowMs);
  bucket.texts = bucket.texts.filter((item) => now - item.at < DUPLICATE_WINDOW_MS);
  const normalized = normalize(text);
  const repeats = bucket.texts.filter((item) => item.text === normalized).length;
  let reason = "";
  if (bucket.hits.length >= maxPerWindow) reason = "rate";
  else if (normalized && repeats >= DUPLICATE_LIMIT - 1) reason = "duplicate";

  if (reason) {
    state.strikes = Math.min(6, (Number(state.strikes) || 0) + 1);
    state.lastBlockAt = now;
    const base = Math.min(COOLDOWN_MAX_MS, Math.max(1000, Math.round(await settingNumber("limits.chatCooldownMs", COOLDOWN_FALLBACK_MS))));
    const cooldown = Math.min(COOLDOWN_MAX_MS, base * 2 ** (state.strikes - 1));
    state.until = now + cooldown;
    persist(key, client?.userId, state);
    return { ok: false, code: "chat_rate_limited", retryAfter: cooldown, strikes: state.strikes, reason };
  }

  bucket.hits.push(now);
  if (normalized) bucket.texts.push({ at: now, text: normalized });
  if (bucket.texts.length > 30) bucket.texts.splice(0, bucket.texts.length - 30);
  if (buckets.size > 5000) {
    for (const [id, item] of buckets) {
      if (!item.hits.length && !item.texts.length) buckets.delete(id);
    }
  }
  return { ok: true };
}
