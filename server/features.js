import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase, all, get } from "./database/index.js";
import {
  CONFIG_LAYERS,
  CONFLICT_RULE,
  ROOM_SETTING_FEATURES,
  matchesFloorKey,
  securityFloorKeys
} from "./configHierarchy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.SITE_CONFIG_PATH || path.join(HERE, "..", "assets", "data", "site-config.json");
const CACHE_MS = Number(process.env.FEATURE_CACHE_MS || 5000);

const DEFAULTS = {
  features: { chat: true, voice: true, liveReactions: true, screenShare: true, queue: true, subtitles: true, localFile: true, realtimeEnabled: true },
  access: { registration: true, login: true, roomCreate: true, roomJoin: true },
  featureRules: {}
};

export const FEATURE_SCOPES = ["global", "plan", "role", "server", "room", "user"];
// Restriction order for scoped overrides: an entitlement outranks a role,
// which outranks server and room configuration, which outranks personal taste.
export const SCOPE_PRIORITY = ["plan", "role", "server", "room", "user"];

export const FEATURE_CATALOG = [
  { key: "features.realtimeEnabled", id: "system.realtime", group: "system", label: "موتور Realtime", desc: "اتصال زندهٔ اتاق، حضور و پیام‌رسانی.", deps: [] },
  { key: "features.webrtcEnabled", id: "system.webrtc", group: "system", label: "موتور WebRTC", desc: "زیرساخت صدا و اشتراک صفحه.", deps: ["features.realtimeEnabled"] },
  { key: "features.storageEnabled", id: "system.storage", group: "system", label: "لایهٔ ذخیره‌سازی", desc: "پایهٔ آپلود و رسانه.", deps: ["features.realtimeEnabled"] },
  { key: "features.notificationsEnabled", id: "system.notifications", group: "system", label: "اعلان‌های سیستمی", desc: "اعلان مرورگر و پیام سیستمی.", deps: [] },

  { key: "features.chat", id: "chat.text", group: "comm", label: "چت متنی", desc: "پنل گفتگو، ارسال و دریافت پیام.", deps: ["features.realtimeEnabled"] },
  { key: "features.liveReactions", id: "chat.reactions", group: "comm", label: "واکنش‌ها", desc: "ایموجی زنده و واکنش به پیام.", deps: ["features.chat"] },
  { key: "features.chatUploads", id: "chat.uploads", group: "comm", label: "آپلود در چت", desc: "پیوست فایل و تصویر به پیام.", deps: ["features.chat", "features.storageEnabled"] },
  { key: "features.chatSearch", id: "chat.search", group: "comm", label: "جستجوی پیام", desc: "جستجو در تاریخچهٔ گفتگو.", deps: ["features.chat"] },
  { key: "features.chatPins", id: "chat.pins", group: "comm", label: "پیام سنجاق‌شده", desc: "سنجاق پیام مهم بالای چت.", deps: ["features.chat"] },
  { key: "features.chatPrivate", id: "chat.private", group: "comm", label: "پیام خصوصی", desc: "گفتگوی دونفره خارج از اتاق.", deps: ["features.chat"] },

  { key: "access.roomCreate", id: "rooms.create", group: "watch", label: "ساخت اتاق", desc: "اجازهٔ ساخت اتاق جدید.", deps: ["features.realtimeEnabled"] },
  { key: "access.roomJoin", id: "rooms.join", group: "watch", label: "ورود به اتاق", desc: "ورود با کد یا لینک اتاق.", deps: ["features.realtimeEnabled"] },
  { key: "features.roomPublic", id: "rooms.public", group: "watch", label: "اتاق عمومی", desc: "اتاق بدون رمز.", deps: ["access.roomCreate"] },
  { key: "features.roomPrivate", id: "rooms.private", group: "watch", label: "اتاق خصوصی", desc: "اتاق همراه با رمز.", deps: ["access.roomCreate"] },
  { key: "features.sharedPlayback", id: "watch.sharedPlayback", group: "watch", label: "پخش مشترک", desc: "همگام‌سازی کنترل پخش.", deps: ["features.realtimeEnabled"] },
  { key: "features.playbackRate", id: "watch.rate", group: "watch", label: "سرعت پخش", desc: "تغییر سرعت پخش.", deps: ["features.sharedPlayback"] },
  { key: "features.queue", id: "watch.queue", group: "watch", label: "صف پخش", desc: "لیست انتظار ویدیو.", deps: ["features.realtimeEnabled"] },
  { key: "features.subtitles", id: "watch.subtitles", group: "watch", label: "زیرنویس", desc: "بارگذاری و نمایش زیرنویس.", deps: [] },
  { key: "features.subtitleCustomization", id: "watch.subtitleCustomization", group: "watch", label: "شخصی‌سازی زیرنویس", desc: "اندازه، رنگ و پس‌زمینهٔ زیرنویس.", deps: ["features.subtitles"] },
  { key: "features.audioTracks", id: "watch.audioTracks", group: "watch", label: "ترک صوتی", desc: "انتخاب ترک صوتی فایل.", deps: [] },
  { key: "features.pictureInPicture", id: "watch.pip", group: "watch", label: "تصویر در تصویر", desc: "حالت PiP مرورگر.", deps: [] },
  { key: "features.theaterMode", id: "watch.theater", group: "watch", label: "حالت سینما", desc: "نمایش عریض صحنه.", deps: [] },
  { key: "features.floatingChat", id: "watch.floatingChat", group: "watch", label: "چت شناور", desc: "چت روی پخش در تمام‌صفحه.", deps: ["features.chat"] },
  { key: "features.videoSources", id: "watch.sources", group: "watch", label: "منبع ویدیو", desc: "تغییر آدرس یا منبع پخش.", deps: [] },
  { key: "features.localFile", id: "watch.localFile", group: "watch", label: "فایل محلی", desc: "پخش فایل از دستگاه میزبان.", deps: ["features.storageEnabled"] },
  { key: "features.playerCustomization", id: "watch.customization", group: "watch", label: "شخصی‌سازی پخش", desc: "روشنایی، اندازهٔ چت و ظاهر.", deps: [] },

  { key: "features.voice", id: "voice.chat", group: "voice", label: "اتاق صوتی", desc: "صدای زندهٔ WebRTC.", deps: ["features.webrtcEnabled"] },
  { key: "features.microphone", id: "voice.mic", group: "voice", label: "میکروفن", desc: "ارسال صدا از میکروفن.", deps: ["features.voice"] },
  { key: "features.pushToTalk", id: "voice.ptt", group: "voice", label: "Push To Talk", desc: "ارسال صدا فقط هنگام نگه‌داشتن کلید.", deps: ["features.microphone"] },
  { key: "features.webcam", id: "voice.camera", group: "voice", label: "وب‌کم", desc: "دوربین در اتاق.", deps: ["features.voice"] },
  { key: "features.screenShare", id: "screen.share", group: "voice", label: "اشتراک صفحه", desc: "ارسال تصویر صفحهٔ میزبان.", deps: ["features.webrtcEnabled"] },
  { key: "features.voiceCalls", id: "voice.calls", group: "voice", label: "تماس صوتی", desc: "تماس یک‌به‌یک.", deps: ["features.voice"] },
  { key: "features.videoCalls", id: "voice.videoCalls", group: "voice", label: "تماس تصویری", desc: "تماس یک‌به‌یک با تصویر.", deps: ["features.webcam"] },

  { key: "access.registration", id: "account.registration", group: "account", label: "ثبت‌نام", desc: "ساخت حساب جدید.", deps: [] },
  { key: "access.login", id: "account.login", group: "account", label: "ورود", desc: "ورود حساب‌های موجود.", deps: [] },
  { key: "features.passwordReset", id: "account.passwordReset", group: "account", label: "بازیابی رمز", desc: "فراموشی و بازیابی رمز.", deps: ["access.login"] },
  { key: "features.profiles", id: "account.profiles", group: "account", label: "پروفایل", desc: "مشاهده و ویرایش پروفایل.", deps: [] },
  { key: "features.friends", id: "account.friends", group: "account", label: "دوستان", desc: "فهرست دوستان.", deps: ["features.profiles"] },
  { key: "features.customThemes", id: "account.customThemes", group: "account", label: "تم سفارشی", desc: "رنگ و ظاهر شخصی.", deps: [] },
  { key: "features.avatarUploads", id: "account.avatarUploads", group: "account", label: "آواتار", desc: "انتخاب و تغییر آواتار.", deps: ["features.profiles"] },

  { key: "features.subscriptionsEnabled", id: "business.subscriptions", group: "business", label: "اشتراک‌ها", desc: "چرخهٔ عمر اشتراک.", deps: [] },
  { key: "features.premiumPlans", id: "business.premiumPlans", group: "business", label: "پلن پریمیوم", desc: "پلن‌های پولی در سایت.", deps: ["features.subscriptionsEnabled"] },
  { key: "features.paymentsEnabled", id: "business.payments", group: "business", label: "پرداخت", desc: "درگاه‌ها و تراکنش‌ها.", deps: ["features.subscriptionsEnabled"] },
  { key: "features.couponsEnabled", id: "business.coupons", group: "business", label: "کد تخفیف", desc: "کوپن و کمپین تخفیف.", deps: ["features.subscriptionsEnabled"] },
  { key: "features.businessAnalytics", id: "business.analytics", group: "business", label: "تحلیل کسب‌وکار", desc: "داشبورد مالی و درآمد.", deps: [] },
  { key: "features.websiteBuilder", id: "business.websiteBuilder", group: "business", label: "سازندهٔ سایت", desc: "مدیریت صفحات و ناوبری.", deps: [] },
  { key: "features.automationBuilder", id: "business.automation", group: "business", label: "خودکارسازی", desc: "قواعد خودکار.", deps: [] },
  { key: "features.publicDiscovery", id: "business.publicDiscovery", group: "business", label: "کشف عمومی", desc: "فهرست عمومی اتاق‌ها.", deps: ["features.roomPublic"] }
];

