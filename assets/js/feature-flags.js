export const FLAG_GROUPS = [
  { id: "comm", label: "ارتباطات", icon: "✉" },
  { id: "watch", label: "تماشای هم‌زمان", icon: "▶" },
  { id: "voice", label: "صدا و تصویر", icon: "♪" },
  { id: "account", label: "حساب کاربری", icon: "◉" },
  { id: "business", label: "کسب‌وکار", icon: "₿" },
  { id: "system", label: "زیرساخت", icon: "⚙" }
];

export const SCOPE_TYPES = [
  { id: "plan", label: "اشتراک", hint: "شناسهٔ پلن" },
  { id: "role", label: "نقش", hint: "شناسهٔ نقش مثل member" },
  { id: "server", label: "سرور", hint: "شناسهٔ سرور" },
  { id: "room", label: "اتاق", hint: "کد اتاق" },
  { id: "user", label: "کاربر", hint: "نام کاربری" }
];

// Authority order of scoped denials: plan > role > server > room > personal.
export const SCOPE_ORDER = ["plan", "role", "server", "room", "user"];

export const FLAGS = [
  { id: "system.realtime", path: "features.realtimeEnabled", group: "system", label: "موتور Realtime", desc: "اتصال زندهٔ اتاق، حضور و پیام‌رسانی.", deps: [] },
  { id: "system.webrtc", path: "features.webrtcEnabled", group: "system", label: "موتور WebRTC", desc: "زیرساخت صدای زنده و اشتراک صفحه.", deps: ["system.realtime"] },
  { id: "system.storage", path: "features.storageEnabled", group: "system", label: "لایهٔ ذخیره‌سازی", desc: "پایهٔ آپلود و کتابخانهٔ رسانهٔ آینده.", deps: ["system.realtime"] },
  { id: "system.notifications", path: "features.notificationsEnabled", group: "system", label: "اعلان‌های سیستمی", desc: "پایهٔ اعلان مرورگر و پیام‌های سیستمی.", deps: [] },

  { id: "chat.text", path: "features.chat", group: "comm", label: "چت متنی", desc: "پنل گفتگو، ارسال و دریافت پیام.", deps: ["system.realtime"], ui: ["#chatForm", "#chatList", "#chatEmpty", "#chatSearch", "#pinnedBar", "#typingLine"] },
  { id: "chat.private", path: "features.chatPrivate", group: "comm", label: "پیام خصوصی", desc: "گفتگوی دونفرهٔ خارج از اتاق.", deps: ["chat.text"], future: true },
  { id: "chat.groups", path: "features.chatGroups", group: "comm", label: "پیام گروهی", desc: "گروه‌های گفتگوی چندنفره.", deps: ["chat.text"], future: true },
  { id: "chat.replies", path: "features.chatReplies", group: "comm", label: "پاسخ به پیام", desc: "نقل‌قول و زنجیرهٔ پاسخ.", deps: ["chat.text"], ui: ["#replyBar"] },
  { id: "chat.mentions", path: "features.chatMentions", group: "comm", label: "منشن", desc: "فراخوانی کاربران با @.", deps: ["chat.text"], future: true },
  { id: "chat.typing", path: "features.chatTyping", group: "comm", label: "نشانگر تایپ", desc: "نمایش «در حال نوشتن».", deps: ["chat.text"], ui: ["#typingLine"] },
  { id: "chat.uploads", path: "features.chatUploads", group: "comm", label: "آپلود فایل در چت", desc: "پیوست فایل و تصویر به پیام.", deps: ["chat.text"], future: true },
  { id: "chat.notifications", path: "features.chatNotifications", group: "comm", label: "اعلان چت", desc: "اعلان پیام جدید در مرورگر.", deps: ["chat.text"], future: true },
  { id: "chat.edit", path: "features.chatEdit", group: "comm", label: "ویرایش پیام", desc: "اصلاح پیام ارسال‌شده.", deps: ["chat.text"] },
  { id: "chat.delete", path: "features.chatDelete", group: "comm", label: "حذف پیام", desc: "حذف پیام توسط میزبان یا نویسنده.", deps: ["chat.text"] },
  { id: "chat.pins", path: "features.chatPins", group: "comm", label: "پیام سنجاق‌شده", desc: "سنجاق پیام مهم در بالای چت.", deps: ["chat.text"], ui: ["#pinnedBar"] },
  { id: "chat.search", path: "features.chatSearch", group: "comm", label: "جستجوی پیام", desc: "جستجو در تاریخچهٔ گفتگو.", deps: ["chat.text"], ui: ["#chatSearch"] },
  { id: "chat.reactions", path: "features.liveReactions", group: "comm", label: "واکنش‌ها", desc: "ایموجی زنده و واکنش به پیام.", deps: ["chat.text"], ui: ["#reactDock"] },

  { id: "rooms.create", path: "access.roomCreate", group: "watch", label: "ساخت اتاق", desc: "اجازهٔ ساخت اتاق جدید.", deps: ["system.realtime"] },
  { id: "rooms.join", path: "access.roomJoin", group: "watch", label: "ورود به اتاق", desc: "ورود با کد یا لینک اتاق.", deps: ["system.realtime"] },
  { id: "rooms.public", path: "features.roomPublic", group: "watch", label: "اتاق عمومی", desc: "اتاق بدون رمز و بدون تأیید.", deps: ["rooms.create"] },
  { id: "rooms.private", path: "features.roomPrivate", group: "watch", label: "اتاق خصوصی", desc: "اتاق همراه با رمز ورود.", deps: ["rooms.create"] },
  { id: "rooms.password", path: "features.roomPassword", group: "watch", label: "رمز اتاق", desc: "تنظیم رمز هنگام ساخت اتاق.", deps: ["rooms.private"], ui: ["#passwordFieldWrap"] },
  { id: "rooms.approval", path: "features.roomApproval", group: "watch", label: "اتاق با تأیید مالک", desc: "ورود مهمان فقط پس از تأیید میزبان.", deps: ["rooms.create"], ui: ["#optApproval"] },
  { id: "watch.sharedPlayback", path: "features.sharedPlayback", group: "watch", label: "پخش مشترک", desc: "همگام‌سازی کنترل پخش بین اعضا.", deps: ["system.realtime"], ui: ["#stageControls"] },
  { id: "watch.play", path: "features.playbackPlay", group: "watch", label: "پخش", desc: "دکمهٔ Play برای اعضا.", deps: ["watch.sharedPlayback"], ui: ["#bigPlayBtn"] },
  { id: "watch.pause", path: "features.playbackPause", group: "watch", label: "توقف", desc: "دکمهٔ Pause برای اعضا.", deps: ["watch.sharedPlayback"] },
  { id: "watch.seek", path: "features.playbackSeek", group: "watch", label: "جابه‌جایی زمان", desc: "Seek روی نوار زمان.", deps: ["watch.sharedPlayback"], ui: ["#seek", "#seekWrap"] },
  { id: "watch.rate", path: "features.playbackRate", group: "watch", label: "سرعت پخش", desc: "تغییر سرعت ۰.۷۵ تا ۲ برابر.", deps: ["watch.sharedPlayback"], ui: ["#speedBtn"] },
  { id: "watch.queue", path: "features.queue", group: "watch", label: "صف پخش", desc: "لیست انتظار ویدیو در اتاق.", deps: ["system.realtime"], ui: ['.tab[data-tab="queue"]', "#queueForm", "#queueList"] },
  { id: "watch.voting", path: "features.queueVoting", group: "watch", label: "رأی‌گیری صف", desc: "رأی اعضا برای ترتیب پخش.", deps: ["watch.queue"] },
  { id: "watch.subtitles", path: "features.subtitles", group: "watch", label: "زیرنویس", desc: "بارگذاری و نمایش زیرنویس.", deps: [], ui: ["#subsBtn"] },
  { id: "watch.audioTracks", path: "features.audioTracks", group: "watch", label: "ترک صوتی", desc: "انتخاب ترک صوتی فایل.", deps: [], ui: ["#audioRow"] },
  { id: "watch.sources", path: "features.videoSources", group: "watch", label: "منبع ویدیو", desc: "تغییر آدرس یا منبع پخش.", deps: [], ui: ["#changeSourceBtn", "#loadVideoBtn", "#videoUrlInput"] },
  { id: "watch.quality", path: "features.qualitySelect", group: "watch", label: "انتخاب کیفیت", desc: "کیفیت پخش HLS.", deps: [], ui: ["#qualityRow"] },
  { id: "watch.pip", path: "features.pictureInPicture", group: "watch", label: "تصویر در تصویر", desc: "حالت PiP مرورگر.", deps: [], ui: ["#pipBtn"] },
  { id: "watch.theater", path: "features.theaterMode", group: "watch", label: "حالت سینما", desc: "نمایش عریض صحنه.", deps: [], ui: ["#theaterBtn"] },
  { id: "watch.floatingChat", path: "features.floatingChat", group: "watch", label: "چت شناور", desc: "پنل گفتگوی شناور روی پخش، حتی در تمام‌صفحه.", deps: ["chat.text"], ui: ["#cineChat", "#cineCtlBtn", "#optCineChat"] },
  { id: "watch.history", path: "features.watchHistory", group: "watch", label: "تاریخچهٔ تماشا", desc: "فهرست اتاق‌ها و ویدیوهای قبلی.", deps: [], future: true },
  { id: "watch.bookmarks", path: "features.watchBookmarks", group: "watch", label: "نشانک", desc: "ذخیرهٔ لحظهٔ مشخص از ویدیو.", deps: [], future: true },
  { id: "watch.customization", path: "features.playerCustomization", group: "watch", label: "شخصی‌سازی پخش‌کننده", desc: "روشنایی، اندازهٔ چت و ظاهر پخش.", deps: [], ui: ["#prefCard"] },
  { id: "watch.localFile", path: "features.localFile", group: "watch", label: "فایل محلی", desc: "پخش فایل از دستگاه میزبان.", deps: ["system.storage"], ui: ["#pickFileBtn", "#fileInput"] },

  { id: "voice.chat", path: "features.voice", group: "voice", label: "اتاق صوتی", desc: "صدای زندهٔ WebRTC در اتاق.", deps: ["system.webrtc"], ui: ["#voiceBtn", "#voiceStrip", "#voiceDock"] },
  { id: "voice.mic", path: "features.microphone", group: "voice", label: "میکروفن", desc: "ارسال صدا از میکروفن.", deps: ["voice.chat"], ui: ["#micBtn"] },
  { id: "voice.deafen", path: "features.deafen", group: "voice", label: "ناشنوایی (Deafen)", desc: "قطع شنیدن همهٔ صداها.", deps: ["voice.chat"], ui: ["#deafenBtn"] },
  { id: "voice.ptt", path: "features.pushToTalk", group: "voice", label: "Push To Talk", desc: "ارسال صدا فقط هنگام نگه‌داشتن کلید.", deps: ["voice.mic"], ui: ["#optPtt"] },
  { id: "voice.camera", path: "features.webcam", group: "voice", label: "وب‌کم", desc: "دوربین هنوز در اتاق پیاده‌سازی نشده؛ کنترل آماده است.", deps: ["voice.chat"], ui: ["#cameraBtn"], future: true },
  { id: "voice.calls", path: "features.voiceCalls", group: "voice", label: "تماس صوتی", desc: "تماس یک‌به‌یک خارج از اتاق.", deps: ["voice.chat"], future: true },
  { id: "voice.videoCalls", path: "features.videoCalls", group: "voice", label: "تماس تصویری", desc: "تماس یک‌به‌یک با تصویر.", deps: ["voice.camera"], future: true },
  { id: "voice.devices", path: "features.deviceSelection", group: "voice", label: "انتخاب دستگاه", desc: "انتخاب میکروفن و بلندگو.", deps: ["voice.chat"], future: true },
  { id: "voice.recovery", path: "features.connectionRecovery", group: "voice", label: "بازیابی اتصال", desc: "نوار قطعی و تلاش دوباره.", deps: ["system.realtime"], ui: ["#connLostBar"] },
  { id: "voice.volume", path: "features.volumeControls", group: "voice", label: "کنترل حجم", desc: "بی‌صدا کردن و تنظیم صدای هر عضو برای خودت.", deps: ["voice.chat"], ui: [".person-audio", ".people-tools"] },
  { id: "voice.speaking", path: "features.speakingIndicators", group: "voice", label: "نشانگر صحبت", desc: "حلقهٔ سبز دور گوینده.", deps: ["voice.chat"], bodyClass: "flag-no-speaking" },
  { id: "voice.recording", path: "features.voiceRecording", group: "voice", label: "ضبط", desc: "ضبط صدا یا صفحه.", deps: ["voice.chat", "screen.share"], future: true },
  { id: "voice.sfu", path: "features.sfuEngine", group: "voice", label: "موتور SFU", desc: "مقیاس‌پذیری اتاق‌های بزرگ.", deps: ["voice.chat"], future: true },
  { id: "screen.share", path: "features.screenShare", group: "voice", label: "اشتراک صفحه", desc: "ارسال تصویر صفحهٔ میزبان.", deps: ["system.webrtc"], ui: ["#shareBtn", "#screenLayer"] },

  { id: "account.registration", path: "access.registration", group: "account", label: "ثبت‌نام", desc: "ساخت حساب جدید.", deps: [] },
  { id: "account.login", path: "access.login", group: "account", label: "ورود", desc: "ورود حساب‌های موجود.", deps: [] },
  { id: "account.passwordReset", path: "features.passwordReset", group: "account", label: "بازیابی رمز", desc: "فراموشی رمز و بازیابی.", deps: ["account.login"] },
  { id: "account.profiles", path: "features.profiles", group: "account", label: "صفحهٔ پروفایل", desc: "مشاهده و ویرایش پروفایل.", deps: [] },
  { id: "account.friends", path: "features.friends", group: "account", label: "دوستان", desc: "فهرست دوستان محلی.", deps: ["account.profiles"], ui: ["#friendsCard"] },
  { id: "account.blocking", path: "features.blocking", group: "account", label: "مسدودسازی کاربر", desc: "مسدودکردن کاربر از دید خود.", deps: ["account.profiles"], future: true },
  { id: "account.dm", path: "features.directMessages", group: "account", label: "پیام مستقیم", desc: "گفتگوی خصوصی دو کاربر.", deps: ["chat.private"], future: true },
  { id: "account.groupMessages", path: "features.accountGroupMessages", group: "account", label: "گروه‌های پیام", desc: "گروه‌های گفتگوی حساب.", deps: ["chat.groups"], future: true },
  { id: "account.roomHistory", path: "features.roomHistory", group: "account", label: "تاریخچهٔ اتاق", desc: "اتاق‌های اخیر کاربر.", deps: [], future: true },
  { id: "account.favorites", path: "features.accountFavorites", group: "account", label: "علاقه‌مندی‌ها", desc: "ذخیرهٔ اتاق یا ویدیوی محبوب.", deps: [], future: true },
  { id: "account.customThemes", path: "features.customThemes", group: "account", label: "تم سفارشی", desc: "رنگ لهجه و ظاهر شخصی.", deps: [], ui: ["#appearanceCard", "#themeRow", "#accentRow", "#accentCustomWrap"] },
  { id: "account.customProfiles", path: "features.customProfiles", group: "account", label: "پروفایل سفارشی", desc: "چیدمان و ظاهر پروفایل.", deps: ["account.profiles"], future: true },
  { id: "account.avatarUploads", path: "features.avatarUploads", group: "account", label: "آواتار", desc: "انتخاب و تغییر آواتار.", deps: ["account.profiles"], ui: ["#avatarPicker", "#avatarRemove", "#avatarHint"] },
  { id: "account.statusMessages", path: "features.statusMessages", group: "account", label: "پیام وضعیت", desc: "وضعیت کوتاه کنار نام.", deps: ["account.profiles"], future: true },

  { id: "business.freePlans", path: "features.freePlans", group: "business", label: "پلن رایگان", desc: "نمایش و ارائهٔ پلن رایگان.", deps: [] },
  { id: "business.premiumPlans", path: "features.premiumPlans", group: "business", label: "پلن پریمیوم", desc: "نمایش پلن‌های پولی در سایت.", deps: [] },
  { id: "business.subscriptions", path: "features.subscriptionsEnabled", group: "business", label: "اشتراک‌ها", desc: "چرخهٔ عمر اشتراک و بخش قیمت‌گذاری.", deps: [] },
  { id: "business.coupons", path: "features.couponsEnabled", group: "business", label: "کدهای تخفیف", desc: "کوپن و کمپین تخفیف.", deps: ["business.subscriptions"] },
  { id: "business.payments", path: "features.paymentsEnabled", group: "business", label: "پرداخت", desc: "درگاه‌ها و تراکنش‌ها.", deps: ["business.subscriptions"] },
  { id: "business.analytics", path: "features.businessAnalytics", group: "business", label: "تحلیل کسب‌وکار", desc: "داشبورد مالی و آمار درآمد.", deps: [] },
  { id: "business.websiteBuilder", path: "features.websiteBuilder", group: "business", label: "سازندهٔ سایت", desc: "مدیریت صفحات و ناوبری.", deps: [] },
  { id: "business.automation", path: "features.automationBuilder", group: "business", label: "سازندهٔ خودکارسازی", desc: "قواعد خودکار رویدادمحور.", deps: [] },
  { id: "business.publicDiscovery", path: "features.publicDiscovery", group: "business", label: "کشف عمومی", desc: "فهرست عمومی اتاق‌ها.", deps: ["rooms.public"], future: true },
  { id: "business.promotions", path: "features.promotionsEnabled", group: "business", label: "پروموشن", desc: "تخفیف زمان‌دار و برچسب ویژه.", deps: ["business.premiumPlans"] },
  { id: "business.referrals", path: "features.referrals", group: "business", label: "معرفی دوستان", desc: "کمپین رفرال و پاداش.", deps: ["business.payments"], future: true },
  { id: "business.futureModules", path: "features.futureMonetization", group: "business", label: "ماژول‌های درآمدی آینده", desc: "کلید آمادهٔ افزونه‌های مالی.", deps: ["business.payments"], future: true }
];

