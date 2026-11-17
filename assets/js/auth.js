import { $, colorFor, initials } from "./core.js";
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
  if (!/^[\p{L}][\p{L} ]*$/u.test(name)) return false;
  const letters = [...name].filter((ch) => /\p{L}/u.test(ch)).length;
  return letters >= 3;
}

export function isUsername(raw) {
  return /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/.test(String(raw || "").trim());
}

export function isPassword(raw) {
  return String(raw || "").length >= 6;
}

/* ---------- session ---------- */
export function currentUser() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (!s || !s.u || !s.exp || Date.now() > s.exp) return null;
    const rec = readUsers()[s.u];
    if (!rec) return null;
    return { username: rec.u, nick: rec.nick, color: colorFor(rec.u) };
  } catch { return null; }
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
export async function register({ name, username, password }) {
  const nick = normalizeName(name);
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
  users[u] = { u, nick, salt, hash: hashValue, createdAt: Date.now() };
  writeUsers(users);
  saveSession(u);
  return { ok: true, nick };
}

export async function login({ username, password }) {
  const u = String(username || "").trim().toLowerCase();
  const rec = readUsers()[u];
  if (!rec) return { ok: false, error: "credentials" };
  let hashValue;
  try { hashValue = await hashPassword(password, rec.salt); }
  catch { return { ok: false, error: "secure" }; }
  if (hashValue !== rec.hash) return { ok: false, error: "credentials" };
  saveSession(u);
  return { ok: true, nick: rec.nick };
}

/* ---------- captcha ---------- */
export function makeCaptcha() {
  const a = 2 + Math.floor(Math.random() * 11);
  const b = 1 + Math.floor(Math.random() * 9);
  const plus = Math.random() < 0.65;
  if (!plus && b > a) return { q: `${a} + ${b}`, a: a + b };
  return plus ? { q: `${a} + ${b}`, a: a + b } : { q: `${a} − ${b}`, a: a - b };
}

/* ---------- user chip ---------- */
export function mountUserChip() {
  const user = currentUser();
  const chip = $("#userChip");
  if (!chip) return;
  if (!user) { chip.classList.add("hidden"); return; }
  chip.classList.remove("hidden");
  const av = $("#userAvatar");
  if (av) { av.textContent = initials(user.nick); av.style.background = user.color; }
  const nm = $("#userName");
  if (nm) nm.textContent = user.nick;
  $("#logoutBtn")?.addEventListener("click", () => {
    logout();
    location.replace("auth.html");
  });
}

/* ---------- auth page ---------- */
export function initAuthPage() {
  const form = $("#authForm");
  if (!form) return;

  let mode = new URLSearchParams(location.search).get("mode") === "login" ? "login" : "register";
  let captcha = makeCaptcha();
  let busy = false;

  const nextRaw = new URLSearchParams(location.search).get("next") || "";
  const next = safeNext(nextRaw);

  const nameField = $("#nameField");
  const confirmField = $("#confirmField");
  const captchaField = $("#captchaField");
  const errLine = $("#authError");
  const submit = $("#submitBtn");

  function drawCaptcha() {
    captcha = makeCaptcha();
    const q = $("#captchaQ");
    if (q) q.textContent = `${captcha.q} = ?`;
    const inp = $("#captchaA");
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
    if (m === "register") drawCaptcha();
    $("#username")?.focus();
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
  document.addEventListener("langchange", () => setMode(mode));

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
      if (!isPassword(password)) return err(fa ? "رمز حداقل ۶ کاراکتر باشد." : "Password must be at least 6 characters.");
      if (password !== $("#password2").value) return err(fa ? "تکرار رمز یکسان نیست." : "Passwords do not match.");
      if (Number($("#captchaA").value) !== captcha.a) {
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
        password: fa ? "رمز کوتاه است." : "Password too short.",
        exists: fa ? "این نام کاربری قبلاً روی این مرورگر ساخته شده." : "This username already exists on this browser.",
        credentials: fa ? "نام کاربری یا رمز اشتباه است." : "Wrong username or password.",
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
