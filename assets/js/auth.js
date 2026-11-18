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
    role: user.role || "user",
    avatar: prof.avatar || user.avatar || "",
    nick: user.nick || prof.nick || "",
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
    role: remote.role || "user"
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
  syncProfileToServer({
    nick: cleanNick,
    birthdate: profile.birthdate,
    city: profile.city,
    bio: profile.bio
  });
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

export async function register({ name, username, email, password }) {
  const nick = normalizeName(name);
  const u = String(username || "").trim().toLowerCase();
  const mail = String(email || "").trim().toLowerCase();
  if (locallyBanned(u)) {
    logModeration("loginFail", `تلاش ثبت‌نام حساب مسدود @${u}`);
    return { ok: false, error: "blocked" };
  }
  if (!isRealName(nick)) return { ok: false, error: "name" };
  if (!isUsername(u)) return { ok: false, error: "username" };
  if (!emailLooksValid(mail)) return { ok: false, error: "email" };
  if (!isPassword(password)) return { ok: false, error: "password" };
  let apiErr = null;
  try {
    const res = await apiFetch("/auth/register", {
      method: "POST",
      auth: false,
      timeoutMs: 12000,
      body: { username: u, email: mail, password, nick }
    });
    if (res?.token && res.user) {
      apiSetToken(res.token);
      writeApiUser(res.user);
      const key = await mirrorApiAccount(res.user, { password, nick, force: true });
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
      return { ok: true, nick, remote: true, recoveryCode: res.recoveryCode || "" };
    }
  } catch (err) { apiErr = err; }
  if (apiErr && !backendUnavailable(apiErr)) {
    if (apiErr.status === 429) return { ok: false, error: "rate" };
    const code = apiErr.payload?.error || "";
    const map = { invalid_username: "username", invalid_email: "email", invalid_password: "password", already_exists: "exists" };
    return { ok: false, error: map[code] || "server" };
  }
  const users = readUsers();
  if (users[u]) return { ok: false, error: "exists" };
  const salt = randHex(16);
  let hashValue;
  try { hashValue = await hashPassword(password, salt); }
  catch { return { ok: false, error: "secure" }; }
  const recoveryCode = makeRecoveryCode();
  let record = { u, nick, salt, hash: hashValue, email: mail, createdAt: Date.now(), profile: {}, friends: [] };
  try { record = await attachRecovery(record, recoveryCode); }
  catch { return { ok: false, error: "secure" }; }
  users[u] = record;
  writeUsers(users);
  saveSession(u);
  return { ok: true, nick, recoveryCode };
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

export async function recover({ username, name, code, password }) {
  const identifier = String(username || "").trim();
  const u = identifier.toLowerCase();
  const nick = normalizeName(name);
  const recoveryCode = normalizeRecoveryCode(code);
  if (locallyBanned(u)) return { ok: false, error: "blocked" };
  const wait = lockedFor(u);
  if (wait) return { ok: false, error: "locked", wait };
  if (!identifier) return { ok: false, error: "credentials" };
  if (!isPassword(password)) return { ok: false, error: "password" };
  if (!recoveryCode && !isRealName(nick)) return { ok: false, error: "credentials" };

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
  const legacyOk = !rec.recHash && isRealName(nick) && normalizeName(rec.nick) === nick;
  const codeOk = recoveryCode ? await matchesRecovery(rec, recoveryCode) : false;
  if (!legacyOk && !codeOk) { noteFailure(u); return { ok: false, error: "credentials" }; }
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

  function showRecoveryPanel(code) {
    const box = $("#recoveryReveal");
    $("#authForm")?.classList.add("hidden");
    $("#recoverForm")?.classList.add("hidden");
    document.querySelector(".auth-tabs")?.classList.add("hidden");
    if (!box) { location.replace(next); return; }
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
    const done = $("#rcDone");
    if (done) {
      done.textContent = t("auth.recoveryContinue");
      done.onclick = () => location.replace(next);
    }
    $("#rcCode")?.scrollIntoView({ block: "center" });
  }

  function showRecover(on) {
    const resetOpen = featureOn("passwordReset", cfg);
    if (on && !resetOpen) {
      toast(document.documentElement.lang === "fa" ? "بازیابی رمز غیرفعال شده است." : "Password recovery is disabled.", "error");
      return;
    }
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
  document.addEventListener("langchange", () => {
    applySiteConfig(cfg);
    const reveal = $("#recoveryReveal");
    if (reveal && !reveal.classList.contains("hidden") && lastRecoveryCode) {
      showRecoveryPanel(lastRecoveryCode);
      return;
    }
    if (recovering) showRecover(true); else setMode(mode);
    applyAccess();
  });

  $("#forgotLink")?.addEventListener("click", () => showRecover(true));
  $("#recoverBack")?.addEventListener("click", () => { showRecover(false); setMode("login"); });
  $("#recCaptchaRefresh")?.addEventListener("click", drawRecCaptcha);

  $("#recoverForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const fa = document.documentElement.lang === "fa";
    const err = (m) => { const el = $("#recError"); if (el) el.textContent = m; };
    if (!accessOn("login", cfg)) return err(fa ? "بازیابی رمز موقتاً بسته است." : "Password recovery is temporarily closed.");
    if (!featureOn("passwordReset", cfg)) return err(fa ? "بازیابی رمز غیرفعال شده است." : "Password recovery is disabled.");
    const username = $("#recUsername").value.trim();
    const name = $("#recName").value;
    const code = $("#recCode")?.value || "";
    const password = $("#recPassword").value;
    if (!username) return err(fa ? "نام کاربری را وارد کن." : "Enter your username.");
    if (!code.trim() && !isRealName(name)) return err(fa ? "کد بازیابی را وارد کن؛ اگر حساب قدیمی داری، اسم واقعی‌ات را بنویس." : "Enter your recovery code, or the real name for older accounts.");
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
    const res = await recover({ username, name, code, password });
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
    const name = $("#name")?.value || "";
    const email = $("#email")?.value.trim() || "";

    if (mode === "register") {
      if (!isRealName(name)) return err(fa ? "اسم واقعی را کامل بنویس (حداقل ۳ حرف، مثل علی یا Ali)." : "Enter your real name (at least 3 letters).");
      if (!isUsername(username)) return err(fa ? "نام کاربری باید ۳ تا ۲۰ کاراکتر لاتین باشد و با حرف شروع شود." : "Username must be 3–20 latin characters and start with a letter.");
      if (!emailLooksValid(email)) return err(fa ? "ایمیل معتبر وارد کن." : "Enter a valid email.");
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
      ? await register({ name, username, email, password })
      : await login({ username, password });

    busy = false;
    submit.disabled = false;
    submit.textContent = old;

    if (!res.ok) {
      const map = {
        name: fa ? "اسم واقعی معتبر نیست." : "Invalid real name.",
        username: fa ? "نام کاربری معتبر نیست." : "Invalid username.",
        email: fa ? "ایمیل معتبر وارد کن." : "Enter a valid email.",
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
      return err(map[res.error] || "Error");
    }

    const u = username.trim().toLowerCase();
    logModeration(mode === "register" ? "register" : "login", `${mode === "register" ? "ساخت حساب" : "ورود"} @${u}`);
    recordFeatureUse(mode === "register" ? "account.registration" : "account.login", buildFlagContext({ user: currentUser() }));
    if (mode === "register" && res.recoveryCode) return showRecoveryPanel(res.recoveryCode);
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