export const FLAG_BY_ID = new Map(FLAGS.map((f) => [f.id, f]));
export const FLAG_PATHS = FLAGS.map((f) => f.path);

const CENTER_KEY = "wt.featureCenter";
const USAGE_KEY = "wt.flagUsage";
const LEGACY_KEY = "wt.ownerData";

export const HEALTH_LABELS = {
  healthy: "سالم",
  partial: "محدودشده",
  disabled: "خاموش",
  emergency: "اضطراری",
  scheduled: "زمان‌بندی",
  dependency: "وابستگی ازکار",
  misconfigured: "پیکربندی نامعتبر",
  future: "در انتظار پیاده‌سازی",
  error: "خطا"
};

export function emptyFeatureCenter() {
  return {
    version: 1,
    scopes: {},
    favorites: [],
    pinned: [],
    configFavorites: [],
    configPinned: [],
    notes: {},
    history: [],
    snapshots: [],
    ui: { group: "all", status: "all", q: "", favOnly: false }
  };
}

export function normalizeFeatureCenter(raw = {}) {
  const base = emptyFeatureCenter();
  if (!raw || typeof raw !== "object") return base;
  const scopes = {};
  for (const type of SCOPE_TYPES) {
    const src = raw.scopes?.[type.id];
    if (!src || typeof src !== "object") continue;
    const bucket = {};
    for (const [key, flags] of Object.entries(src)) {
      if (!flags || typeof flags !== "object") continue;
      const clean = {};
      for (const [flagId, state] of Object.entries(flags)) {
        if (FLAG_BY_ID.has(flagId) && state === "off") clean[flagId] = "off";
      }
      if (Object.keys(clean).length) bucket[String(key).slice(0, 60)] = clean;
    }
    if (Object.keys(bucket).length) scopes[type.id] = bucket;
  }
  const ids = (list) => [...new Set((Array.isArray(list) ? list : []).filter((x) => FLAG_BY_ID.has(x)))];
  const history = (Array.isArray(raw.history) ? raw.history : []).filter((h) => h && FLAG_BY_ID.has(h.id)).slice(0, 200).map((h) => ({
    at: Number(h.at) || Date.now(),
    id: h.id,
    action: String(h.action || "").slice(0, 80),
    scope: String(h.scope || "global").slice(0, 40),
    before: h.before ?? null,
    after: h.after ?? null,
    reason: String(h.reason || "").slice(0, 200),
    source: String(h.source || "owner").slice(0, 40),
    actor: String(h.actor || "owner").slice(0, 40)
  }));
  const snapshots = (Array.isArray(raw.snapshots) ? raw.snapshots : []).filter((s) => s && s.data).slice(0, 20).map((s) => ({
    id: String(s.id || `snap-${s.at || Date.now()}`),
    at: Number(s.at) || Date.now(),
    label: String(s.label || "نقطهٔ بازیابی").slice(0, 80),
    data: s.data
  }));
  const notes = {};
  for (const [id, text] of Object.entries(raw.notes || {})) {
    if (FLAG_BY_ID.has(id)) notes[id] = String(text || "").slice(0, 240);
  }
  const list = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x)).filter((x) => FLAG_BY_ID.has(x) || FLAG_PATHS.includes(x)))];
  return {
    ...base,
    scopes,
    favorites: ids(raw.favorites),
    pinned: ids(raw.pinned),
    configFavorites: list(raw.configFavorites).filter((x) => !FLAG_BY_ID.has(x)),
    configPinned: list(raw.configPinned).filter((x) => !FLAG_BY_ID.has(x)),
    notes,
    history,
    snapshots,
    ui: { ...base.ui, ...(raw.ui && typeof raw.ui === "object" ? raw.ui : {}) }
  };
}

