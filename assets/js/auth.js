import { $, colorFor, initials, applyUIPrefs } from "./core.js";
import { t } from "./i18n.js";

const USERS_KEY = "wt.users";
const SESSION_KEY = "wt.session";
const SESSION_DAYS = 30;
const PBKDF2_ITER = 120000;

const enc = new TextEncoder();

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

async function hashPassword(password, saltHex) {
  if (!crypto.subtle) throw new Error("secure-context");
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unhex(saltHex), iterations: PBKDF2_ITER, hash: "SHA-256" },
    key,
    256
  );
  return hex(bits);
}

function readUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) || "{}") || {}; } catch { return {}; }
}
function writeUsers(users) {
  try { localStorage.setItem(USERS_KEY, JSON.stringify(users)); } catch {}
}

/* ---------- validation ---------- */
export function normalizeName(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim();
}

export function isRealName(raw) {
  const name = normalizeName(raw);
  if (name.length < 3 || name.length > 24) return false;
  if (!/^[\p{L}][\p{L} \u200c]*$/u.test(name)) return false;
  const letters = [...name].filter((ch) => /\p{L}/u.test(ch)).length;
  return letters >= 3;
}

export function isUsername(raw) {
  return /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/.test(String(raw || "").trim());
}

export const PASSWORD_MIN = 8;

export function passwordChecks(raw) {
  const s = String(raw || "");
  return {
    length: s.length >= PASSWORD_MIN,
    lower: /[a-z]/.test(s),
    upper: /[A-Z]/.test(s),
    digit: /[0-9۰-۹٠-٩]/.test(s),
    long: s.length >= 12
  };
}

export function passwordScore(raw) {
  const s = String(raw || "");
  if (!s) return 0;
  const c = passwordChecks(s);
  const n = [c.length, c.lower, c.upper, c.digit].filter(Boolean).length;
  if (n <= 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  return c.long ? 4 : 3;
}

export function isPassword(raw) {
  const c = passwordChecks(raw);
  return c.length && c.lower && c.upper && c.digit;
}

export function normalizeDigits(raw) {
  return String(raw || "")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[−–—]/g, "-")
    .trim();
}

/* ---------- session ---------- */
export function currentUser() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (!s || !s.u || !s.exp || Date.now() > s.exp) return null;
    const rec = readUsers()[s.u];
    if (!rec) return null;
    return {
      username: rec.u,
      nick: rec.nick,
      color: colorFor(rec.u),
      avatar: rec.profile?.avatar || "",
      city: rec.profile?.city || "",
      birthdate: rec.profile?.birthdate || "",
      bio: rec.profile?.bio || "",
      createdAt: rec.createdAt || null,
      friends: Array.isArray(rec.friends) ? [...rec.friends] : []
    };
  } catch { return null; }
}

export function getProfile(username) {
  const u = String(username || "").trim().toLowerCase();
  const rec = readUsers()[u];
  if (!rec) return null;
  return {
    username: rec.u,
    nick: rec.nick,
    color: colorFor(rec.u),
    avatar: rec.profile?.avatar || "",
    city: rec.profile?.city || "",
    birthdate: rec.profile?.birthdate || "",
    bio: rec.profile?.bio || "",
    createdAt: rec.createdAt || null,
    friends: Array.isArray(rec.friends) ? [...rec.friends] : [],
    hasPassword: !!rec.hash
  };
}

export function listLocalUsers() {
  return Object.values(readUsers()).map((rec) => ({
    username: rec.u,
    nick: rec.nick,
    color: colorFor(rec.u),
    avatar: rec.profile?.avatar || ""
  }));
}

function requireSessionUser() {
  const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  if (!s?.u) throw new Error("no-session");
  const users = readUsers();
  const rec = users[s.u];
  if (!rec) throw new Error("no-session");
  return { users, rec, key: s.u };
}

