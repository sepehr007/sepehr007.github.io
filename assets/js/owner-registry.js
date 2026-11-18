import { SITE_CONFIG_DEFAULTS } from "./site-config.js";

/* Central configuration registry.
   Every site setting the owner can edit is described here once; forms,
   search, Feature Center and change history all read from this list. */

const num = (min, max, step = 1) => ({ min, max, step });
const str = (maxLength) => ({ maxLength });
const enumOf = (...values) => ({ enum: values });
const hex = () => ({ pattern: "^#[0-9a-fA-F]{6}$" });
const url = () => ({ url: true });

function def(id, name, category, type, validation = {}, description = "") {
  return { id, name, category, type, validation, description, editable: true, defaultValue: null };
}

export const CONFIG_REGISTRY = [
  def("site.nameFa", "نام فارسی سایت", "branding", "string", str(40), "در سربرگ، عنوان صفحه و متای سایت استفاده می‌شود."),
  def("site.nameEn", "Site name (English)", "branding", "string", str(40), "نسخهٔ انگلیسی نام سایت."),
  def("site.taglineFa", "شعار فارسی", "branding", "string", str(140), "توضیح کوتاه زیر نام سایت."),
  def("site.taglineEn", "Tagline (English)", "branding", "string", str(140), "نسخهٔ انگلیسی شعار."),
  def("site.defaultTheme", "تم پیش‌فرض", "theme", "enum", enumOf("dark", "light"), "فقط برای بازدیدکنندگانی که ظاهر شخصی انتخاب نکرده‌اند."),
  def("site.accent", "رنگ لهجهٔ اصلی", "theme", "color", hex(), "رنگ اصلی دکمه‌ها و لینک‌ها."),
  def("site.accent2", "رنگ لهجهٔ دوم", "theme", "color", hex(), "رنگ گرادیان و جزئیات."),
  def("site.supportUrl", "لینک پشتیبانی", "site", "url", url(), "در فوتر سایت نمایش داده می‌شود."),
  def("site.metaTitleFa", "عنوان متای فارسی", "seo", "string", str(70), "اگر خالی باشد از «نام سایت — Watch Together» استفاده می‌شود."),
  def("site.metaTitleEn", "Meta title (English)", "seo", "string", str(70), "عنوان متای انگلیسی."),
  def("site.metaDescFa", "توضیحات متای فارسی", "seo", "string", str(160), "توضیح متای فارسی صفحهٔ اصلی."),
  def("site.metaDescEn", "Meta description (English)", "seo", "string", str(160), "توضیح متای انگلیسی صفحهٔ اصلی."),
  def("announcement.enabled", "نوار اطلاعیه", "notifications", "boolean", {}, "نوار سراسری بالای صفحات."),
  def("announcement.type", "نوع اطلاعیه", "notifications", "enum", enumOf("info", "warn", "critical"), "رنگ و لحن نوار اطلاعیه."),
  def("announcement.textFa", "متن اطلاعیه (فارسی)", "notifications", "string", str(220)),
  def("announcement.textEn", "Announcement text (English)", "notifications", "string", str(220)),
  def("maintenance.enabled", "حالت تعمیرات", "maintenance", "boolean", {}, "سایت برای همه به‌جز مالک قفل می‌شود."),
  def("maintenance.messageFa", "پیام تعمیرات (فارسی)", "maintenance", "string", str(300)),
  def("maintenance.messageEn", "Maintenance message (English)", "maintenance", "string", str(300)),
  def("access.registration", "ثبت‌نام حساب جدید", "accounts", "boolean", {}, "اجازهٔ ساخت حساب در رابط سایت."),
  def("access.login", "ورود حساب‌های موجود", "accounts", "boolean", {}, "اجازهٔ ورود به حساب."),
  def("access.roomCreate", "ساخت اتاق", "rooms", "boolean", {}, "اجازهٔ ساخت اتاق جدید."),
  def("access.roomJoin", "ورود به اتاق", "rooms", "boolean", {}, "اجازهٔ ورود با کد یا لینک اتاق."),
  def("features.chat", "چت متنی", "chat", "boolean", {}, "پنل گفتگو و ارسال پیام در اتاق."),
  def("features.voice", "صدای زنده", "voice", "boolean", {}, "میکروفن و بلندگوی WebRTC."),
  def("features.liveReactions", "واکنش‌های شناور", "video", "boolean", {}, "ایموجی‌های زنده روی پخش."),
  def("features.screenShare", "اشتراک صفحه", "screenShare", "boolean", {}, "نمایش صفحهٔ میزبان به اتاق."),
  def("features.queue", "صف پخش", "video", "boolean", {}, "لیست انتظار ویدیو در اتاق."),
  def("features.subtitles", "زیرنویس", "video", "boolean", {}, "بارگذاری و نمایش زیرنویس."),
  def("features.localFile", "فایل محلی", "video", "boolean", {}, "بارگذاری فایل از دستگاه میزبان."),
  def("limits.defaultCapacity", "ظرفیت پیش‌فرض اتاق", "rooms", "number", num(2, 24), "تعداد نفرات پیش‌فرض هنگام ساخت اتاق."),
  def("limits.maxCapacity", "بیشترین ظرفیت اتاق", "rooms", "number", num(2, 24), "سقف ظرفیتی که میزبان می‌تواند انتخاب کند."),
  def("limits.chatPerWindow", "پیام مجاز در بازه", "chat", "number", num(2, 30), "محدودکنندهٔ اسپم چت."),
  def("limits.chatWindowMs", "طول بازهٔ چت (ms)", "chat", "number", num(1000, 30000, 500)),
  def("limits.avatarChanges", "تغییر آواتار در بازه", "profile", "number", num(1, 20)),
  def("limits.avatarWindowMs", "بازهٔ آواتار (ms)", "profile", "number", num(500, 30000, 100)),
  def("limits.roomActions", "اکشن اتاق در بازه", "rooms", "number", num(1, 20)),
  def("limits.roomWindowMs", "بازهٔ اکشن اتاق (ms)", "rooms", "number", num(500, 30000, 100)),
  def("plans.premiumEnabled", "فروش پریمیوم", "billing", "boolean", {}, "نمایش دکمهٔ خرید در صفحهٔ قیمت."),
  def("plans.premiumUrl", "لینک پرداخت پریمیوم", "billing", "url", url(), "لینک میزبانی‌شدهٔ پرداخت (مثلاً Stripe Payment Link)."),
  def("plans.premiumPriceFa", "قیمت (فارسی)", "billing", "string", str(30)),
  def("plans.premiumPriceEn", "Price (English)", "billing", "string", str(30)),
  def("plans.premiumNoteFa", "توضیح پلن (فارسی)", "billing", "string", str(140)),
  def("plans.premiumNoteEn", "Plan note (English)", "billing", "string", str(140)),
  def("billing.currency", "ارز پرداخت", "billing", "enum", enumOf("IRT", "USD"), "واحد نمایش قیمت پلن‌ها در سایت و داشبورد مالی.")
];