export function readFeatureCenter() {
  try { return normalizeFeatureCenter(JSON.parse(localStorage.getItem(CENTER_KEY) || "null")); }
  catch { return emptyFeatureCenter(); }
}

export function writeFeatureCenter(center) {
  const clean = normalizeFeatureCenter(center);
  try { localStorage.setItem(CENTER_KEY, JSON.stringify(clean)); } catch {}
  return clean;
}

export function updateFeatureCenter(mutator) {
  const center = readFeatureCenter();
  const next = mutator(center) || center;
  return writeFeatureCenter(next);
}

export function getPath(object, path) {
  return String(path).split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
}

export function normalizeRule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rule = {};
  if (raw.emergency) rule.emergency = true;
  const at = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const enableAt = at(raw.enableAt);
  const disableAt = at(raw.disableAt);
  if (enableAt) rule.enableAt = enableAt;
  if (disableAt) rule.disableAt = disableAt;
  return Object.keys(rule).length ? rule : null;
}

export function normalizeFeatureRules(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [path, rule] of Object.entries(raw)) {
    if (!FLAG_PATHS.includes(path)) continue;
    const clean = normalizeRule(rule);
    if (clean) out[path] = clean;
  }
  return out;
}

export function ruleFor(config, flag) {
  return config?.featureRules?.[flag.path] || null;
}

