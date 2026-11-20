import { $, $$, toast, store, applyUIPrefs, safeReload, onceAsync } from "./core.js";
import {
  SITE_CONFIG_DEFAULTS, normalizeSiteConfig, loadSiteConfig,
  setOwnerSession, savePreviewDraft, broadcastLiveConfig
} from "./site-config.js";
import { normalizeRule, normalizeFeatureRules } from "./feature-flags.js";
import { readModLog, logModeration, clearModLog } from "./modlog.js";
import { apiFetch, getApiBase } from "./api.js";
import { logAudit } from "./owner-audit.js";
import { createCenter, getUi, setUi } from "./owner-center.js";
import { installGodPages } from "./owner-god.js";
import { pageDef } from "./owner-registry.js";

const DRAFT_KEY = "wt.ownerDraft";
const OWNER_JWT_KEY = "wt.ownerJwt";
const OWNER_ID_KEY = "wt.ownerId";
const LOCK_KEY = "wt.ownerLock";
const BANS_KEY = "wt.localBans";
const USERS_KEY = "wt.users";

applyUIPrefs();
document.documentElement.dataset.theme = "dark";

let published = null;
let draft = null;
let saveTimer = 0;
let lockDeadline = 0;
const committed = new Map();

const VIEW_META = {
  overview: ["داشبورد", "وضعیت زندهٔ پلتفرم، اقدام‌های سریع و آخرین تغییرات."],
  branding: ["هویت سایت", "نام، شعار، تم و رنگ‌های پیش‌فرض سراسری."],
  content: ["اطلاعیه و تعمیرات", "پیام سراسری و قفل موقت سایت."],
  access: ["دسترسی‌ها", "کنترل ثبت‌نام، ورود، ساخت و پیوستن به اتاق."],
  features: ["قابلیت‌ها", "روشن و خاموش کردن بخش‌های اصلی سایت."],
  limits: ["محدودیت‌ها", "ظرفیت اتاق و نرخ مجاز چت، آواتار و اکشن."],
  plans: ["سازندهٔ پلن", "ساخت، ویرایش، قیمت‌گذاری و انتشار پلن‌ها بدون تغییر کد."],
  entitlements: ["دسترسی‌های پلن", "قابلیت‌ها، سهمیه‌ها و محدودیت‌های هر پلن."],
  subscriptions: ["اشتراک‌ها", "چرخهٔ عمر اشتراک: فعال‌سازی، تمدید، لغو و ارتقا."],
  coupons: ["کدهای تخفیف", "کمپین‌های درصدی و مبلغی با بازهٔ زمانی."],
  finance: ["داشبورد مالی", "MRR، ARR، رشد، ریزش و روند درآمد."],
  payments: ["پرداخت‌ها", "درگاه‌ها، تراکنش‌ها و وضعیت اتصال."],
  moderation: ["مدیریت محلی", "حساب‌های همین مرورگر و گزارش رخدادها."],
  rooms: ["اتاق‌ها", "پایهٔ مدیریت اتاق‌ها؛ نسخهٔ فعلی اتاق سروری ندارد."],
  system: ["سیستم", "وضعیت API، شبکه و محیط اجرا."],
  security: ["امنیت مالک", "ورود سروری و تغییر رمز با یک کد ایمیل یا پیامک."],
  analytics: ["آمار", "پایهٔ شاخص‌های مصرف؛ دادهٔ سراسری در فاز بعد."],
  publish: ["پشتیبان تنظیمات", "بازبینی تغییرات، پیش‌نمایش و دریافت فایل JSON."]
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function getPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

/* ---------- local owner lockout ---------- */
function readLock() {
  const l = store.get(LOCK_KEY, null);
  return l && Number(l.until) > Date.now() ? l : null;
}
function noteOwnerFailure() {
  const l = store.get(LOCK_KEY, null) || { n: 0, until: 0 };
  if (Number(l.until) > Date.now()) return;
  l.n = (Number(l.n) || 0) + 1;
  if (l.n >= 5) { l.n = 0; l.until = Date.now() + 5 * 60 * 1000; }
  store.set(LOCK_KEY, l);
}
function clearOwnerFailures() {
  store.del(LOCK_KEY);
  lockDeadline = 0;
}

/* ---------- draft ---------- */
function loadDraft() {
  const saved = store.get(DRAFT_KEY, null);
  draft = saved && typeof saved === "object" ? normalizeSiteConfig(saved) : clone(published);
}
function saveDraft() {
  draft = normalizeSiteConfig(draft);
  store.set(DRAFT_KEY, draft);
  broadcastLiveConfig(draft);
  markDirty();
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 220);
}
function isDirty() {
  return JSON.stringify(published) !== JSON.stringify(draft);
}
function markDirty() {
  const dirty = isDirty();
  $("#dirtyBadge")?.classList.toggle("hidden", !dirty);
  const st = $("#draftState");
  if (st) {
    st.textContent = dirty ? "تغییرات ذخیرهٔ محلی دارید و هنوز منتشر نشده‌اند." : "هم‌سان با نسخهٔ منتشرشده";
    st.classList.toggle("dirty", dirty);
  }
  refreshOverview();
  refreshDiff();
}

