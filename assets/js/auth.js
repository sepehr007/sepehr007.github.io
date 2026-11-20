import { $, colorFor, initials, applyUIPrefs, toast } from "./core.js";
import { t } from "./i18n.js";
import { avatarId, avatarSrc, isAvatarId, presetValue } from "./avatars.js";
import { loadSiteConfig, applySiteConfig, accessOn, featureOn } from "./site-config.js";
import { buildFlagContext, recordFeatureUse } from "./feature-flags.js";
import { logModeration } from "./modlog.js";
import { apiFetch, apiGetToken, apiSetToken, apiClearToken, authApi } from "./api.js";
import { dbPut, dbDelete } from "./db.js";

const USERS_KEY = "wt.users";
const SESSION_KEY = "wt.session";
const API_USER_KEY = "wt.user";
const LOCAL_BANS_KEY = "wt.localBans";
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

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeRecoveryCode() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

function normalizeRecoveryCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function attachRecovery(rec, code) {
  const salt = randHex(16);
  return { ...rec, recSalt: salt, recHash: await hashPassword(normalizeRecoveryCode(code), salt) };
}

async function matchesRecovery(rec, code) {
  if (!rec?.recHash || !rec?.recSalt) return false;
  try {
    return (await hashPassword(normalizeRecoveryCode(code), rec.recSalt)) === rec.recHash;
  } catch {
    return false;
  }
}

function syncProfileToServer(patch) {
  if (!apiGetToken()) return;
  apiFetch("/auth/me", { method: "PATCH", body: patch, timeoutMs: 8000 }).catch(() => {});
}

function readUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) || "{}") || {}; } catch { return {}; }
}
function writeUsers(users) {
  try { localStorage.setItem(USERS_KEY, JSON.stringify(users)); } catch {}
  syncUsersToDb(users);
}
/* keep the accounts/profiles object stores in step with localStorage */
function syncUsersToDb(users) {
  for (const [username, rec] of Object.entries(users || {})) {
    if (!rec?.u) continue;
    dbPut("accounts", {
      username,
      nick: rec.nick || username,
      email: rec.email || "",
      createdAt: rec.createdAt || Date.now(),
      salt: rec.salt || "",
      hash: rec.hash || "",
      updatedAt: Date.now()
    }).catch(() => {});
    dbPut("profiles", {
      username,
      avatar: rec.profile?.avatar || "",
      city: rec.profile?.city || "",
      birthdate: rec.profile?.birthdate || "",
      bio: rec.profile?.bio || "",
      friends: Array.isArray(rec.friends) ? rec.friends : []
    }).catch(() => {});
  }
}
function readApiUser() {
  try {
    const u = JSON.parse(localStorage.getItem(API_USER_KEY) || "null");
    return u && typeof u === "object" && u.username ? u : null;
  } catch { return null; }
}
function writeApiUser(user) {
  if (!user?.username) return null;
  const prof = user.profile && typeof user.profile === "object" ? user.profile : {};
  const safe = {
    id: user.id || "",
    username: user.username,
    email: user.email || "",
    phone: user.phone || "",
    role: user.role || "user",
    avatar: prof.avatar || user.avatar || "",
    nick: user.nick || prof.nick || "",
    emailVerified: Boolean(user.emailVerified),
    createdAt: user.createdAt || null,
    profile: {
      nick: prof.nick || user.nick || "",
      birthdate: prof.birthdate || "",
      city: prof.city || "",
      bio: prof.bio || "",
      avatar: prof.avatar || user.avatar || ""
    }
  };
  try { localStorage.setItem(API_USER_KEY, JSON.stringify(safe)); } catch {}
  return safe;
}
function clearApiAuth() {
  apiClearToken();
  try { localStorage.removeItem(API_USER_KEY); } catch {}
}
function localKey(name) {
  return String(name || "").trim().toLowerCase();
}
function readLocalSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}
function emailLooksValid(raw) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(raw || "").trim());
}
function normalizePhone(raw) {
  let digits = normalizeDigits(String(raw || "")).replace(/\D/g, "");
  if (digits.startsWith("0098")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("98") && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (digits.length === 10 && digits.startsWith("9")) digits = `0${digits}`;
  return /^09\d{9}$/.test(digits) ? digits : "";
}
function maskPhoneClient(phone) {
  const p = String(phone || "");
  return /^09\d{9}$/.test(p) ? `${p.slice(0, 4)}***${p.slice(-4)}` : p;
}
function backendUnavailable(err) {
  if (!err) return true;
  if (err.status === 0 || err.status === 404 || err.status === 503) return true;
  return err.status >= 500;
}
async function mirrorApiAccount(apiUser, { password = "", nick = "", force = false } = {}) {
  const key = localKey(apiUser?.username);
  if (!key) return "";
  const users = readUsers();
  const existing = users[key];
  const session = readLocalSession();
  const sessionActive = Boolean(session?.u) && (!session.exp || Date.now() <= session.exp);
  if (!force && !existing && sessionActive && session.u !== key) return "";
  const serverProfile = apiUser?.profile && typeof apiUser.profile === "object" ? apiUser.profile : {};
  const serverNick = normalizeName(apiUser?.nick || serverProfile.nick || "");
  if (existing) {
    let changed = false;
    if (!existing.email && apiUser.email) { existing.email = apiUser.email; changed = true; }
    if (serverNick && normalizeName(existing.nick) !== serverNick) { existing.nick = serverNick; changed = true; }
    const merged = { ...(existing.profile || {}) };
    if (serverProfile.birthdate && merged.birthdate !== serverProfile.birthdate) { merged.birthdate = serverProfile.birthdate; changed = true; }
    if (serverProfile.city && merged.city !== serverProfile.city) { merged.city = serverProfile.city; changed = true; }
    if (serverProfile.bio && merged.bio !== serverProfile.bio) { merged.bio = serverProfile.bio; changed = true; }
    if (serverProfile.avatar && merged.avatar !== serverProfile.avatar) { merged.avatar = serverProfile.avatar; changed = true; }
    if (changed) existing.profile = merged;
    if (password) {
      try {
        const salt = randHex(16);
        existing.salt = salt;
        existing.hash = await hashPassword(password, salt);
        changed = true;
      } catch {}
    }
    if (changed) {
      users[key] = existing;
      writeUsers(users);
    }
    return key;
  }
  const salt = randHex(16);
  let hashValue = "";
  if (password) {
    try { hashValue = await hashPassword(password, salt); } catch { hashValue = ""; }
  }
  users[key] = {
    u: apiUser.username,
    nick: serverNick || normalizeName(nick) || apiUser.username,
    salt,
    hash: hashValue,
    email: apiUser.email || "",
    createdAt: Date.parse(apiUser.createdAt) || Date.now(),
    profile: {
      avatar: serverProfile.avatar || apiUser.avatar || "",
      birthdate: serverProfile.birthdate || "",
      city: serverProfile.city || "",
      bio: serverProfile.bio || ""
    },
    friends: []
  };
  writeUsers(users);
  return key;
}
function locallyBanned(username) {
  const u = String(username || "").toLowerCase();
  if (!u) return false;
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_BANS_KEY) || "[]");
    return Array.isArray(list) && list.map((x) => String(x).toLowerCase()).includes(u);
  } catch { return false; }
}

export function isLocallyBanned(username) {
  return locallyBanned(username);
}

/* ---------- validation ---------- */
export function normalizeName(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim();
}