export function scheduleState(rule, now = Date.now()) {
  if (!rule) return "none";
  const { enableAt = 0, disableAt = 0 } = rule;
  if (enableAt && disableAt && enableAt >= disableAt) return "invalid";
  if (enableAt && now < enableAt) return "waiting";
  if (disableAt && now >= disableAt) return "off";
  if (enableAt && now >= enableAt && enableAt) return "on";
  return "none";
}

export function isFlagOn(config, flagId, now = Date.now()) {
  const flag = FLAG_BY_ID.get(flagId);
  if (!flag) return false;
  if (!config) return true;
  const rule = ruleFor(config, flag);
  if (rule?.emergency) return false;
  const sched = scheduleState(rule, now);
  if (sched === "invalid") return false;
  if (sched === "off" || sched === "waiting") return false;
  return getPath(config, flag.path) !== false;
}

export function normalizeContext(raw = {}) {
  const roleAlias = { user: "member", owner: "super_owner", admin: "administrator", moderator: "moderator" };
  const role = String(raw.role || "member");
  return {
    role: roleAlias[role] || role,
    user: String(raw.user || ""),
    plan: String(raw.plan || ""),
    room: String(raw.room || ""),
    server: String(raw.server || "local")
  };
}

export function scopeKeyFor(type, context) {
  const ctx = normalizeContext(context);
  const key = ctx[type.id];
  return key ? String(key).toLowerCase() : "";
}