function renderInputs() {
  for (const input of $$("[data-cfg]")) {
    const path = input.dataset.cfg;
    const value = getPath(draft, path);
    if (input.type === "checkbox") input.checked = !!value;
    else if (input.type === "number") input.value = value == null ? "" : String(value);
    else input.value = value == null ? "" : String(value);
  }
  $$("[data-cfg]").forEach((input) => {
    if (input.type === "color") {
      const twin = input.parentElement?.querySelector(`input.mono[data-cfg="${CSS.escape(input.dataset.cfg)}"]`);
      if (twin) twin.value = input.value;
    }
  });
  refreshAnnouncePreview();
  refreshOverview();
  refreshDiff();
  committed.clear();
  for (const [path] of Object.entries(flatten(draft))) committed.set(path, getPath(draft, path));
}

function refreshAnnouncePreview() {
  const box = $("#announcePreview");
  if (!box) return;
  const text = draft.announcement.textFa?.trim();
  box.textContent = text || "پیش‌نمایش اطلاعیه (متن فارسی خالی است)";
  box.className = `announce-preview ${draft.announcement.type || "info"}`;
}

function refreshOverview() {
  if (!draft) return;
  $("#statVersion").textContent = String(draft.version || 1);
  $("#statUpdated").textContent = published?.updatedAt
    ? `آخرین انتشار: ${new Date(published.updatedAt).toLocaleString("fa-IR")}`
    : "هنوز منتشر نشده";
  const users = readUsers();
  const bans = readBans();
  $("#statUsers").textContent = String(Object.keys(users).length);
  $("#statBans").textContent = String(bans.length);
  $("#statLogs").textContent = String(readModLog().length);

  const setState = (id, on, onLabel = "روشن", offLabel = "خاموش") => {
    const node = $(id);
    if (!node) return;
    node.textContent = on ? onLabel : offLabel;
    node.classList.toggle("on", on);
    node.classList.toggle("off", !on);
  };
  setState("#ovMaint", draft.maintenance.enabled);
  setState("#ovAnnounce", draft.announcement.enabled);
  setState("#ovRegister", draft.access.registration, "باز", "بسته");
  setState("#ovCreate", draft.access.roomCreate, "باز", "بسته");
  const f = draft.features;
  const onCount = ["chat", "voice", "liveReactions", "screenShare", "queue", "subtitles", "localFile"].filter((k) => f[k] !== false).length;
  const feat = $("#ovFeat");
  if (feat) {
    feat.textContent = `${onCount} از ۷ فعال`;
    feat.classList.toggle("on", onCount === 7);
    feat.classList.toggle("off", onCount === 0);
  }
}

function flatten(value, prefix = "", out = []) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.push([prefix, value]);
  }
  return out;
}
function refreshDiff() {
  const list = $("#diffList");
  if (!list || !draft) return;
  const before = new Map(flatten(published));
  const after = flatten(draft);
  const changes = after.filter(([path, value]) => JSON.stringify(before.get(path)) !== JSON.stringify(value));
  if (!changes.length) {
    list.innerHTML = '<p class="empty">تغییری نسبت به نسخهٔ منتشرشده نیست.</p>';
    return;
  }
  list.replaceChildren();
  for (const [path, value] of changes.slice(0, 60)) {
    const row = document.createElement("div");
    row.className = "diff-item";
    const key = document.createElement("code");
    key.textContent = path;
    const val = document.createElement("span");
    const raw = typeof value === "boolean" ? (value ? "روشن" : "خاموش") : String(value ?? "");
    val.textContent = raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
    row.append(key, val);
    list.append(row);
  }
  if (changes.length > 60) {
    const more = document.createElement("p");
    more.className = "empty";
    more.textContent = `و ${changes.length - 60} تغییر دیگر…`;
    list.append(more);
  }
}