export function isDisplayName(raw) {
  const name = normalizeName(raw);
  if (name.length < 3 || name.length > 24) return false;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _\-\u200c]*$/u.test(name)) return false;
  return /\p{L}/u.test(name);
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
function localSessionUser() {
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

function remoteUser() {
  if (!apiGetToken()) return null;
  const remote = readApiUser();
  if (!remote?.username) return null;
  const key = localKey(remote.username);
  const rec = readUsers()[key] || null;
  const created = rec?.createdAt || (remote.createdAt ? Date.parse(remote.createdAt) : 0);
  return {
    username: remote.username,
    nick: rec?.nick || remote.username,
    color: colorFor(remote.username),
    avatar: rec?.profile?.avatar || remote.avatar || "",
    city: rec?.profile?.city || "",
    birthdate: rec?.profile?.birthdate || "",
    bio: rec?.profile?.bio || "",
    createdAt: Number.isFinite(created) && created > 0 ? created : null,
    friends: Array.isArray(rec?.friends) ? [...rec.friends] : [],
    email: remote.email || rec?.email || "",
    phone: remote.phone || rec?.phone || "",
    role: remote.role || "user",
    emailVerified: Boolean(remote.emailVerified)
  };
}

export function currentUser() {
  return localSessionUser() || remoteUser();
}

export async function syncRemoteSession() {
  if (!apiGetToken()) return null;
  try {
    const res = await apiFetch("/auth/me", { timeoutMs: 8000 });
    const user = res?.user;
    if (!user?.username) return null;
    writeApiUser(user);
    const key = await mirrorApiAccount(user);
    if (key) saveSession(key);
    return user;
  } catch (err) {
    if (err?.status === 401) clearApiAuth();
    return null;
  }
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
    email: rec.email || "",
    phone: rec.phone || "",
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

export function saveProfile({ nick, birthdate, city, bio, phone }) {
  const { users, rec, key } = requireSessionUser();
  const cleanNick = normalizeName(nick);
  if (!isDisplayName(cleanNick)) return { ok: false, error: "name" };
  if (!validBirthdate(birthdate)) return { ok: false, error: "birthdate" };
  let nextPhone = rec.phone || "";
  if (phone !== undefined) {
    const raw = String(phone || "").trim();
    if (raw && !normalizePhone(raw)) return { ok: false, error: "phone" };
    nextPhone = raw ? normalizePhone(raw) : "";
  }
  const profile = {
    ...(rec.profile || {}),
    birthdate: String(birthdate || "").trim(),
    city: cleanText(city, 40),
    bio: cleanText(bio, 160)
  };
  users[key] = { ...rec, nick: cleanNick, phone: nextPhone, profile };
  writeUsers(users);
  syncProfileToServer({
    nick: cleanNick,
    phone: nextPhone,
    birthdate: profile.birthdate,
    city: profile.city,
    bio: profile.bio
  });
  return { ok: true, nick: cleanNick, phone: nextPhone };
}

export async function changeUsername(raw) {
  const newU = String(raw || "").trim().toLowerCase();
  if (!isUsername(newU)) return { ok: false, error: "username" };
  let ctx;
  try { ctx = requireSessionUser(); } catch { return { ok: false, error: "session" }; }
  const { users, rec, key } = ctx;
  if (newU === key) return { ok: true, username: newU };
  if (users[newU]) return { ok: false, error: "exists" };
  if (apiGetToken()) {
    try {
      await apiFetch("/auth/me", { method: "PATCH", body: { username: newU }, timeoutMs: 10000 });
    } catch (err) {
      if (!backendUnavailable(err)) {
        return { ok: false, error: err.status === 409 || err.payload?.error === "already_exists" ? "exists" : "username" };
      }
    }
  }
  users[newU] = { ...rec, u: newU };
  delete users[key];
  for (const other of Object.values(users)) {
    if (Array.isArray(other.friends)) {
      other.friends = other.friends.map((f) => (f === key ? newU : f));
    }
  }
  writeUsers(users);
  const apiUser = readApiUser();
  if (apiUser && localKey(apiUser.username) === key) writeApiUser({ ...apiUser, username: newU });
  saveSession(newU);
  return { ok: true, username: newU };
}

export async function changePassword({ current, next }) {
  let ctx;
  try { ctx = requireSessionUser(); } catch { return { ok: false, error: "session" }; }
  const { users, rec, key } = ctx;
  if (!isPassword(next)) return { ok: false, error: "password" };
  let currentHash;
  try { currentHash = await hashPassword(String(current || ""), rec.salt); }
  catch { return { ok: false, error: "secure" }; }
  const localOk = Boolean(rec.hash) && currentHash === rec.hash;
  let serverOk = false;
  if (apiGetToken()) {
    try {
      const res = await apiFetch("/auth/password", { method: "POST", body: { current, next }, timeoutMs: 12000 });
      if (res?.token) apiSetToken(res.token);
      serverOk = true;
    } catch (err) {
      if (!backendUnavailable(err)) {
        const code = err.payload?.error || "";
        return { ok: false, error: code === "wrong_password" ? "current" : code === "invalid_password" ? "password" : "server" };
      }
    }
  }
  if (!localOk && !serverOk) return { ok: false, error: "current" };
  const salt = randHex(16);
  let hashValue;
  try { hashValue = await hashPassword(next, salt); }
  catch { return { ok: false, error: "secure" }; }
  users[key] = { ...rec, salt, hash: hashValue, updatedAt: Date.now() };
  writeUsers(users);
  return { ok: true };
}

export function setAvatar(value) {
  const { users, rec, key } = requireSessionUser();
  const profile = { ...(rec.profile || {}) };
  const val = String(value || "");
  if (!val) delete profile.avatar;
  else if (isAvatarId(val)) profile.avatar = presetValue(avatarId(val));
  else if (val.length <= 500000 && /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(val)) profile.avatar = val;
  else if (val.length <= 500 && /^https?:\/\/[^\s"'<>]{3,400}\/api\/files\/[a-f0-9-]{8,64}$/i.test(val)) profile.avatar = val;
  else return { ok: false, error: "image" };
  users[key] = { ...rec, profile };
  writeUsers(users);
  syncProfileToServer({ avatar: profile.avatar || "" });
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
  const token = apiGetToken();
  const session = readLocalSession();
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  if (session?.u) dbDelete("sessions", session.u).catch(() => {});
  clearApiAuth();
  if (token) {
    apiFetch("/auth/logout", { method: "POST", token, auth: false, timeoutMs: 4000 }).catch(() => {});
  }
}

function saveSession(username) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ u: username, exp })); } catch {}
  dbPut("sessions", { username, exp, at: Date.now() }).catch(() => {});
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