function cleanText(raw, max) {
  return String(raw || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function validBirthdate(raw) {
  const s = String(raw || "").trim();
  if (!s) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00`);
  if (!Number.isFinite(t)) return false;
  const year = Number(s.slice(0, 4));
  return year >= 1900 && t <= Date.now();
}

export function saveProfile({ nick, birthdate, city, bio }) {
  const { users, rec, key } = requireSessionUser();
  const cleanNick = normalizeName(nick);
  if (!isRealName(cleanNick)) return { ok: false, error: "name" };
  if (!validBirthdate(birthdate)) return { ok: false, error: "birthdate" };
  const profile = {
    ...(rec.profile || {}),
    birthdate: String(birthdate || "").trim(),
    city: cleanText(city, 40),
    bio: cleanText(bio, 160)
  };
  users[key] = { ...rec, nick: cleanNick, profile };
  writeUsers(users);
  return { ok: true, nick: cleanNick };
}

export async function changeUsername(raw) {
  const newU = String(raw || "").trim().toLowerCase();
  if (!isUsername(newU)) return { ok: false, error: "username" };
  let ctx;
  try { ctx = requireSessionUser(); } catch { return { ok: false, error: "session" }; }
  const { users, rec, key } = ctx;
  if (newU === key) return { ok: true, username: newU };
  if (users[newU]) return { ok: false, error: "exists" };
  users[newU] = { ...rec, u: newU };
  delete users[key];
  for (const other of Object.values(users)) {
    if (Array.isArray(other.friends)) {
      other.friends = other.friends.map((f) => (f === key ? newU : f));
    }
  }
  writeUsers(users);
  saveSession(newU);
  return { ok: true, username: newU };
}

export async function changePassword({ current, next }) {
  let ctx;
  try { ctx = requireSessionUser(); } catch { return { ok: false, error: "session" }; }
  const { users, rec, key } = ctx;
  let currentHash;
  try { currentHash = await hashPassword(String(current || ""), rec.salt); }
  catch { return { ok: false, error: "secure" }; }
  if (currentHash !== rec.hash) return { ok: false, error: "current" };
  if (!isPassword(next)) return { ok: false, error: "password" };
  const salt = randHex(16);
  let hashValue;
  try { hashValue = await hashPassword(next, salt); }
  catch { return { ok: false, error: "secure" }; }
  users[key] = { ...rec, salt, hash: hashValue, updatedAt: Date.now() };
  writeUsers(users);
  return { ok: true };
}

export function setAvatar(dataUrl) {
  const { users, rec, key } = requireSessionUser();
  const profile = { ...(rec.profile || {}) };
  const val = String(dataUrl || "");
  if (!val) delete profile.avatar;
  else if (!/^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(val)) return { ok: false, error: "image" };
  else profile.avatar = val;
  users[key] = { ...rec, profile };
  writeUsers(users);
  return { ok: true, avatar: profile.avatar || "" };
}

export function addFriend(raw) {
  const target = String(raw || "").trim().toLowerCase();
  if (!isUsername(target)) return { ok: false, error: "username" };
  const { users, rec, key } = requireSessionUser();
  if (target === key) return { ok: false, error: "self" };
  if (!users[target]) return { ok: false, error: "missing" };
  const friends = Array.isArray(rec.friends) ? [...rec.friends] : [];
  if (friends.includes(target)) return { ok: false, error: "exists" };
  friends.push(target);
  users[key] = { ...rec, friends };
  writeUsers(users);
  return { ok: true, friends };
}

export function removeFriend(raw) {
  const target = String(raw || "").trim().toLowerCase();
  const { users, rec, key } = requireSessionUser();
  const friends = (Array.isArray(rec.friends) ? rec.friends : []).filter((f) => f !== target);
  users[key] = { ...rec, friends };
  writeUsers(users);
  return { ok: true, friends };
}

export function requireAuth(nextPath) {
  if (currentUser()) return null;
  const next = nextPath || location.pathname.replace(/^\//, "") + location.search;
  location.replace(`auth.html?next=${encodeURIComponent(next)}`);
  return true;
}

export function logout() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

function saveSession(username) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ u: username, exp })); } catch {}
}

/* ---------- auth actions ---------- */
const THROTTLE_KEY = "wt.loginThrottle";
const MAX_TRIES = 5;
const LOCK_MS = 60000;

function readThrottle() {
  try { return JSON.parse(localStorage.getItem(THROTTLE_KEY) || "{}") || {}; } catch { return {}; }
}
function writeThrottle(map) {
  try { localStorage.setItem(THROTTLE_KEY, JSON.stringify(map)); } catch {}
}
function lockedFor(u) {
  const st = readThrottle()[u];
  const left = st?.until ? st.until - Date.now() : 0;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}
function noteFailure(u) {
  const map = readThrottle();
  const now = Date.now();
  const st = map[u] || { n: 0, until: 0 };
  if (st.until && st.until > now) return;
  st.n = (st.n || 0) + 1;
  if (st.n >= MAX_TRIES) { st.n = 0; st.until = now + LOCK_MS; }
  map[u] = st;
  writeThrottle(map);
}
function clearThrottle(u) {
  const map = readThrottle();
  if (!(u in map)) return;
  delete map[u];
  writeThrottle(map);
}

export async function register({ name, username, password }) {  const nick = normalizeName(name);
  const u = String(username || "").trim().toLowerCase();
  if (!isRealName(nick)) return { ok: false, error: "name" };
  if (!isUsername(u)) return { ok: false, error: "username" };
  if (!isPassword(password)) return { ok: false, error: "password" };
  const users = readUsers();
  if (users[u]) return { ok: false, error: "exists" };
  const salt = randHex(16);
  let hashValue;
  try { hashValue = await hashPassword(password, salt); }
  catch { return { ok: false, error: "secure" }; }
  users[u] = { u, nick, salt, hash: hashValue, createdAt: Date.now(), profile: {}, friends: [] };
  writeUsers(users);
  saveSession(u);
  return { ok: true, nick };
}

export async function login({ username, password }) {
  const u = String(username || "").trim().toLowerCase();
  const wait = lockedFor(u);
  if (wait) return { ok: false, error: "locked", wait };
  const rec = readUsers()[u];
  if (!rec) { noteFailure(u); return { ok: false, error: "credentials" }; }
  let hashValue;
  try { hashValue = await hashPassword(password, rec.salt); }
  catch { return { ok: false, error: "secure" }; }
  if (hashValue !== rec.hash) { noteFailure(u); return { ok: false, error: "credentials" }; }
  clearThrottle(u);
  saveSession(u);
  return { ok: true, nick: rec.nick };
}

export async function recover({ username, name, password }) {
  const u = String(username || "").trim().toLowerCase();
  const nick = normalizeName(name);
  const wait = lockedFor(u);
  if (wait) return { ok: false, error: "locked", wait };
  const users = readUsers();
  const rec = users[u];
  if (!rec || normalizeName(rec.nick) !== nick) { noteFailure(u); return { ok: false, error: "credentials" }; }
  if (!isPassword(password)) return { ok: false, error: "password" };
  const salt = randHex(16);
  let hashValue;
  try { hashValue = await hashPassword(password, salt); }
  catch { return { ok: false, error: "secure" }; }
  users[u] = { ...rec, salt, hash: hashValue, updatedAt: Date.now() };
  writeUsers(users);
  clearThrottle(u);
  saveSession(u);
  return { ok: true, nick: rec.nick };
}

/* ---------- captcha ---------- */
export function makeCaptcha() {
  const plus = Math.random() < 0.6;
  if (plus) {
    const a = 2 + Math.floor(Math.random() * 11);
    const b = 1 + Math.floor(Math.random() * 9);
    return { q: `${a} + ${b}`, a: a + b };
  }
  const b = 2 + Math.floor(Math.random() * 8);
  const a = b + 1 + Math.floor(Math.random() * 9);
  return { q: `${a} − ${b}`, a: a - b };
}

/* ---------- user chip ---------- */
export function mountUserChip() {
  const user = currentUser();
  const chip = $("#userChip");
  const links = $("#authActions");
  if (!chip) return;
  if (!user) {
    chip.classList.add("hidden");
    links?.classList.remove("hidden");
    return;
  }
  links?.classList.add("hidden");
  chip.classList.remove("hidden");
  const av = $("#userAvatar");
  if (av) {
    av.textContent = user.avatar ? "" : initials(user.nick);
    av.style.background = user.color;
    av.style.backgroundImage = user.avatar ? `url("${user.avatar}")` : "";
    if (user.avatar) { av.style.backgroundSize = "cover"; av.style.backgroundPosition = "center"; }
  }
  const nm = $("#userName");
  if (nm) nm.textContent = user.nick;
  $("#logoutBtn")?.addEventListener("click", () => {
    logout();
    location.replace("index.html");
  });
}

/* ---------- auth page ---------- */
export function initAuthPage() {
  const form = $("#authForm");
  if (!form) return;
  applyUIPrefs();

  let mode = new URLSearchParams(location.search).get("mode") === "login" ? "login" : "register";
  let captcha = makeCaptcha();
  let recCaptcha = makeCaptcha();
  let busy = false;
  let recovering = false;

  const nextRaw = new URLSearchParams(location.search).get("next") || "";
  const next = safeNext(nextRaw);

  const nameField = $("#nameField");
  const confirmField = $("#confirmField");
  const captchaField = $("#captchaField");
  const errLine = $("#authError");
  const submit = $("#submitBtn");
  const meter = $("#pwMeter");
  const pwLabel = $("#pwLabel");

  function renderPwMeter(pw) {
    const score = passwordScore(pw);
    if (meter) {
      meter.classList.toggle("hidden", !pw);
      meter.dataset.score = String(score);
      const fill = meter.firstElementChild;
      if (fill) fill.style.width = `${score * 25}%`;
    }
    if (pwLabel) pwLabel.textContent = pw ? t(`auth.pwLevel${Math.max(1, score)}`) : "";
  }
  $("#password")?.addEventListener("input", (e) => renderPwMeter(e.target.value));

  function drawCaptcha() {
    captcha = makeCaptcha();
    const q = $("#captchaQ");
    if (q) q.textContent = `${captcha.q} = ?`;
    const inp = $("#captchaA");
    if (inp) inp.value = "";
  }

  function drawRecCaptcha() {
    recCaptcha = makeCaptcha();
    const q = $("#recCaptchaQ");
    if (q) q.textContent = `${recCaptcha.q} = ?`;
    const inp = $("#recCaptchaA");
    if (inp) inp.value = "";
  }

  function setMode(m) {
    mode = m;
    const fa = document.documentElement.lang === "fa";
    $("#tabLogin")?.classList.toggle("active", m === "login");
    $("#tabRegister")?.classList.toggle("active", m === "register");
    nameField?.classList.toggle("hidden", m === "login");
    confirmField?.classList.toggle("hidden", m === "login");
    captchaField?.classList.toggle("hidden", m === "login");
    const title = $("#authTitle");
    const sub = $("#authSub");
    if (title) title.textContent = t(m === "login" ? "auth.loginTitle" : "auth.registerTitle");
    if (sub) sub.textContent = t(m === "login" ? "auth.loginSub" : "auth.registerSub");
    if (submit) submit.textContent = t(m === "login" ? "auth.login" : "auth.register");
    if (errLine) errLine.textContent = "";
    $("#forgotLink")?.classList.toggle("hidden", m !== "login");
    if (m === "register") drawCaptcha();
    $("#username")?.focus();
  }

  function showRecover(on) {
    recovering = on;
    $("#authForm")?.classList.toggle("hidden", on);
    $("#recoverForm")?.classList.toggle("hidden", !on);
    document.querySelector(".auth-tabs")?.classList.toggle("hidden", on);
    const title = $("#authTitle");
    const sub = $("#authSub");
    if (title) title.textContent = t(on ? "auth.recoverTitle" : mode === "login" ? "auth.loginTitle" : "auth.registerTitle");
    if (sub) sub.textContent = t(on ? "auth.recoverSub" : mode === "login" ? "auth.loginSub" : "auth.registerSub");
    if (on) {
      $("#recError").textContent = "";
      drawRecCaptcha();
      $("#recUsername")?.focus();
    }
  }

  $("#tabLogin")?.addEventListener("click", () => setMode("login"));
  $("#tabRegister")?.addEventListener("click", () => setMode("register"));
  $("#captchaRefresh")?.addEventListener("click", drawCaptcha);

  const user = currentUser();
  if (user && !new URLSearchParams(location.search).get("force")) {
    location.replace(next);
    return;
  }

  setMode(mode);
  document.addEventListener("langchange", () => { if (recovering) showRecover(true); else setMode(mode); });

  $("#forgotLink")?.addEventListener("click", () => showRecover(true));
  $("#recoverBack")?.addEventListener("click", () => { showRecover(false); setMode("login"); });
  $("#recCaptchaRefresh")?.addEventListener("click", drawRecCaptcha);

  $("#recoverForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const fa = document.documentElement.lang === "fa";
    const err = (m) => { const el = $("#recError"); if (el) el.textContent = m; };
    const username = $("#recUsername").value.trim();
    const name = $("#recName").value;
    const password = $("#recPassword").value;
    if (!username) return err(fa ? "نام کاربری را وارد کن." : "Enter your username.");
    if (!isRealName(name)) return err(fa ? "اسم واقعیِ ثبت‌شده را کامل بنویس." : "Enter the real name used at signup.");
    if (!isPassword(password)) return err(t("auth.pwWeak"));
    if (password !== $("#recPassword2").value) return err(fa ? "تکرار رمز یکسان نیست." : "Passwords do not match.");
    if (Number(normalizeDigits($("#recCaptchaA").value)) !== recCaptcha.a) {
      drawRecCaptcha();
      return err(fa ? "جواب کپچا درست نیست؛ دوباره تلاش کن." : "Captcha answer is wrong, try again.");
    }
    busy = true;
    const btn = $("#recSubmit");
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = fa ? "کمی صبر…" : "Please wait…";
    const res = await recover({ username, name, password });
    busy = false;
    btn.disabled = false;
    btn.textContent = old;
    if (!res.ok) {
      const map = {
        credentials: fa ? "این نام کاربری و اسم واقعی با هم هم‌خوانی ندارند." : "Username and real name do not match.",
        password: t("auth.pwWeak"),
        locked: t("auth.locked"),
        secure: fa ? "این مرورگر از رمزنگاری پشتیبانی نمی‌کند؛ سایت را با https باز کن." : "Browser crypto unavailable; use https."
      };
      return err(map[res.error] || "Error");
    }
    location.replace(next);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const fa = document.documentElement.lang === "fa";
    const err = (m) => { if (errLine) errLine.textContent = m; };

    const username = $("#username").value.trim();
    const password = $("#password").value;
    const name = $("#name")?.value || "";

    if (mode === "register") {
      if (!isRealName(name)) return err(fa ? "اسم واقعی را کامل بنویس (حداقل ۳ حرف، مثل علی یا Ali)." : "Enter your real name (at least 3 letters).");
      if (!isUsername(username)) return err(fa ? "نام کاربری باید ۳ تا ۲۰ کاراکتر لاتین باشد و با حرف شروع شود." : "Username must be 3–20 latin characters and start with a letter.");
      if (!isPassword(password)) return err(t("auth.pwWeak"));
      if (password !== $("#password2").value) return err(fa ? "تکرار رمز یکسان نیست." : "Passwords do not match.");
      if (Number(normalizeDigits($("#captchaA").value)) !== captcha.a) {
        drawCaptcha();
        return err(fa ? "جواب کپچا درست نیست؛ دوباره تلاش کن." : "Captcha answer is wrong, try again.");
      }
    } else {
      if (!username || !password) return err(fa ? "نام کاربری و رمز را وارد کن." : "Enter username and password.");
    }

    busy = true;
    submit.disabled = true;
    const old = submit.textContent;
    submit.textContent = fa ? "کمی صبر…" : "Please wait…";

    const res = mode === "register"
      ? await register({ name, username, password })
      : await login({ username, password });

    busy = false;
    submit.disabled = false;
    submit.textContent = old;

    if (!res.ok) {
      const map = {
        name: fa ? "اسم واقعی معتبر نیست." : "Invalid real name.",
        username: fa ? "نام کاربری معتبر نیست." : "Invalid username.",
        password: t("auth.pwWeak"),
        exists: fa ? "این نام کاربری قبلاً روی این مرورگر ساخته شده." : "This username already exists on this browser.",
        credentials: fa ? "نام کاربری یا رمز اشتباه است." : "Wrong username or password.",
        locked: t("auth.locked"),
        secure: fa ? "این مرورگر از رمزنگاری پشتیبانی نمی‌کند؛ سایت را با https باز کن." : "Browser crypto unavailable; use https."
      };
      return err(map[res.error] || "Error");
    }

    location.replace(next);
  });
}

function safeNext(raw) {
  let n = String(raw || "").trim();
  if (!n) return "./";
  if (/^https?:/i.test(n)) {
    try {
      const u = new URL(n);
      if (u.origin !== location.origin) return "./";
      n = u.pathname.replace(/^\//, "") + u.search;
    } catch { return "./"; }
  }
  if (n.startsWith("/")) n = n.slice(1);
  if (!/^[a-z0-9._-]+(\.html)?(\?.*)?$/i.test(n)) return "./";
  return n;
}