/* ---------- local users / bans / log ---------- */
function readUsers() {
  const users = store.get(USERS_KEY, {});
  return users && typeof users === "object" ? users : {};
}
function readBans() {
  const bans = store.get(BANS_KEY, []);
  return Array.isArray(bans) ? bans.map((x) => String(x).toLowerCase()) : [];
}
function writeBans(list) {
  store.set(BANS_KEY, [...new Set(list.map((x) => String(x).toLowerCase()))]);
}
function renderUsers() {
  const body = $("#localUsersBody");
  if (!body) return;
  const users = readUsers();
  const bans = readBans();
  body.replaceChildren();
  const entries = Object.values(users);
  if (!entries.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "empty";
    td.textContent = "حسابی روی این مرورگر ساخته نشده.";
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const rec of entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = rec.nick || "?";
    const user = document.createElement("td");
    const code = document.createElement("small");
    code.textContent = rec.u || "";
    user.textContent = "@" + (rec.u || "?");
    user.append(code);
    const when = document.createElement("td");
    when.textContent = rec.createdAt ? new Date(rec.createdAt).toLocaleDateString("fa-IR") : "—";
    const state = document.createElement("td");
    const banned = bans.includes(String(rec.u || "").toLowerCase());
    const tag = document.createElement("span");
    tag.className = `tag ${banned ? "bad" : "ok"}`;
    tag.textContent = banned ? "مسدود محلی" : "فعال";
    state.append(tag);
    const actions = document.createElement("td");
    const banBtn = document.createElement("button");
    banBtn.type = "button";
    banBtn.className = "mini-btn";
    banBtn.textContent = banned ? "رفع مسدودی" : "مسدود";
    banBtn.addEventListener("click", () => toggleBan(rec.u, banned));
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "mini-btn danger";
    delBtn.textContent = "حذف";
    delBtn.addEventListener("click", () => deleteLocalUser(rec.u));
    actions.append(banBtn, delBtn);
    tr.append(name, user, when, state, actions);
    body.append(tr);
  }
}
function toggleBan(username, banned) {
  const u = String(username || "").toLowerCase();
  if (!u) return;
  const bans = readBans();
  if (banned) writeBans(bans.filter((x) => x !== u));
  else writeBans([...bans, u]);
  logModeration(banned ? "unban" : "ban", `@${u}`);
  logAudit({ kind: "user", action: banned ? "رفع مسدودی" : "مسدودسازی", target: `@${u}` });
  renderUsers();
  refreshOverview();
  renderLog();
  toast(banned ? "مسدودی محلی برداشته شد." : "این حساب روی همین مرورگر مسدود شد.", "success");
}
function deleteLocalUser(username, opts = {}) {
  const u = String(username || "").toLowerCase();
  const users = readUsers();
  if (!users[u]) return;
  if (!opts.silent && !confirm(`حساب @${u} و رمز هش‌شدهٔ آن از این مرورگر حذف شود؟ این کار برگشت‌پذیر نیست.`)) return;
  delete users[u];
  store.set(USERS_KEY, users);
  writeBans(readBans().filter((x) => x !== u));
  logModeration("deleteAccount", `@${u}`);
  logAudit({ kind: "user", action: "حذف حساب", target: `@${u}` });
  renderUsers();
  refreshOverview();
  renderLog();
  if (!opts.silent) toast("حساب محلی حذف شد.", "success");
}
function renderLog() {
  const box = $("#modLogList");
  if (!box) return;
  const log = readModLog();
  box.replaceChildren();
  if (!log.length) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "رخدادی ثبت نشده است.";
    box.append(empty);
    return;
  }
  const labels = {
    ban: "مسدودسازی", unban: "رفع مسدودی", deleteAccount: "حذف حساب",
    loginFail: "ورود ناموفق", loginLock: "قفل ورود", throttle: "محدودیت اسپم",
    ownerLogin: "ورود مالک", publish: "انتشار", passChange: "تغییر رمز مالک",
    register: "ثبت‌نام", login: "ورود", recover: "بازیابی رمز", recoverFail: "بازیابی ناموفق"
  };
  for (const item of log) {
    const row = document.createElement("div");
    row.className = "log-item";
    const time = document.createElement("time");
    time.textContent = new Date(item.at).toLocaleString("fa-IR");
    const text = document.createElement("span");
    const label = document.createElement("b");
    label.textContent = labels[item.kind] || item.kind;
    text.append(label, document.createTextNode(item.detail || ""));
    row.append(time, text);
    box.append(row);
  }
}

