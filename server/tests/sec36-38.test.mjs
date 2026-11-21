import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, "..", ".tmp");
fs.mkdirSync(tmpRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tmpRoot, "sec-"));
process.env.APP_ENV = "development";
process.env.DATA_DIR = tmp;
process.env.SQLITE_FILE = path.join(tmp, "wt.sqlite");
process.env.JWT_SECRET = "test-secret-".padEnd(48, "x");
process.env.LOG_LEVEL = "silent";
process.env.RATE_LIMIT_MAX = "100000";
process.env.RATE_LIMIT_WINDOW_MS = "1000";
process.env.ADMIN_RATE_LIMIT = "100000";
process.env.REDIS_URL = "";
process.env.BACKUP_DIR = path.join(tmp, "backups");

const { buildServer } = await import("../index.js");
const { getDatabase, closeDatabase } = await import("../database/index.js");
const { invalidateAuthCache } = await import("../routes/auth.js");

const app = await buildServer();
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}/ws`;
const db = await getDatabase();
assert.ok(db, "database must open");

const failures = [];
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

async function api(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase);
    const queue = [];
    const waiters = [];
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({
        ws,
        send(payload) {
          ws.send(JSON.stringify(payload));
        },
        next(predicate, timeoutMs = 5000) {
          const match = (msg) => (typeof predicate === "function" ? predicate(msg) : msg.type === predicate);
          const index = queue.findIndex(match);
          if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
          return new Promise((res, rej) => {
            const waiter = {
              match,
              res,
              timer: setTimeout(() => {
                const at = waiters.indexOf(waiter);
                if (at >= 0) waiters.splice(at, 1);
                rej(new Error("ws message timeout"));
              }, timeoutMs)
            };
            waiters.push(waiter);
          });
        },
        close() {
          try {
            ws.close();
          } catch {}
        }
      });
    });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "hello") msg.__hello = true;
      const index = waiters.findIndex((w) => w.match(msg));
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.res(msg);
      } else {
        queue.push(msg);
      }
    });
    ws.on("error", reject);
  });
}

async function register(username) {
  const res = await api("POST", "/api/auth/register", {
    body: {
      username,
      email: `${username}@example.test`,
      password: "Passw0rd!test",
      nick: username,
      birthdate: "1995-05-05"
    }
  });
  assert.equal(res.status, 201, `register ${username}: ${res.text}`);
  return res.json;
}

let owner;
let alice;
let bob;
let carol;

await step("security headers and no-store on api", async () => {
  const res = await api("GET", "/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("permissions-policy") || "", /camera=\(\)/);
  assert.match(res.headers.get("cache-control") || "", /no-store/);
});

await step("error responses carry a request id", async () => {
  const res = await api("GET", "/api/does-not-exist");
  assert.equal(res.status, 404);
  assert.equal(res.json.error, "not_found");
  assert.ok(String(res.json.requestId || "").length > 0);
});

await step("register users", async () => {
  owner = await register("owner1");
  alice = await register("alice1");
  bob = await register("bob1");
  carol = await register("carol1");
  assert.ok(owner.token && alice.token && bob.token && carol.token);
});

await step("promote owner role in database and admin works", async () => {
  db.prepare("UPDATE users SET role = 'owner', updated_at = ? WHERE id = ?").run(Date.now(), owner.user.id);
  invalidateAuthCache(owner.user.id);
  const res = await api("GET", "/api/admin/overview", { token: owner.token });
  assert.equal(res.status, 200, res.text);
});

await step("large json responses are gzip compressed", async () => {
  const res = await fetch(`${base}/api/features`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.features && typeof body.features === "object");
});

await step("owner cannot change own role", async () => {
  const res = await api("PATCH", `/api/admin/users/${owner.user.id}`, {
    token: owner.token,
    body: { role: "administrator" }
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, "self_role_change");
});

await step("suspended account loses sessions and cannot login", async () => {
  const res = await api("PATCH", `/api/admin/users/${bob.user.id}`, {
    token: owner.token,
    body: { status: "suspended" }
  });
  assert.equal(res.status, 200, res.text);
  const me = await api("GET", "/api/auth/me", { token: bob.token });
  assert.ok([401, 403].includes(me.status), `expected 401/403, got ${me.status}`);
  const login = await api("POST", "/api/auth/login", {
    body: { identifier: "bob1", password: "Passw0rd!test" }
  });
  assert.equal(login.status, 403, login.text);
  assert.equal(login.json.error, "account_inactive");
  const ws = await wsClient();
  await ws.next("hello");
  ws.send({ type: "identify", token: bob.token });
  const err = await ws.next("error");
  assert.equal(err.code, "invalid_token");
  ws.close();
});

await step("direct messages are private to participants", async () => {
  const open = await api("POST", "/api/social/dm", { token: alice.token, body: { username: "carol1" } });
  assert.equal(open.status, 201, open.text);
  const id = open.json.conversation.id;
  const sent = await api("POST", `/api/social/dm/${id}/messages`, {
    token: alice.token,
    body: { body: "hello carol" }
  });
  assert.equal(sent.status, 201, sent.text);
  const peek = await api("GET", `/api/social/dm/${id}/messages`, { token: owner.token });
  assert.ok([403, 404].includes(peek.status), `non-participant got ${peek.status}`);
  await api("PATCH", `/api/admin/users/${bob.user.id}`, { token: owner.token, body: { status: "active" } });
});

await step("invite creation is rate limited per user", async () => {
  const roomId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO rooms (id, room_code, name, host_id, kind, is_active, privacy, capacity, last_activity_at, created_at)
     VALUES (?, ?, ?, ?, 'lobby', 1, 'public', 8, ?, ?)`
  ).run(roomId, "INVITE1", "invite room", owner.user.id, Date.now(), Date.now());
  let limited = null;
  for (let i = 0; i < 31; i += 1) {
    const res = await api("POST", "/api/social/invites", { token: owner.token, body: { roomCode: "INVITE1" } });
    if (res.status === 429) {
      limited = res;
      break;
    }
    assert.equal(res.status, 201, `invite ${i}: ${res.text}`);
  }
  assert.ok(limited, "expected invite rate limit");
  assert.equal(limited.json.error, "invite_rate_limit");
});

