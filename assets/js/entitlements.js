export const UNLIMITED = -1;

export const ENTITLEMENT_TYPES = {
  boolean: { id: "boolean", label: "دسترسی" },
  limit: { id: "limit", label: "سقف عددی" },
  quota: { id: "quota", label: "سهمیه" },
  rate: { id: "rate", label: "نرخ مجاز" },
  concurrent: { id: "concurrent", label: "هم‌زمانی" }
};

export const ENTITLEMENT_GROUPS = [
  { id: "rooms", label: "اتاق و اعضا" },
  { id: "media", label: "پخش و تماس" },
  { id: "storage", label: "ذخیره و رسانه" },
  { id: "appearance", label: "ظاهر و پروفایل" },
  { id: "platform", label: "قابلیت‌های پلتفرم" },
  { id: "support", label: "پشتیبانی" }
];

export const ENTITLEMENTS = [
  { id: "room.create", label: "ساخت اتاق", group: "rooms", type: "boolean", defaultValue: true, flag: "roomCreate" },
  { id: "room.max", label: "حداکثر اتاق هم‌زمان", group: "rooms", type: "concurrent", unit: "اتاق", defaultValue: UNLIMITED },
  { id: "room.maxParticipants", label: "حداکثر اعضای اتاق", group: "rooms", type: "limit", unit: "نفر", defaultValue: 24 },
  { id: "room.concurrentRooms", label: "اتاق‌های فعال هم‌زمان", group: "rooms", type: "concurrent", unit: "اتاق", defaultValue: 1 },

  { id: "media.voice", label: "صدای زنده", group: "media", type: "boolean", defaultValue: true, flag: "voice" },
  { id: "media.video", label: "ویدیو", group: "media", type: "boolean", defaultValue: true, flag: "localFile" },
  { id: "media.screenShare", label: "اشتراک صفحه", group: "media", type: "boolean", defaultValue: true, flag: "screenShare" },
  { id: "media.pushToTalk", label: "Push To Talk", group: "media", type: "boolean", defaultValue: true },
  { id: "media.subtitles", label: "کنترل زیرنویس", group: "media", type: "boolean", defaultValue: true, flag: "subtitles" },
  { id: "media.playerCustomization", label: "شخصی‌سازی پخش‌کننده", group: "media", type: "boolean", defaultValue: false },
  { id: "media.chatRate", label: "نرخ پیام چت", group: "media", type: "rate", unit: "پیام/دقیقه", defaultValue: 20, flag: "chat" },

  { id: "storage.uploadMb", label: "حداکثر حجم آپلود", group: "storage", type: "limit", unit: "MB", defaultValue: 2048 },
  { id: "storage.quotaMb", label: "سهمیهٔ فضای ذخیره", group: "storage", type: "quota", unit: "MB", defaultValue: 0 },
  { id: "storage.mediaLibrary", label: "کتابخانهٔ رسانه", group: "storage", type: "boolean", defaultValue: false },
  { id: "storage.subtitleLibrary", label: "کتابخانهٔ زیرنویس", group: "storage", type: "quota", unit: "فایل", defaultValue: 0 },

  { id: "appearance.premiumThemes", label: "تم‌های ویژه", group: "appearance", type: "boolean", defaultValue: false },
  { id: "appearance.customProfiles", label: "پروفایل سفارشی", group: "appearance", type: "boolean", defaultValue: false },

  { id: "platform.advancedAnalytics", label: "تحلیل پیشرفته", group: "platform", type: "boolean", defaultValue: false },
  { id: "platform.automation", label: "سازندهٔ خودکارسازی", group: "platform", type: "boolean", defaultValue: false },
  { id: "platform.websiteBuilder", label: "سازندهٔ سایت", group: "platform", type: "boolean", defaultValue: false },
  { id: "platform.apiAccess", label: "دسترسی API", group: "platform", type: "boolean", defaultValue: false },
  { id: "platform.devices", label: "دستگاه هم‌زمان", group: "platform", type: "concurrent", unit: "دستگاه", defaultValue: 2 },

  { id: "support.priority", label: "پشتیبانی اولویت‌دار", group: "support", type: "boolean", defaultValue: false }
];