export function scopeDenials(flagId, scopes, context) {
  const denials = [];
  for (const typeId of SCOPE_ORDER) {
    const key = scopeKeyFor({ id: typeId }, context);
    if (!key) continue;
    for (const [storedKey, flags] of Object.entries(scopes?.[typeId] || {})) {
      if (String(storedKey).toLowerCase() !== key) continue;
      if (flags?.[flagId] === "off") denials.push(typeId);
    }
  }
  return denials;
}

export function resolveFlags(config, scopes = {}, context = {}, now = Date.now()) {
  const states = {};
  for (const flag of FLAGS) {
    const denialScopes = scopeDenials(flag.id, scopes, context);
    const rule = ruleFor(config, flag);
    const sched = scheduleState(rule, now);
    let enabled = true;
    let reason = "ok";
    let layer = "default";
    if (rule?.emergency) { enabled = false; reason = "emergency"; layer = "security"; }
    else if (sched === "invalid") { enabled = false; reason = "misconfigured"; layer = "global"; }
    else if (sched === "off" || sched === "waiting") { enabled = false; reason = "scheduled"; layer = "global"; }
    else if (getPath(config, flag.path) === false) { enabled = false; reason = "global"; layer = "global"; }
    else if (denialScopes.length) { enabled = false; reason = `scope_${denialScopes[0]}`; layer = denialScopes[0]; }
    states[flag.id] = { enabled, reason, layer, denials: denialScopes, rule, sched, future: !!flag.future };
  }
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const flag of FLAGS) {
      if (!flag.deps?.length) continue;
      const failed = flag.deps.filter((dep) => !states[dep]?.enabled);
      if (failed.length && states[flag.id].enabled) {
        states[flag.id] = { ...states[flag.id], enabled: false, reason: "dependency", failedDeps: failed };
        changed = true;
      }
    }
    if (!changed) break;
  }
  return states;
}