export const FEATURE_BY_KEY = new Map(FEATURE_CATALOG.map((item) => [item.key, item]));

let cache = { at: 0, state: null };
let scheduleCheckedAt = 0;
const SCOPE_CACHE_MS = Number(process.env.FEATURE_SCOPE_CACHE_MS || 3000);
const scopeCache = new Map();

export function invalidateFeatureState() {
  cache = { at: 0, state: null };
  scheduleCheckedAt = 0;
  scopeCache.clear();
}

function envEmergency() {
  return String(process.env.FEATURE_EMERGENCY_OFF || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

export function isSecurityLocked(key) {
  return matchesFloorKey(securityFloorKeys(), String(key)) || matchesFloorKey(envEmergency(), String(key));
}

export function configHierarchy() {
  return { layers: CONFIG_LAYERS, conflict: CONFLICT_RULE };
}

function normalizeRules(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, rule] of Object.entries(raw)) {
    if (!rule || typeof rule !== "object") continue;
    const clean = {};
    if (rule.emergency) clean.emergency = true;
    for (const field of ["enableAt", "disableAt"]) {
      const n = Number(rule[field]);
      if (Number.isFinite(n) && n > 0) clean[field] = n;
    }
    if (Object.keys(clean).length) out[key] = clean;
  }
  return out;
}