await step("private files require owner token", async () => {
  const fileId = crypto.randomUUID();
  const objectKey = `sec/${fileId}.txt`;
  const dir = path.join(tmp, "uploads", "sec");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${fileId}.txt`), "private-content");
  db.prepare(
    `INSERT INTO media_objects (id, owner_id, bucket, object_key, mime, size_bytes, kind, visibility, created_at)
     VALUES (?, ?, 'sec', ?, 'text/plain', 15, 'attachment', 'private', ?)`
  ).run(fileId, alice.user.id, objectKey, Date.now());
  const mine = await api("GET", `/api/files/${fileId}`, { token: alice.token });
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.text, "private-content");
  const other = await api("GET", `/api/files/${fileId}`, { token: carol.token });
  assert.equal(other.status, 403, other.text);
  const anonymous = await api("GET", `/api/files/${fileId}`);
  assert.equal(anonymous.status, 401, anonymous.text);
});

await step("media proxy requires auth and blocks internal hosts", async () => {
  const target = encodeURIComponent("http://127.0.0.1/api/health");
  const anon = await api("GET", `/api/media/fetch?url=${target}`);
  assert.equal(anon.status, 401, anon.text);
  const loopback = await api("GET", `/api/media/fetch?url=${target}`, { token: alice.token });
  assert.equal(loopback.status, 400, loopback.text);
  assert.equal(loopback.json.error, "url_not_allowed");
  const localhost = await api("GET", `/api/media/fetch?url=${encodeURIComponent("https://localhost/x.mp4")}`, { token: alice.token });
  assert.equal(localhost.status, 400, localhost.text);
  const metadata = await api("GET", `/api/media/fetch?url=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`, { token: alice.token });
  assert.equal(metadata.status, 400, metadata.text);
  const missing = await api("GET", "/api/media/fetch", { token: alice.token });
  assert.equal(missing.status, 400, missing.text);
});

await step("websocket chat dedupe, ack and resume", async () => {
  const a = await wsClient();
  const hello = await a.next("hello");
  assert.equal(hello.v, 1);
  a.send({ type: "identify", token: alice.token });
  const identified = await a.next("identified");
  assert.equal(identified.userId, alice.user.id);
  a.send({ type: "join", room: "WSROOM1", name: "alice" });
  const joined = await a.next("joined");
  assert.equal(joined.room, "WSROOM1");
  assert.ok(joined.members.some((m) => m.identified));
  a.send({ type: "chat", content: "سلام", cid: "cid-1" });
  const chat = await a.next("chat");
  assert.equal(chat.message.content, "سلام");
  const ack = await a.next("chat-ack");
  assert.equal(ack.duplicate, undefined);
  assert.ok(ack.seq > 0);
  a.send({ type: "chat", content: "duplicate", cid: "cid-1" });
  const dup = await a.next("chat-ack");
  assert.equal(dup.duplicate, true);
  assert.equal(dup.id, ack.id);

  const b = await wsClient();
  await b.next("hello");
  b.send({ type: "join", room: "WSROOM1", since: 0 });
  const resumed = await b.next("resumed");
  assert.ok(resumed.replayed >= 1);
  const replay = await b.next((m) => m.type === "chat" && m.seq <= resumed.seq);
  assert.equal(replay.message.content, "سلام");
  b.close();
  a.close();
});

await step("websocket password rooms require membership", async () => {
  const roomId = crypto.randomUUID();
  const hash = await bcrypt.hash("room-pass", 4);
  db.prepare(
    `INSERT INTO rooms (id, room_code, name, host_id, kind, is_active, privacy, password_hash, capacity, last_activity_at, created_at)
     VALUES (?, ?, ?, ?, 'lobby', 1, 'password', ?, 8, ?, ?)`
  ).run(roomId, "LOCKED1", "locked room", owner.user.id, hash, Date.now(), Date.now());

  const anon = await wsClient();
  await anon.next("hello");
  anon.send({ type: "join", room: "LOCKED1" });
  const denied = await anon.next("error");
  assert.equal(denied.code, "room_locked");
  anon.close();

  const memberWs = await wsClient();
  await memberWs.next("hello");
  memberWs.send({ type: "identify", token: alice.token });
  await memberWs.next("identified");
  memberWs.send({ type: "join", room: "LOCKED1" });
  const stillDenied = await memberWs.next("error");
  assert.equal(stillDenied.code, "room_locked");

  db.prepare(
    `INSERT INTO room_memberships (id, room_id, user_id, role, joined_at, last_seen_at)
     VALUES (?, ?, ?, 'member', ?, ?)`
  ).run(crypto.randomUUID(), roomId, alice.user.id, Date.now(), Date.now());
  memberWs.send({ type: "join", room: "LOCKED1" });
  const ok = await memberWs.next("joined");
  assert.equal(ok.room, "LOCKED1");
  memberWs.close();
});

await step("websocket flood protection", async () => {
  const ws = await wsClient();
  await ws.next("hello");
  for (let i = 0; i < 61; i += 1) ws.send({ type: "ping" });
  const err = await ws.next((m) => m.type === "error" && m.code === "flood", 8000);
  assert.equal(err.code, "flood");
  ws.close();
});

await step("websocket oversized frame rejected", async () => {
  const ws = await wsClient();
  await ws.next("hello");
  ws.send({ type: "chat", content: "x".repeat(70 * 1024) });
  const err = await ws.next((m) => m.type === "error" && m.code === "frame_too_large");
  assert.equal(err.code, "frame_too_large");
  ws.close();
});

await step("login lockout after repeated failures", async () => {
  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(alice.user.id);
  for (let i = 0; i < 10; i += 1) {
    const res = await api("POST", "/api/auth/login", {
      body: { identifier: "alice1", password: "wrong-password" }
    });
    assert.equal(res.status, 401, `attempt ${i}: ${res.text}`);
  }
  const locked = await api("POST", "/api/auth/login", {
    body: { identifier: "alice1", password: "Passw0rd!test" }
  });
  assert.equal(locked.status, 429, locked.text);
  assert.equal(locked.json.error, "too_many_attempts");
});

await step("database integrity and foreign keys", async () => {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  assert.equal(integrity[0].integrity_check, "ok");
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(fk, []);
  const moderated = db.prepare("SELECT COUNT(*) AS n FROM moderation_actions").get();
  assert.ok(Number(moderated.n) >= 1, "moderation actions must be recorded");
});

await app.close();
closeDatabase();
fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} test(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall security & realtime checks passed");