for (const item of CONFIG_REGISTRY) {
  item.defaultValue = item.id.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), SITE_CONFIG_DEFAULTS);
}

export const CONFIG_CATEGORIES = {
  branding: "برندینگ",
  theme: "تم",
  seo: "سئو",
  site: "سایت",
  notifications: "اعلام‌ها",
  maintenance: "تعمیرات",
  accounts: "حساب‌ها",
  rooms: "اتاق‌ها",
  chat: "چت",
  voice: "صدا",
  video: "ویدیو",
  screenShare: "اشتراک صفحه",
  profile: "پروفایل",
  billing: "اشتراک"
};

export function configMeta(id) {
  return CONFIG_REGISTRY.find((item) => item.id === id) || null;
}

export function validateConfigValue(meta, value) {
  if (!meta) return { ok: true, value };
  const v = meta.validation || {};
  if (meta.type === "boolean") return { ok: true, value: !!value };
  if (meta.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: "عدد معتبر نیست." };
    const clamped = Math.min(v.max ?? Infinity, Math.max(v.min ?? -Infinity, n));
    return { ok: clamped === n, value: clamped, error: clamped === n ? "" : `مقدار باید بین ${v.min} و ${v.max} باشد.` };
  }
  const s = String(value ?? "");
  if (meta.type === "enum" && !v.enum.includes(s)) return { ok: false, error: "مقدار مجاز نیست." };
  if (meta.type === "color" && s && !new RegExp(v.pattern).test(s)) return { ok: false, error: "کد رنگ باید مثل #3d6bff باشد." };
  if (meta.type === "url" && s) {
    try { const u = new URL(s); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { return { ok: false, error: "لینک باید با http یا https شروع شود." }; }
  }
  if (v.maxLength && s.length > v.maxLength) return { ok: false, error: `حداکثر ${v.maxLength} کاراکتر.` };
  return { ok: true, value: s };
}