function splitKey(key) {
  const text = String(key || "");
  const idx = text.indexOf(".");
  if (idx <= 0 || idx === text.length - 1) return null;
  return { root: text.slice(0, idx), leaf: text.slice(idx + 1) };
}

function groupValue(state, key) {
  const parts = splitKey(key);
  if (!parts) return true;
  const group = state[parts.root];
  if (!group || !Object.prototype.hasOwnProperty.call(group, parts.leaf)) return true;
  return group[parts.leaf] !== false;
}

function setGroupValue(state, key, enabled) {
  const parts = splitKey(key);
  if (!parts) return;
  if (!state[parts.root] || typeof state[parts.root] !== "object") state[parts.root] = {};
  state[parts.root][parts.leaf] = Boolean(enabled);
}

function ruleRejects(rule, now) {
  if (!rule) return false;
  if (rule.emergency) return true;
  const enableAt = Number(rule.enableAt) || 0;
  const disableAt = Number(rule.disableAt) || 0;
  if (enableAt && disableAt && enableAt >= disableAt) return true;
  if (enableAt && now < enableAt) return true;
  if (disableAt && now >= disableAt) return true;
  return false;
}

async function dbRows(sql, params = []) {
  try {
    if (!(await getDatabase())) return [];
    return all(sql, ...params);
  } catch {
    return [];
  }
}

