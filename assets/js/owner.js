import { $, $$, toast, store, applyUIPrefs, safeReload, onceAsync } from "./core.js";
import {
  SITE_CONFIG_DEFAULTS, normalizeSiteConfig, loadSiteConfig, getSiteConfig,
  ownerSessionValid, setOwnerSession, savePreviewDraft
} from "./site-config.js";
import { readModLog, logModeration, clearModLog } from "./modlog.js";
import { apiFetch } from "./api.js";

const DRAFT_KEY = "wt.ownerDraft";
const CRED_KEY = "wt.ownerCred";
const TOKEN_KEY = "wt.ownerToken";
const OWNER_JWT_KEY = "wt.ownerJwt";
const LOCK_KEY = "wt.ownerLock";
const BANS_KEY = "wt.localBans";
const USERS_KEY = "wt.users";
const CONFIG_PATH = "assets/data/site-config.json";
const PBKDF2_ITER = 210000;
const OWNER_SALT = "5e7a19c3b2d84f6011a9c7e3d5b8f204";
const OWNER_PASS_HASH = "12a4e7961abe05cf869f7a433b92a96aa1d087e3eee8d2ff9a7b7510b6f1906f";

applyUIPrefs();
document.documentElement.dataset.theme = "dark";

let published = null;
let draft = null;
let verifiedToken = "";
let saveTimer = 0;
let lockDeadline = 0;