/* ---------------- pages / navigation ---------------- */

export const NAV_GROUPS = [
  { id: "overview", label: "مرور کلی" },
  { id: "access", label: "کاربران و دسترسی" },
  { id: "experience", label: "تجربهٔ اتاق" },
  { id: "business", label: "کسب‌وکار" },
  { id: "content", label: "محتوا و ظاهر" },
  { id: "system", label: "سیستم" }
];

function page(id, view, label, icon, group, title, sub, kind = "dynamic", keywords = "") {
  return { id, view: view || id, label, icon, group, title, sub, kind, keywords };
}

export const PAGE_DEFS = [
  page("dashboard", "overview", "داشبورد", "◈", "overview", "داشبورد", "وضعیت زندهٔ سایت، تغییرات و فعالیت اخیر.", "core", "dashboard خانه"),
  page("analytics", null, "آمار", "◔", "overview", "آمار", "شاخص‌های محلی و پایهٔ آمار سراسری.", "core", "analytics statistics"),
  page("audit", null, "گزارش رویدادها", "≡", "overview", "گزارش رویدادها", "همهٔ تغییرات و اقدامات مالک با زمان و جزئیات.", "dynamic", "audit log رویداد"),

  page("users", null, "کاربران", "◉", "access", "مدیریت کاربران", "حساب‌های ثبت‌شده روی این مرورگر با جستجو، فیلتر و اقدام گروهی.", "dynamic", "users user کاربر"),
  page("roles", null, "نقش‌ها", "♜", "access", "نقش‌ها", "نقش‌های پیش‌فرض و نقش‌های سفارشی آینده.", "dynamic", "roles نقش"),
  page("permissions", null, "دسترسی‌ها", "⛨", "access", "ماتریس دسترسی", "اجازه / منع / ارث‌بری برای هر نقش در هر دامنه.", "dynamic", "permissions مجوز"),
  page("moderation", null, "مدیریت محلی", "⚑", "access", "مدیریت محلی", "مسدودسازی محلی و گزارش رخدادهای امنیتی.", "core", "moderation ban مسدود"),

  page("rooms", null, "اتاق‌ها", "▤", "experience", "اتاق‌ها", "ظرفیت و قواعد اتاق؛ فهرست سروری پس از اتصال بک‌اند.", "dynamic", "rooms اتاق"),
  page("communities", null, "انجمن‌ها", "◫", "experience", "انجمن‌ها", "پایهٔ ساخت انجمن و گروه‌های کاربری.", "dynamic", "communities انجمن"),
  page("player", null, "پخش‌کننده", "▶", "experience", "پخش‌کننده", "تنظیمات پخش، زیرنویس و همگام‌سازی.", "dynamic", "player پخش"),
  page("chat", null, "چت", "✉", "experience", "چت", "روشن/خاموش چت و محدودیت نرخ پیام.", "dynamic", "chat چت"),
  page("voice", null, "صدا", "♪", "experience", "صدای زنده", "کنترل صدای زندهٔ اتاق.", "dynamic", "voice صدا"),
  page("video", null, "ویدیو", "▣", "experience", "ویدیو", "فایل محلی، صف پخش و زیرنویس.", "dynamic", "video ویدیو"),
  page("screenShare", null, "اشتراک صفحه", "⧉", "experience", "اشتراک صفحه", "نمایش صفحه و واکنش‌های زنده.", "dynamic", "screen share اشتراک"),
  page("features", null, "مرکز قابلیت‌ها", "◧", "experience", "مرکز قابلیت‌ها", "کنترل سراسری همهٔ قابلیت‌ها با دامنه، زمان‌بندی، وابستگی، سلامت و تاریخچه.", "dynamic", "feature center قابلیت فلگ flag"),
  page("limits", null, "محدودیت‌ها", "⏱", "experience", "محدودیت‌ها", "ظرفیت اتاق و نرخ مجاز چت، آواتار و اکشن.", "core", "limits محدودیت"),

  page("plans", null, "پلن‌های اشتراک", "◇", "business", "سازندهٔ پلن", "ساخت، ویرایش، کپی، آرشیو و ترتیب پلن‌ها با قیمت‌گذاری کامل.", "dynamic", "plans subscription پلن اشتراک builder"),
  page("entitlements", null, "دسترسی‌های پلن", "⛃", "business", "دسترسی‌های پلن", "ماتریس قابلیت‌ها و سهمیه‌های هر پلن؛ اعمال مرکزی.", "dynamic", "entitlements دسترسی قابلیت سهمیه quota"),
  page("subscriptions", null, "اشتراک‌ها", "◷", "business", "اشتراک‌ها", "چرخهٔ عمر کامل اشتراک: فعال‌سازی، تمدید، لغو و بازگشت.", "dynamic", "subscriptions اشتراک lifecycle"),
  page("coupons", null, "کدهای تخفیف", "٪", "business", "کدهای تخفیف", "کمپین درصدی و مبلغی با سقف استفاده و بازهٔ زمانی.", "dynamic", "coupons تخفیف kupon promo"),
  page("finance", null, "داشبورد مالی", "₿", "business", "داشبورد مالی", "MRR، ARR، اشتراک فعال، پرداخت ناموفق و روندها.", "dynamic", "finance مالی درآمد mrr arr charts"),
  page("pricing", null, "قیمت‌گذاری", "⌘", "business", "قیمت‌گذاری", "ارز، نمای زندهٔ پلن‌ها و لینک پرداخت ساده.", "dynamic", "pricing قیمت"),
  page("premium", null, "قابلیت‌های پریمیوم", "✦", "business", "قابلیت‌های پریمیوم", "مزایای پلن‌ها و سطح دسترسی.", "dynamic", "premium پریمیوم"),
  page("payments", null, "پرداخت‌ها", "₪", "business", "پرداخت‌ها", "درگاه‌های پرداخت، تراکنش‌ها و وضعیت اتصال.", "dynamic", "payments پرداخت gateway درگاه"),

  page("website", null, "سازندهٔ سایت", "⌂", "content", "سازندهٔ سایت", "پایهٔ مدیریت صفحات، ناوبری و فوتر.", "dynamic", "website builder سایت"),
  page("pages", null, "صفحه‌ساز", "▦", "content", "صفحه‌ساز", "پایهٔ ساخت صفحات بدون کد.", "dynamic", "page builder صفحه"),
  page("theme", null, "استودیوی تم", "🎨", "content", "استودیوی تم", "تم، رنگ‌ها و پیش‌تنظیم‌های ظاهری.", "dynamic", "theme تم رنگ"),
  page("branding", null, "برندینگ", "✎", "content", "برندینگ", "نام، شعار، رنگ‌ها و لینک پشتیبانی.", "core", "branding برند"),
  page("content", null, "مدیریت محتوا", "◫", "content", "مدیریت محتوا", "اطلاعیهٔ سراسری و حالت تعمیرات.", "core", "content محتوا اطلاعیه"),
  page("seo", null, "سئو", "⌕", "content", "سئو", "عنوان و توضیحات متای سراسری.", "dynamic", "seo متا"),
  page("notifications", null, "اعلام‌ها", "🔔", "content", "اعلام‌ها", "نوار اطلاعیه و پیام‌های سراسری.", "dynamic", "notifications اعلام"),

  page("security", null, "امنیت", "⛨", "system", "امنیت مالک", "ورود، نشست و قفل کنسول.", "core", "security امنیت"),
  page("configcenter", null, "مرکز پیکربندی", "⚙", "system", "مرکز پیکربندی", "جستجو، فیلتر، گروه‌بندی و ویرایش گروهی همهٔ تنظیمات سیستم در یک صفحه.", "dynamic", "config center پیکربندی تنظیمات configuration"),
  page("system", null, "سیستم", "⚙", "system", "سیستم", "وضعیت API، شبکه و محیط اجرا.", "core", "system سیستم"),
  page("automation", null, "خودکارسازی", "⚙", "system", "خودکارسازی", "پایهٔ قواعد خودکار و رویدادمحور.", "dynamic", "automation خودکار"),
  page("storage", null, "فضای ذخیره", "▤", "system", "فضای ذخیره", "پایهٔ سهمیه و فایل‌های ابری.", "dynamic", "storage ذخیره"),
  page("integrations", null, "یکپارچه‌سازی", "⇄", "system", "یکپارچه‌سازی", "پایهٔ اتصال سرویس‌های بیرونی.", "dynamic", "integrations اتصال"),
  page("backups", null, "پشتیبان‌گیری", "⤓", "system", "پشتیبان‌گیری", "دانلود و بازگردانی تنظیمات و دادهٔ محلی.", "dynamic", "backups پشتیبان"),
  page("maintenance", null, "تعمیرات", "⚠", "system", "تعمیرات", "قفل موقت سایت و پیام تعمیرات.", "dynamic", "maintenance تعمیر"),
  page("publish", null, "انتشار", "↑", "system", "انتشار تغییرات", "بازبینی، پیش‌نمایش و خروجی تنظیمات.", "core", "publish انتشار")
];