export function dependentIds(flagId) {
  const out = [];
  const walk = (id) => {
    for (const flag of FLAGS) {
      if (flag.deps?.includes(id) && !out.includes(flag.id)) {
        out.push(flag.id);
        walk(flag.id);
      }
    }
  };
  walk(flagId);
  return out;
}

export function missingDependencies(flagId, states) {
  const flag = FLAG_BY_ID.get(flagId);
  return (flag?.deps || []).filter((dep) => !states[dep]?.enabled);
}

export function flagHealth(flag, state, now = Date.now()) {
  if (!state) return { id: "error", label: HEALTH_LABELS.error };
  if (flag.future) return { id: "future", label: HEALTH_LABELS.future };
  if (state.reason === "emergency") return { id: "emergency", label: HEALTH_LABELS.emergency };
  if (state.reason === "misconfigured") return { id: "misconfigured", label: HEALTH_LABELS.misconfigured };
  if (state.reason === "dependency") return { id: "dependency", label: HEALTH_LABELS.dependency };
  if (state.reason === "scheduled") return { id: "scheduled", label: HEALTH_LABELS.scheduled };
  if (!state.enabled) return { id: "disabled", label: HEALTH_LABELS.disabled };
  const rule = state.rule;
  if (rule?.disableAt && rule.disableAt > now) return { id: "scheduled", label: `${HEALTH_LABELS.scheduled} · خاموشی ${new Date(rule.disableAt).toLocaleString("fa-IR")}` };
  if (rule?.enableAt && rule.enableAt > now) return { id: "scheduled", label: HEALTH_LABELS.scheduled };
  if (state.denials?.length) return { id: "partial", label: HEALTH_LABELS.partial };
  return { id: "healthy", label: HEALTH_LABELS.healthy };
}