const VIEW_META = {
  overview: ["نمای کلی", "وضعیت سایت، تنظیمات منتشرشده و پیش‌نویس محلی."],
  branding: ["هویت سایت", "نام، شعار، تم و رنگ‌های پیش‌فرض سراسری."],
  content: ["اطلاعیه و تعمیرات", "پیام سراسری و قفل موقت سایت."],
  access: ["دسترسی‌ها", "کنترل ثبت‌نام، ورود، ساخت و پیوستن به اتاق."],
  features: ["قابلیت‌ها", "روشن و خاموش کردن بخش‌های اصلی سایت."],
  limits: ["محدودیت‌ها", "ظرفیت اتاق و نرخ مجاز چت، آواتار و اکشن."],
  plans: ["پلن پریمیوم", "لینک پرداخت واقعی یا نمایش «به‌زودی»."],
  moderation: ["مدیریت محلی", "حساب‌های همین مرورگر و گزارش رخدادها."],
  security: ["امنیت مالک", "رمز محلی و توکن گیت‌هاب."],
  publish: ["انتشار تغییرات", "بازبینی، پیش‌نمایش و کامیت روی GitHub."]
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function randHex(n = 16) {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}
async function pbkdf2(pass, saltHex) {
  if (!crypto.subtle) throw new Error("secure");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unhex(saltHex), iterations: PBKDF2_ITER, hash: "SHA-256" },
    key,
    256
  );
  return hex(bits);
}
function sameHex(a = "", b = "") {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function checkOwnerPass(pass) {
  const hash = await pbkdf2(String(pass || ""), OWNER_SALT);
  return sameHex(hash, OWNER_PASS_HASH);
}
function readCred() {
  const c = store.get(CRED_KEY, null);
  return c && c.salt && c.hash ? c : null;
}
async function writeCred(pass, login) {
  const salt = randHex(16);
  const hash = await pbkdf2(pass, salt);
  store.set(CRED_KEY, { v: 1, salt, hash, login, createdAt: Date.now(), updatedAt: Date.now() });
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
  if (l.n >= 5) { l.n = 0; l.until = Date.now() + 2 * 60 * 1000; }
  store.set(LOCK_KEY, l);
}
function clearOwnerFailures() {
  store.del(LOCK_KEY);
  lockDeadline = 0;
}

/* ---------- github api ---------- */
function repoSlug() {
  return published?.owner?.repo || SITE_CONFIG_DEFAULTS.owner.repo;
}
function branchName() {
  return published?.owner?.branch || SITE_CONFIG_DEFAULTS.owner.branch || "main";
}
function ownerLogin() {
  return (published?.owner?.login || SITE_CONFIG_DEFAULTS.owner.login).toLowerCase();
}
async function gh(path, token, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.message || `GitHub ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function verifyOwnerToken(token) {
  const tok = String(token || "").trim();
  if (!tok) throw new Error("توکن خالی است.");
  const user = await gh("/user", tok);
  if (String(user?.login || "").toLowerCase() !== ownerLogin()) {
    throw new Error(`این توکن به حساب «${user?.login || "?"}» است، نه «${published?.owner?.login || SITE_CONFIG_DEFAULTS.owner.login}».`);
  }
  const repo = await gh(`/repos/${repoSlug()}`, tok);
  const canPush = repo?.permissions?.push === true || repo?.permissions?.admin === true || repo?.permissions?.maintain === true;
  let canReadContents = false;
  try {
    await gh(`/repos/${repoSlug()}/contents/${CONFIG_PATH}?ref=${encodeURIComponent(branchName())}`, tok);
    canReadContents = true;
  } catch (err) {
    if (err.status !== 404) throw err;
    canReadContents = true;
  }
  if (!canPush) throw new Error("این توکن دسترسی نوشتن (Contents: Read and write) به مخزن ندارد.");
  if (!canReadContents) throw new Error("خواندن فایل تنظیمات از مخزن ممکن نشد.");
  return tok;
}

function b64utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/* ---------- draft ---------- */
function loadDraft() {
  const saved = store.get(DRAFT_KEY, null);
  draft = saved && typeof saved === "object" ? normalizeSiteConfig(saved) : clone(published);
}
function saveDraft() {
  draft = normalizeSiteConfig(draft);
  store.set(DRAFT_KEY, draft);
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
  renderUsers();
  refreshOverview();
  renderLog();
  toast(banned ? "مسدودی محلی برداشته شد." : "این حساب روی همین مرورگر مسدود شد.", "success");
}
function deleteLocalUser(username) {
  const u = String(username || "").toLowerCase();
  const users = readUsers();
  if (!users[u]) return;
  if (!confirm(`حساب @${u} و رمز هش‌شدهٔ آن از این مرورگر حذف شود؟ این کار برگشت‌پذیر نیست.`)) return;
  delete users[u];
  store.set(USERS_KEY, users);
  writeBans(readBans().filter((x) => x !== u));
  logModeration("deleteAccount", `@${u}`);
  renderUsers();
  refreshOverview();
  renderLog();
  toast("حساب محلی حذف شد.", "success");
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
function showView(name) {
  if (!VIEW_META[name]) name = "overview";
  $$("[data-view]").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  $$("[data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  const [title, sub] = VIEW_META[name];
  $("#viewTitle").textContent = title;
  $("#viewSub").textContent = sub;
  $("#ownerSide")?.classList.remove("open");
  if (name === "moderation") { renderUsers(); renderLog(); }
  if (name === "publish") refreshDiff();
  if (name === "security") refreshTokenState();
}
function goto(name) {
  showView(name);
  $("#ownerSide")?.classList.remove("open");
}

/* ---------- gate ---------- */
function configureGate() {
  const login = ownerLogin();
  const repo = repoSlug();
  $("#ghLogin").value = login;
  $("#ghRepo").textContent = repo;
  $("#repoLink").href = `https://github.com/${repo}`;
  $("#actionsLink").href = `https://github.com/${repo}/actions`;
  const pubBranch = $("#pubBranch");
  if (pubBranch) pubBranch.textContent = branchName();
  const gateGithub = $("#gateTabGithub");
  if (gateGithub) { gateGithub.hidden = true; gateGithub.disabled = true; }
  $("#githubForm")?.classList.add("hidden");
  $("#loginHint").textContent = "رمز مالک را وارد کن؛ اتصال گیت‌هاب لازم نیست.";
  $("#ownerPass").disabled = false;
}
function setGateTab(which) {
  const login = which !== "github";
  $("#gateTabLogin").classList.toggle("active", login);
  $("#gateTabGithub").classList.toggle("active", !login);
  $("#loginForm").classList.toggle("hidden", !login);
  $("#githubForm").classList.toggle("hidden", login);
}
async function unlock() {
  setOwnerSession(true);
  $("#ownerGate").classList.add("hidden");
  $("#ownerApp").classList.remove("hidden");
  renderAll();
  try { history.replaceState(null, "", location.pathname); } catch {}
  logModeration("ownerLogin", "ورود موفق به کنسول");
}
async function storeOwnerToken(pass) {
  try {
    const res = await apiFetch("/auth/login", {
      method: "POST",
      auth: false,
      timeoutMs: 10000,
      body: { identifier: "owner@qoder.local", password: pass }
    });
    if (res?.token && (res.user?.role === "super_owner" || res.user?.role === "owner")) {
      try { sessionStorage.setItem(OWNER_JWT_KEY, res.token); } catch {}
      return true;
    }
  } catch {}
  return false;
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
  const pass = $("#ownerPass").value;
  if (!pass) { err.textContent = "رمز را وارد کن."; return; }
  const btn = $("#loginBtn");
  btn.disabled = true;
  btn.textContent = "در حال بررسی…";
  try {
    const ok = await checkOwnerPass(pass);
    if (!ok) {
      noteOwnerFailure();
      const l = readLock();
      err.textContent = l ? "پنج تلاش ناموفق؛ دو دقیقه قفل شد." : "رمز اشتباه است.";
      if (l) logModeration("loginLock", "قفل دو دقیقه‌ای کنسول");
      else logModeration("loginFail", "رمز مالک اشتباه");
      return;
    }
    clearOwnerFailures();
    $("#ownerPass").value = "";
    await storeOwnerToken(pass);
    await unlock();
  } catch {
    err.textContent = "رمزنگاری مرورگر در دسترس نیست؛ سایت را روی HTTPS باز کن.";
  } finally {
    btn.disabled = false;
    btn.textContent = "باز کردن کنسول";
  }
}
async function doGithubActivate(e) {
  e.preventDefault();
  const err = $("#githubErr");
  err.textContent = "اتصال گیت‌هاب غیرفعال شده است؛ فقط از رمز مالک استفاده کن.";
  return;
  const token = $("#ghToken").value.trim();
  const pass = $("#newOwnerPass").value;
  const pass2 = $("#newOwnerPass2").value;
  if (pass.length < 10) { err.textContent = "رمز محلی باید حداقل ۱۰ کاراکتر باشد."; return; }
  if (pass !== pass2) { err.textContent = "تکرار رمز یکسان نیست."; return; }
  if (!token) { err.textContent = "توکن گیت‌هاب را وارد کن."; return; }
  const btn = $("#githubBtn");
  btn.disabled = true;
  btn.textContent = "در حال بررسی با گیت‌هاب…";
  try {
    const tok = await verifyOwnerToken(token);
    await writeCred(pass, ownerLogin());
    verifiedToken = tok;
    try { sessionStorage.setItem(TOKEN_KEY, tok); } catch {}
    clearOwnerFailures();
    $("#ghToken").value = "";
    $("#newOwnerPass").value = "";
    $("#newOwnerPass2").value = "";
    logModeration("ownerLogin", "فعال‌سازی کنسول با توکن گیت‌هاب");
    await unlock();
    refreshTokenState();
    toast("کنسول مالک فعال شد.", "success");
  } catch (ex) {
    err.textContent = ex.message || "تأیید گیت‌هاب ناموفق بود.";
  } finally {
    btn.disabled = false;
    btn.textContent = "تأیید با گیت‌هاب و فعال‌سازی";
  }
}

/* ---------- security ---------- */
function refreshTokenState() {
  const node = $("#tokenState");
  if (!node) return;
  node.textContent = "اتصال توکن گیت‌هاب غیرفعال شده است.";
  node.className = "token-state";
}
async function changePass(e) {
  e.preventDefault();
  const err = $("#passErr");
  if (err) err.textContent = "رمز مالک در این نسخه ثابت است و تغییر نمی‌کند.";
  return;
  const cred = readCred();
  if (!cred) { err.textContent = "رمز محلی وجود ندارد."; return; }
  const cur = $("#curPass").value;
  const next = $("#nextPass").value;
  const next2 = $("#nextPass2").value;
  if (next.length < 10) { err.textContent = "رمز جدید حداقل ۱۰ کاراکتر باشد."; return; }
  if (next !== next2) { err.textContent = "تکرار رمز جدید یکسان نیست."; return; }
  try {
    const hash = await pbkdf2(cur, cred.salt);
    if (hash !== cred.hash) { err.textContent = "رمز فعلی اشتباه است."; return; }
    await writeCred(next, ownerLogin());
    $("#curPass").value = $("#nextPass").value = $("#nextPass2").value = "";
    logModeration("passChange", "رمز مالک عوض شد");
    toast("رمز مالک به‌روز شد.", "success");
  } catch {
    err.textContent = "تغییر رمز ممکن نشد.";
  }
}
async function verifySessionToken(e) {
  e.preventDefault();
  const stateNode = $("#tokenState");
  if (stateNode) { stateNode.textContent = "اتصال توکن گیت‌هاب غیرفعال شده است."; stateNode.className = "token-state"; }
  return;
  const input = $("#sessionToken");
  const token = input.value.trim();
  const node = $("#tokenState");
  if (!token) { node.textContent = "توکن خالی است."; node.className = "token-state bad"; return; }
  node.textContent = "در حال بررسی توکن…";
  node.className = "token-state busy";
  try {
    const tok = await verifyOwnerToken(token);
    verifiedToken = tok;
    sessionStorage.setItem(TOKEN_KEY, tok);
    node.textContent = "توکن معتبر است و برای انتشار آماده است.";
    node.className = "token-state ok";
    const pubInput = $("#publishToken");
    if (pubInput) pubInput.value = tok;
    toast("توکن تأیید شد.", "success");
  } catch (ex) {
    verifiedToken = "";
    try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
    node.textContent = ex.message || "توکن معتبر نیست.";
    node.className = "token-state bad";
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
    toast("فایل تنظیمات بارگذاری شد.", "success");
  } catch {
    toast("فایل JSON معتبر نیست.", "error");
  }
}
function resetDraft() {
  if (!confirm("همهٔ تغییرات محلی دور انداخته شود و نسخهٔ منتشرشده بازگردد؟")) return;
  draft = clone(published);
  store.set(DRAFT_KEY, draft);
  renderAll();
  toast("پیش‌نویس بازنشانی شد.");
}
function previewSite() {
  savePreviewDraft(draft);
  window.open("index.html?preview=1", "_blank");
  toast("پیش‌نمایش در تب تازه باز شد (فقط برای مالک).", "success");
}
function setPubState(text, cls = "") {
  const node = $("#pubState");
  if (!node) return;
  node.textContent = text;
  node.className = `pub-state ${cls}`.trim();
}
async function publishConfig(e) {
  e?.preventDefault();
  setPubState("انتشار خودکار با توکن گیت‌هاب غیرفعال است. تنظیمات را با دانلود JSON ذخیره کن.", "bad");
  return;
  const input = $("#publishToken");
  const token = (verifiedToken || input.value || "").trim();
  if (!token) {
    setPubState("برای انتشار، توکن گیت‌هاب را وارد کن.", "bad");
    goto("publish");
    return;
  }
  const btn = $("#publishBtn");
  btn.disabled = true;
  btn.textContent = "در حال انتشار…";
  setPubState("در حال تأیید توکن و ارسال به GitHub…", "busy");
  try {
    const tok = verifiedToken || await verifyOwnerToken(token);
    verifiedToken = tok;
    try { sessionStorage.setItem(TOKEN_KEY, tok); } catch {}
    const next = normalizeSiteConfig({ ...draft, updatedAt: new Date().toISOString() });
    let sha = "";
    try {
      const meta = await gh(`/repos/${repoSlug()}/contents/${CONFIG_PATH}?ref=${encodeURIComponent(branchName())}`, tok);
      sha = meta?.sha || "";
    } catch (ex) {
      if (ex.status !== 404) throw ex;
    }
    const body = {
      message: `Publish site config ${new Date().toISOString()}`,
      content: b64utf8(JSON.stringify(next, null, 2) + "\n"),
      branch: branchName()
    };
    if (sha) body.sha = sha;
    const res = await gh(`/repos/${repoSlug()}/contents/${CONFIG_PATH}`, tok, {
      method: "PUT",
      body: JSON.stringify(body)
    });
    draft = next;
    published = clone(next);
    store.set(DRAFT_KEY, draft);
    markDirty();
    logModeration("publish", `کامیت ${String(res?.commit?.sha || "").slice(0, 7)}`);
    setPubState(`منتشر شد. GitHub Pages در حال ساخت نسخهٔ تازه است…`, "ok");
    toast("تنظیمات با موفقیت کامیت شد.", "success");
    watchBuild(res?.commit?.sha || "", tok);
  } catch (ex) {
    setPubState(ex.message || "انتشار ناموفق بود.", "bad");
    toast(ex.message || "انتشار ناموفق بود.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "انتشار تغییرات";
  }
}
async function watchBuild(sha, token) {
  for (let i = 0; i < 12; i++) {
    await sleep(6000);
    try {
      const build = await gh(`/repos/${repoSlug()}/pages/builds/latest`, token);
      if (build?.status === "built") {
        if (!sha || String(build.commit || "").startsWith(sha.slice(0, 7)) || i >= 2) {
          setPubState(`ساخت Pages تمام شد (${new Date().toLocaleTimeString("fa-IR")}). سایت تازه منتشر شد.`, "ok");
          return;
        }
      }
      if (build?.status === "errored") {
        setPubState("کامیت انجام شد اما ساخت GitHub Pages خطا داد. Actions را بررسی کن.", "bad");
        return;
      }
      setPubState(`کامیت شد؛ GitHub Pages در حال ساخت است (${i + 1}/12)…`, "busy");
    } catch {
      setPubState("کامیت انجام شد. وضعیت ساخت از GitHub Actions قابل بررسی است.", "ok");
      return;
    }
  }
  setPubState("کامیت انجام شد؛ ساخت Pages هنوز در حال انجام است. چند دقیقه بعد سایت را ببین.", "ok");
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
    saveDraft();
  });
}
function bindChrome() {
  $("#gateTabLogin").addEventListener("click", () => setGateTab("login"));
  $("#gateTabGithub").addEventListener("click", () => setGateTab("github"));
  $("#loginForm").addEventListener("submit", onceAsync(doPasswordLogin));
  $("#githubForm").addEventListener("submit", doGithubActivate);

  $$("[data-nav]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.nav)));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.goto)));
  $("#menuBtn").addEventListener("click", () => $("#ownerSide").classList.toggle("open"));
  $("#lockBtn").addEventListener("click", () => {
    if (!confirm("کنسول قفل شود؟ برای ورود دوباره رمز مالک لازم است.")) return;
    setOwnerSession(false);
    try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
    try { sessionStorage.removeItem(OWNER_JWT_KEY); } catch {}
    verifiedToken = "";
    safeReload();
  });

  $("#passForm").addEventListener("submit", changePass);
  $("#tokenForm").addEventListener("submit", verifySessionToken);
  $("#publishForm").addEventListener("submit", publishConfig);
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

function renderAll() {
  configureGate();
  renderInputs();
  renderUsers();
  renderLog();
  refreshTokenState();
  markDirty();
  showView("overview");
}

(async function bootOwner() {
  try {
    published = clone(await loadSiteConfig());
  } catch {
    published = clone(SITE_CONFIG_DEFAULTS);
  }
  loadDraft();
  bindChrome();
  bindInputs();
  configureGate();

  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  verifiedToken = "";

  if (ownerSessionValid()) {
    $("#ownerGate").classList.add("hidden");
    $("#ownerApp").classList.remove("hidden");
    renderAll();
  } else {
    setGateTab("login");
    renderInputs();
    refreshTokenState();
  }
})();
