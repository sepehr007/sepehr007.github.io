import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(here, "..");
const siteDir = path.join(serverDir, "..");
const tmpRoot = path.join(here, "..", ".tmp");
fs.mkdirSync(tmpRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tmpRoot, "qa-"));
process.env.APP_ENV = "development";
process.env.NODE_ENV = "development";
process.env.DATA_DIR = tmp;
process.env.SQLITE_FILE = path.join(tmp, "wt.sqlite");
process.env.JWT_SECRET = "qa-secret-".padEnd(48, "x");
process.env.LOG_LEVEL = "silent";
process.env.RATE_LIMIT_MAX = "100000";
process.env.RATE_LIMIT_WINDOW_MS = "1000";
process.env.ADMIN_RATE_LIMIT = "100000";
process.env.REDIS_URL = "";
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.PAYMENT_PROVIDER = "manual";
process.env.APP_ORIGIN = "http://localhost:4789";
process.env.REQUIRE_EMAIL_VERIFICATION = "false";

const { buildServer } = await import("../index.js");
const { getDatabase, closeDatabase } = await import("../database/index.js");
const { invalidateAuthCache } = await import("../routes/auth.js");
const bcrypt = (await import("bcryptjs")).default;

const app = await buildServer();
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}/ws`;
const db = await getDatabase();
assert.ok(db, "database must open");

const results = [];
async function step(section, name, fn) {
  try {
    await fn();
    results.push({ section, name, ok: true });
    console.log(`ok   [${section}] ${name}`);
  } catch (err) {
    results.push({ section, name, ok: false, error: err.message });
    console.error(`FAIL [${section}] ${name}: ${err.message}`);
  }
}

async function api(method, url, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
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

async function register(username, password = "Passw0rd!test") {
  const res = await api("POST", "/api/auth/register", {
    body: {
      username,
      email: `${username}@example.test`,
      password,
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
let dave;
let eve;

/* ================================================================== setup */
await step("accounts", "register independent accounts", async () => {
  owner = await register("qaowner");
  alice = await register("qaalice");
  bob = await register("qabob");
  carol = await register("qacarol");
  dave = await register("qadave");
  eve = await register("qaeve");
  for (const user of [owner, alice, bob, carol, dave, eve]) {
    assert.ok(user.token, "token must be issued");
    assert.ok(user.user?.id, "user id must be returned");
  }
  db.prepare("UPDATE users SET role = 'owner', updated_at = ? WHERE id = ?").run(Date.now(), owner.user.id);
  invalidateAuthCache(owner.user.id);
});

/* ============================================================== accounts */
await step("accounts", "login, me and session listing", async () => {
  const login = await api("POST", "/api/auth/login", { body: { identifier: "qaalice", password: "Passw0rd!test" } });
  assert.equal(login.status, 200, login.text);
  const token = login.json.token;
  const me = await api("GET", "/api/auth/me", { token });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json.user.username, "qaalice");
  const sessions = await api("GET", "/api/auth/sessions", { token });
  assert.equal(sessions.status, 200);
  assert.ok(Array.isArray(sessions.json.sessions) && sessions.json.sessions.length >= 1);
  const anon = await api("GET", "/api/auth/me");
  assert.equal(anon.status, 401);
});

await step("accounts", "password change revokes old sessions", async () => {
  const oldToken = dave.token;
  const changed = await api("POST", "/api/auth/password", {
    token: oldToken,
    body: { current: "Passw0rd!test", next: "NewPass!456" }
  });
  assert.equal(changed.status, 200, changed.text);
  assert.ok(changed.json.token, "new token must be issued");
  const stale = await api("GET", "/api/auth/me", { token: oldToken });
  assert.equal(stale.status, 401, "old token must stop working");
  const fresh = await api("GET", "/api/auth/me", { token: changed.json.token });
  assert.equal(fresh.status, 200, fresh.text);
  const oldLogin = await api("POST", "/api/auth/login", {
    body: { identifier: "qadave", password: "Passw0rd!test" }
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await api("POST", "/api/auth/login", {
    body: { identifier: "qadave", password: "NewPass!456" }
  });
  assert.equal(newLogin.status, 200, newLogin.text);
  dave.token = newLogin.json.token;
});

await step("accounts", "password recovery link resets the password", async () => {
  const forgot = await api("POST", "/api/auth/password/forgot", { body: { email: "qacarol@example.test" } });
  assert.equal(forgot.status, 200, forgot.text);
  assert.equal(forgot.json.sent, true);
  assert.ok(forgot.json.previewLink, "development outbox must expose the reset link");
  const link = new URL(forgot.json.previewLink);
  const token = link.searchParams.get("reset");
  assert.ok(token, "reset token must be in the link");
  const reset = await api("POST", "/api/auth/password/reset", {
    body: { token, password: "ResetPass!789" }
  });
  assert.equal(reset.status, 200, reset.text);
  assert.ok(reset.json.token, "reset must issue a new session");
  assert.ok(reset.json.recoveryCode, "reset must issue a recovery code");
  carol.token = reset.json.token;
  const login = await api("POST", "/api/auth/login", {
    body: { identifier: "qacarol", password: "ResetPass!789" }
  });
  assert.equal(login.status, 200, login.text);
});

await step("accounts", "toast-free privacy update and friend request flow", async () => {
  const privacy = await api("PATCH", "/api/auth/privacy", {
    token: alice.token,
    body: { discoverable: true, dmFrom: "friends" }
  });
  assert.equal(privacy.status, 200, privacy.text);

  const sent = await api("POST", "/api/social/friends/request", {
    token: alice.token,
    body: { username: "qabob", message: "سلام، دوست باشیم؟" }
  });
  assert.equal(sent.status, 201, sent.text);
  const requestId = sent.json.request.id;

  const inbox = await api("GET", "/api/social/requests", { token: bob.token });
  assert.equal(inbox.status, 200);
  assert.ok(inbox.json.incoming.some((item) => item.id === requestId));

  const accepted = await api("POST", "/api/social/friends/respond", {
    token: bob.token,
    body: { requestId, accept: true }
  });
  assert.equal(accepted.status, 200, accepted.text);

  const aliceFriends = await api("GET", "/api/social/friends", { token: alice.token });
  assert.ok(aliceFriends.json.friends.some((item) => item.username === "qabob"));
});

await step("accounts", "blocking stops private messages", async () => {
  const blocked = await api("POST", "/api/social/blocks", { token: bob.token, body: { username: "qaalice" } });
  assert.equal(blocked.status, 201, blocked.text);
  const denied = await api("POST", "/api/social/dm", { token: alice.token, body: { username: "qabob" } });
  assert.equal(denied.status, 403, denied.text);
  assert.equal(denied.json.error, "blocked");
  const unblocked = await api("DELETE", "/api/social/blocks/qaalice", { token: bob.token });
  assert.equal(unblocked.status, 200, unblocked.text);
});

await step("accounts", "private messaging is limited to participants", async () => {
  const open = await api("POST", "/api/social/dm", { token: alice.token, body: { username: "qabob" } });
  assert.equal(open.status, 201, open.text);
  const conversationId = open.json.conversation.id;
  const sent = await api("POST", `/api/social/dm/${conversationId}/messages`, {
    token: alice.token,
    body: { body: "پیام خصوصی تست" }
  });
  assert.equal(sent.status, 201, sent.text);
  const messages = await api("GET", `/api/social/dm/${conversationId}/messages`, { token: bob.token });
  assert.equal(messages.status, 200);
  assert.ok(messages.json.messages.some((item) => item.body === "پیام خصوصی تست"));
  const intruder = await api("GET", `/api/social/dm/${conversationId}/messages`, { token: carol.token });
  assert.ok([403, 404].includes(intruder.status), `intruder got ${intruder.status}`);
});

/* ========================================================== communities */
let roomCode;

await step("rooms", "create, join and discover a public room", async () => {
  const created = await api("POST", "/api/rooms", {
    token: alice.token,
    body: { name: "اتاق آزمون", description: "QA room", visibility: "public", capacity: 6 }
  });
  assert.equal(created.status, 201, created.text);
  roomCode = created.json.room.code;
  assert.ok(roomCode);
  assert.equal(created.json.room.viewerRole, "host");

  const joined = await api("POST", `/api/rooms/${roomCode}/join`, { token: bob.token, body: {} });
  assert.equal(joined.status, 200, joined.text);
  const carolJoin = await api("POST", `/api/rooms/${roomCode}/join`, { token: carol.token, body: {} });
  assert.equal(carolJoin.status, 200, carolJoin.text);

  const mine = await api("GET", "/api/rooms/mine", { token: bob.token });
  assert.equal(mine.status, 200, mine.text);
  assert.ok(mine.json.rooms.some((room) => room.code === roomCode));
  const discover = await api("GET", "/api/rooms/discover", { token: dave.token });
  assert.equal(discover.status, 200, discover.text);
  assert.ok(discover.json.rooms.some((room) => room.code === roomCode));
});

await step("rooms", "role permissions are enforced", async () => {
  const promote = await api("POST", `/api/rooms/${roomCode}/members/${bob.user.id}/role`, {
    token: alice.token,
    body: { role: "moderator" }
  });
  assert.equal(promote.status, 200, promote.text);

  const moderatorCannotPromote = await api("POST", `/api/rooms/${roomCode}/members/${carol.user.id}/role`, {
    token: bob.token,
    body: { role: "moderator" }
  });
  assert.equal(moderatorCannotPromote.status, 403, moderatorCannotPromote.text);

  const moderatorCannotTransfer = await api("POST", `/api/rooms/${roomCode}/transfer`, {
    token: bob.token,
    body: { userId: carol.user.id, password: "Passw0rd!test" }
  });
  assert.equal(moderatorCannotTransfer.status, 403, moderatorCannotTransfer.text);

  const outsiderJoin = await api("POST", `/api/rooms/${roomCode}/join`, { token: owner.token, body: {} });
  assert.equal(outsiderJoin.status, 200, "staff may join as well");
  await api("POST", `/api/rooms/${roomCode}/leave`, { token: owner.token });
});

await step("rooms", "administrators get granular permissions", async () => {
  const eveJoin = await api("POST", `/api/rooms/${roomCode}/join`, { token: eve.token, body: {} });
  assert.equal(eveJoin.status, 200, eveJoin.text);

  const restricted = await api("POST", `/api/rooms/${roomCode}/members/${carol.user.id}/role`, {
    token: alice.token,
    body: { role: "administrator", permissions: { admin: false, settings: false, remove: false, video: false } }
  });
  assert.equal(restricted.status, 200, restricted.text);
  assert.equal(restricted.json.role, "administrator");
  assert.equal(restricted.json.permissions.admin, false);
  assert.equal(restricted.json.permissions.settings, false);
  assert.equal(restricted.json.permissions.chat, true, "role defaults must still apply");

  const view = await api("GET", `/api/rooms/${roomCode}`, { token: carol.token });
  assert.equal(view.status, 200, view.text);
  assert.equal(view.json.room.viewerRole, "administrator");
  assert.equal(view.json.room.viewerPermissions.admin, false);
  assert.equal(view.json.room.canManage, false, "administrator is not the Manager");

  const members = await api("GET", `/api/rooms/${roomCode}/members`, { token: alice.token });
  assert.equal(members.status, 200, members.text);
  const carolRow = members.json.members.find((m) => m.userId === carol.user.id);
  assert.ok(carolRow, "administrator must be listed");
  assert.equal(carolRow.role, "administrator");
  assert.equal(carolRow.permissions.settings, false);

  const deniedRole = await api("POST", `/api/rooms/${roomCode}/members/${eve.user.id}/role`, {
    token: carol.token,
    body: { role: "guest" }
  });
  assert.equal(deniedRole.status, 403, "administrator without the admin cap cannot change roles");

  const deniedSettings = await api("PATCH", `/api/rooms/${roomCode}`, {
    token: carol.token,
    body: { name: "تغییر غیرمجاز" }
  });
  assert.equal(deniedSettings.status, 403, "administrator without the settings cap cannot edit the room");

  const widened = await api("POST", `/api/rooms/${roomCode}/members/${carol.user.id}/permissions`, {
    token: alice.token,
    body: { permissions: { admin: true, settings: true, remove: true, video: true } }
  });
  assert.equal(widened.status, 200, widened.text);
  assert.equal(widened.json.permissions.admin, true);

  const tooHigh = await api("POST", `/api/rooms/${roomCode}/members/${bob.user.id}/role`, {
    token: carol.token,
    body: { role: "administrator" }
  });
  assert.equal(tooHigh.status, 403, "nobody can grant a role at or above their own rank");

  const demote = await api("POST", `/api/rooms/${roomCode}/members/${eve.user.id}/role`, {
    token: carol.token,
    body: { role: "guest" }
  });
  assert.equal(demote.status, 200, demote.text);
  assert.equal(demote.json.role, "guest");

  const mute = await api("POST", `/api/rooms/${roomCode}/members/${eve.user.id}/mute`, {
    token: carol.token,
    body: { muted: true }
  });
  assert.equal(mute.status, 200, mute.text);
  assert.equal(mute.json.muted, true);
  const unmute = await api("POST", `/api/rooms/${roomCode}/members/${eve.user.id}/mute`, {
    token: carol.token,
    body: { muted: false }
  });
  assert.equal(unmute.status, 200, unmute.text);
  assert.equal(unmute.json.muted, false);

  const muteManager = await api("POST", `/api/rooms/${roomCode}/members/${alice.user.id}/mute`, {
    token: carol.token,
    body: { muted: true }
  });
  assert.equal(muteManager.status, 409, "the Manager can never be muted");

  const restrictRemove = await api("POST", `/api/rooms/${roomCode}/members/${bob.user.id}/permissions`, {
    token: alice.token,
    body: { permissions: { remove: false } }
  });
  assert.equal(restrictRemove.status, 200, restrictRemove.text);
  const blockedKick = await api("POST", `/api/rooms/${roomCode}/members/${eve.user.id}/kick`, {
    token: bob.token
  });
  assert.equal(blockedKick.status, 403, "moderator without the remove cap cannot kick");
  const restoreRemove = await api("POST", `/api/rooms/${roomCode}/members/${bob.user.id}/permissions`, {
    token: alice.token,
    body: { permissions: {} }
  });
  assert.equal(restoreRemove.status, 200, restoreRemove.text);
  assert.equal(restoreRemove.json.permissions.remove, true, "role defaults return once overrides are cleared");

  const rankKick = await api("POST", `/api/rooms/${roomCode}/members/${carol.user.id}/kick`, {
    token: bob.token
  });
  assert.equal(rankKick.status, 403, "a moderator cannot remove an administrator");

  const kicked = await api("POST", `/api/rooms/${roomCode}/members/${eve.user.id}/kick`, {
    token: alice.token
  });
  assert.equal(kicked.status, 200, kicked.text);
  assert.ok(kicked.json.by, "the Manager name must be returned for the removal notice");

  const after = await api("GET", `/api/rooms/${roomCode}/members`, { token: alice.token });
  assert.equal(after.status, 200, after.text);
  assert.ok(!after.json.members.some((m) => m.userId === eve.user.id), "removed member must disappear immediately");

  const eveView = await api("GET", `/api/rooms/${roomCode}`, { token: eve.token });
  assert.equal(eveView.status, 200, eveView.text);
  assert.equal(eveView.json.room.isMember, false, "stale membership must be cleared");
  assert.equal(eveView.json.room.viewerRole, "");

  const selfKick = await api("POST", `/api/rooms/${roomCode}/members/${alice.user.id}/kick`, {
    token: alice.token
  });
  assert.equal(selfKick.status, 409, "the Manager cannot remove themselves");

  const resetCarol = await api("POST", `/api/rooms/${roomCode}/members/${carol.user.id}/role`, {
    token: alice.token,
    body: { role: "member", permissions: {} }
  });
  assert.equal(resetCarol.status, 200, resetCarol.text);
  assert.ok(!resetCarol.json.permissions.settings, "plain members carry no settings capability");
});

await step("rooms", "invite creation and acceptance", async () => {
  const invite = await api("POST", `/api/rooms/${roomCode}/invites`, {
    token: alice.token,
    body: { expiresInHours: 4, maxUses: 3 }
  });
  assert.equal(invite.status, 201, invite.text);
  const code = invite.json.invite.code;
  assert.ok(code, "invite code must be returned once");
  const accepted = await api("POST", "/api/social/invites/accept", { token: dave.token, body: { code } });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(String(accepted.json.roomCode).toUpperCase(), roomCode.toUpperCase());
  const join = await api("POST", `/api/rooms/${roomCode}/join`, { token: dave.token, body: {} });
  assert.equal(join.status, 200, join.text);
  const details = await api("GET", `/api/rooms/${roomCode}`, { token: dave.token });
  assert.equal(details.json.room.isMember, true);
});

await step("rooms", "manager transfer needs the account password", async () => {
  const wrong = await api("POST", `/api/rooms/${roomCode}/transfer`, {
    token: alice.token,
    body: { userId: bob.user.id, password: "not-my-password" }
  });
  assert.equal(wrong.status, 403, wrong.text);
  assert.equal(wrong.json.error, "wrong_password");

  const transfer = await api("POST", `/api/rooms/${roomCode}/transfer`, {
    token: alice.token,
    body: { userId: bob.user.id, password: "Passw0rd!test" }
  });
  assert.equal(transfer.status, 200, transfer.text);

  const bobView = await api("GET", `/api/rooms/${roomCode}`, { token: bob.token });
  assert.equal(bobView.json.room.canManage, true);
  const aliceView = await api("GET", `/api/rooms/${roomCode}`, { token: alice.token });
  assert.equal(aliceView.json.room.canManage, false);
  assert.equal(aliceView.json.room.viewerRole, "member");

  const formerHostKick = await api("POST", `/api/rooms/${roomCode}/members/${dave.user.id}/kick`, {
    token: alice.token
  });
  assert.equal(formerHostKick.status, 403, formerHostKick.text);
});

await step("rooms", "password and private rooms are gated", async () => {
  const locked = await api("POST", "/api/rooms", {
    token: bob.token,
    body: { name: "اتاق رمزی", visibility: "public", password: "roompass1", capacity: 4 }
  });
  assert.equal(locked.status, 201, locked.text);
  const lockedCode = locked.json.room.code;

  const noPassword = await api("POST", `/api/rooms/${lockedCode}/join`, { token: carol.token, body: {} });
  assert.equal(noPassword.status, 403, noPassword.text);
  assert.equal(noPassword.json.error, "wrong_password");
  const wrongPassword = await api("POST", `/api/rooms/${lockedCode}/join`, {
    token: carol.token,
    body: { password: "nope-nope" }
  });
  assert.equal(wrongPassword.status, 403, wrongPassword.text);
  const goodPassword = await api("POST", `/api/rooms/${lockedCode}/join`, {
    token: carol.token,
    body: { password: "roompass1" }
  });
  assert.equal(goodPassword.status, 200, goodPassword.text);

  const hidden = await api("POST", "/api/rooms", {
    token: bob.token,
    body: { name: "اتاق خصوصی", visibility: "private", capacity: 4 }
  });
  assert.equal(hidden.status, 201, hidden.text);
  const denied = await api("POST", `/api/rooms/${hidden.json.room.code}/join`, { token: dave.token, body: {} });
  assert.equal(denied.status, 403, denied.text);
  assert.ok(["private_room", "invite_required"].includes(denied.json.error), denied.text);
});

await step("rooms", "approval rooms wait for manager decision", async () => {
  const created = await api("POST", "/api/rooms", {
    token: bob.token,
    body: { name: "اتاق تأییدی", joinMode: "approval", capacity: 6 }
  });
  assert.equal(created.status, 201, created.text);
  const code = created.json.room.code;

  const blocked = await api("POST", `/api/rooms/${code}/join`, { token: dave.token, body: {} });
  assert.equal(blocked.status, 403, blocked.text);
  assert.equal(blocked.json.error, "approval_required");

  const requested = await api("POST", `/api/rooms/${code}/request`, { token: dave.token, body: { note: "سلام" } });
  assert.ok([200, 202].includes(requested.status), requested.text);

  const pending = await api("GET", `/api/rooms/${code}/requests`, { token: bob.token });
  assert.equal(pending.status, 200, pending.text);
  assert.ok(pending.json.requests.some((row) => row.userId === dave.user.id), pending.text);

  const stillBlocked = await api("POST", `/api/rooms/${code}/join`, { token: dave.token, body: {} });
  assert.equal(stillBlocked.status, 403, stillBlocked.text);
  assert.equal(stillBlocked.json.error, "approval_pending");

  const decided = await api("POST", `/api/rooms/${code}/requests/${dave.user.id}/decide`, {
    token: bob.token,
    body: { decision: "approve" }
  });
  assert.equal(decided.status, 200, decided.text);

  const joined = await api("POST", `/api/rooms/${code}/join`, { token: dave.token, body: {} });
  assert.equal(joined.status, 200, joined.text);

  const anonymous = await api("GET", "/api/rooms/public");
  assert.equal(anonymous.status, 200, anonymous.text);
  assert.ok(anonymous.json.rooms.some((room) => room.code === code), anonymous.text);
});

await step("rooms", "room creation can require an active subscription", async () => {
  const enable = await api("PUT", "/api/admin/settings", {
    token: owner.token,
    body: { values: { "plans.roomsRequirePremium": true } }
  });
  assert.equal(enable.status, 200, enable.text);
  try {
    const denied = await api("POST", "/api/rooms", { token: carol.token, body: { name: "اتاق بدون اشتراک" } });
    assert.equal(denied.status, 403, denied.text);
    assert.equal(denied.json.error, "premium_required");
    const staff = await api("POST", "/api/rooms", { token: owner.token, body: { name: "اتاق مالک" } });
    assert.equal(staff.status, 201, staff.text);
  } finally {
    await api("PUT", "/api/admin/settings", {
      token: owner.token,
      body: { values: { "plans.roomsRequirePremium": false } }
    });
  }
});

/* ================================================================= media */
await step("media", "watch history upsert, list and delete", async () => {
  const saved = await api("POST", "/api/social/history", {
    token: alice.token,
    body: { mediaUrl: "https://example.com/movie.mp4", title: "فیلم آزمون", position: 120, duration: 3600 }
  });
  assert.equal(saved.status, 201, saved.text);
  const updated = await api("POST", "/api/social/history", {
    token: alice.token,
    body: { mediaUrl: "https://example.com/movie.mp4", title: "فیلم آزمون", position: 300, duration: 3600 }
  });
  assert.equal(updated.json.item.id, saved.json.item.id, "same media must upsert");
  assert.equal(updated.json.item.position, 300);
  const list = await api("GET", "/api/social/history", { token: alice.token });
  assert.ok(list.json.history.some((item) => item.id === saved.json.item.id && item.position === 300));
  const removed = await api("DELETE", `/api/social/history/${saved.json.item.id}`, { token: alice.token });
  assert.equal(removed.status, 200);
  const after = await api("GET", "/api/social/history", { token: alice.token });
  assert.ok(!after.json.history.some((item) => item.id === saved.json.item.id));
});

await step("media", "favorites and media library", async () => {
  const added = await api("POST", "/api/social/library", {
    token: alice.token,
    body: { kind: "favorite", title: "فیلم محبوب", url: "https://example.com/fav.mp4", meta: { year: 2024 } }
  });
  assert.equal(added.status, 201, added.text);
  const list = await api("GET", "/api/social/library?kind=favorite", { token: alice.token });
  assert.ok(list.json.items.some((item) => item.id === added.json.item.id));
  const bad = await api("POST", "/api/social/library", {
    token: alice.token,
    body: { kind: "spam", title: "x", url: "https://example.com/x" }
  });
  assert.equal(bad.status, 400);
  const removed = await api("DELETE", `/api/social/library/${added.json.item.id}`, { token: alice.token });
  assert.equal(removed.status, 200);
});

await step("media", "polls across members", async () => {
  const created = await api("POST", "/api/social/polls", {
    token: bob.token,
    body: { roomCode, question: "کدام فیلم؟", options: ["الف", "ب", "ج"], multi: false, anonymous: true }
  });
  assert.equal(created.status, 201, created.text);
  const poll = created.json.poll;
  assert.equal(poll.options.length, 3);

  const optionId = poll.options[1].id;
  const voted = await api("POST", `/api/social/polls/${poll.id}/vote`, {
    token: carol.token,
    body: { optionIds: [optionId] }
  });
  assert.equal(voted.status, 200, voted.text);

  const closed = await api("POST", `/api/social/polls/${poll.id}/close`, { token: bob.token });
  assert.equal(closed.status, 200, closed.text);
  assert.ok(closed.json.poll.closedAt || closed.json.poll.status === "closed");
  const lateVote = await api("POST", `/api/social/polls/${poll.id}/vote`, {
    token: carol.token,
    body: { optionIds: [optionId] }
  });
  assert.equal(lateVote.status, 409, lateVote.text);
});

await step("media", "private room polls stay inside the room", async () => {
  const hidden = await api("POST", "/api/rooms", {
    token: bob.token,
    body: { name: "رأی خصوصی", visibility: "private", capacity: 4 }
  });
  assert.equal(hidden.status, 201, hidden.text);
  const hiddenCode = hidden.json.room.code;
  const poll = await api("POST", "/api/social/polls", {
    token: bob.token,
    body: { roomCode: hiddenCode, question: "داخلی؟", options: ["بله", "نه"] }
  });
  assert.equal(poll.status, 201, poll.text);
  const optionId = poll.json.poll.options[0].id;
  const outsider = await api("POST", `/api/social/polls/${poll.json.poll.id}/vote`, {
    token: eve.token,
    body: { optionIds: [optionId] }
  });
  assert.equal(outsider.status, 403, "non-members cannot vote in a private room");
});

await step("media", "realtime chat delivery and playback sync", async () => {
  const a = await wsClient();
  const b = await wsClient();
  await a.next("hello");
  await b.next("hello");
  a.send({ type: "join", room: "QAWS01", name: "alice" });
  await a.next("joined");
  b.send({ type: "join", room: "QAWS01", name: "bob" });
  await b.next("joined");

  a.send({ type: "chat", content: "سلام از اتاق", cid: "qa-cid-1" });
  const delivered = await b.next("chat");
  assert.equal(delivered.message.content, "سلام از اتاق");
  await a.next("chat-ack");

  a.send({ type: "playback", action: "play", time: 42.5, paused: false, rate: 1 });
  const state = await b.next("playback");
  assert.equal(state.action, "play");
  assert.equal(state.time, 42.5);
  a.send({ type: "playback", action: "seek", time: 90, paused: false, rate: 1 });
  const seek = await b.next((m) => m.type === "playback" && m.action === "seek");
  assert.equal(seek.time, 90);
  a.close();
  b.close();
});

/* ====================================================== administration */
await step("business", "plan listing, order, manual payment verify", async () => {
  const plans = await api("GET", "/api/billing/plans");
  assert.equal(plans.status, 200, plans.text);
  const plan = plans.json.plans.find((item) => item.slug === "monthly") || plans.json.plans[0];
  assert.ok(plan, "at least one plan must exist");
  assert.equal(plans.json.provider.provider, "manual");

  const order = await api("POST", "/api/billing/orders", { token: alice.token, body: { planSlug: plan.slug } });
  assert.equal(order.status, 200, order.text);
  assert.equal(order.json.order.status, "pending");
  const orderId = order.json.order.id;

  const pay = await api("POST", `/api/billing/orders/${orderId}/pay`, { token: alice.token });
  assert.equal(pay.status, 200, pay.text);
  assert.equal(pay.json.intent.mode, "manual");
  const paymentId = pay.json.payment.id;

  const noConfirm = await api("POST", `/api/admin/billing/payments/${paymentId}/verify`, {
    token: owner.token,
    body: { providerRef: "QA-REF-1" }
  });
  assert.equal(noConfirm.status, 428, "manual verification must require confirm:true");
  assert.equal(noConfirm.json.error, "confirmation_required");

  const verified = await api("POST", `/api/admin/billing/payments/${paymentId}/verify`, {
    token: owner.token,
    body: { confirm: true, providerRef: "QA-REF-1" }
  });
  assert.equal(verified.status, 200, verified.text);

  const me = await api("GET", "/api/billing/me", { token: alice.token });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json.state, "active");
});

await step("business", "website page publishing reaches the public nav", async () => {
  const created = await api("POST", "/api/admin/pages", {
    token: owner.token,
    body: {
      slug: "qa-page",
      title: "صفحه آزمون",
      blocks: [{ type: "heading", text: "سلام دنیا" }, { type: "text", text: "محتوای آزمون" }],
      status: "published",
      showInNav: true,
      visibility: "public"
    }
  });
  assert.equal(created.status, 200, created.text);
  const pageId = created.json.page.id;

  const publicPage = await api("GET", "/api/pages/qa-page");
  assert.equal(publicPage.status, 200, publicPage.text);
  assert.equal(publicPage.json.page.title, "صفحه آزمون");
  assert.ok(publicPage.json.page.blocks.some((block) => block.type === "heading"));

  const nav = await api("GET", "/api/pages/nav");
  assert.ok(nav.json.items.some((item) => item.slug === "qa-page"));

  const unpublished = await api("PATCH", `/api/admin/pages/${pageId}`, {
    token: owner.token,
    body: { status: "draft" }
  });
  assert.equal(unpublished.status, 200, unpublished.text);
  const hidden = await api("GET", "/api/pages/qa-page");
  assert.equal(hidden.status, 404);
});

await step("business", "automation workflow creates and simulates", async () => {
  const created = await api("POST", "/api/admin/automation", {
    token: owner.token,
    body: {
      name: "اعلان اتاق تازه",
      trigger: "room.created",
      conditions: { match: "all", rules: [] },
      actions: [{ type: "notify_owner", params: { title: "اتاق تازه", body: "یک اتاق تازه ساخته شد." } }],
      enabled: true
    }
  });
  assert.equal(created.status, 200, created.text);
  const workflowId = created.json.workflow.id;
  assert.equal(created.json.workflow.enabled, true);

  const simulate = await api("POST", `/api/admin/automation/${workflowId}/simulate`, {
    token: owner.token,
    body: { confirm: true, event: { roomCode: "QAWS01", name: "اتاق آزمون", capacity: 6 } }
  });
  assert.equal(simulate.status, 200, simulate.text);
  assert.equal(simulate.json.dryRun, true);
  assert.equal(simulate.json.matched, true);
});

await step("business", "analytics ingest and report", async () => {
  const ingested = await api("POST", "/api/analytics/events", {
    body: { event: "qa.page_view", path: "/index.html", sessionId: "qa-session-1", props: { source: "test" } }
  });
  assert.equal(ingested.status, 200, ingested.text);
  const report = await api("GET", "/api/admin/analytics/report?days=7", { token: owner.token });
  assert.equal(report.status, 200, report.text);
  assert.ok(report.json.summary, "summary must be present");
  assert.ok(Array.isArray(report.json.series.labels));
  assert.ok(report.json.summary.pageViews.available !== false);
});

await step("business", "moderation reports resolve end to end", async () => {
  const report = await api("POST", "/api/social/reports", {
    token: alice.token,
    body: { targetType: "user", targetId: bob.user.id, category: "spam", details: "گزارش آزمون" }
  });
  assert.equal(report.status, 201, report.text);
  const reportId = report.json.report.id;
  const resolved = await api("PATCH", `/api/admin/reports/social/${reportId}`, {
    token: owner.token,
    body: { status: "resolved", resolution: "بررسی شد" }
  });
  assert.equal(resolved.status, 200, resolved.text);
  const mine = await api("GET", "/api/social/reports/mine", { token: alice.token });
  assert.ok(mine.json.reports.some((item) => item.id === reportId && item.status === "resolved"));
});

await step("business", "support ticket lifecycle", async () => {
  const ticket = await api("POST", "/api/social/support/tickets", {
    token: alice.token,
    body: { subject: "مشکل پخش", category: "playback", priority: "high", body: "ویدیو پخش نمی‌شود." }
  });
  assert.equal(ticket.status, 201, ticket.text);
  const ticketId = ticket.json.ticket.id;

  const reply = await api("POST", `/api/social/support/tickets/${ticketId}/messages`, {
    token: alice.token,
    body: { body: "جزئیات بیشتر: مرورگر کروم." }
  });
  assert.equal(reply.status, 201, reply.text);

  const patched = await api("PATCH", `/api/admin/support/${ticketId}`, {
    token: owner.token,
    body: { status: "resolved", priority: "normal", assignedTo: owner.user.id, resolution: "حل شد" }
  });
  assert.equal(patched.status, 200, patched.text);
  const view = await api("GET", `/api/social/support/tickets/${ticketId}`, { token: alice.token });
  assert.equal(view.json.ticket.status, "resolved");
});

/* ===================================================== platform quality */
await step("platform", "upload validation, private files and deletion", async () => {
  const created = await api("POST", "/api/uploads?kind=attachment", {
    token: alice.token,
    headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("qa.txt"), "x-file-type": "text/plain" },
    raw: "QA upload content"
  });
  assert.equal(created.status, 200, created.text);
  const fileId = created.json.id;
  assert.ok(fileId);

  const mine = await api("GET", `/api/files/${fileId}`, { token: alice.token });
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.text, "QA upload content");
  const other = await api("GET", `/api/files/${fileId}`, { token: carol.token });
  assert.equal(other.status, 403, other.text);
  const anonymous = await api("GET", `/api/files/${fileId}`);
  assert.equal(anonymous.status, 401, anonymous.text);

  const rejected = await api("POST", "/api/uploads?kind=avatar", {
    token: alice.token,
    headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("bad.txt"), "x-file-type": "text/plain" },
    raw: "not an image"
  });
  assert.equal(rejected.status, 415, rejected.text);
  assert.equal(rejected.json.error, "unsupported_type");

  const removed = await api("DELETE", `/api/uploads/${fileId}`, { token: alice.token });
  assert.equal(removed.status, 200, removed.text);
  const gone = await api("GET", `/api/files/${fileId}`, { token: alice.token });
  assert.equal(gone.status, 404, gone.text);
});

await step("platform", "database integrity, migrations and indexes", async () => {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  assert.equal(integrity[0].integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const version = Number(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v || 0);
  assert.ok(version >= 16, `schema version must be >= 16, got ${version}`);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name);
  assert.ok(indexes.includes("idx_users_active_created"));
  assert.ok(indexes.includes("idx_rooms_last_activity"));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const name of ["users", "profiles", "sessions", "friendships", "blocks", "dm_conversations", "rooms", "room_memberships", "messages", "room_polls", "poll_votes", "reports", "support_tickets", "playback_history", "media_library", "notifications", "subscription_plans", "orders", "payments", "website_pages", "analytics_events", "automation_workflows", "audit_logs"]) {
    assert.ok(tables.includes(name), `missing table ${name}`);
  }
});

await step("platform", "RTL pages, LTR inputs and PWA assets", async () => {
  const index = fs.readFileSync(path.join(siteDir, "index.html"), "utf8");
  assert.match(index, /<html[^>]*lang="fa"[^>]*dir="rtl"/);
  assert.match(index, /id="joinCode"[^>]*dir="ltr"/);
  const room = fs.readFileSync(path.join(siteDir, "room.html"), "utf8");
  assert.match(room, /dir="rtl"/);
  for (const file of ["manifest.webmanifest", "sw.js", "offline.html", "auth.html", "profile.html", "social.html", "rooms.html", "owner.html"]) {
    assert.ok(fs.existsSync(path.join(siteDir, file)), `missing ${file}`);
  }
  const sw = fs.readFileSync(path.join(siteDir, "sw.js"), "utf8");
  assert.match(sw, /const CACHE = "wt-v\d+"/);
  const manifest = JSON.parse(fs.readFileSync(path.join(siteDir, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.lang, "fa");
  assert.ok(manifest.display);
});

await step("platform", "production config refuses to start without JWT secret", () => {
  const envBase = { ...process.env, APP_ENV: "production", DATA_DIR: tmp, SQLITE_FILE: path.join(tmp, "prod.sqlite"), BACKUP_DIR: path.join(tmp, "prod-back"), CORS_ORIGIN: "https://example.com", APP_ORIGIN: "https://example.com" };
  const missing = spawnSync(process.execPath, ["config-check.js"], {
    cwd: serverDir,
    env: { ...envBase, JWT_SECRET: "" },
    encoding: "utf8",
    timeout: 30000
  });
  assert.equal(missing.status, 1, `expected exit 1, got ${missing.status}: ${missing.stdout}`);
  assert.match(missing.stdout, /jwt_secret_missing/);
  const ok = spawnSync(process.execPath, ["config-check.js"], {
    cwd: serverDir,
    env: { ...envBase, JWT_SECRET: "prod-secret-".padEnd(48, "z") },
    encoding: "utf8",
    timeout: 30000
  });
  assert.equal(ok.status, 0, `expected exit 0, got ${ok.status}: ${ok.stdout}`);
  assert.match(ok.stdout, /"ok": true/);
});

/* ======================================================== owner security */
let ownerSmsCode = "";
await step("owner", "owner console opens with a verified email OR a phone", async () => {
  const login = await api("POST", "/api/auth/login", { body: { identifier: "qaowner", password: "Passw0rd!test" } });
  assert.equal(login.status, 200, login.text);
  assert.equal(login.json.user.role, "owner");
  owner.token = login.json.token;
  const identity = await api("GET", "/api/auth/owner/identity", { token: owner.token });
  assert.equal(identity.status, 200, identity.text);
  assert.equal(identity.json.canAccess, false, "owner with no verified email and no phone must stay locked");
  assert.equal(identity.json.identity.emailReady, false);
  assert.equal(identity.json.identity.phoneReady, false);
  const lockedEmail = await api("POST", "/api/auth/owner/password/code", {
    token: owner.token,
    body: { channel: "email" }
  });
  assert.equal(lockedEmail.status, 409, lockedEmail.text);
  assert.equal(lockedEmail.json.error, "owner_contact_missing");
  const lockedSms = await api("POST", "/api/auth/owner/password/code", {
    token: owner.token,
    body: { channel: "sms" }
  });
  assert.equal(lockedSms.status, 409, lockedSms.text);
  const outsider = await api("GET", "/api/auth/owner/identity", { token: alice.token });
  assert.equal(outsider.status, 403, "non-owner must not read owner identity");

  db.prepare("UPDATE users SET phone = ?, updated_at = ? WHERE id = ?").run(
    "09121234567",
    Date.now(),
    owner.user.id
  );
  invalidateAuthCache(owner.user.id);
  const relogin = await api("POST", "/api/auth/login", { body: { identifier: "qaowner", password: "Passw0rd!test" } });
  assert.equal(relogin.status, 200, relogin.text);
  owner.token = relogin.json.token;
  const phoneOnly = await api("GET", "/api/auth/owner/identity", { token: owner.token });
  assert.equal(phoneOnly.status, 200, phoneOnly.text);
  assert.equal(phoneOnly.json.canAccess, true, "a registered phone alone must unlock the console");
  assert.equal(phoneOnly.json.identity.phoneReady, true);
  assert.equal(phoneOnly.json.identity.emailReady, false);
  assert.match(phoneOnly.json.identity.phone, /\*/);
  const emailStillLocked = await api("POST", "/api/auth/owner/password/code", {
    token: owner.token,
    body: { channel: "email" }
  });
  assert.equal(emailStillLocked.status, 409, "email channel needs a verified email");

  const smsRes = await api("POST", "/api/auth/owner/password/code", {
    token: owner.token,
    body: { channel: "sms" }
  });
  assert.equal(smsRes.status, 200, smsRes.text);
  assert.equal(smsRes.json.delivery.sent, true);
  assert.match(String(smsRes.json.delivery.previewCode || ""), /^\d{8}$/);
  ownerSmsCode = smsRes.json.delivery.previewCode;
});

await step("owner", "one SMS code is enough to change the owner password", async () => {
  const samePassword = await api("POST", "/api/auth/owner/password/confirm", {
    token: owner.token,
    body: { channel: "sms", code: ownerSmsCode, password: "Passw0rd!test" }
  });
  assert.equal(samePassword.status, 400, samePassword.text);
  assert.equal(samePassword.json.error, "password_unchanged");

  const wrongCode = await api("POST", "/api/auth/owner/password/confirm", {
    token: owner.token,
    body: { channel: "sms", code: "00000000", password: "OwnerNew!2026x" }
  });
  assert.equal(wrongCode.status, 400, wrongCode.text);
  assert.equal(wrongCode.json.error, "invalid_code");

  const changed = await api("POST", "/api/auth/owner/password/confirm", {
    token: owner.token,
    body: { channel: "sms", code: ownerSmsCode, password: "OwnerNew!2026x" }
  });
  assert.equal(changed.status, 200, changed.text);
  assert.ok(changed.json.token, "a fresh owner session must be issued");
  const revoked = await api("GET", "/api/auth/me", { token: owner.token });
  assert.equal(revoked.status, 401, "old owner sessions must be revoked");
  const oldLogin = await api("POST", "/api/auth/login", {
    body: { identifier: "qaowner", password: "Passw0rd!test" }
  });
  assert.equal(oldLogin.status, 401, "old password must stop working");
  const newLogin = await api("POST", "/api/auth/login", {
    body: { identifier: "qaowner", password: "OwnerNew!2026x" }
  });
  assert.equal(newLogin.status, 200, newLogin.text);
  assert.equal(newLogin.json.user.role, "owner");
  owner.token = newLogin.json.token;

  const reuse = await api("POST", "/api/auth/owner/password/confirm", {
    token: owner.token,
    body: { channel: "sms", code: ownerSmsCode, password: "OwnerNew!2026y" }
  });
  assert.equal(reuse.status, 400, "replay of a used code must fail");
  assert.equal(reuse.json.error, "code_expired");

  db.prepare("UPDATE users SET email_verified = 1, email_verified_at = ? WHERE id = ?").run(
    Date.now(),
    owner.user.id
  );
  invalidateAuthCache(owner.user.id);
  const emailReady = await api("GET", "/api/auth/owner/identity", { token: owner.token });
  assert.equal(emailReady.json.identity.emailReady, true);
  assert.equal(emailReady.json.identity.phoneReady, true);
  const emailRes = await api("POST", "/api/auth/owner/password/code", {
    token: owner.token,
    body: { channel: "email" }
  });
  assert.equal(emailRes.status, 200, "verified email channel must also work on its own");
  assert.match(String(emailRes.json.delivery.previewCode || ""), /^\d{8}$/);
});

await step("owner", "owner password changes are locked to the owner console", async () => {
  const viaProfile = await api("POST", "/api/auth/password", {
    token: owner.token,
    body: { current: "OwnerNew!2026x", next: "OwnerNew!2026z" }
  });
  assert.equal(viaProfile.status, 403, viaProfile.text);
  assert.equal(viaProfile.json.error, "owner_console_only");

  const forgotEmail = await api("POST", "/api/auth/password/forgot", { body: { email: "qaowner@example.test" } });
  assert.equal(forgotEmail.status, 200, forgotEmail.text);
  assert.equal(forgotEmail.json.previewCode, undefined, "owner email reset must not issue a code");
  const forgotPhone = await api("POST", "/api/auth/password/forgot", { body: { phone: "09121234567" } });
  assert.equal(forgotPhone.status, 200, forgotPhone.text);
  assert.equal(forgotPhone.json.previewCode, undefined, "owner SMS reset must not issue a code");

  const rotate = await api("POST", "/api/auth/recovery-code", {
    token: owner.token,
    body: { password: "OwnerNew!2026x" }
  });
  assert.equal(rotate.status, 403, rotate.text);
  assert.equal(rotate.json.error, "owner_console_only");

  const hash = await bcrypt.hash("12345678", 12);
  db.prepare("UPDATE users SET recovery_hash = ?, updated_at = ? WHERE id = ?").run(hash, Date.now(), owner.user.id);
  const recover = await api("POST", "/api/auth/recover", {
    body: { identifier: "qaowner", code: "12345678", password: "OwnerNew!2026z" }
  });
  assert.equal(recover.status, 403, recover.text);
  assert.equal(recover.json.error, "owner_console_only");

  const stillWorks = await api("POST", "/api/auth/login", {
    body: { identifier: "qaowner", password: "OwnerNew!2026x" }
  });
  assert.equal(stillWorks.status, 200, "owner password must stay unchanged after blocked paths");
});

await app.close();
closeDatabase();
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((item) => !item.ok);
const bySection = results.reduce((acc, item) => {
  acc[item.section] = acc[item.section] || { total: 0, failed: 0 };
  acc[item.section].total += 1;
  if (!item.ok) acc[item.section].failed += 1;
  return acc;
}, {});
console.log("\n--- section 42 summary ---");
for (const [section, stat] of Object.entries(bySection)) {
  console.log(`${section}: ${stat.total - stat.failed}/${stat.total} passed`);
}
if (failed.length) {
  console.error(`\n${failed.length} test(s) failed:`);
  for (const item of failed) console.error(`- [${item.section}] ${item.name}: ${item.error}`);
  process.exit(1);
}
console.log(`\nall ${results.length} section 42 checks passed`);