export async function register({ username, email, phone, password }) {
  const u = String(username || "").trim().toLowerCase();
  const mail = String(email || "").trim().toLowerCase();
  const phoneRaw = String(phone || "").trim();
  const mobile = phoneRaw ? normalizePhone(phoneRaw) : "";
  if (locallyBanned(u)) {
    logModeration("loginFail", `تلاش ثبت‌نام حساب مسدود @${u}`);
    return { ok: false, error: "blocked" };
  }
  if (!isUsername(u)) return { ok: false, error: "username" };
  if (!emailLooksValid(mail)) return { ok: false, error: "email" };
  if (phoneRaw && !mobile) return { ok: false, error: "phone" };
  if (!isPassword(password)) return { ok: false, error: "password" };
  let apiErr = null;
  try {
    const res = await apiFetch("/auth/register", {
      method: "POST",
      auth: false,
      timeoutMs: 12000,
      body: { username: u, email: mail, phone: mobile, password }
    });
    if (res?.token && res.user) {
      apiSetToken(res.token);
      writeApiUser(res.user);
      const key = await mirrorApiAccount(res.user, { password, force: true });
      if (key) {
        saveSession(key);
        if (res.recoveryCode) {
          const users = readUsers();
          if (users[key]) {
            users[key] = await attachRecovery(users[key], res.recoveryCode);
            writeUsers(users);
          }
        }
      }
      clearThrottle(u);
      return {
        ok: true,
        nick: u,
        remote: true,
        recoveryCode: res.recoveryCode || "",
        verification: res.verification || null,
        verificationRequired: Boolean(res.verificationRequired)
      };
    }
  } catch (err) { apiErr = err; }
  if (apiErr && !backendUnavailable(apiErr)) {
    if (apiErr.status === 429) return { ok: false, error: "rate" };
    const code = apiErr.payload?.error || "";
    const map = { invalid_username: "username", invalid_email: "email", invalid_phone: "phone", invalid_password: "password", already_exists: "exists" };
    return { ok: false, error: map[code] || "server" };
  }
  const users = readUsers();
  if (users[u]) return { ok: false, error: "exists" };
  const salt = randHex(16);
  let hashValue;
  try { hashValue = await hashPassword(password, salt); }
  catch { return { ok: false, error: "secure" }; }
  const recoveryCode = makeRecoveryCode();
  let record = { u, nick: u, salt, hash: hashValue, email: mail, phone: mobile, createdAt: Date.now(), profile: {}, friends: [] };
  try { record = await attachRecovery(record, recoveryCode); }
  catch { return { ok: false, error: "secure" }; }
  users[u] = record;
  writeUsers(users);
  saveSession(u);
  return { ok: true, nick: u, recoveryCode };
}

export async function login({ username, password }) {
  const identifier = String(username || "").trim();
  const u = identifier.toLowerCase();
  if (locallyBanned(u)) {
    logModeration("loginFail", `ورود حساب مسدود @${u}`);
    return { ok: false, error: "blocked" };
  }
  const users = readUsers();
  const localLookup = users[u]
    ? u
    : Object.keys(users).find((key) => String(users[key]?.email || "").toLowerCase() === u) || "";
  const wait = lockedFor(u) || (localLookup ? lockedFor(localLookup) : 0);
  if (wait) {
    logModeration("loginLock", `قفل ورود @${u}`);
    return { ok: false, error: "locked", wait };
  }
  let apiErr = null;
  try {
    const res = await apiFetch("/auth/login", {
      method: "POST",
      auth: false,
      timeoutMs: 12000,
      body: { identifier, password }
    });
    if (res?.token && res.user) {
      apiSetToken(res.token);
      writeApiUser(res.user);
      const key = await mirrorApiAccount(res.user, { password, force: true });
      const localRec = key ? readUsers()[key] : null;
      saveSession(key || localKey(res.user.username));
      clearThrottle(u);
      if (key) clearThrottle(key);
      return { ok: true, nick: localRec?.nick || res.user.username, remote: true };
    }
  } catch (err) { apiErr = err; }
  if (apiErr?.status === 429) return { ok: false, error: "rate" };
  if (apiErr?.payload?.error === "email_not_verified") {
    return {
      ok: false,
      error: "verify",
      email: apiErr.payload.email || "",
      verification: apiErr.payload.verification || null
    };
  }
  const recKey = localLookup || u;
  const rec = users[recKey];
  if (!rec) { noteFailure(recKey); logModeration("loginFail", `نام کاربری ناشناس @${u}`); return { ok: false, error: "credentials" }; }
  let hashValue;
  try { hashValue = await hashPassword(password, rec.salt); }
  catch { return { ok: false, error: "secure" }; }
  if (!rec.hash || hashValue !== rec.hash) {
    noteFailure(recKey);
    logModeration("loginFail", `رمز اشتباه @${u}`);
    return { ok: false, error: "credentials" };
  }
  clearThrottle(u);
  if (recKey !== u) clearThrottle(recKey);
  saveSession(recKey);
  return { ok: true, nick: rec.nick };
}

export async function recover({ username, code, password }) {
  const identifier = String(username || "").trim();
  const u = identifier.toLowerCase();
  const recoveryCode = normalizeRecoveryCode(code);
  if (locallyBanned(u)) return { ok: false, error: "blocked" };
  const wait = lockedFor(u);
  if (wait) return { ok: false, error: "locked", wait };
  if (!identifier) return { ok: false, error: "credentials" };
  if (!isPassword(password)) return { ok: false, error: "password" };
  if (!recoveryCode) return { ok: false, error: "credentials" };

  if (recoveryCode) {
    let apiErr = null;
    try {
      const res = await authApi.recover({ identifier, code: recoveryCode, password });
      if (res?.token && res.user) {
        apiSetToken(res.token);
        writeApiUser(res.user);
        const key = await mirrorApiAccount(res.user, { password, force: true });
        if (key) {
          saveSession(key);
          const users = readUsers();
          if (users[key] && res.recoveryCode) {
            users[key] = await attachRecovery(users[key], res.recoveryCode);
            writeUsers(users);
          }
        }
        clearThrottle(u);
        return { ok: true, nick: res.user.nick || res.user.username, remote: true, recoveryCode: res.recoveryCode || "" };
      }
    } catch (err) { apiErr = err; }
    if (apiErr && !backendUnavailable(apiErr)) {
      if (apiErr.status === 429) return { ok: false, error: "rate" };
      if (apiErr.payload?.error === "invalid_password") return { ok: false, error: "password" };
      return { ok: false, error: "credentials" };
    }
  }

  const users = readUsers();
  const rec = users[u];
  if (!rec) { noteFailure(u); return { ok: false, error: "credentials" }; }
  const codeOk = await matchesRecovery(rec, recoveryCode);
  if (!codeOk) { noteFailure(u); return { ok: false, error: "credentials" }; }
  const salt = randHex(16);
  let hashValue;
  try { hashValue = await hashPassword(password, salt); }
  catch { return { ok: false, error: "secure" }; }
  const newCode = makeRecoveryCode();
  let record = { ...rec, salt, hash: hashValue, updatedAt: Date.now() };
  try { record = await attachRecovery(record, newCode); }
  catch { return { ok: false, error: "secure" }; }
  users[u] = record;
  writeUsers(users);
  clearThrottle(u);
  saveSession(u);
  return { ok: true, nick: rec.nick, recoveryCode: newCode };
}

export async function rotateRecoveryCode({ password } = {}) {
  let ctx;
  try { ctx = requireSessionUser(); } catch { return { ok: false, error: "session" }; }
  const { users, rec, key } = ctx;
  let hashValue;
  try { hashValue = await hashPassword(String(password || ""), rec.salt); }
  catch { return { ok: false, error: "secure" }; }
  const localOk = Boolean(rec.hash) && hashValue === rec.hash;
  if (apiGetToken()) {
    try {
      const res = await authApi.newRecoveryCode({ password });
      if (res?.recoveryCode) {
        users[key] = await attachRecovery(users[key], res.recoveryCode);
        writeUsers(users);
        return { ok: true, recoveryCode: res.recoveryCode };
      }
    } catch (err) {
      if (!backendUnavailable(err)) {
        const code = err.payload?.error || "";
        return { ok: false, error: code === "wrong_password" ? "current" : "server" };
      }
    }
  }
  if (!localOk) return { ok: false, error: "current" };
  const recoveryCode = makeRecoveryCode();
  try { users[key] = await attachRecovery(users[key], recoveryCode); }
  catch { return { ok: false, error: "secure" }; }
  writeUsers(users);
  return { ok: true, recoveryCode };
}