async function applyDueSchedules() {
  if (!(await getDatabase())) return;
  const now = Date.now();
  if (now - scheduleCheckedAt < 3000) return;
  scheduleCheckedAt = now;
  const due = await dbRows(
    "SELECT * FROM feature_schedule WHERE applied_at IS NULL AND effective_at <= ? ORDER BY effective_at ASC LIMIT 100",
    [now]
  );
  if (!due.length) return;
  try {
    const { transaction } = await import("./database/index.js");
    transaction((conn) => {
      const upsert = conn.prepare(
        `INSERT INTO feature_overrides (id, feature_key, scope_type, scope_id, enabled, config_json, note, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)
         ON CONFLICT(feature_key, scope_type, scope_id)
         DO UPDATE SET enabled = excluded.enabled, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      );
      const history = conn.prepare(
        `INSERT INTO feature_history (id, feature_key, scope_type, scope_id, enabled, source, actor, note, created_at)
         VALUES (?, ?, ?, ?, ?, 'schedule', ?, ?, ?)`
      );
      const mark = conn.prepare("UPDATE feature_schedule SET applied_at = ? WHERE id = ?");
      for (const row of due) {
        upsert.run(crypto.randomUUID(), row.feature_key, row.scope_type, row.scope_id, row.enabled, row.note, row.created_by, now);
        history.run(crypto.randomUUID(), row.feature_key, row.scope_type, row.scope_id, row.enabled, row.created_by, row.note, now);
        mark.run(now, row.id);
      }
    });
    cache = { at: 0, state: null };
    scopeCache.clear();
  } catch {}
}

function buildFlags(state, scoped = new Map(), now = Date.now(), roomBlocks = new Map()) {
  const flags = {};
  const rules = state.featureRules || {};
  const emergency = envEmergency();
  const floor = securityFloorKeys();
  for (const item of FEATURE_CATALOG) {
    const key = item.key;
    const layers = [];
    const push = (layer, enabled, source, note = "", scopeId = "") => {
      layers.push({ layer, enabled: Boolean(enabled), source, note, scopeId });
    };

    if (matchesFloorKey(floor, key)) push("security", false, "security", "SECURITY_MANDATORY_OFF");
    else if (matchesFloorKey(emergency, key)) push("security", false, "emergency", "FEATURE_EMERGENCY_OFF");

    let globalEnabled = groupValue(state, key);
    let globalSource = "default";
    if (state.globalOverrides?.has(key)) {
      globalEnabled = Boolean(state.globalOverrides.get(key).enabled);
      globalSource = "global";
    }
    const blockedByRule = ruleRejects(rules[key], now);
    if (blockedByRule) {
      globalEnabled = false;
      globalSource = "rule";
    }
    push("global", globalEnabled, globalSource, blockedByRule ? "emergency or scheduled rule" : "");

    for (const scope of SCOPE_PRIORITY) {
      const hit = scoped.get(scope)?.get(key);
      if (hit) push(scope, hit.enabled, scope, hit.note || "", hit.scope_id || "");
    }
    const roomNote = roomBlocks.get(key);
    if (roomNote) push("room", false, "room_settings", roomNote);

    const blocked = layers.find((layer) => layer.enabled === false);
    flags[key] = {
      enabled: !blocked,
      source: blocked ? blocked.source : "default",
      layer: blocked ? blocked.layer : "default",
      reason: blocked ? blocked.note || "" : "",
      layers,
      label: item.label,
      group: item.group,
      id: item.id,
      deps: item.deps
    };
  }
  for (const item of FEATURE_CATALOG) {
    const flag = flags[item.key];
    if (!flag.enabled) continue;
    const blocker = (item.deps || []).find((dep) => flags[dep] && !flags[dep].enabled);
    if (blocker) {
      flag.enabled = false;
      flag.source = "dependency";
      flag.layer = "dependency";
      flag.blockedBy = blocker;
      flag.reason = `${blocker} is off`;
    }
  }
  return flags;
}

export async function loadFeatureState() {
  const now = Date.now();
  if (cache.state && now - cache.at < CACHE_MS) return cache.state;
  await applyDueSchedules();
  let raw = {};
  try {
    raw = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  } catch {}
  const globalRows = await dbRows("SELECT * FROM feature_overrides WHERE scope_type = 'global'");
  const state = {
    source: globalRows.length ? "database+site-config" : "site-config.json",
    updatedAt: raw.updatedAt || "",
    features: { ...DEFAULTS.features, ...(raw.features || {}) },
    access: { ...DEFAULTS.access, ...(raw.access || {}) },
    featureRules: normalizeRules(raw.featureRules),
    globalOverrides: new Map()
  };
  for (const row of globalRows) {
    state.globalOverrides.set(row.feature_key, row);
    setGroupValue(state, row.feature_key, row.enabled);
  }
  state.flags = buildFlags(state, new Map(), now);
  cache = { at: now, state };
  return state;
}

export async function activePlanFor(userId) {
  if (!userId) return "";
  try {
    if (!(await getDatabase())) return "";
    const row = get(
      "SELECT plan_id FROM subscriptions WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT 1",
      String(userId),
      Date.now()
    );
    return row?.plan_id || "";
  } catch {
    return "";
  }
}

async function planFeatureKeys(planId) {
  if (!planId) return [];
  try {
    if (!(await getDatabase())) return [];
    const row = get("SELECT features_json FROM subscription_plans WHERE id = ?", String(planId));
    if (!row) return [];
    const parsed = JSON.parse(row.features_json || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? item : item?.key))
      .filter((key) => typeof key === "string" && key.trim())
      .map((key) => key.trim());
  } catch {
    return [];
  }
}

async function roomServerFor(roomCode) {
  if (!roomCode) return "";
  try {
    if (!(await getDatabase())) return "";
    const row = get("SELECT server_id FROM rooms WHERE room_code = ?", String(roomCode).toUpperCase());
    return row?.server_id || "";
  } catch {
    return "";
  }
}

async function roomSettingBlocks(roomCode) {
  const map = new Map();
  if (!roomCode) return map;
  try {
    if (!(await getDatabase())) return map;
    const row = get(
      "SELECT rs.* FROM room_settings rs JOIN rooms r ON r.id = rs.room_id WHERE r.room_code = ?",
      String(roomCode).toUpperCase()
    );
    if (!row) return map;
    for (const [column, keys] of Object.entries(ROOM_SETTING_FEATURES)) {
      if (Number(row[column]) !== 0) continue;
      for (const key of keys) map.set(key, `room setting ${column} is off`);
    }
  } catch {}
  return map;
}

export async function resolveFeatureState(ctx = {}) {
  const now = Date.now();
  const cacheKey = [ctx.userId || "", ctx.role || "", ctx.room || "", ctx.server || "", ctx.plan || ""].join("|");
  const cached = scopeCache.get(cacheKey);
  if (cached && now - cached.at < SCOPE_CACHE_MS) return cached.state;
  const base = await loadFeatureState();
  const room = ctx.room ? String(ctx.room).toUpperCase() : "";
  const plan = ctx.plan ? String(ctx.plan) : await activePlanFor(ctx.userId);
  const server = ctx.server ? String(ctx.server) : await roomServerFor(room);
  const scopeIds = {
    user: ctx.userId ? String(ctx.userId) : "",
    room,
    server,
    role: ctx.role ? String(ctx.role) : "",
    plan
  };
  const scoped = new Map(SCOPE_PRIORITY.map((scope) => [scope, new Map()]));
  const active = SCOPE_PRIORITY.filter((scope) => scopeIds[scope]);
  if (active.length) {
    const rows = await dbRows(
      `SELECT * FROM feature_overrides WHERE ${active.map(() => "(scope_type = ? AND scope_id = ?)").join(" OR ")}`,
      active.flatMap((scope) => [scope, scopeIds[scope]])
    );
    for (const row of rows) {
      scoped.get(row.scope_type)?.set(row.feature_key, row);
    }
  }
  const roomBlocks = await roomSettingBlocks(room);
  const planFeatures = await planFeatureKeys(plan);
  if (planFeatures.length) {
    const planMap = scoped.get("plan");
    const known = new Set(FEATURE_CATALOG.map((item) => item.key));
    for (const key of planFeatures) {
      if (!known.has(key) || planMap.has(key)) continue;
      planMap.set(key, { feature_key: key, enabled: 1, scope_type: "plan", scope_id: plan });
    }
  }
  const state = {
    ...base,
    flags: buildFlags(base, scoped, now, roomBlocks),
    context: { userId: ctx.userId || "", role: ctx.role || "", room, server, plan }
  };
  // Cached per context for a few seconds so chat/playback loops don't hit SQLite
  // on every message; any override change clears it immediately.
  if (scopeCache.size > 500) scopeCache.clear();
  scopeCache.set(cacheKey, { at: now, state });
  return state;
}

export function isEnabled(state, pathName, now = Date.now()) {
  if (!state) return true;
  if (state.flags && Object.prototype.hasOwnProperty.call(state.flags, pathName)) {
    return state.flags[pathName].enabled !== false;
  }
  const rule = state.featureRules?.[pathName];
  if (ruleRejects(rule, now)) return false;
  if (envEmergency().some((id) => pathName === id || pathName.endsWith(`.${id}`))) return false;
  return groupValue(state, pathName);
}

export function featureStatus(state) {
  const flags = state?.flags || {};
  return FEATURE_CATALOG.map((item) => {
    const flag = flags[item.key] || { enabled: true, source: "default", reason: "" };
    return {
      id: item.id,
      key: item.key,
      label: item.label,
      group: item.group,
      desc: item.desc,
      deps: item.deps,
      enabled: flag.enabled !== false,
      source: flag.source || "default",
      layer: flag.layer || "default",
      locked: flag.layer === "security",
      reason: flag.reason || "",
      blockedBy: flag.blockedBy || "",
      layers: flag.layers || []
    };
  });
}

export function summarizeFeatures(state) {
  return {
    realtime: isEnabled(state, "features.realtimeEnabled"),
    chat: isEnabled(state, "features.chat"),
    voice: isEnabled(state, "features.voice"),
    screenShare: isEnabled(state, "features.screenShare"),
    sharedPlayback: isEnabled(state, "features.sharedPlayback"),
    queue: isEnabled(state, "features.queue"),
    roomsCreate: isEnabled(state, "access.roomCreate"),
    roomsJoin: isEnabled(state, "access.roomJoin"),
    registration: isEnabled(state, "access.registration"),
    login: isEnabled(state, "access.login")
  };
}

function validScope(scopeType, scopeId) {
  if (!FEATURE_SCOPES.includes(scopeType)) return false;
  if (scopeType === "global") return true;
  return Boolean(String(scopeId || "").trim());
}

export async function setFeatureOverride({ key, scopeType = "global", scopeId = "", enabled, note = "", actor = "" }) {
  if (!FEATURE_BY_KEY.has(key)) throw Object.assign(new Error("Unknown feature key."), { statusCode: 400 });
  if (!validScope(scopeType, scopeId)) throw Object.assign(new Error("Invalid scope."), { statusCode: 400 });
  if (enabled && isSecurityLocked(key)) {
    throw Object.assign(new Error("This feature is locked off by a global security restriction."), { statusCode: 403, code: "security_locked" });
  }
  if (!(await getDatabase())) throw Object.assign(new Error("Database is unavailable."), { statusCode: 503 });
  const cleanScope = scopeType === "room" ? String(scopeId).trim().toUpperCase() : String(scopeId || "").trim();
  const now = Date.now();
  const { transaction } = await import("./database/index.js");
  transaction((conn) => {
    conn.prepare(
      `INSERT INTO feature_overrides (id, feature_key, scope_type, scope_id, enabled, config_json, note, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)
       ON CONFLICT(feature_key, scope_type, scope_id)
       DO UPDATE SET enabled = excluded.enabled, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).run(crypto.randomUUID(), key, scopeType, cleanScope, enabled ? 1 : 0, String(note || "").slice(0, 300), String(actor || ""), now);
    conn.prepare(
      `INSERT INTO feature_history (id, feature_key, scope_type, scope_id, enabled, source, actor, note, created_at)
       VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?)`
    ).run(crypto.randomUUID(), key, scopeType, cleanScope, enabled ? 1 : 0, String(actor || ""), String(note || "").slice(0, 300), now);
  });
  invalidateFeatureState();
  return true;
}

export async function clearFeatureOverride({ key, scopeType = "global", scopeId = "", actor = "", note = "" }) {
  if (!FEATURE_BY_KEY.has(key)) throw Object.assign(new Error("Unknown feature key."), { statusCode: 400 });
  if (!validScope(scopeType, scopeId)) throw Object.assign(new Error("Invalid scope."), { statusCode: 400 });
  if (!(await getDatabase())) throw Object.assign(new Error("Database is unavailable."), { statusCode: 503 });
  const cleanScope = scopeType === "room" ? String(scopeId).trim().toUpperCase() : String(scopeId || "").trim();
  const now = Date.now();
  const { transaction, get } = await import("./database/index.js");
  const existing = get("SELECT * FROM feature_overrides WHERE feature_key = ? AND scope_type = ? AND scope_id = ?", key, scopeType, cleanScope);
  transaction((conn) => {
    conn.prepare("DELETE FROM feature_overrides WHERE feature_key = ? AND scope_type = ? AND scope_id = ?").run(key, scopeType, cleanScope);
    conn.prepare(
      `INSERT INTO feature_history (id, feature_key, scope_type, scope_id, enabled, source, actor, note, created_at)
       VALUES (?, ?, ?, ?, ?, 'removed', ?, ?, ?)`
    ).run(crypto.randomUUID(), key, scopeType, cleanScope, existing ? existing.enabled : 1, String(actor || ""), String(note || "override removed").slice(0, 300), now);
  });
  invalidateFeatureState();
  return Boolean(existing);
}

export async function scheduleFeatureChange({ key, scopeType = "global", scopeId = "", enabled, effectiveAt, note = "", actor = "" }) {
  if (!FEATURE_BY_KEY.has(key)) throw Object.assign(new Error("Unknown feature key."), { statusCode: 400 });
  if (!validScope(scopeType, scopeId)) throw Object.assign(new Error("Invalid scope."), { statusCode: 400 });
  if (enabled && isSecurityLocked(key)) {
    throw Object.assign(new Error("This feature is locked off by a global security restriction."), { statusCode: 403, code: "security_locked" });
  }
  const at = Number(effectiveAt);
  if (!Number.isFinite(at) || at < Date.now() + 5000) {
    throw Object.assign(new Error("Effective time must be at least a few seconds in the future."), { statusCode: 400 });
  }
  if (!(await getDatabase())) throw Object.assign(new Error("Database is unavailable."), { statusCode: 503 });
  const cleanScope = scopeType === "room" ? String(scopeId).trim().toUpperCase() : String(scopeId || "").trim();
  const id = crypto.randomUUID();
  const { run } = await import("./database/index.js");
  run(
    `INSERT INTO feature_schedule (id, feature_key, scope_type, scope_id, enabled, note, effective_at, created_by, created_at, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    id, key, scopeType, cleanScope, enabled ? 1 : 0, String(note || "").slice(0, 300), at, String(actor || ""), Date.now()
  );
  invalidateFeatureState();
  return { id, key, scopeType, scopeId: cleanScope, enabled: Boolean(enabled), effectiveAt: at };
}

export async function listFeatureOverrides() {
  return dbRows("SELECT * FROM feature_overrides ORDER BY scope_type, scope_id, feature_key");
}

export async function listFeatureSchedules({ pendingOnly = true } = {}) {
  return dbRows(
    pendingOnly
      ? "SELECT * FROM feature_schedule WHERE applied_at IS NULL ORDER BY effective_at ASC LIMIT 200"
      : "SELECT * FROM feature_schedule ORDER BY created_at DESC LIMIT 200"
  );
}

export async function listFeatureHistory({ limit = 50, before = 0 } = {}) {
  return dbRows(
    "SELECT * FROM feature_history WHERE created_at < ? ORDER BY created_at DESC LIMIT ?",
    [before || Date.now() + 1, Math.min(200, Math.max(1, Number(limit) || 50))]
  );
}

export async function removeSchedule(id) {
  if (!(await getDatabase())) return false;
  const { run } = await import("./database/index.js");
  const res = run("DELETE FROM feature_schedule WHERE id = ? AND applied_at IS NULL", String(id));
  invalidateFeatureState();
  return Number(res?.changes || 0) > 0;
}

export async function globalFeatureDefaults() {
  return {
    features: { ...DEFAULTS.features },
    access: { ...DEFAULTS.access }
  };
}