export function pageDef(id) {
  return PAGE_DEFS.find((p) => p.id === id || p.view === id) || null;
}

/* ---------------- roles & permissions ---------------- */

export const DEFAULT_ROLES = [
  { id: "super_owner", name: "Super Owner", level: 100, builtin: true },
  { id: "administrator", name: "Administrator", level: 80, builtin: true },
  { id: "moderator", name: "Moderator", level: 60, builtin: true },
  { id: "room_owner", name: "Room Owner", level: 40, builtin: true },
  { id: "member", name: "Member", level: 20, builtin: true },
  { id: "guest", name: "Guest", level: 0, builtin: true }
];

export const PERMISSION_SCOPES = [
  { id: "global", label: "سراسری" },
  { id: "role", label: "نقش" },
  { id: "user", label: "کاربر" },
  { id: "room", label: "اتاق" },
  { id: "plan", label: "پلن" }
];

export const PERMISSIONS = [
  { id: "view", label: "مشاهده" },
  { id: "create", label: "ساخت" },
  { id: "edit", label: "ویرایش" },
  { id: "delete", label: "حذف" },
  { id: "moderate", label: "مدیریت محتوا" },
  { id: "ban", label: "مسدودسازی" },
  { id: "manageRoles", label: "مدیریت نقش‌ها" },
  { id: "manageRooms", label: "مدیریت اتاق‌ها" },
  { id: "manageBilling", label: "مدیریت اشتراک" },
  { id: "manageContent", label: "مدیریت محتوا و ظاهر" },
  { id: "manageSystem", label: "مدیریت سیستم" }
];

