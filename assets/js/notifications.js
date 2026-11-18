/* Local, permission-respecting notifications.
   Rooms are peer-to-peer with no push server, so these alerts can only fire
   while the site is open in a tab. The UI says so instead of pretending. */

import { store } from "./core.js";
import { t } from "./i18n.js";

const DEFAULTS = {
  enabled: false,
  mentions: true,
  chat: false,
  activity: false,
  preview: true,
  muted: {}
};

const keyFor = (uid) => `notif:v1:${uid || "guest"}`;

export function notifPrefs(uid) {
  const raw = store.get(keyFor(uid), null);
  if (!raw || typeof raw !== "object") return { ...DEFAULTS, muted: {} };
  return {
    ...DEFAULTS,
    ...raw,
    muted: raw.muted && typeof raw.muted === "object" ? { ...raw.muted } : {}
  };
}

export function saveNotifPrefs(uid, patch) {
  const next = { ...notifPrefs(uid), ...patch };
  if (patch?.muted) next.muted = { ...patch.muted };
  store.set(keyFor(uid), next);
  return next;
}

export function notifPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export async function requestNotifPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function roomNotifOn(uid, roomId) {
  const p = notifPrefs(uid);
  if (!p.enabled || notifPermission() !== "granted") return false;
  return !p.muted[roomId];
}

export function mutedRooms(uid) {
  return Object.entries(notifPrefs(uid).muted).map(([roomId, info]) => ({
    roomId,
    name: info?.name || roomId,
    at: Number(info?.at) || 0
  }));
}

/* `on = false` mutes the room; `on = true` removes the mute. */
export function setRoomNotif(uid, roomId, on, roomName = "") {
  const p = notifPrefs(uid);
  if (on) delete p.muted[roomId];
  else p.muted[roomId] = { name: roomName || roomId, at: Date.now() };
  return saveNotifPrefs(uid, { muted: p.muted });
}

const lastAt = new Map();
const THROTTLE = 4000;

function snippet(text, max = 90) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

async function show(title, body, { url, tag, roomId } = {}) {
  const options = {
    body,
    icon: "assets/img/icon-192.png",
    badge: "assets/img/icon-192.png",
    lang: document.documentElement.lang || "fa",
    dir: document.documentElement.dir || "rtl",
    tag: tag || "wt-chat",
    renotify: false,
    silent: false,
    data: { url: url || "./", roomId: roomId || "" }
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) return reg.showNotification(title, options);
  } catch {}
  try { return new Notification(title, options); } catch {}
  return null;
}

/* Returns true when a notification was actually shown. */
export function notifyChat(uid, { roomId, roomName, msg, selfNick, url }) {
  if (!uid || !roomId || !msg) return false;
  if (document.visibilityState === "visible") return false;
  const prefs = notifPrefs(uid);
  if (!prefs.enabled || notifPermission() !== "granted") return false;
  if (prefs.muted[roomId]) return false;
  if (msg.by === selfNick) return false;

  const text = String(msg.text || "");
  const mention = selfNick ? text.toLowerCase().includes(`@${String(selfNick).toLowerCase()}`) : false;
  if (mention ? !prefs.mentions : !prefs.chat) return false;

  const now = Date.now();
  if (now - (lastAt.get(roomId) || 0) < THROTTLE) return false;
  lastAt.set(roomId, now);

  const who = msg.nick || t("notif.someone");
  const title = mention
    ? t("notif.mentionTitle", { room: roomName || "" })
    : t("notif.chatTitle", { room: roomName || "" });
  const body = prefs.preview && text ? snippet(`${who}: ${text}`) : `${who} — ${t("notif.noPreview")}`;

  show(title, body, {
    url: url || `${location.pathname}?room=${encodeURIComponent(roomId)}`,
    tag: `wt-room-${roomId}`,
    roomId
  });
  return true;
}

export function notifyActivity(uid, { roomId, roomName, text, url }) {
  if (!uid || !roomId || !text) return false;
  if (document.visibilityState === "visible") return false;
  const prefs = notifPrefs(uid);
  if (!prefs.enabled || !prefs.activity) return false;
  if (notifPermission() !== "granted") return false;
  if (prefs.muted[roomId]) return false;
  const now = Date.now();
  if (now - (lastAt.get(`a:${roomId}`) || 0) < 8000) return false;
  lastAt.set(`a:${roomId}`, now);
  show(roomName || t("notif.activityTitle"), snippet(text), {
    url: url || `${location.pathname}?room=${encodeURIComponent(roomId)}`,
    tag: `wt-room-${roomId}`,
    roomId
  });
  return true;
}

export function testNotification() {
  return show(
    t("notif.testTitle"),
    t("notif.testBody"),
    { tag: "wt-test" }
  );
}
