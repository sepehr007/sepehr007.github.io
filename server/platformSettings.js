import { dbReady } from "./db.js";
import { getDatabase } from "./database/index.js";
import { getAppSetting, setAppSetting } from "./userStore.js";
import { invalidateFeatureState } from "./features.js";

const STORE_KEY = "platform.settings";
const CACHE_MS = 4000;

const text = (maxLength, extra = {}) => ({ type: "string", maxLength, ...extra });
const bool = () => ({ type: "boolean" });
const number = (min, max, step = 1) => ({ type: "number", min, max, step });
const pick = (...values) => ({ type: "enum", values });
const color = () => ({ type: "color", pattern: /^#[0-9a-fA-F]{6}$/ });
const url = () => ({ type: "url" });

export const SETTINGS_REGISTRY = [
  { id: "site.nameFa", label: "نام فارسی سایت", category: "branding", ...text(40) },
  { id: "site.nameEn", label: "Site name (English)", category: "branding", ...text(40) },
  { id: "site.taglineFa", label: "شعار فارسی", category: "branding", ...text(140) },
  { id: "site.taglineEn", label: "Tagline (English)", category: "branding", ...text(140) },
  { id: "site.accent", label: "رنگ لهجهٔ اصلی", category: "appearance", ...color() },
  { id: "site.accent2", label: "رنگ لهجهٔ دوم", category: "appearance", ...color() },
  { id: "site.defaultTheme", label: "تم پیش‌فرض", category: "appearance", ...pick("dark", "light") },
  { id: "site.supportUrl", label: "لینک پشتیبانی", category: "branding", ...url() },
  { id: "site.metaTitleFa", label: "عنوان متای فارسی", category: "seo", ...text(70) },
  { id: "site.metaTitleEn", label: "Meta title (English)", category: "seo", ...text(70) },
  { id: "site.metaDescFa", label: "توضیحات متای فارسی", category: "seo", ...text(160) },
  { id: "site.metaDescEn", label: "Meta description (English)", category: "seo", ...text(160) },

  { id: "announcement.enabled", label: "نوار اطلاعیه", category: "content", ...bool() },
  { id: "announcement.type", label: "نوع اطلاعیه", category: "content", ...pick("info", "warn", "critical") },
  { id: "announcement.textFa", label: "متن اطلاعیه (فارسی)", category: "content", ...text(220) },
  { id: "announcement.textEn", label: "Announcement (English)", category: "content", ...text(220) },
  { id: "maintenance.enabled", label: "حالت تعمیرات", category: "content", ...bool() },
  { id: "maintenance.messageFa", label: "پیام تعمیرات (فارسی)", category: "content", ...text(300) },
  { id: "maintenance.messageEn", label: "Maintenance message (English)", category: "content", ...text(300) },

  { id: "limits.defaultCapacity", label: "ظرفیت پیش‌فرض اتاق", category: "rooms", ...number(2, 24) },
  { id: "limits.maxCapacity", label: "بیشترین ظرفیت اتاق", category: "rooms", ...number(2, 48) },
  { id: "room.defaultPrivacy", label: "حریم پیش‌فرض اتاق", category: "rooms", ...pick("public", "password") },
  { id: "room.allowFileUpload", label: "آپلود و اشتراک فایل در اتاق", category: "rooms", ...bool() },
  { id: "chat.maxLength", label: "حداکثر طول پیام", category: "chat", ...number(100, 4000) },
  { id: "limits.chatPerWindow", label: "پیام مجاز در بازه", category: "chat", ...number(2, 60) },
  { id: "limits.chatWindowMs", label: "طول بازهٔ چت (ms)", category: "chat", ...number(1000, 30000) },
  { id: "limits.chatCooldownMs", label: "مکث ضدهرزنامه (ms)", category: "chat", ...number(1000, 120000) },
  { id: "chat.retentionDays", label: "نگهداری پیام (روز، ۰=همیشه)", category: "chat", ...number(0, 3650) },
  { id: "limits.avatarChanges", label: "تغییر آواتار در بازه", category: "profile", ...number(1, 20) },
  { id: "limits.avatarWindowMs", label: "بازهٔ آواتار (ms)", category: "profile", ...number(500, 30000) },
  { id: "limits.roomActions", label: "اکشن اتاق در بازه", category: "rooms", ...number(1, 20) },
  { id: "limits.roomWindowMs", label: "بازهٔ اکشن اتاق (ms)", category: "rooms", ...number(500, 30000) },

  { id: "player.autoplay", label: "پخش خودکار", category: "player", ...bool() },
  { id: "player.defaultVolume", label: "صدای پیش‌فرض (۰ تا ۱۰۰)", category: "player", ...number(0, 100) },
  { id: "player.syncToleranceMs", label: "تلورانس هم‌گام‌سازی (ms)", category: "player", ...number(200, 5000) },
  { id: "subtitle.fontSize", label: "اندازهٔ زیرنویس", category: "subtitles", ...number(12, 32) },
  { id: "subtitle.background", label: "پس‌زمینهٔ زیرنویس", category: "subtitles", ...pick("none", "shadow", "dark") },
  { id: "subtitle.autoLoad", label: "بارگذاری خودکار زیرنویس", category: "subtitles", ...bool() },

  { id: "upload.maxFileMB", label: "حداکثر حجم ویدیو (MB)", category: "storage", ...number(1, 100) },
  { id: "upload.storageQuotaMB", label: "سهمیهٔ ذخیره‌سازی هر کاربر (MB)", category: "storage", ...number(10, 1000000) },
  { id: "upload.deleteAfterWatch", label: "حذف خودکار ویدیو پس از تماشا", category: "storage", ...bool() },
  { id: "upload.deleteGraceMinutes", label: "مهلت حذف بعد از آخرین تماشا (دقیقه)", category: "storage", ...number(1, 1440) },
  { id: "upload.mediaKeepHours", label: "حذف ویدیوهای تماشانشده پس از (ساعت، ۰=خاموش)", category: "storage", ...number(0, 720) },

  { id: "notify.emailEnabled", label: "اعلان ایمیلی", category: "notifications", ...bool() },
  { id: "notify.browserPush", label: "اعلان مرورگر", category: "notifications", ...bool() },
  { id: "notify.digest", label: "خلاصهٔ خبرنامه", category: "notifications", ...pick("off", "daily", "weekly") },

  { id: "security.sessionDays", label: "طول نشست (روز)", category: "security", ...number(1, 90) },
  { id: "security.maxLoginAttempts", label: "حداکثر تلاش ورود", category: "security", ...number(3, 50) },
  { id: "security.requireEmailVerify", label: "الزام تأیید ایمیل", category: "security", ...bool() },

  { id: "plans.premiumEnabled", label: "فروش پریمیوم", category: "billing", ...bool() },
  { id: "plans.roomsRequirePremium", label: "ساخت اتاق فقط با اشتراک فعال", category: "billing", ...bool() },
  { id: "plans.premiumUrl", label: "لینک پرداخت پریمیوم", category: "billing", ...url() },
  { id: "plans.premiumPriceFa", label: "قیمت (فارسی)", category: "billing", ...text(30) },
  { id: "plans.premiumPriceEn", label: "Price (English)", category: "billing", ...text(30) },
  { id: "plans.premiumNoteFa", label: "توضیح پلن (فارسی)", category: "billing", ...text(140) },
  { id: "plans.premiumNoteEn", label: "Plan note (English)", category: "billing", ...text(140) },
  { id: "billing.currency", label: "ارز پرداخت", category: "billing", ...pick("IRT", "USD") }
];

export const SETTING_BY_ID = new Map(SETTINGS_REGISTRY.map((item) => [item.id, item]));

export const SETTINGS_CATEGORIES = {
  branding: "برندینگ",
  appearance: "ظاهر و تم",
  seo: "سئو",
  content: "محتوا و اعلام‌ها",
  rooms: "اتاق‌ها",
  chat: "چت",
  profile: "پروفایل",
  player: "پخش‌کننده",
  subtitles: "زیرنویس",
  storage: "ذخیره‌سازی",
  notifications: "اعلان‌ها",
  security: "امنیت",
  billing: "اشتراک و پرداخت"
};

let cache = { at: 0, values: null };

export function invalidateSettings() {
  cache = { at: 0, values: null };
}

export async function getPlatformSettings() {
  const now = Date.now();
  if (cache.values && now - cache.at < CACHE_MS) return cache.values;
  let values = {};
  try {
    const raw = await getAppSetting(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") values = parsed;
    }
  } catch {}
  cache = { at: now, values };
  return values;
}

export async function settingValue(id, fallback = null) {
  const values = await getPlatformSettings();
  return Object.prototype.hasOwnProperty.call(values, id) ? values[id] : fallback;
}

export async function settingNumber(id, fallback) {
  const value = await settingValue(id, null);
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function settingBool(id, fallback) {
  const value = await settingValue(id, null);
  if (value === null) return fallback;
  return value !== false;
}

function validate(item, value) {
  if (item.type === "boolean") return { ok: true, value: Boolean(value) };
  if (item.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: `${item.label}: عدد معتبر نیست.` };
    if (n < item.min || n > item.max) return { ok: false, error: `${item.label}: باید بین ${item.min} و ${item.max} باشد.` };
    return { ok: true, value: n };
  }
  const s = String(value ?? "").trim();
  if (item.type === "enum") {
    return item.values.includes(s) ? { ok: true, value: s } : { ok: false, error: `${item.label}: مقدار مجاز نیست.` };
  }
  if (item.type === "color") {
    return item.pattern.test(s) ? { ok: true, value: s } : { ok: false, error: `${item.label}: کد رنگ مثل #3d6bff باشد.` };
  }
  if (item.type === "url" && s) {
    try {
      const u = new URL(s);
      if (!/^https?:$/.test(u.protocol)) throw new Error("protocol");
    } catch {
      return { ok: false, error: `${item.label}: لینک باید با http یا https شروع شود.` };
    }
  }
  if (item.maxLength && s.length > item.maxLength) {
    return { ok: false, error: `${item.label}: حداکثر ${item.maxLength} کاراکتر.` };
  }
  return { ok: true, value: s };
}

export async function savePlatformSettings(patch) {
  if (!dbReady() && !(await getDatabase())) throw Object.assign(new Error("Database is unavailable."), { statusCode: 503 });
  const current = { ...(await getPlatformSettings()) };
  const changed = {};
  for (const [id, raw] of Object.entries(patch || {})) {
    const item = SETTING_BY_ID.get(id);
    if (!item) throw Object.assign(new Error(`Unknown setting: ${id}`), { statusCode: 400 });
    const result = validate(item, raw);
    if (!result.ok) throw Object.assign(new Error(result.error), { statusCode: 400 });
    current[id] = result.value;
    changed[id] = result.value;
  }
  if (!Object.keys(changed).length) return { changed, values: current };
  await setAppSetting(STORE_KEY, JSON.stringify(current));
  invalidateSettings();
  if (Object.keys(changed).some((id) => /^limits\.maxCapacity|^room\.defaultPrivacy/.test(id))) invalidateFeatureState();
  return { changed, values: current };
}

function nest(target, id, value) {
  const [root, leaf] = id.split(".");
  if (!root || !leaf) return;
  if (!target[root] || typeof target[root] !== "object") target[root] = {};
  target[root][leaf] = value;
}

export async function publicPlatformSettings() {
  const values = await getPlatformSettings();
  const out = { updatedAt: new Date().toISOString(), values };
  for (const [id, value] of Object.entries(values)) nest(out, id, value);
  return out;
}