const BY_ID = new Map(ENTITLEMENTS.map((e) => [e.id, e]));

export function entitlementMeta(id) {
  return BY_ID.get(id) || null;
}

function toNumber(value) {
  if (value === "unlimited" || value === Infinity) return UNLIMITED;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

export function normalizeEntitlementValue(meta, value) {
  if (!meta) return null;
  if (meta.type === "boolean") return Boolean(value);
  const n = toNumber(value);
  if (n === null) return meta.defaultValue;
  if (n < 0) return UNLIMITED;
  return n;
}

export function normalizeEntitlements(input = {}) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input)) {
    const meta = entitlementMeta(key);
    if (!meta) continue;
    out[key] = normalizeEntitlementValue(meta, value);
  }
  return out;
}

export const FREE_ENTITLEMENTS = Object.freeze(
  Object.fromEntries(ENTITLEMENTS.map((e) => [e.id, e.defaultValue]))
);

export function mergeEntitlements(...layers) {
  const out = { ...FREE_ENTITLEMENTS };
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    for (const [key, value] of Object.entries(layer)) {
      if (!BY_ID.has(key)) continue;
      out[key] = value;
    }
  }
  return out;
}

export function subscriptionActive(sub, now = Date.now()) {
  if (!sub) return false;
  const status = String(sub.status || "");
  if (!["trialing", "active", "past_due", "grace"].includes(status)) return false;
  if (status === "trialing" && Number(sub.trialEndsAt) && now > Number(sub.trialEndsAt)) return false;
  if (status === "grace" && Number(sub.graceEndsAt) && now > Number(sub.graceEndsAt)) return false;
  if (Number(sub.currentPeriodEnd) && now > Number(sub.currentPeriodEnd)) {
    return status === "grace" ? now <= Number(sub.graceEndsAt || 0) : status === "past_due";
  }
  return true;
}

export function resolveEntitlements({ plan = null, subscription = null, ownerOverrides = {}, featureFlags = {}, permissions = {} } = {}, now = Date.now()) {
  const planApplies = plan ? (subscription ? subscriptionActive(subscription, now) : true) : false;
  const layers = [];
  if (planApplies && plan.entitlements) layers.push(normalizeEntitlements(plan.entitlements));
  if (ownerOverrides) layers.push(normalizeEntitlements(ownerOverrides));
  if (subscription?.overrides) layers.push(normalizeEntitlements(subscription.overrides));
  const resolved = mergeEntitlements(...layers);

  for (const meta of ENTITLEMENTS) {
    if (meta.flag && featureFlags[meta.flag] === false) {
      resolved[meta.id] = meta.type === "boolean" ? false : 0;
    }
    if (meta.permission && permissions[meta.permission] === "deny") {
      resolved[meta.id] = meta.type === "boolean" ? false : 0;
    }
  }
  return resolved;
}

export function checkEntitlement(id, resolved, usage = 0) {
  const meta = entitlementMeta(id);
  if (!meta) return { allowed: false, value: 0, reason: "unknown" };
  const value = resolved?.[id] ?? meta.defaultValue;
  if (meta.type === "boolean") return { allowed: Boolean(value), value, reason: value ? "granted" : "denied" };
  if (value === UNLIMITED) return { allowed: true, value, unlimited: true, reason: "unlimited" };
  return { allowed: Number(usage) < Number(value), value, remaining: Math.max(0, Number(value) - Number(usage)), reason: Number(usage) < Number(value) ? "within_limit" : "limit_reached" };
}

export function formatLimit(value, unit = "") {
  if (value === UNLIMITED) return "نامحدود";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return unit ? `${n.toLocaleString("fa-IR")} ${unit}` : n.toLocaleString("fa-IR");
}

export function summarizeEntitlements(values) {
  const rows = [];
  for (const meta of ENTITLEMENTS) {
    const value = values?.[meta.id];
    if (meta.type === "boolean") {
      if (value) rows.push({ id: meta.id, text: meta.label });
      continue;
    }
    if (value === UNLIMITED) rows.push({ id: meta.id, text: `${meta.label}: نامحدود` });
    else if (Number(value) > 0) rows.push({ id: meta.id, text: `${meta.label}: ${formatLimit(value, meta.unit)}` });
  }
  return rows;
}