/* ---------- overview + views ---------- */
function metaFor(name) {
  const def = pageDef(name);
  if (VIEW_META[name]) {
    return { view: def?.view || name, page: def?.id || name, title: VIEW_META[name][0], sub: VIEW_META[name][1] };
  }
  if (def) return { view: def.view, page: def.id, title: def.title, sub: def.sub };
  return { view: "overview", page: "dashboard", title: VIEW_META.overview[0], sub: VIEW_META.overview[1] };
}
function showView(name) {
  const info = metaFor(name);
  center.renderPage(info.page);
  $$("[data-view]").forEach((v) => v.classList.toggle("active", v.dataset.view === info.view));
  $$("[data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === info.view));
  $("#viewTitle").textContent = info.title;
  $("#viewSub").textContent = info.sub;
  $("#ownerSide")?.classList.remove("open");
  document.getElementById("owBackdrop")?.classList.add("hidden");
  if (!$("#ownerApp")?.classList.contains("hidden")) setUi({ view: info.page });
  if (info.view === "moderation") { renderUsers(); renderLog(); }
  if (info.view === "publish") refreshDiff();
  if (info.view === "security") refreshOwnerIdentity();
  if (info.view === "system") refreshSystemView();
}
/* ---------- gate ---------- */
function configureGate() {
  let base = "";
  try { base = getApiBase(); } catch {}
  const savedId = String(store.get(OWNER_ID_KEY, "") || "");
  if (savedId) $("#ownerId").value = savedId;
  $("#loginHint").textContent = base
    ? "فقط حساب مالک سرور با ایمیل تأییدشده یا شمارهٔ پیامک ثبت‌شده اجازهٔ ورود دارد."
    : "کنسول امن فقط با بک‌اند فعال کار می‌کند؛ apiBase را در runtime-config تنظیم کن.";
  $("#ownerPass").disabled = false;
}
function getOwnerJwt() {
  try { return sessionStorage.getItem(OWNER_JWT_KEY) || ""; } catch { return ""; }
}
function setOwnerJwt(token) {
  try {
    if (token) sessionStorage.setItem(OWNER_JWT_KEY, token);
    else sessionStorage.removeItem(OWNER_JWT_KEY);
  } catch {}
}
async function ownerApi(path, options = {}) {
  const token = getOwnerJwt();
  if (!token) throw Object.assign(new Error("owner session missing"), { code: "no_session", status: 401 });
  return apiFetch(path, { ...options, token, auth: false });
}
async function unlock() {
  await setOwnerSession(true);
  $("#ownerGate").classList.add("hidden");
  $("#ownerApp").classList.remove("hidden");
  renderAll();
  try { history.replaceState(null, "", location.pathname); } catch {}
  logModeration("ownerLogin", "ورود موفق به کنسول");
  logAudit({ kind: "security", action: "ورود مالک به کنسول" });
}
async function storeOwnerToken(identifier, pass) {
  const res = await apiFetch("/auth/login", {
    method: "POST",
    auth: false,
    timeoutMs: 12000,
    body: { identifier, password: pass }
  });
  if (!res?.token || !["owner", "super_owner"].includes(res.user?.role)) {
    throw Object.assign(new Error("not_owner"), { code: "not_owner", status: 403 });
  }
  setOwnerJwt(res.token);
  let identity = null;
  try {
    identity = await apiFetch("/auth/owner/identity", { token: res.token, auth: false, timeoutMs: 10000 });
  } catch (err) {
    setOwnerJwt("");
    throw err;
  }
  if (!identity?.canAccess) {
    setOwnerJwt("");
    throw Object.assign(new Error("owner_contact_missing"), {
      code: "owner_contact_missing",
      status: 409,
      identity: identity?.identity || null
    });
  }
  return identity;
}
function loginErrorMessage(err) {
  const code = err?.code || "";
  if (code === "not_configured" || err?.status === 0 && /configured/i.test(err?.message || "")) {
    return "بک‌اند تنظیم نشده است. apiBase را در assets/data/runtime-config.json بگذار.";
  }
  if (code === "owner_contact_missing") {
    return "ایمیل تأییدشده یا شمارهٔ پیامک مالک روی سرور تنظیم نشده است. با npm run owner:setup -- --yes اعمالش کن.";
  }
  if (code === "not_owner") return "این حساب نقش مالک ندارد.";
  if (code === "too_many_attempts") return "تلاش‌های زیاد؛ کمی بعد دوباره امتحان کن.";
  if (err?.status === 401 || code === "invalid_credentials") return "ایمیل/نام کاربری یا رمز اشتباه است.";
  if (err?.status === 403) return "ورود مالک برای این حساب مجاز نیست.";
  if (code === "database_unavailable") return "پایگاه دادهٔ سرور آماده نیست؛ کمی بعد دوباره تلاش کن.";
  if (code === "network_error" || code === "timeout") return "اتصال به سرور برقرار نشد.";
  return err?.message || "ورود انجام نشد.";
}
async function doPasswordLogin(e) {
  e.preventDefault();
  const err = $("#loginErr");
  err.textContent = "";
  const lock = readLock();
  if (lock) {
    err.textContent = `تلاش‌های زیاد. ${Math.ceil((lock.until - Date.now()) / 1000)} ثانیه صبر کن.`;
    return;
  }
  const identifier = $("#ownerId").value.trim().toLowerCase();
  const pass = $("#ownerPass").value;
  if (!identifier) { err.textContent = "ایمیل یا نام کاربری مالک را وارد کن."; return; }
  if (!pass) { err.textContent = "رمز را وارد کن."; return; }
  const btn = $("#loginBtn");
  btn.disabled = true;
  btn.textContent = "در حال بررسی…";
  try {
    const identity = await storeOwnerToken(identifier, pass);
    clearOwnerFailures();
    store.set(OWNER_ID_KEY, identifier);
    $("#ownerPass").value = "";
    await unlock();
    renderOwnerIdentity(identity);
  } catch (ex) {
    if (ex?.status === 401 || ex?.code === "invalid_credentials") {
      noteOwnerFailure();
      const l = readLock();
      err.textContent = l ? "پنج تلاش ناموفق؛ پنج دقیقه قفل شد." : "ایمیل/نام کاربری یا رمز اشتباه است.";
      if (l) logModeration("loginLock", "قفل پنج دقیقه‌ای کنسول");
      else logModeration("loginFail", "ورود مالک ناموفق");
    } else {
      err.textContent = loginErrorMessage(ex);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "باز کردن کنسول";
  }
}

/* ---------- security ---------- */
function renderOwnerIdentity(data) {
  const id = data?.identity || null;
  const emailEl = $("#ownerIdEmail");
  const phoneEl = $("#ownerIdPhone");
  const stateEl = $("#ownerIdState");
  if (emailEl) emailEl.textContent = id?.email || "تنظیم نشده";
  if (phoneEl) phoneEl.textContent = id?.phone || "تنظیم نشده";
  const emailReady = Boolean(id?.emailReady);
  const phoneReady = Boolean(id?.phoneReady);
  const anyReady = emailReady || phoneReady;
  if (stateEl) {
    const open = emailReady && phoneReady ? "ایمیل و پیامک" : emailReady ? "ایمیل" : phoneReady ? "پیامک" : "";
    stateEl.textContent = anyReady ? `فعال؛ تأیید با ${open} ممکن است` : "ناقص؛ ایمیل تأییدشده یا شماره را روی سرور تنظیم کن";
    stateEl.classList.toggle("on", anyReady);
    stateEl.classList.toggle("off", !anyReady);
  }
  const select = $("#codeChannel");
  if (select) {
    for (const option of select.options) {
      option.disabled = option.value === "email" ? !emailReady : !phoneReady;
    }
    if (select.selectedOptions[0]?.disabled) {
      const first = [...select.options].find((option) => !option.disabled);
      if (first) select.value = first.value;
    }
  }
  const sendBtn = $("#sendCodeBtn");
  if (sendBtn) sendBtn.disabled = !anyReady;
  const min = Number(data?.minPassword || 12);
  if ($("#nextPass")) $("#nextPass").minLength = min;
  if ($("#nextPass2")) $("#nextPass2").minLength = min;
}
async function refreshOwnerIdentity() {
  const stateEl = $("#ownerIdState");
  try {
    const data = await ownerApi("/auth/owner/identity", { timeoutMs: 10000 });
    renderOwnerIdentity(data);
    return data;
  } catch (ex) {
    if (stateEl) {
      stateEl.textContent = ex?.status === 401 ? "نشست منقضی شده؛ دوباره وارد شو" : "دریافت وضعیت ممکن نشد";
      stateEl.classList.add("off");
    }
    return null;
  }
}
async function sendOwnerCode() {
  const stateEl = $("#codeState");
  const btn = $("#sendCodeBtn");
  const channel = $("#codeChannel")?.value === "sms" ? "sms" : "email";
  if (btn) { btn.disabled = true; btn.textContent = "در حال ارسال…"; }
  if (stateEl) stateEl.textContent = channel === "email" ? "ارسال کد به ایمیل…" : "ارسال کد به پیامک…";
  try {
    const res = await ownerApi("/auth/owner/password/code", {
      method: "POST",
      timeoutMs: 15000,
      body: { channel }
    });
    const d = res?.delivery || {};
    if (stateEl) {
      const target = channel === "email" ? d.email : d.phone;
      let text = `کد به ${target || (channel === "email" ? "ایمیل" : "پیامک")} ارسال شد (${d.mode || "ارسال"}).`;
      if (d.previewCode) text += ` کد آزمایشی این محیط: ${d.previewCode}`;
      stateEl.textContent = text;
    }
    logAudit({ kind: "security", action: "درخواست کد تغییر رمز مالک", target: channel });
    toast(channel === "email" ? "کد ایمیل ارسال شد." : "کد پیامک ارسال شد.", "success");
  } catch (ex) {
    const code = ex?.code || "";
    const message =
      code === "owner_contact_missing"
        ? "برای این روش، ایمیل تأییدشده یا شمارهٔ مالک باید اول روی سرور تنظیم شود."
        : code === "code_cooldown"
          ? "کمی صبر کن؛ تا ارسال کد بعدی چند ثانیه مانده."
          : code === "mail_failed" || code === "sms_failed"
            ? "ارسال کد ناموفق بود؛ تنظیمات ایمیل/پیامک را در تنظیمات سرور بررسی کن."
            : ex?.message || "ارسال کد ممکن نشد.";
    if (stateEl) stateEl.textContent = message;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "ارسال کد";
    }
  }
}
async function changePass(e) {
  e.preventDefault();
  const err = $("#passErr");
  if (err) err.textContent = "";
  if (!getOwnerJwt()) { if (err) err.textContent = "نشست مالک نیست؛ دوباره وارد شو."; return; }
  const channel = $("#codeChannel")?.value === "sms" ? "sms" : "email";
  const code = $("#verifyCode").value.replace(/\D/g, "");
  const next = $("#nextPass").value;
  const next2 = $("#nextPass2").value;
  if (next.length < 12) { if (err) err.textContent = "رمز جدید باید حداقل ۱۲ کاراکتر باشد."; return; }
  if (next !== next2) { if (err) err.textContent = "تکرار رمز جدید یکسان نیست."; return; }
  if (!/^\d{8}$/.test(code)) {
    if (err) err.textContent = "کد ۸ رقمی ایمیل یا پیامک را وارد کن.";
    return;
  }
  const btn = $("#passForm button[type=submit]");
  if (btn) { btn.disabled = true; btn.textContent = "در حال ذخیره…"; }
  try {
    const res = await ownerApi("/auth/owner/password/confirm", {
      method: "POST",
      timeoutMs: 20000,
      body: { channel, code, password: next }
    });
    if (res?.token) setOwnerJwt(res.token);
    $("#verifyCode").value = "";
    $("#nextPass").value = $("#nextPass2").value = "";
    if (err) err.textContent = "";
    logModeration("passChange", "رمز مالک با یک کد تأیید عوض شد");
    logAudit({ kind: "security", action: "تغییر رمز مالک با کد", target: channel });
    toast("رمز مالک عوض شد و نشست‌های قبلی بسته شدند.", "success");
    await refreshOwnerIdentity();
  } catch (ex) {
    const codeName = ex?.code || "";
    const message =
      codeName === "password_unchanged"
        ? "رمز جدید نباید با رمز فعلی یکی باشد."
        : codeName === "code_expired"
          ? "کد منقضی شده؛ دوباره کد بگیر."
          : codeName === "invalid_code"
            ? "کد واردشده اشتباه است."
            : codeName === "too_many_attempts"
              ? "تلاش‌های اشتباه زیاد شد؛ کد تازه بگیر."
              : codeName === "owner_contact_missing"
                ? "ایمیل تأییدشده یا شمارهٔ مالک روی سرور تنظیم نشده است."
                : ex?.message || "تغییر رمز ممکن نشد.";
    if (err) err.textContent = message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "ذخیرهٔ رمز جدید"; }
  }
}