export const PERMISSION_STATES = ["allow", "deny", "inherit"];

/* ---------------- feature center ---------------- */

export const FEATURE_DEFS = [
  { id: "features.chat", key: "chat", label: "چت متنی", desc: "پنل گفتگو، ارسال پیام، پاسخ و ویرایش.", dependency: "—" },
  { id: "features.voice", key: "voice", label: "صدای زنده", desc: "میکروفن و بلندگوی WebRTC.", dependency: "به دسترسی مرورگر نیاز دارد" },
  { id: "features.liveReactions", key: "liveReactions", label: "واکنش‌های شناور", desc: "ایموجی‌های زنده روی ویدیو.", dependency: "—" },
  { id: "features.screenShare", key: "screenShare", label: "اشتراک صفحه", desc: "ارسال تصویر صفحهٔ میزبان.", dependency: "—" },
  { id: "features.queue", key: "queue", label: "صف پخش", desc: "لیست انتظار ویدیو.", dependency: "—" },
  { id: "features.subtitles", key: "subtitles", label: "زیرنویس", desc: "بارگذاری فایل VTT/SRT.", dependency: "—" },
  { id: "features.localFile", key: "localFile", label: "فایل محلی", desc: "پخش فایل از دستگاه میزبان (تبدیل با ffmpeg.wasm).", dependency: "CDN برای تبدیل" }
];