/* ---------- email verification & reset ---------- */
function mailError(err, fallback = "server") {
  if (backendUnavailable(err)) return "offline";
  if (err?.status === 429) return "rate";
  const code = err?.payload?.error || "";
  if (code === "invalid_email") return "email";
  if (code === "invalid_code") return "code";
  if (code === "code_expired" || code === "link_expired" || code === "invalid_link") return "expired";
  if (code === "invalid_password") return "password";
  if (code === "mail_failed") return "mail";
  if (code === "invalid_phone") return "phone";
  if (code === "sms_failed") return "sms";
  return fallback;
}

async function adoptResetSession(res, password) {
  apiSetToken(res.token);
  writeApiUser(res.user);
  const key = await mirrorApiAccount(res.user, { password, force: true });
  if (key) {
    saveSession(key);
    const users = readUsers();
    if (users[key] && res.recoveryCode) {
      users[key] = await attachRecovery(users[key], res.recoveryCode);
      writeUsers(users);
    }
  }
  return { ok: true, nick: res.user?.nick || res.user?.username || "", recoveryCode: res.recoveryCode || "" };
}

export async function verifyEmailCode(code, identifier = "") {
  const digits = String(code || "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) return { ok: false, error: "code" };
  try {
    const res = await authApi.confirmEmailCode({ code: digits, identifier: String(identifier || "").trim() });
    if (res?.user) {
      writeApiUser(res.user);
      const key = await mirrorApiAccount(res.user, { force: true });
      if (key) saveSession(key);
    }
    return { ok: true, user: res?.user || null, already: Boolean(res?.already) };
  } catch (err) {
    return { ok: false, error: mailError(err) };
  }
}

export async function resendVerificationEmail(identifier = "") {
  try {
    const res = await authApi.sendEmailCode({ identifier: String(identifier || "").trim() });
    return { ok: true, already: Boolean(res?.already), verification: res?.verification || null };
  } catch (err) {
    return { ok: false, error: mailError(err) };
  }
}

export async function verifyEmailWithLink(token) {
  const clean = String(token || "").trim();
  if (!clean) return { ok: false, error: "expired" };
  try {
    const res = await authApi.verifyEmailLink({ token: clean });
    if (res?.user) {
      writeApiUser(res.user);
      const key = await mirrorApiAccount(res.user, { force: true });
      if (key) saveSession(key);
    }
    return { ok: true, user: res?.user || null };
  } catch (err) {
    return { ok: false, error: mailError(err) };
  }
}

export async function requestPasswordCode({ email = "", phone = "" } = {}) {
  const channel = phone ? "sms" : "email";
  const mail = String(email || "").trim().toLowerCase();
  const mobile = channel === "sms" ? normalizePhone(phone) : "";
  if (channel === "sms" ? !mobile : !emailLooksValid(mail)) {
    return { ok: false, error: channel === "sms" ? "phone" : "email" };
  }
  try {
    const res = await authApi.forgotPassword(channel === "sms" ? { phone: mobile } : { email: mail });
    return {
      ok: true,
      channel,
      sent: res?.sent !== false,
      email: channel === "email" ? mail : "",
      phone: channel === "sms" ? mobile : "",
      maskedEmail: channel === "email" ? res?.email || "" : "",
      maskedPhone: channel === "sms" ? res?.phone || maskPhoneClient(mobile) : "",
      minutes: Number(res?.minutes || 0),
      cooldown: Boolean(res?.cooldown)
    };
  } catch (err) {
    return { ok: false, error: mailError(err) };
  }
}

export async function resetPasswordWithEmail({ email, code, password }) {
  const mail = String(email || "").trim().toLowerCase();
  const digits = String(code || "").replace(/\D/g, "");
  if (!emailLooksValid(mail)) return { ok: false, error: "email" };
  if (!/^\d{8}$/.test(digits)) return { ok: false, error: "code" };
  if (!isPassword(password)) return { ok: false, error: "password" };
  try {
    const res = await authApi.resetPassword({ email: mail, code: digits, password });
    return await adoptResetSession(res, password);
  } catch (err) {
    return { ok: false, error: mailError(err) };
  }
}

export async function resetPasswordWithPhone({ phone, code, password }) {
  const mobile = normalizePhone(phone);
  const digits = String(code || "").replace(/\D/g, "");
  if (!mobile) return { ok: false, error: "phone" };
  if (!/^\d{8}$/.test(digits)) return { ok: false, error: "code" };
  if (!isPassword(password)) return { ok: false, error: "password" };
  try {
    const res = await authApi.resetPassword({ phone: mobile, code: digits, password });
    return await adoptResetSession(res, password);
  } catch (err) {
    return { ok: false, error: mailError(err) };
  }
}

export async function resetPasswordWithLink({ token, password }) {
  if (!isPassword(password)) return { ok: false, error: "password" };
  try {
    const res = await authApi.resetPassword({ token: String(token || "").trim(), password });
    return await adoptResetSession(res, password);
  } catch (err) {
    return { ok: false, error: mailError(err) };
  }
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
    const src = avatarSrc(user.avatar);
    av.textContent = src ? "" : initials(user.nick);
    av.style.background = user.color;
    av.style.backgroundImage = src ? `url("${src}")` : "";
    if (src) { av.style.backgroundSize = "cover"; av.style.backgroundPosition = "center"; }
  }
  const nm = $("#userName");
  if (nm) nm.textContent = user.nick;
  $("#logoutBtn")?.addEventListener("click", () => {
    logout();
    location.replace("index.html");
  });
}