/* ---------- publish ---------- */
function downloadJson() {
  const blob = new Blob([JSON.stringify(draft, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `site-config-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importJson(file) {
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    draft = normalizeSiteConfig(raw);
    saveDraft();
    renderAll();
    logAudit({ kind: "config", action: "بارگذاری فایل تنظیمات", target: file.name || "" });
    toast("فایل تنظیمات بارگذاری شد.", "success");
  } catch {
    toast("فایل JSON معتبر نیست.", "error");
  }
}
function resetDraft() {
  if (!confirm("همهٔ تغییرات محلی دور انداخته شود و نسخهٔ منتشرشده بازگردد؟")) return;
  draft = clone(published);
  store.set(DRAFT_KEY, draft);
  logAudit({ kind: "config", action: "بازنشانی پیش‌نویس تنظیمات" });
  renderAll();
  toast("پیش‌نویس بازنشانی شد.");
}
function previewSite() {
  savePreviewDraft(draft);
  window.open("index.html?preview=1", "_blank");
  logAudit({ kind: "action", action: "بازکردن پیش‌نمایش سایت" });
  toast("پیش‌نمایش در تب تازه باز شد (فقط برای مالک).", "success");
}

/* ---------- boot / bind ---------- */
function bindInputs() {
  document.addEventListener("input", (e) => {
    const input = e.target.closest?.("[data-cfg]");
    if (!input) return;
    const path = input.dataset.cfg;
    let value;
    if (input.type === "checkbox") value = input.checked;
    else if (input.type === "number") value = Number(input.value);
    else value = input.value;
    setPath(draft, path, value);
    $$(`[data-cfg="${CSS.escape(path)}"]`).forEach((twin) => {
      if (twin === input) return;
      if (twin.type === "checkbox") twin.checked = !!value;
      else twin.value = String(value ?? "");
    });
    refreshAnnouncePreview();
    scheduleSave();
  });
  document.addEventListener("change", (e) => {
    const input = e.target.closest?.("[data-cfg]");
    if (!input) return;
    const path = input.dataset.cfg;
    const before = committed.get(path);
    const after = getPath(draft, path);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      logAudit({ kind: "config", action: "تغییر تنظیمات", target: path, before, after });
      committed.set(path, after);
    }
    saveDraft();
  });
}
function bindChrome() {
  $("#loginForm").addEventListener("submit", onceAsync(doPasswordLogin));

  $$("[data-nav]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.nav)));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.goto)));
  $("#lockBtn").addEventListener("click", lockConsole);

  $("#passForm").addEventListener("submit", changePass);
  $("#sendCodeBtn")?.addEventListener("click", sendOwnerCode);
  $("#publishTop").addEventListener("click", () => { showView("publish"); });
  $("#previewBtn").addEventListener("click", previewSite);
  $("#previewBtn2").addEventListener("click", previewSite);
  $("#exportBtn").addEventListener("click", downloadJson);
  $("#importInput").addEventListener("change", (e) => { importJson(e.target.files?.[0]); e.target.value = ""; });
  $("#discardBtn").addEventListener("click", resetDraft);
  $("#discardTop").addEventListener("click", resetDraft);
  $("#clearLogBtn").addEventListener("click", () => {
    if (!confirm("کل گزارش محلی پاک شود؟")) return;
    clearModLog();
    renderLog();
    refreshOverview();
    toast("گزارش پاک شد.");
  });
}

function setCfg(path, value) {
  if (!draft) return;
  setPath(draft, path, value);
  saveDraft();
  renderInputs();
}
function setFeatureRule(flagPath, rule) {
  if (!draft) return;
  const rules = { ...(draft.featureRules || {}) };
  const clean = normalizeRule(rule);
  if (clean) rules[flagPath] = clean;
  else delete rules[flagPath];
  draft.featureRules = rules;
  saveDraft();
  renderInputs();
}
function applyFeatureSnapshot(payload = {}) {
  if (!draft) return;
  for (const [key, value] of Object.entries(payload.features || {})) {
    if (draft.features && Object.prototype.hasOwnProperty.call(draft.features, key)) draft.features[key] = value !== false;
  }
  for (const [key, value] of Object.entries(payload.access || {})) {
    if (draft.access && Object.prototype.hasOwnProperty.call(draft.access, key)) draft.access[key] = value !== false;
  }
  draft.featureRules = normalizeFeatureRules(payload.featureRules || {});
  saveDraft();
  renderInputs();
}
function lockConsole() {
  if (!confirm("کنسول قفل شود؟ برای ورود دوباره رمز مالک لازم است.")) return;
  setOwnerSession(false);
  setOwnerJwt("");
  logAudit({ kind: "security", action: "قفل کنسول" });
  safeReload();
}
const center = createCenter({
  getDraft: () => draft,
  getPublished: () => published,
  isDirty,
  setCfg,
  setFeatureRule,
  applyFeatureSnapshot,
  renderInputs,
  toast,
  showView,
  readUsers,
  readBans,
  toggleBan,
  deleteLocalUser,
  readModLog,
  previewSite,
  downloadJson,
  importJsonFile: importJson,
  resetDraft,
  lockConsole,
  getApiBase
});

installGodPages(center);

function renderAll() {
  configureGate();
  renderInputs();
  renderUsers();
  renderLog();
  refreshOwnerIdentity();
  markDirty();
  center.ensureExtras();
  center.refreshAll();
  const saved = getUi().view;
  showView(pageDef(saved) ? saved : "dashboard");
}

function refreshSystemView() {
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  let base = "";
  try { base = getApiBase(); } catch {}
  set("sysApiBase", base || "تنظیم نشده (حالت محلی)");
  set("sysOnline", navigator.onLine ? "آنلاین" : "آفلاین");
  set("sysHost", location.host || "—");
  set("sysMode", location.protocol === "https:" ? "HTTPS" : location.protocol === "http:" ? "HTTP" : "فایل محلی");
}

async function backendOwnerValid() {
  const token = getOwnerJwt();
  if (!token) return null;
  try {
    const res = await apiFetch("/auth/me", { token, auth: false, timeoutMs: 6000 });
    const role = res?.user?.role;
    if (role !== "owner" && role !== "super_owner") return false;
    const identity = await apiFetch("/auth/owner/identity", { token, auth: false, timeoutMs: 8000 });
    if (!identity?.canAccess) {
      setOwnerJwt("");
      return false;
    }
    return true;
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      setOwnerJwt("");
      return false;
    }
    return null;
  }
}

async function validOwnerAccess() {
  const remote = await backendOwnerValid();
  if (remote === true) {
    await setOwnerSession(true);
    return true;
  }
  return false;
}

(async function bootOwner() {
  try {
    published = clone(await loadSiteConfig());
  } catch {
    published = clone(SITE_CONFIG_DEFAULTS);
  }
  loadDraft();
  center.init();
  bindChrome();
  bindInputs();
  configureGate();

  let allowed = false;
  try { allowed = await validOwnerAccess(); } catch { allowed = false; }
  if (allowed) {
    $("#ownerGate").classList.add("hidden");
    $("#ownerApp").classList.remove("hidden");
    renderAll();
    refreshOwnerIdentity();
  } else {
    renderInputs();
  }
})();