export function healthSummary(config, scopes, context, now = Date.now()) {
  const states = resolveFlags(config, scopes, context, now);
  const counts = { healthy: 0, partial: 0, disabled: 0, emergency: 0, scheduled: 0, dependency: 0, misconfigured: 0, future: 0, error: 0 };
  for (const flag of FLAGS) {
    const health = flagHealth(flag, states[flag.id], now);
    counts[health.id] = (counts[health.id] || 0) + 1;
  }
  return { states, counts, total: FLAGS.length };
}

export function applyFlagsToDom(config, center, context, root = document, states = null) {
  const resolved = states || resolveFlags(config, center?.scopes || {}, context);
  for (const flag of FLAGS) {
    const on = resolved[flag.id]?.enabled !== false;
    for (const selector of flag.ui || []) {
      root.querySelectorAll(selector).forEach((node) => node.classList.toggle("feature-off", !on));
    }
    if (flag.bodyClass) root.documentElement.classList.toggle(flag.bodyClass, !on);
  }
  return resolved;
}

export function flagOn(states, flagId) {
  return states?.[flagId]?.enabled !== false;
}

export function mapRole(role) {
  const known = ["super_owner", "administrator", "moderator", "room_owner", "member", "guest"];
  const raw = String(role || "").trim();
  if (known.includes(raw)) return raw;
  if (raw === "owner" || raw === "superowner") return "super_owner";
  if (raw === "admin") return "administrator";
  if (raw === "user") return "member";
  return "member";
}

export function readLocalBilling() {
  try { return JSON.parse(localStorage.getItem("wt.billing") || "null") || {}; }
  catch { return {}; }
}

export function activePlanFor(userKey, billing = readLocalBilling()) {
  if (!userKey) return "";
  const now = Date.now();
  const sub = (billing.subscriptions || []).find((s) => {
    if (String(s.userKey || "").toLowerCase() !== String(userKey).toLowerCase()) return false;
    if (!["trialing", "active", "past_due", "grace"].includes(s.status)) return false;
    if (s.status === "trialing" && Number(s.trialEndsAt) && now > Number(s.trialEndsAt)) return false;
    if (Number(s.currentPeriodEnd) && now > Number(s.currentPeriodEnd) && s.status !== "grace" && s.status !== "past_due") return false;
    return true;
  });
  return sub?.planId || "";
}

export function buildFlagContext({ user = null, room = "", server = "local", plan = null } = {}) {
  const userKey = user?.username || "";
  return normalizeContext({
    role: mapRole(user?.role),
    user: userKey,
    plan: plan || activePlanFor(userKey),
    room,
    server
  });
}

export function recordFeatureUse(flagId, meta = {}) {
  if (!FLAG_BY_ID.has(flagId)) return;
  let data = null;
  try { data = JSON.parse(localStorage.getItem(USAGE_KEY) || "null"); } catch {}
  if (!data || typeof data !== "object") data = { days: {}, plan: {}, role: {}, room: {}, total: {}, last: {} };
  const day = new Date().toISOString().slice(0, 10);
  data.days = data.days && typeof data.days === "object" ? data.days : {};
  const bucket = (data.days[day] = data.days[day] || {});
  bucket[flagId] = (Number(bucket[flagId]) || 0) + 1;
  const bump = (group, key) => {
    if (!key) return;
    data[group] = data[group] || {};
    const safe = String(key).slice(0, 40);
    data[group][safe] = data[group][safe] || {};
    data[group][safe][flagId] = (Number(data[group][safe][flagId]) || 0) + 1;
  };
  bump("plan", meta.plan);
  bump("role", meta.role);
  bump("room", meta.room ? `room:${meta.room}` : "");
  data.total = data.total || {};
  data.total[flagId] = (Number(data.total[flagId]) || 0) + 1;
  data.last = data.last || {};
  data.last[flagId] = Date.now();
  const days = Object.keys(data.days).sort();
  while (days.length > 90) delete data.days[days.shift()];
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(data)); } catch {}
  window.dispatchEvent(new CustomEvent("wt:flaguse", { detail: { id: flagId } }));
}