/* ---------- auth page ---------- */
export async function initAuthPage() {
  const form = $("#authForm");
  if (!form) return;
  applyUIPrefs();
  const cfg = await loadSiteConfig();
  applySiteConfig(cfg);

  let mode = new URLSearchParams(location.search).get("mode") === "login" ? "login" : "register";
  let captcha = makeCaptcha();
  let recCaptcha = makeCaptcha();
  let busy = false;
  let recovering = false;
  let lastRecoveryCode = "";
  let verifyEmail = "";
  let verifyIdentifier = "";
  let verifyDone = null;
  let resetToken = new URLSearchParams(location.search).get("reset") || "";
  let resetEmail = "";
  let resetPhone = "";
  let resetChannel = "email";
  let recoverChannel = "email";
  let recoverStep = "email";

  const nextRaw = new URLSearchParams(location.search).get("next") || "";
  const next = safeNext(nextRaw);

  const phoneField = $("#phoneField");
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

  let legacyCaptcha = makeCaptcha();
  function drawLegacyCaptcha() {
    legacyCaptcha = makeCaptcha();
    const q = $("#recLegacyCaptchaQ");
    if (q) q.textContent = `${legacyCaptcha.q} = ?`;
    const inp = $("#recLegacyCaptchaA");
    if (inp) inp.value = "";
  }

  const timers = new WeakMap();
  function stopCodeTimer(node) {
    if (!node) return;
    const id = timers.get(node);
    if (id) clearInterval(id);
    timers.delete(node);
    node.hidden = true;
    node.classList.remove("expired");
  }
  function startCodeTimer(node, minutes, onExpire) {
    if (!node) return;
    stopCodeTimer(node);
    const total = Math.max(1, Math.round(Number(minutes) || 0)) * 60000;
    const end = Date.now() + total;
    node.hidden = false;
    node.classList.remove("expired");
    const tick = () => {
      const left = Math.max(0, end - Date.now());
      if (!left) {
        clearInterval(timers.get(node));
        timers.delete(node);
        node.classList.add("expired");
        node.textContent = t("auth.codeExpired");
        onExpire?.();
        return;
      }
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      node.textContent = t("auth.codeValidFor", { time: `${m}:${String(s).padStart(2, "0")}` });
    };
    tick();
    timers.set(node, setInterval(tick, 1000));
  }

  function setMode(m) {
    mode = m;
    recovering = false;
    stopCodeTimer($("#verifyTimer"));
    stopCodeTimer($("#recTimer"));
    for (const id of ["verifyForm", "resetForm", "recoverForm", "recoveryReveal", "mailResult"]) {
      document.getElementById(id)?.classList.add("hidden");
    }
    form.classList.remove("hidden");
    const fa = document.documentElement.lang === "fa";
    $("#tabLogin")?.classList.toggle("active", m === "login");
    $("#tabRegister")?.classList.toggle("active", m === "register");
    phoneField?.classList.toggle("hidden", m === "login");
    confirmField?.classList.toggle("hidden", m === "login");
    captchaField?.classList.toggle("hidden", m === "login");
    $("#emailField")?.classList.toggle("hidden", m === "login");
    const idLabel = $("#usernameLabel");
    const idInput = $("#username");
    if (idLabel) idLabel.textContent = t(m === "login" ? "auth.identifier" : "auth.username");
    if (idInput) idInput.placeholder = t(m === "login" ? "auth.identifierPh" : "auth.usernamePh");
    const title = $("#authTitle");
    const sub = $("#authSub");
    if (title) title.textContent = t(m === "login" ? "auth.loginTitle" : "auth.registerTitle");
    if (sub) sub.textContent = t(m === "login" ? "auth.loginSub" : "auth.registerSub");
    if (submit) submit.textContent = t(m === "login" ? "auth.login" : "auth.register");
    if (errLine) errLine.textContent = "";
    $("#forgotLink")?.classList.toggle("hidden", m !== "login" || !featureOn("passwordReset", cfg));
    if (m === "register") drawCaptcha();
    $("#username")?.focus();
  }

  function showRecoveryPanel(code, done) {
    const box = $("#recoveryReveal");
    for (const id of ["authForm", "verifyForm", "resetForm", "recoverForm", "mailResult"]) {
      document.getElementById(id)?.classList.add("hidden");
    }
    stopCodeTimer($("#verifyTimer"));
    stopCodeTimer($("#recTimer"));
    document.querySelector(".auth-tabs")?.classList.add("hidden");
    if (!box) { (done || (() => location.replace(next)))(); return; }
    lastRecoveryCode = code;
    const codeNode = $("#rcCode");
    if (codeNode) codeNode.textContent = code;
    box.classList.remove("hidden");
    $("#authTitle").textContent = t("auth.recoveryTitle");
    $("#authSub").textContent = "";
    const copy = $("#rcCopy");
    if (copy) {
      copy.textContent = t("auth.recoveryCopy");
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(code); copy.textContent = t("auth.recoveryCopied"); }
        catch { copy.textContent = code; }
      };
    }
    const finish = $("#rcDone");
    if (finish) {
      finish.textContent = t("auth.recoveryContinue");
      finish.onclick = done || (() => location.replace(next));
    }
    $("#rcCode")?.scrollIntoView({ block: "center" });
  }

  function setRecoverChannel(channel) {
    recoverChannel = channel === "sms" ? "sms" : "email";
    for (const btn of document.querySelectorAll("#recChannelTabs button")) {
      btn.classList.toggle("active", btn.dataset.channel === recoverChannel);
    }
    $("#recEmailField")?.classList.toggle("hidden", recoverChannel === "sms");
    $("#recPhoneField")?.classList.toggle("hidden", recoverChannel !== "sms");
    const hint = $("#recSendHint");
    if (hint) hint.textContent = t(recoverChannel === "sms" ? "auth.forgotPhoneHint" : "auth.forgotEmailHint");
    const btn = $("#recSendCode");
    if (btn) btn.textContent = t(recoverChannel === "sms" ? "auth.sendCodeSms" : "auth.sendCodeEmail");
  }

  function showRecoverStep(step) {
    recoverStep = step;
    $("#recStep1")?.classList.toggle("hidden", step !== "email");
    $("#recStep2")?.classList.toggle("hidden", step !== "code");
    $("#recStepRecovery")?.classList.toggle("hidden", step !== "recovery");
    if (step === "code") {
      $("#recError").textContent = "";
      drawRecCaptcha();
      $("#recCode")?.focus();
    } else if (step === "recovery") {
      $("#recErrorLegacy").textContent = "";
      drawLegacyCaptcha();
      $("#recUsername")?.focus();
    } else {
      $("#recStep1Error").textContent = "";
      setRecoverChannel(recoverChannel);
      (recoverChannel === "sms" ? $("#recPhone") : $("#recEmail"))?.focus();
    }
  }

  function showVerify(email, done, { required = false, identifier = "", minutes = 0 } = {}) {
    recovering = false;
    verifyIdentifier = identifier;
    $("#verifyLater")?.classList.toggle("hidden", Boolean(required));
    for (const id of ["authForm", "recoverForm", "resetForm", "recoveryReveal", "mailResult"]) {
      document.getElementById(id)?.classList.add("hidden");
    }
    document.querySelector(".auth-tabs")?.classList.add("hidden");
    $("#verifyForm")?.classList.remove("hidden");
    verifyEmail = email || "";
    verifyDone = done || (() => location.replace(next));
    $("#authTitle").textContent = t("auth.verifyTitle");
    $("#authSub").textContent = t("auth.verifySub");
    const hint = $("#verifyHint");
    if (hint) hint.textContent = verifyEmail ? t("auth.codeSentTo", { email: verifyEmail }) : "";
    $("#verifyError").textContent = "";
    const inp = $("#verifyCode");
    if (inp) { inp.value = ""; inp.focus(); }
    if (minutes) startCodeTimer($("#verifyTimer"), minutes);
    else stopCodeTimer($("#verifyTimer"));
  }

  function showReset() {
    recovering = false;
    for (const id of ["authForm", "verifyForm", "recoverForm", "recoveryReveal", "mailResult"]) {
      document.getElementById(id)?.classList.add("hidden");
    }
    document.querySelector(".auth-tabs")?.classList.add("hidden");
    $("#resetForm")?.classList.remove("hidden");
    $("#authTitle").textContent = t("auth.resetLinkTitle");
    $("#authSub").textContent = t("auth.resetLinkSub");
    $("#resetError").textContent = "";
    const inp = $("#resetPassword");
    if (inp) { inp.value = ""; inp.focus(); }
    const again = $("#resetPassword2");
    if (again) again.value = "";
  }

  function showMailResult(message) {
    for (const id of ["authForm", "verifyForm", "resetForm", "recoverForm", "recoveryReveal"]) {
      document.getElementById(id)?.classList.add("hidden");
    }
    document.querySelector(".auth-tabs")?.classList.add("hidden");
    $("#mailResult")?.classList.remove("hidden");
    const text = $("#mailResultText");
    if (text) text.textContent = message;
    $("#authTitle").textContent = t("auth.verifyTitle");
    $("#authSub").textContent = "";
  }

  function openRecover() {
    if (!featureOn("passwordReset", cfg)) {
      toast(document.documentElement.lang === "fa" ? "بازیابی رمز غیرفعال شده است." : "Password recovery is disabled.", "error");
      return;
    }
    recovering = true;
    for (const id of ["authForm", "verifyForm", "resetForm", "recoveryReveal", "mailResult"]) {
      document.getElementById(id)?.classList.add("hidden");
    }
    $("#recoverForm")?.classList.remove("hidden");
    document.querySelector(".auth-tabs")?.classList.add("hidden");
    $("#authTitle").textContent = t("auth.recoverTitle");
    $("#authSub").textContent = t("auth.forgotSub");
    $("#recStep1Msg").textContent = "";
    $("#recSentHint").textContent = "";
    stopCodeTimer($("#recTimer"));
    resetChannel = "email";
    resetPhone = "";
    const loginId = $("#username")?.value.trim() || "";
    const mailInput = $("#recEmail");
    if (mailInput && emailLooksValid(loginId)) mailInput.value = loginId;
    setRecoverChannel("email");
    showRecoverStep("email");
  }

  function closeRecover() {
    recovering = false;
    setMode(mode);
  }

  function showRecover(on) {
    if (on) openRecover();
    else { closeRecover(); setMode("login"); }
  }

  function authFailMessage(error) {
    const fa = document.documentElement.lang === "fa";
    const map = {
      email: fa ? "ایمیل معتبر وارد کن." : "Enter a valid email.",
      phone: fa ? "شماره موبایل معتبر وارد کن؛ مثلاً 09121234567." : "Enter a valid mobile number, e.g. 09121234567.",
      sms: fa ? "ارسال پیامک ممکن نشد؛ چند لحظه بعد دوباره تلاش کن." : "The SMS could not be sent. Try again shortly.",
      code: fa ? "کد ۸ رقمی درست نیست." : "That 8-digit code is not correct.",
      expired: fa ? "این کد یا لینک منقضی شده؛ کد تازه بگیر." : "This code or link expired. Request a new one.",
      rate: fa ? "درخواست‌های زیادی فرستادی؛ کمی صبر کن." : "Too many attempts; wait a moment.",
      password: t("auth.pwWeak"),
      mail: fa ? "ارسال ایمیل ممکن نشد؛ چند لحظه بعد دوباره تلاش کن." : "The email could not be sent. Try again shortly.",
      offline: fa ? "این قابلیت به سرور سایت نیاز دارد و الان سرور در دسترس نیست؛ فعلاً با کد بازیابی وارد شو." : "This needs the site server, which is not reachable right now; use your recovery code for now.",
      server: fa ? "ارتباط با سرور برقرار نشد؛ دوباره تلاش کن." : "Could not reach the server; try again."
    };
    return map[error] || map.server;
  }

  function applyAccess() {
    const fa = document.documentElement.lang === "fa";
    const regOpen = accessOn("registration", cfg);
    const loginOpen = accessOn("login", cfg);
    const bothClosed = !regOpen && !loginOpen;
    $("#tabRegister")?.classList.toggle("hidden", !regOpen);
    $("#tabLogin")?.classList.toggle("hidden", !loginOpen);
    document.querySelector(".auth-tabs")?.classList.toggle("hidden", bothClosed);

    const notice = $("#authNotice");
    let msg = "";
    if (bothClosed) msg = fa ? "ثبت‌نام و ورود موقتاً توسط مدیر سایت بسته شده است." : "Sign-up and sign-in are temporarily closed by the site owner.";
    else if (!regOpen) msg = fa ? "ثبت‌نام حساب جدید موقتاً بسته است؛ اگر حساب داری وارد شو." : "New sign-ups are temporarily closed; sign in if you already have an account.";
    else if (!loginOpen) msg = fa ? "ورود با حساب موجود موقتاً بسته است؛ فقط ثبت‌نام باز است." : "Sign-in is temporarily closed; only new sign-ups are open.";
    if (notice) {
      notice.textContent = msg;
      notice.classList.toggle("hidden", !msg);
    }

    form.classList.toggle("is-closed", bothClosed);
    if (submit) submit.disabled = bothClosed;
    $("#forgotLink")?.classList.toggle("hidden", bothClosed || !loginOpen || mode !== "login" || !featureOn("passwordReset", cfg));

    if (bothClosed) return;
    if (mode === "register" && !regOpen) setMode("login");
    if (mode === "login" && !loginOpen) setMode("register");
  }

  $("#tabLogin")?.addEventListener("click", () => setMode("login"));
  $("#tabRegister")?.addEventListener("click", () => setMode("register"));
  $("#captchaRefresh")?.addEventListener("click", drawCaptcha);
  $("#forgotLink")?.addEventListener("click", () => showRecover(true));

  async function handleMailLinks() {
    const verifyToken = new URLSearchParams(location.search).get("verify");
    if (verifyToken) {
      const res = await verifyEmailWithLink(verifyToken);
      if (res.ok) {
        toast(t("auth.verifyDone"), "success");
        setTimeout(() => location.replace(next), 900);
      } else {
        showMailResult(res.error === "expired" ? t("auth.verifyLinkInvalid") : authFailMessage(res.error));
      }
      return true;
    }
    if (resetToken) {
      showReset();
      return true;
    }
    return false;
  }

  if (!(await handleMailLinks())) {
    await syncRemoteSession();
    const user = currentUser();
    if (user && !new URLSearchParams(location.search).get("force")) {
      location.replace(next);
      return;
    }

    if (mode === "register" && !accessOn("registration", cfg) && accessOn("login", cfg)) mode = "login";
    if (mode === "login" && !accessOn("login", cfg) && accessOn("registration", cfg)) mode = "register";
    setMode(mode);
    applyAccess();
  }

  document.addEventListener("langchange", () => {
    applySiteConfig(cfg);
    const reveal = $("#recoveryReveal");
    if (reveal && !reveal.classList.contains("hidden") && lastRecoveryCode) {
      showRecoveryPanel(lastRecoveryCode);
      return;
    }
    const verifyBox = $("#verifyForm");
    if (verifyEmail && verifyBox && !verifyBox.classList.contains("hidden")) {
      $("#authTitle").textContent = t("auth.verifyTitle");
      $("#authSub").textContent = t("auth.verifySub");
      const hint = $("#verifyHint");
      if (hint) hint.textContent = t("auth.codeSentTo", { email: verifyEmail });
      return;
    }
    const resetBox = $("#resetForm");
    if (resetBox && !resetBox.classList.contains("hidden")) {
      $("#authTitle").textContent = t("auth.resetLinkTitle");
      $("#authSub").textContent = t("auth.resetLinkSub");
      return;
    }
    if (recovering) {
      openRecover();
      showRecoverStep(recoverStep);
      return;
    }
    setMode(mode);
    applyAccess();
  });

  $("#recoverBack")?.addEventListener("click", () => { closeRecover(); setMode("login"); });
  $("#recoverBack2")?.addEventListener("click", () => { closeRecover(); setMode("login"); });
  $("#recoverBack3")?.addEventListener("click", () => { closeRecover(); setMode("login"); });
  $("#recCaptchaRefresh")?.addEventListener("click", drawRecCaptcha);
  $("#recLegacyCaptchaRefresh")?.addEventListener("click", drawLegacyCaptcha);
  for (const btn of document.querySelectorAll("#recChannelTabs button")) {
    btn.addEventListener("click", () => {
      if (recoverChannel === btn.dataset.channel) return;
      $("#recStep1Error").textContent = "";
      $("#recStep1Msg").textContent = "";
      setRecoverChannel(btn.dataset.channel);
      (btn.dataset.channel === "sms" ? $("#recPhone") : $("#recEmail"))?.focus();
    });
  }
  $("#recToRecovery")?.addEventListener("click", () => showRecoverStep("recovery"));
  $("#recToEmail")?.addEventListener("click", () => showRecoverStep("email"));
  $("#recEmailAgain")?.addEventListener("click", () => {
    stopCodeTimer($("#recTimer"));
    $("#recSentHint").textContent = "";
    showRecoverStep("email");
  });

  $("#resetNewCode")?.addEventListener("click", () => {
    resetToken = "";
    openRecover();
  });
  $("#resetToLogin")?.addEventListener("click", () => { resetToken = ""; setMode("login"); });

  async function sendResetCode() {
    const fa = document.documentElement.lang === "fa";
    const err = (m) => { $("#recStep1Error").textContent = m; };
    const info = (m) => { $("#recStep1Msg").textContent = m; };
    const smsChannel = recoverChannel === "sms";
    const raw = smsChannel ? $("#recPhone")?.value : $("#recEmail")?.value;
    const value = String(raw || "").trim();
    if (smsChannel ? !normalizePhone(value) : !emailLooksValid(value)) {
      return err(smsChannel
        ? (fa ? "شماره موبایل معتبر وارد کن؛ مثلاً 09121234567." : "Enter a valid mobile number, e.g. 09121234567.")
        : (fa ? "ایمیل معتبر وارد کن." : "Enter a valid email."));
    }
    err("");
    info("");
    const res = await requestPasswordCode(smsChannel ? { phone: value } : { email: value });
    if (!res.ok) return err(authFailMessage(res.error));
    resetChannel = res.channel;
    resetEmail = res.email || "";
    resetPhone = res.phone || "";
    const hint = $("#recSentHint");
    if (hint) {
      hint.textContent = resetChannel === "sms"
        ? t("auth.codeSentToPhone", { phone: res.maskedPhone || maskPhoneClient(resetPhone) })
        : t("auth.codeSentTo", { email: res.maskedEmail || resetEmail });
    }
    info(res.cooldown ? t("auth.codeCooldown") : t("auth.codeSentAgain"));
    showRecoverStep("code");
    startCodeTimer($("#recTimer"), res.minutes || 15);
  }

  $("#recSendCode")?.addEventListener("click", async () => {
    if (busy) return;
    const btn = $("#recSendCode");
    const fa = document.documentElement.lang === "fa";
    const old = btn.textContent;
    busy = true;
    btn.disabled = true;
    btn.textContent = fa ? "کمی صبر…" : "Please wait…";
    await sendResetCode();
    busy = false;
    btn.disabled = false;
    btn.textContent = old;
  });

  $("#recResend")?.addEventListener("click", async () => {
    if (busy || !(resetChannel === "sms" ? resetPhone : resetEmail)) return;
    busy = true;
    const res = await requestPasswordCode(resetChannel === "sms" ? { phone: resetPhone } : { email: resetEmail });
    busy = false;
    if (!res.ok) return toast(authFailMessage(res.error), "error");
    const hint = $("#recSentHint");
    if (hint) {
      hint.textContent = resetChannel === "sms"
        ? t("auth.codeSentToPhone", { phone: res.maskedPhone || maskPhoneClient(resetPhone) })
        : t("auth.codeSentTo", { email: res.maskedEmail || resetEmail });
    }
    startCodeTimer($("#recTimer"), res.minutes || 15);
    toast(res.cooldown ? t("auth.codeCooldown") : t("auth.codeSentAgain"), "success");
  });

  $("#verifyForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const fa = document.documentElement.lang === "fa";
    const err = (m) => { $("#verifyError").textContent = m; };
    const digits = ($("#verifyCode")?.value || "").replace(/\D/g, "");
    if (!/^\d{8}$/.test(digits)) return err(fa ? "کد باید ۸ رقم باشد." : "The code must be 8 digits.");
    const btn = $("#verifySubmit");
    const old = btn.textContent;
    busy = true;
    btn.disabled = true;
    btn.textContent = fa ? "کمی صبر…" : "Please wait…";
    const res = await verifyEmailCode(digits, verifyIdentifier);
    busy = false;
    btn.disabled = false;
    btn.textContent = old;
    if (!res.ok) return err(authFailMessage(res.error));
    stopCodeTimer($("#verifyTimer"));
    toast(t("auth.verifyDone"), "success");
    (verifyDone || (() => location.replace(next)))();
  });

  $("#verifyResend")?.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    const res = await resendVerificationEmail(verifyIdentifier);
    busy = false;
    if (!res.ok) return toast(authFailMessage(res.error), "error");
    if (res.already) {
      toast(t("auth.verifyDone"), "success");
      (verifyDone || (() => location.replace(next)))();
      return;
    }
    if (res.verification?.email) {
      verifyEmail = res.verification.email;
      const hint = $("#verifyHint");
      if (hint) hint.textContent = t("auth.codeSentTo", { email: verifyEmail });
    }
    startCodeTimer($("#verifyTimer"), res.verification?.minutes || 30);
    toast(t("auth.codeSentAgain"), "success");
  });

  $("#verifyLater")?.addEventListener("click", () => {
    (verifyDone || (() => location.replace(next)))();
  });

  $("#resetForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const fa = document.documentElement.lang === "fa";
    const err = (m) => { $("#resetError").textContent = m; };
    const password = $("#resetPassword")?.value || "";
    if (!isPassword(password)) return err(t("auth.pwWeak"));
    if (password !== $("#resetPassword2")?.value) return err(fa ? "تکرار رمز یکسان نیست." : "Passwords do not match.");
    const btn = $("#resetSubmit");
    const old = btn.textContent;
    busy = true;
    btn.disabled = true;
    btn.textContent = fa ? "کمی صبر…" : "Please wait…";
    const res = await resetPasswordWithLink({ token: resetToken, password });
    busy = false;
    btn.disabled = false;
    btn.textContent = old;
    if (!res.ok) {
      if (res.error === "expired") resetToken = "";
      return err(authFailMessage(res.error));
    }
    logModeration("recover", "بازیابی رمز با لینک ایمیل");
    resetToken = "";
    if (res.recoveryCode) return showRecoveryPanel(res.recoveryCode);
    location.replace(next);
  });

  $("#recoverForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const fa = document.documentElement.lang === "fa";
    if (!accessOn("login", cfg)) {
      const el = recoverStep === "recovery" ? $("#recErrorLegacy") : recoverStep === "email" ? $("#recStep1Error") : $("#recError");
      if (el) el.textContent = fa ? "بازیابی رمز موقتاً بسته است." : "Password recovery is temporarily closed.";
      return;
    }
    if (!featureOn("passwordReset", cfg)) {
      const el = recoverStep === "recovery" ? $("#recErrorLegacy") : recoverStep === "email" ? $("#recStep1Error") : $("#recError");
      if (el) el.textContent = fa ? "بازیابی رمز غیرفعال شده است." : "Password recovery is disabled.";
      return;
    }
    if (recoverStep === "email") return;

    if (recoverStep === "recovery") {
      const err = (m) => { $("#recErrorLegacy").textContent = m; };
      const username = $("#recUsername").value.trim();
      const code = $("#recRecoveryCode").value;
      const password = $("#recNewPassword").value;
      if (!username) return err(fa ? "نام کاربری را وارد کن." : "Enter your username.");
      if (!code.trim()) return err(fa ? "کد بازیابی را وارد کن." : "Enter your recovery code.");
      if (!isPassword(password)) return err(t("auth.pwWeak"));
      if (password !== $("#recNewPassword2").value) return err(fa ? "تکرار رمز یکسان نیست." : "Passwords do not match.");
      if (Number(normalizeDigits($("#recLegacyCaptchaA").value)) !== legacyCaptcha.a) {
        drawLegacyCaptcha();
        return err(fa ? "جواب کپچا درست نیست؛ دوباره تلاش کن." : "Captcha answer is wrong, try again.");
      }
      const btn = $("#recSubmitLegacy");
      const old = btn.textContent;
      busy = true;
      btn.disabled = true;
      btn.textContent = fa ? "کمی صبر…" : "Please wait…";
      const res = await recover({ username, code, password });
      busy = false;
      btn.disabled = false;
      btn.textContent = old;
      if (!res.ok) {
        const map = {
          credentials: fa ? "این نام کاربری و کد بازیابی با هم هم‌خوانی ندارند." : "Username and recovery code do not match.",
          password: t("auth.pwWeak"),
          locked: t("auth.locked"),
          blocked: fa ? "این حساب به‌دست مدیر سایت مسدود شده است." : "This account is blocked by the site owner.",
          secure: fa ? "این مرورگر از رمزنگاری پشتیبانی نمی‌کند؛ سایت را با https باز کن." : "Browser crypto unavailable; use https.",
          rate: fa ? "درخواست‌های زیادی فرستادی؛ کمی صبر کن." : "Too many attempts; wait a moment."
        };
        logModeration("recoverFail", `تلاش ناموفق بازیابی رمز @${username}`);
        return err(map[res.error] || "Error");
      }
      logModeration("recover", `بازیابی رمز @${String(username).trim().toLowerCase()}`);
      if (res.recoveryCode) return showRecoveryPanel(res.recoveryCode);
      location.replace(next);
      return;
    }

    const err = (m) => { $("#recError").textContent = m; };
    const code = ($("#recCode")?.value || "").replace(/\D/g, "");
    const password = $("#recPassword").value;
    const smsChannel = resetChannel === "sms";
    if (smsChannel ? !resetPhone : !resetEmail) {
      $("#recSentHint").textContent = "";
      return showRecoverStep("email");
    }
    if (!/^\d{8}$/.test(code)) return err(fa ? "کد باید ۸ رقم باشد." : "The code must be 8 digits.");
    if (!isPassword(password)) return err(t("auth.pwWeak"));
    if (password !== $("#recPassword2").value) return err(fa ? "تکرار رمز یکسان نیست." : "Passwords do not match.");
    if (Number(normalizeDigits($("#recCaptchaA").value)) !== recCaptcha.a) {
      drawRecCaptcha();
      return err(fa ? "جواب کپچا درست نیست؛ دوباره تلاش کن." : "Captcha answer is wrong, try again.");
    }
    const btn = $("#recSubmit");
    const old = btn.textContent;
    busy = true;
    btn.disabled = true;
    btn.textContent = fa ? "کمی صبر…" : "Please wait…";
    const res = smsChannel
      ? await resetPasswordWithPhone({ phone: resetPhone, code, password })
      : await resetPasswordWithEmail({ email: resetEmail, code, password });
    busy = false;
    btn.disabled = false;
    btn.textContent = old;
    if (!res.ok) return err(authFailMessage(res.error));
    logModeration("recover", `بازیابی رمز با کد ${smsChannel ? `پیامک ${resetPhone}` : `ایمیل ${resetEmail}`}`);
    if (res.recoveryCode) return showRecoveryPanel(res.recoveryCode);
    location.replace(next);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const fa = document.documentElement.lang === "fa";
    const err = (m) => { if (errLine) errLine.textContent = m; };
    if (mode === "register" && !accessOn("registration", cfg)) {
      return err(fa ? "ثبت‌نام موقتاً بسته است." : "Sign-up is temporarily closed.");
    }
    if (mode === "login" && !accessOn("login", cfg)) {
      return err(fa ? "ورود موقتاً بسته است." : "Sign-in is temporarily closed.");
    }

    const username = $("#username").value.trim();
    const password = $("#password").value;
    const email = $("#email")?.value.trim() || "";
    const phone = $("#phone")?.value.trim() || "";

    if (mode === "register") {
      if (!isUsername(username)) return err(fa ? "نام کاربری باید ۳ تا ۲۰ کاراکتر لاتین باشد و با حرف شروع شود." : "Username must be 3–20 latin characters and start with a letter.");
      if (!emailLooksValid(email)) return err(fa ? "ایمیل معتبر وارد کن." : "Enter a valid email.");
      if (phone && !normalizePhone(phone)) return err(fa ? "شماره موبایل معتبر وارد کن؛ مثلاً 09121234567." : "Enter a valid mobile number, e.g. 09121234567.");
      if (!isPassword(password)) return err(t("auth.pwWeak"));
      if (password !== $("#password2").value) return err(fa ? "تکرار رمز یکسان نیست." : "Passwords do not match.");
      if (Number(normalizeDigits($("#captchaA").value)) !== captcha.a) {
        drawCaptcha();
        return err(fa ? "جواب کپچا درست نیست؛ دوباره تلاش کن." : "Captcha answer is wrong, try again.");
      }
    } else {
      if (!username || !password) return err(fa ? "ایمیل یا نام کاربری و رمز را وارد کن." : "Enter your email or username and password.");
    }

    busy = true;
    submit.disabled = true;
    const old = submit.textContent;
    submit.textContent = fa ? "کمی صبر…" : "Please wait…";

    const res = mode === "register"
      ? await register({ username, email, phone, password })
      : await login({ username, password });

    busy = false;
    submit.disabled = false;
    submit.textContent = old;

    if (!res.ok) {
      const map = {
        username: fa ? "نام کاربری معتبر نیست." : "Invalid username.",
        email: fa ? "ایمیل معتبر وارد کن." : "Enter a valid email.",
        phone: fa ? "شماره موبایل معتبر وارد کن؛ مثلاً 09121234567." : "Enter a valid mobile number, e.g. 09121234567.",
        password: t("auth.pwWeak"),
        exists: fa ? "این ایمیل یا نام کاربری قبلاً ثبت شده است." : "This email or username is already registered.",
        credentials: fa ? "ایمیل یا نام کاربری، یا رمز اشتباه است." : "Wrong email/username or password.",
        locked: t("auth.locked"),
        blocked: fa ? "این حساب به‌دست مدیر سایت مسدود شده است." : "This account is blocked by the site owner.",
        rate: fa ? "درخواست‌های زیادی فرستادی؛ کمی صبر کن." : "Too many attempts; wait a moment.",
        server: fa ? "ارتباط با سرور برقرار نشد؛ دوباره تلاش کن." : "Could not reach the server; try again.",
        secure: fa ? "این مرورگر از رمزنگاری پشتیبانی نمی‌کند؛ سایت را با https باز کن." : "Browser crypto unavailable; use https."
      };
      if (res.error === "blocked") logModeration("loginFail", `ورود حساب مسدود @${username.trim().toLowerCase()}`);
      if (res.error === "verify") {
        logModeration("loginFail", `ورود با ایمیل تأییدنشده @${username.trim().toLowerCase()}`);
        toast(t("auth.emailNotVerified"), "info");
        return showVerify(res.email || username, () => location.replace(next), {
          required: true,
          identifier: username,
          minutes: res.verification?.minutes || 0
        });
      }
      return err(map[res.error] || "Error");
    }

    const u = username.trim().toLowerCase();
    logModeration(mode === "register" ? "register" : "login", `${mode === "register" ? "ساخت حساب" : "ورود"} @${u}`);
    recordFeatureUse(mode === "register" ? "account.registration" : "account.login", buildFlagContext({ user: currentUser() }));
    if (mode === "register" && res.recoveryCode) {
      const done = () => showRecoveryPanel(res.recoveryCode);
      if (res.verification?.sent || res.verificationRequired) {
        return showVerify(res.verification?.email || email, done, {
          required: Boolean(res.verificationRequired),
          identifier: email,
          minutes: res.verification?.minutes || 0
        });
      }
      return done();
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
