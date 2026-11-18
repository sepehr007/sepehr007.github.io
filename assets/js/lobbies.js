/* One active lobby per account.
   Lobby records live in the `lobbies` store (plus a snapshot in `rooms`),
   so the home page can always offer "continue where you left off".
   A silent backend mirror is attempted when an API is configured. */

import { dbGet, dbGetByIndex, dbGetAll, dbPut, dbDelete, recordActivity } from "./db.js";
import { makeCode } from "./core.js";
import { apiFetch } from "./api.js";

const LIFETIME_MS = 24 * 60 * 60 * 1000;
const ACTIVE = "active";
const CLOSED = "closed";

function now() {
  return Date.now();
}

function userKey(user) {
  return String(user?.username || "").trim().toLowerCase();
}

function freshLobby(lobby) {
  return !!lobby && lobby.active === ACTIVE && Number(lobby.expiresAt || 0) > now();
}

function mirror(path, body) {
  apiFetch(path, { method: "POST", body, timeoutMs: 5000 }).catch(() => {});
}

function mirrorPatch(path, body) {
  apiFetch(path, { method: "PATCH", body, timeoutMs: 5000 }).catch(() => {});
}

export async function uniqueLobbyCode() {
  for (let i = 0; i < 12; i++) {
    const code = makeCode(6);
    const existing = await dbGet("lobbies", code);
    if (!existing) return code;
    if (!freshLobby(existing)) return code;
  }
  return makeCode(7);
}

async function closeRecord(lobby, reason) {
  if (!lobby) return null;
  const next = {
    ...lobby,
    active: CLOSED,
    closedAt: now(),
    closeReason: reason || "closed",
    updatedAt: now()
  };
  await dbPut("lobbies", next);
  await dbPut("rooms", {
    code: next.code,
    host: next.owner,
    name: next.name,
    capacity: next.capacity,
    privacy: next.privacy,
    active: false,
    closedAt: next.closedAt,
    updatedAt: next.closedAt
  });
  return next;
}

export async function listUserLobbies(user) {
  const owner = userKey(user);
  if (!owner) return [];
  const rows = await dbGetByIndex("lobbies", "owner", owner);
  return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getActiveLobby(user) {
  const owner = userKey(user);
  if (!owner) return null;
  const rows = (await listUserLobbies(user)).filter(freshLobby);
  if (!rows.length) return null;
  const [newest, ...stale] = rows;
  for (const lobby of stale) await closeRecord(lobby, "replaced");
  return newest;
}

export async function createLobby(user, data = {}) {
  const owner = userKey(user);
  if (!owner) return { ok: false, error: "session" };
  const name = String(data.name || "").trim().slice(0, 40);
  const capacity = Math.max(2, Math.min(24, Number(data.capacity) || 6));
  const privacy = data.privacy === "password" ? "password" : "public";
  const code = String(data.code || "").trim().toUpperCase() || (await uniqueLobbyCode());
  const previous = await listUserLobbies(user);
  for (const lobby of previous) {
    if (freshLobby(lobby)) await closeRecord(lobby, "replaced");
  }
  const ts = now();
  const lobby = {
    code,
    owner,
    ownerNick: String(user?.nick || "").slice(0, 24),
    name: name || (user?.nick ? `لابی ${user.nick}` : "لابی من"),
    capacity,
    privacy,
    active: ACTIVE,
    createdAt: ts,
    updatedAt: ts,
    lastActivityAt: ts,
    expiresAt: ts + LIFETIME_MS
  };
  await dbPut("lobbies", lobby);
  await dbPut("rooms", {
    code,
    host: owner,
    name: lobby.name,
    capacity,
    privacy,
    active: true,
    createdAt: ts,
    updatedAt: ts
  });
  await recordActivity(user, "lobby.create", { code, name: lobby.name });
  mirror("/lobbies", { code, name: lobby.name, capacity, privacy });
  return { ok: true, lobby };
}

export async function touchLobby(user, code) {
  const key = String(code || "").toUpperCase();
  if (!key) return null;
  const lobby = await dbGet("lobbies", key);
  if (!lobby || userKey(user) !== lobby.owner) return null;
  if (lobby.active !== ACTIVE) return lobby;
  const next = {
    ...lobby,
    lastActivityAt: now(),
    updatedAt: now(),
    expiresAt: Math.max(Number(lobby.expiresAt || 0), now() + LIFETIME_MS)
  };
  await dbPut("lobbies", next);
  return next;
}

export async function closeLobby(user, code, reason = "closed") {
  const key = String(code || "").toUpperCase();
  if (!key) return { ok: false, error: "code" };
  const lobby = await dbGet("lobbies", key);
  if (!lobby) return { ok: true, lobby: null };
  if (user && userKey(user) !== lobby.owner) return { ok: false, error: "forbidden" };
  const closed = await closeRecord(lobby, reason);
  await recordActivity(user || lobby.owner, "lobby.close", { code: key, reason });
  mirrorPatch(`/lobbies/${encodeURIComponent(key)}/close`, { reason });
  return { ok: true, lobby: closed };
}

export async function forceCloseLobby(code, reason = "closed") {
  const key = String(code || "").toUpperCase();
  if (!key) return { ok: false, error: "code" };
  const lobby = await dbGet("lobbies", key);
  if (!lobby) return { ok: true, lobby: null };
  const closed = await closeRecord(lobby, reason);
  await recordActivity(lobby.owner, "lobby.close", { code: key, reason });
  mirrorPatch(`/lobbies/${encodeURIComponent(key)}/close`, { reason });
  return { ok: true, lobby: closed };
}

export async function lobbyStats(user) {
  const rows = await listUserLobbies(user);
  const active = rows.filter(freshLobby);
  const last = rows.reduce((max, row) => Math.max(max, row.lastActivityAt || row.createdAt || 0), 0);
  return {
    total: rows.length,
    active: active.length,
    lastActivityAt: last || null,
    activeLobby: active[0] || null
  };
}

export function lobbyQuery(lobby, { host = true, nick = "" } = {}) {
  if (!lobby?.code) return "";
  const q = new URLSearchParams({
    room: lobby.code,
    nick: String(nick || "").slice(0, 20),
    name: lobby.name || "",
    cap: String(lobby.capacity || 6),
    privacy: lobby.privacy || "public"
  });
  if (host) q.set("host", "1");
  return q.toString();
}

export function lobbyInviteUrl(lobby, { nick = "" } = {}) {
  if (!lobby?.code) return "";
  const url = new URL("room.html", document.baseURI);
  url.search = lobbyQuery(lobby, { host: false, nick });
  return url.href;
}

export async function pruneExpiredLobbies(user) {
  const rows = await listUserLobbies(user);
  for (const lobby of rows) {
    if (lobby.active === ACTIVE && Number(lobby.expiresAt || 0) <= now()) {
      await closeRecord(lobby, "expired");
    }
  }
}

export async function clearLobbyData(user) {
  const rows = await listUserLobbies(user);
  for (const lobby of rows) await dbDelete("lobbies", lobby.code);
  await recordActivity(user, "lobby.clear", { count: rows.length });
  return { ok: true, removed: rows.length };
}

export async function allLobbyCodes() {
  const rows = await dbGetAll("lobbies");
  return rows.map((row) => row.code);
}
