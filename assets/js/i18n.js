const DICT = {
  fa: {
    "hero.badge": "بدون ثبت‌نام · مستقیم در مرورگر",
    "hero.title1": "با دوستات هم‌زمان فیلم ببین",
    "hero.title2": "دقیق، ثانیه‌به‌ثانیه",
    "hero.sub": "یک لینک بساز، بفرست، و هم‌زمان با چت و صدای زنده تماشا کنید. هیچ نصب و حسابی لازم نیست.",
    "create.title": "ساخت اتاق",
    "create.sub": "اتاق بساز و لینکش رو برای دوستات بفرست.",
    "create.name": "اسم اتاق",
    "create.namePh": "شب فیلم جمعه",
    "create.nick": "اسم نمایشی تو",
    "create.nickPh": "مثلاً سارا",
    "create.capacity": "ظرفیت",
    "create.privacy": "دسترسی",
    "create.password": "رمز اتاق",
    "create.cta": "ساخت اتاق",
    "privacy.public": "عمومی",
    "privacy.password": "با رمز",
    "join.title": "ورود به اتاق",
    "join.sub": "کد اتاق یا لینک دعوت رو وارد کن.",
    "join.code": "کد اتاق یا لینک",
    "join.cta": "ورود",
    "feat.sync.t": "همگام‌سازی دقیق",
    "feat.sync.d": "پخش، توقف و جابه‌جایی برای همه هم‌زمان.",
    "feat.chat.t": "چت زنده",
    "feat.chat.d": "ری‌اکشن، پاسخ، سنجاق و تایپینگ.",
    "feat.voice.t": "صدای زنده",
    "feat.voice.d": "میکروفون و کنترل صدا، داخل مرورگر.",
    "feat.player.t": "پلیر سینمایی",
    "feat.player.d": "MP4 و HLS، زیرنویس، سرعت و PiP.",
    "footer.note": "اتاق روی مرورگر میزبان اجرا می‌شود؛ برای تماشا، میزبان باید صفحه را باز نگه دارد.",
    "room.emptyTitle": "هنوز فیلمی انتخاب نشده",
    "room.emptySub": "یه لینک مستقیم MP4 یا HLS بذار تا همه تماشا کنن.",
    "room.load": "پخش",
    "room.urlHint": "فقط لینک‌های مستقیم MP4 / M3U8 پشتیبانی می‌شوند.",
    "tab.chat": "چت",
    "tab.people": "افراد",
    "tab.queue": "صف",
    "tab.settings": "تنظیمات",
    "chat.search": "جستجو در پیام‌ها…",
    "chat.placeholder": "پیام بنویس…",
    "people.title": "افراد اتاق",
    "queue.title": "صف پخش",
    "queue.add": "افزودن",
    "settings.title": "تنظیمات اتاق",
    "settings.whoControls": "چه کسی کنترل پخش دارد؟",
    "settings.hostOnly": "فقط میزبان",
    "settings.hostMods": "میزبان و مدیران",
    "settings.everyone": "همه",
    "settings.lock": "قفل اتاق (ورود جدید ممنوع)",
    "settings.approval": "تأیید ورود توسط میزبان",
    "settings.subs": "زیرنویس (SRT / VTT)",
    "settings.subsSize": "اندازه",
    "settings.subsOffset": "تأخیر (ثانیه)",
    "settings.note": "تغییرات در همین مرورگر ذخیره می‌شوند.",
    "common.cancel": "انصراف",
    "common.ok": "تأیید",
    "common.close": "بستن",
    "common.delete": "حذف",
    "common.edit": "ویرایش",
    "common.reply": "پاسخ",
    "common.pin": "سنجاق",
    "common.unpin": "برداشتن سنجاق",
    "common.copy": "کپی",
    "common.confirm": "مطمئنی؟",
    "player.play": "پخش",
    "player.pause": "توقف",
    "net.connecting": "در حال اتصال…",
    "net.online": "متصل",
    "net.offline": "قطع شد",
    "toast.copied": "لینک کپی شد",
    "toast.nameRequired": "اسم نمایشی رو وارد کن",
    "toast.roomRequired": "کد اتاق رو وارد کن",
    "toast.roomLocked": "اتاق قفل است",
    "toast.roomFull": "ظرفیت اتاق پر است",
    "toast.wrongPassword": "رمز اشتباه است",
    "toast.cantControl": "اجازه کنترل پخش را نداری",
    "toast.videoInvalid": "لینک باید https و مستقیم باشد",
    "toast.blockedDomain": "این دامنه مسدود شده است",
    "toast.youWereKicked": "از اتاق بیرون انداخته شدی",
    "toast.connLost": "اتصال به میزبان قطع شد",
    "toast.voiceDenied": "دسترسی به میکروفون داده نشد",
    "toast.voiceJoined": "به صدا وصل شدی",
    "toast.voiceLeft": "از صدا خارج شدی",
    "toast.notInVoice": "اول به صدا وصل شو",
    "toast.hostLeft": "میزبان اتاق را ترک کرد",
    "role.owner": "میزبان",
    "role.mod": "مدیر",
    "role.member": "عضو",
    "people.kick": "اخراج",
    "people.mute": "بی‌صدا",
    "people.ban": "مسدود",
    "people.promote": "ارتقا به مدیر",
    "people.demote": "حذف نقش مدیر",
    "chat.edited": "ویرایش شد",
    "chat.deleted": "این پیام حذف شد",
    "chat.typingOne": "{n} در حال نوشتن…",
    "chat.typingMany": "{n} نفر در حال نوشتن…",
    "pinned.label": "سنجاق‌شده",
    "queue.empty": "صف خالیه — یه لینک اضافه کن.",
    "queue.votes": "رأی",
    "queue.play": "پخش"
  },
  en: {
    "hero.badge": "No sign-up · Right in your browser",
    "hero.title1": "Watch movies with friends, together",
    "hero.title2": "Perfectly in sync",
    "hero.sub": "Create a link, share it, and watch together with live chat and voice. No installs, no accounts.",
    "create.title": "Create a room",
    "create.sub": "Create a room and send the link to your friends.",
    "create.name": "Room name",
    "create.namePh": "Friday movie night",
    "create.nick": "Your display name",
    "create.nickPh": "e.g. Sara",
    "create.capacity": "Capacity",
    "create.privacy": "Access",
    "create.password": "Room password",
    "create.cta": "Create room",
    "privacy.public": "Public",
    "privacy.password": "Password",
    "join.title": "Join a room",
    "join.sub": "Enter the room code or invite link.",
    "join.code": "Room code or link",
    "join.cta": "Join",
    "feat.sync.t": "Precise sync",
    "feat.sync.d": "Play, pause and seek are synchronized.",
    "feat.chat.t": "Live chat",
    "feat.chat.d": "Reactions, replies, pins and typing.",
    "feat.voice.t": "Live voice",
    "feat.voice.d": "Mic and volume control in the browser.",
    "feat.player.t": "Cinema player",
    "feat.player.d": "MP4 and HLS, subtitles, speed and PiP.",
    "footer.note": "The room runs in the host's browser; the host must keep the page open.",
    "room.emptyTitle": "No movie selected yet",
    "room.emptySub": "Paste a direct MP4 or HLS link so everyone can watch.",
    "room.load": "Play",
    "room.urlHint": "Only direct MP4 / M3U8 links are supported.",
    "tab.chat": "Chat",
    "tab.people": "People",
    "tab.queue": "Queue",
    "tab.settings": "Settings",
    "chat.search": "Search messages…",
    "chat.placeholder": "Write a message…",
    "people.title": "People",
    "queue.title": "Play queue",
    "queue.add": "Add",
    "settings.title": "Room settings",
    "settings.whoControls": "Who can control playback?",
    "settings.hostOnly": "Host only",
    "settings.hostMods": "Host & moderators",
    "settings.everyone": "Everyone",
    "settings.lock": "Lock room (no new joins)",
    "settings.approval": "Host approval for joins",
    "settings.subs": "Subtitles (SRT / VTT)",
    "settings.subsSize": "Size",
    "settings.subsOffset": "Offset (sec)",
    "settings.note": "Settings are saved in this browser.",
    "common.cancel": "Cancel",
    "common.ok": "OK",
    "common.close": "Close",
    "common.delete": "Delete",
    "common.edit": "Edit",
    "common.reply": "Reply",
    "common.pin": "Pin",
    "common.unpin": "Unpin",
    "common.copy": "Copy",
    "common.confirm": "Are you sure?",
    "player.play": "Play",
    "player.pause": "Pause",
    "net.connecting": "Connecting…",
    "net.online": "Connected",
    "net.offline": "Disconnected",
    "toast.copied": "Link copied",
    "toast.nameRequired": "Enter your display name",
    "toast.roomRequired": "Enter the room code",
    "toast.roomLocked": "The room is locked",
    "toast.roomFull": "The room is full",
    "toast.wrongPassword": "Wrong password",
    "toast.cantControl": "You can't control playback",
    "toast.videoInvalid": "Link must be a direct https URL",
    "toast.blockedDomain": "This domain is blocked",
    "toast.youWereKicked": "You were removed from the room",
    "toast.connLost": "Lost connection to host",
    "toast.voiceDenied": "Microphone permission denied",
    "toast.voiceJoined": "Joined voice",
    "toast.voiceLeft": "Left voice",
    "toast.notInVoice": "Join voice first",
    "toast.hostLeft": "The host left the room",
    "role.owner": "Host",
    "role.mod": "Mod",
    "role.member": "Member",
    "people.kick": "Kick",
    "people.mute": "Mute",
    "people.ban": "Ban",
    "people.promote": "Promote to mod",
    "people.demote": "Remove mod",
    "chat.edited": "edited",
    "chat.deleted": "This message was deleted",
    "chat.typingOne": "{n} is typing…",
    "chat.typingMany": "{n} people are typing…",
    "pinned.label": "Pinned",
    "queue.empty": "Queue is empty — add a link.",
    "queue.votes": "votes",
    "queue.play": "Play"
  }
};

const KEY = "wt.lang";

export function getLang() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "fa" || saved === "en") return saved;
  } catch {}
  return "fa";
}

export function t(key, vars) {
  const dict = DICT[getLang()] || DICT.fa;
  let s = dict[key] ?? DICT.fa[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

export function applyI18n(root = document) {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  const toggle = document.getElementById("langToggle");
  if (toggle) toggle.textContent = lang === "fa" ? "EN" : "فا";
}

export function toggleLang() {
  const next = getLang() === "fa" ? "en" : "fa";
  try { localStorage.setItem(KEY, next); } catch {}
  applyI18n();
  document.dispatchEvent(new CustomEvent("langchange", { detail: next }));
  return next;
}

export function initI18n() {
  applyI18n();
  const toggle = document.getElementById("langToggle");
  if (toggle) toggle.addEventListener("click", toggleLang);
}