export function readUsage() {
  try {
    const data = JSON.parse(localStorage.getItem(USAGE_KEY) || "null");
    return data && typeof data === "object" ? data : { days: {}, plan: {}, role: {}, room: {}, total: {}, last: {} };
  } catch { return { days: {}, plan: {}, role: {}, room: {}, total: {}, last: {} }; }
}

export function usageSeries(usage, days = 14) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const total = Object.values(usage.days?.[key] || {}).reduce((s, n) => s + (Number(n) || 0), 0);
    out.push({ label: key.slice(5), at: key, value: total });
  }
  return out;
}

export function usageTop(usage, limit = 8) {
  return Object.entries(usage.total || {})
    .filter(([id]) => FLAG_BY_ID.has(id))
    .map(([id, count]) => ({ id, label: FLAG_BY_ID.get(id).label, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function usageByDimension(usage, dim, limit = 6) {
  const rows = [];
  for (const [key, flags] of Object.entries(usage[dim] || {})) {
    const total = Object.values(flags || {}).reduce((s, n) => s + (Number(n) || 0), 0);
    if (total > 0) rows.push({ key, label: dim === "room" ? key.replace(/^room:/, "اتاق ") : key, count: total });
  }
  return rows.sort((a, b) => b.count - a.count).slice(0, limit);
}

export function usageAdoption(usage, days = 14) {
  const activeFlags = new Set();
  const series = usageSeries(usage, days);
  for (const d of Object.keys(usage.days || {})) {
    if (series.some((s) => s.at === d)) for (const id of Object.keys(usage.days[d] || {})) activeFlags.add(id);
  }
  return { active: activeFlags.size, keys: [...activeFlags], series };
}

export function buildFeatureExport(config, center) {
  return {
    type: "wt-feature-config",
    version: 1,
    at: new Date().toISOString(),
    features: { ...(config?.features || {}) },
    access: { ...(config?.access || {}) },
    featureRules: { ...(config?.featureRules || {}) },
    scopes: center?.scopes || {},
    favorites: center?.favorites || [],
    pinned: center?.pinned || [],
    notes: center?.notes || {}
  };
}

export function readFeatureImport(raw) {
  if (!raw || typeof raw !== "object" || raw.type !== "wt-feature-config") {
    throw Object.assign(new Error("فایل پیکربندی قابلیت معتبر نیست."), { code: "bad_import" });
  }
  const boolMap = (src) => {
    const out = {};
    if (src && typeof src === "object") {
      for (const [key, value] of Object.entries(src)) {
        if (typeof value === "boolean" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) out[key] = value;
      }
    }
    return out;
  };
  const featureRules = normalizeFeatureRules(raw.featureRules);
  const scopes = normalizeFeatureCenter({ scopes: raw.scopes }).scopes;
  return {
    features: boolMap(raw.features),
    access: boolMap(raw.access),
    featureRules,
    scopes,
    favorites: normalizeFeatureCenter({ favorites: raw.favorites }).favorites,
    pinned: normalizeFeatureCenter({ pinned: raw.pinned }).pinned,
    notes: normalizeFeatureCenter({ notes: raw.notes }).notes
  };
}

export function pushHistory(center, entry) {
  const list = [{
    at: Date.now(),
    id: entry.id,
    action: String(entry.action || ""),
    scope: String(entry.scope || "global"),
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: String(entry.reason || ""),
    source: String(entry.source || "owner"),
    actor: String(entry.actor || "owner")
  }, ...(center.history || [])].slice(0, 200);
  center.history = list;
  return list[0];
}

export function lastHistoryFor(center, flagId) {
  return (center.history || []).find((h) => h.id === flagId) || null;
}

export function snapshotFeatureState(config, center, label) {
  return {
    id: `snap-${Date.now()}`,
    at: Date.now(),
    label: String(label || "نقطهٔ بازیابی").slice(0, 80),
    data: buildFeatureExport(config, center)
  };
}
