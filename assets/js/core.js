import { t } from "./i18n.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  del(key) { try { localStorage.removeItem(key); } catch {} }
};

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) node.append(c);
  }
  return node;
}

export function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const PALETTE = ["#3d6bff", "#f5b23e", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#a78bfa", "#fb7185"];
export function colorFor(seed = "") {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export function initials(name = "?") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(s).padStart(2, "0")}`;
}
export function fmtClock(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const toastQueue = [];
const TOAST_GAP = 1500;
let toastBusy = false;
export function toast(message, type = "info", ms = 3200) {
  const wrap = document.getElementById("toasts");
  if (!wrap) return;
  toastQueue.push({ message, type, ms });
  if (toastQueue.length > 6) toastQueue.splice(0, toastQueue.length - 6);
  drainToasts();
}
export function urgentToast(message, type = "error", ms = 6000) {
  const wrap = document.getElementById("toasts");
  if (!wrap) return;
  toastQueue.length = 0;
  wrap.querySelectorAll(".toast").forEach((node) => node.remove());
  toastBusy = true;
  const node = el("div", { class: `toast ${type === "info" ? "" : type}`, text: message });
  wrap.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(-6px)";
    setTimeout(() => node.remove(), 220);
    toastBusy = false;
  }, ms);
}

function drainToasts() {
  if (toastBusy || !toastQueue.length) return;
  const wrap = document.getElementById("toasts");
  if (!wrap) { toastQueue.length = 0; return; }
  const { message, type, ms } = toastQueue.shift();
  toastBusy = true;
  const node = el("div", { class: `toast ${type === "info" ? "" : type}`, text: message });
  wrap.append(node);
  while (wrap.children.length > 3) wrap.firstElementChild.remove();
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(-6px)";
    setTimeout(() => node.remove(), 220);
    toastBusy = false;
    setTimeout(drainToasts, TOAST_GAP);
  }, ms);
}

const RELOAD_KEY = "wt.reloadGuard";
const RELOAD_WINDOW = 30000;
const RELOAD_MAX = 3;
export function safeReload({ force = false } = {}) {
  if (force) { location.reload(); return true; }
  const now = Date.now();
  const hits = (store.get(RELOAD_KEY, []) || []).filter((t) => Number.isFinite(t) && now - t < RELOAD_WINDOW);
  if (hits.length >= RELOAD_MAX) {
    toast(t("toast.reloadBlocked"), "error");
    return false;
  }
  hits.push(now);
  store.set(RELOAD_KEY, hits);
  location.reload();
  return true;
}

export function confirmDialog({ title, text, okLabel } = {}) {
  return new Promise((resolve) => {
    const back = document.getElementById("modalBackdrop");
    const mTitle = document.getElementById("modalTitle");
    const mText = document.getElementById("modalText");
    const ok = document.getElementById("modalOk");
    const cancel = document.getElementById("modalCancel");
    if (!back) return resolve(false);
    mTitle.textContent = title || t("common.confirm");
    mText.textContent = text || "";
    ok.textContent = okLabel || t("common.ok");
    back.classList.remove("hidden");
    const done = (v) => {
      back.classList.add("hidden");
      ok.onclick = null; cancel.onclick = null; back.onclick = null;
      resolve(v);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    back.onclick = (e) => { if (e.target === back) done(false); };
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/* --- media URL policy: https only, direct media, block known adult domains --- */
const BLOCKED_HOSTS = [
  "pornhub.com", "xvideos.com", "xnxx.com", "redtube.com", "youporn.com",
  "xhamster.com", "spankbang.com", "eporner.com", "brazzers.com"
];
export function validateMediaUrl(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch { return { ok: false, reason: "invalid" }; }
  const devLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(devLocal && loopback && url.protocol === "http:")) {
    return { ok: false, reason: "invalid" };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (BLOCKED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { ok: false, reason: "blocked" };
  }
  return { ok: true, url: url.href };
}

/* ---------- personal appearance ---------- */
export const PREF_DEFAULTS = {
  theme: "dark",
  accent: "#6c5cff",
  accent2: "#ff4fd2",
  bgColor: "",
  textColor: "",
  brightness: 100,
  chatSize: 13.4,
  chatAlpha: 72,
  chatBright: 100,
  glass: 60,
  cineBright: 100,
  cineSize: 14,
  cineStayOpen: true
};

/* Accounts still carrying an earlier skin default move to the Nebula
   palette once; any other custom color is left alone. */
const PALETTE_VERSION = 4;
const LEGACY_ACCENTS = {
  "#d97742": "#6c5cff",
  "#a84924": "#5b4cf0",
  "#7fb6a0": "#ff4fd2",
  "#2e6b58": "#d9389f",
  "#7c5cff": "#6c5cff",
  "#22d3ee": "#ff4fd2",
  "#3d6bff": "#6c5cff",
  "#f5b23e": "#ff4fd2"
};

/* Appearance is per account: a theme chosen here must never leak into
   another account using the same browser. Guests get their own bucket. */
const LEGACY_PREFS_KEY = "wt.prefs";
function sessionUid() {
  const s = store.get("wt.session", null);
  return s && typeof s.u === "string" && s.u ? s.u : "";
}
export function prefsKey(uid = sessionUid()) {
  return uid ? `wt.prefs:${uid}` : "wt.prefs:guest";
}
function prevPrefsKey(uid = sessionUid()) {
  return uid ? `wt.prefs.prev:${uid}` : "wt.prefs.prev:guest";
}
function userThemesKey(uid = sessionUid()) {
  return uid ? `wt.themes:${uid}` : "wt.themes:guest";
}
export function hasPersonalTheme() {
  return !!store.get(prefsKey(), null);
}

export const THEME_PRESETS = [
  { id: "nebula", fa: "سحابی", en: "Nebula", theme: "dark", accent: "#6c5cff", accent2: "#ff4fd2" },
  { id: "aurora", fa: "شفق", en: "Aurora", theme: "dark", accent: "#3be8ff", accent2: "#3ef0a0" },
  { id: "sunset", fa: "غروب", en: "Sunset", theme: "dark", accent: "#ff6b4a", accent2: "#ffd84d" },
  { id: "emerald", fa: "زمرد", en: "Emerald", theme: "dark", accent: "#2fd88f", accent2: "#3be8ff" },
  { id: "neon", fa: "نئون", en: "Neon", theme: "dark", accent: "#ff3d8b", accent2: "#8a5cff" },
  { id: "frost", fa: "یخی", en: "Frost", theme: "light", accent: "#5b4cf0", accent2: "#d9389f" },
  { id: "blossom", fa: "شکوفه", en: "Blossom", theme: "light", accent: "#d9389f", accent2: "#ff7a45" }
];

export function normalizeHex(raw) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(raw || "").trim());
  return m ? `#${m[1].toLowerCase()}` : "";
}

function cleanTheme(theme) {
  return theme === "light" ? "light" : theme === "dark" ? "dark" : "";
}

export function listUserThemes() {
  const raw = store.get(userThemesKey(), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((t) => t && typeof t.id === "string" && normalizeHex(t.accent) && normalizeHex(t.accent2));
}

export function saveUserTheme(name) {
  const clean = String(name || "").trim().replace(/\s+/g, " ").slice(0, 24);
  if (clean.length < 2) return { ok: false, reason: "name" };
  const p = getPrefs();
  const list = listUserThemes();
  const existing = list.find((t) => t.name.toLowerCase() === clean.toLowerCase());
  const entry = {
    id: existing?.id || `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: clean,
    theme: cleanTheme(p.theme) || "dark",
    accent: p.accent,
    accent2: p.accent2,
    bgColor: normalizeHex(p.bgColor) || "",
    textColor: normalizeHex(p.textColor) || "",
    at: Date.now()
  };
  const next = [entry, ...list.filter((t) => t.id !== entry.id)].slice(0, 12);
  store.set(userThemesKey(), next);
  return { ok: true, theme: entry, replaced: !!existing };
}

export function deleteUserTheme(id) {
  const list = listUserThemes();
  const next = list.filter((t) => t.id !== id);
  store.set(userThemesKey(), next);
  return next.length !== list.length;
}

export function currentThemeId() {
  const p = getPrefs();
  const all = [...THEME_PRESETS, ...listUserThemes()];
  return all.find(
    (t) => (cleanTheme(t.theme) || "dark") === (cleanTheme(p.theme) || "dark") &&
      normalizeHex(t.accent) === normalizeHex(p.accent) &&
      normalizeHex(t.accent2) === normalizeHex(p.accent2) &&
      (normalizeHex(t.bgColor) || "") === (normalizeHex(p.bgColor) || "") &&
      (normalizeHex(t.textColor) || "") === (normalizeHex(p.textColor) || "")
  )?.id || "";
}

export function applyThemeById(id) {
  const preset = THEME_PRESETS.find((t) => t.id === id);
  const saved = preset || listUserThemes().find((t) => t.id === id);
  if (!saved) return null;
  return savePrefs({
    theme: cleanTheme(saved.theme) || "dark",
    accent: saved.accent,
    accent2: saved.accent2,
    bgColor: normalizeHex(saved.bgColor) || "",
    textColor: normalizeHex(saved.textColor) || ""
  });
}

export function hasPreviousTheme() {
  const prev = store.get(prevPrefsKey(), null);
  return !!(prev && normalizeHex(prev.accent) && normalizeHex(prev.accent2));
}

export function restorePreviousTheme() {
  const prev = store.get(prevPrefsKey(), null);
  if (!prev || !normalizeHex(prev.accent) || !normalizeHex(prev.accent2)) return null;
  const current = getPrefs();
  store.set(prevPrefsKey(), {
    theme: current.theme,
    accent: current.accent,
    accent2: current.accent2,
    bgColor: current.bgColor,
    textColor: current.textColor
  });
  const next = {
    ...current,
    theme: cleanTheme(prev.theme) || "dark",
    accent: normalizeHex(prev.accent),
    accent2: normalizeHex(prev.accent2),
    bgColor: normalizeHex(prev.bgColor) || "",
    textColor: normalizeHex(prev.textColor) || "",
    palette: PALETTE_VERSION
  };
  store.set(prefsKey(), next);
  applyUIPrefs(next);
  return next;
}


function hexToRgbTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

export function getPrefs() {
  const key = prefsKey();
  let saved = store.get(key, null);
  if (!saved) {
    /* one-time adoption of the old device-wide record for whoever is
       signed in now; every later account starts from the site defaults */
    const legacy = store.get(LEGACY_PREFS_KEY, null);
    if (legacy && typeof legacy === "object" && !store.get("wt.prefs.migrated", false)) {
      saved = legacy;
      store.set(key, { ...legacy });
      store.del(LEGACY_PREFS_KEY);
      store.set("wt.prefs.migrated", true);
    }
  }
  const merged = { ...PREF_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
  if (saved && saved.palette !== PALETTE_VERSION) {
    if (LEGACY_ACCENTS[merged.accent]) merged.accent = LEGACY_ACCENTS[merged.accent];
    if (LEGACY_ACCENTS[merged.accent2]) merged.accent2 = LEGACY_ACCENTS[merged.accent2];
  }
  return merged;
}

export function savePrefs(patch) {
  const clean = { ...patch };
  if (clean.accent) clean.accent = normalizeHex(clean.accent) || patch.accent;
  if (clean.accent2) clean.accent2 = normalizeHex(clean.accent2) || patch.accent2;
  if ("bgColor" in clean) clean.bgColor = clean.bgColor ? normalizeHex(clean.bgColor) || "" : "";
  if ("textColor" in clean) clean.textColor = clean.textColor ? normalizeHex(clean.textColor) || "" : "";
  const current = getPrefs();
  const next = { ...current, ...clean, palette: PALETTE_VERSION };
  const themeChanged = ["theme", "accent", "accent2", "bgColor", "textColor"].some(
    (k) => k in clean && clean[k] !== current[k]
  );
  if (themeChanged) {
    store.set(prevPrefsKey(), {
      theme: current.theme,
      accent: current.accent,
      accent2: current.accent2,
      bgColor: current.bgColor,
      textColor: current.textColor
    });
  }
  store.set(prefsKey(), next);
  applyUIPrefs(next);
  return next;
}

export function resetPrefs() {
  store.del(prefsKey());
  store.del(LEGACY_PREFS_KEY);
  applyUIPrefs(PREF_DEFAULTS);
  return { ...PREF_DEFAULTS };
}

function mixHex(a, b, t = 0.5) {
  const pa = /^#?([0-9a-f]{6})$/i.exec(String(a || "").trim());
  const pb = /^#?([0-9a-f]{6})$/i.exec(String(b || "").trim());
  if (!pa || !pb) return a;
  const na = parseInt(pa[1], 16);
  const nb = parseInt(pb[1], 16);
  const ch = (shift) => {
    const av = (na >> shift) & 255;
    const bv = (nb >> shift) & 255;
    return Math.round(av + (bv - av) * t).toString(16).padStart(2, "0");
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

export function applyUIPrefs(prefs = getPrefs()) {
  const theme = prefs.theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  const light = theme === "light";
  const accent = normalizeHex(prefs.accent) || (light ? "#5b4cf0" : "#6c5cff");
  const accent2 = normalizeHex(prefs.accent2) || (light ? "#d9389f" : "#ff4fd2");
  const bg = normalizeHex(prefs.bgColor) || (light ? "#f4f2ff" : "#0c0b1d");
  const text = normalizeHex(prefs.textColor) || (light ? "#17152e" : "#f1efff");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = bg;
  const root = document.documentElement.style;
  root.setProperty("--accent", accent);
  root.setProperty("--accent-2", accent2);
  root.setProperty("--accent-strong", mixHex(accent, "#000000", 0.2));
  const rgb1 = hexToRgbTriplet(accent);
  const rgb2 = hexToRgbTriplet(accent2);
  if (rgb1) root.setProperty("--brand-rgb", rgb1);
  if (rgb2) root.setProperty("--brand-2-rgb", rgb2);
  root.setProperty("--grad", `linear-gradient(135deg,${accent} 0%,${accent2} 100%)`);
  const panelBase = light ? "#ffffff" : text;
  root.setProperty("--bg", bg);
  root.setProperty("--bg-2", mixHex(bg, panelBase, light ? 0.03 : 0.025));
  root.setProperty("--panel", mixHex(bg, panelBase, light ? 0.72 : 0.065));
  root.setProperty("--panel-strong", light ? mixHex(bg, text, 0.04) : mixHex(bg, text, 0.12));
  root.setProperty("--border", mixHex(bg, text, light ? 0.12 : 0.16));
  root.setProperty("--border-strong", mixHex(bg, text, light ? 0.24 : 0.29));
  root.setProperty("--text", text);
  root.setProperty("--text-dim", mixHex(text, bg, light ? 0.3 : 0.35));
  root.setProperty("--text-faint", mixHex(text, bg, light ? 0.48 : 0.55));
  root.setProperty("--chat-size", `${prefs.chatSize}px`);
  root.setProperty("--chat-font-size", `${prefs.chatSize}px`);
  root.setProperty("--side-alpha", String(prefs.chatAlpha / 100));
  root.setProperty("--chat-bright", String(prefs.chatBright / 100));
  root.setProperty("--chat-text-brightness", String(prefs.chatBright / 100));
  const glass = Math.min(100, Math.max(0, Number(prefs.glass) || 0));
  root.setProperty("--glass-blur", `${Math.round(4 + glass * 0.22)}px`);
  root.setProperty("--glass-alpha", (0.94 - glass * 0.0032).toFixed(2));
  root.setProperty("--glass", String(glass));
  const cineBright = Math.min(160, Math.max(40, Number(prefs.cineBright) || 100));
  const cineSize = Math.min(22, Math.max(10, Number(prefs.cineSize) || 14));
  root.setProperty("--cine-bright", (cineBright / 100).toFixed(2));
  root.setProperty("--cine-size", `${cineSize}px`);
  root.setProperty("--cine-alpha", (0.3 + 0.42 * (cineBright / 100)).toFixed(2));
  const video = document.getElementById("video");
  if (video) video.style.filter = prefs.brightness === 100 ? "" : `brightness(${prefs.brightness / 100})`;
  saveBootSnapshot();
}

export function saveBootSnapshot() {
  try {
    const d = document.documentElement;
    const vars = {};
    for (const name of d.style) if (name.startsWith("--")) vars[name] = d.style.getPropertyValue(name).trim();
    const meta = document.querySelector('meta[name="theme-color"]')?.content || "";
    localStorage.setItem("wt.boot", JSON.stringify({ theme: d.dataset.theme === "light" ? "light" : "dark", vars, meta }));
  } catch {}
}

export function lightenHex(hex, amount = 0.35) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0");
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

export const ACCENTS = [
  { a: "#6c5cff", b: "#ff4fd2" },
  { a: "#3be8ff", b: "#3ef0a0" },
  { a: "#ff6b4a", b: "#ffd84d" },
  { a: "#2fd88f", b: "#3be8ff" },
  { a: "#ff3d8b", b: "#8a5cff" },
  { a: "#5b4cf0", b: "#d9389f" }
];

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";export function makeCode(len = 6) {
  let out = "";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out;
}
export function uid() {
  return Math.random().toString(36).slice(2, 10);
}
export function debounce(fn, ms = 300) {
  let id;
  return (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), ms); };
}

/* small client-side rate limiter for chat spam */
export function createLimiter(max, windowMs) {
  const hits = [];
  return () => {
    const now = Date.now();
    while (hits.length && now - hits[0] > windowMs) hits.shift();
    if (hits.length >= max) return false;
    hits.push(now);
    return true;
  };
}

/* rate guard with retry information for locking pickers and repeat actions */
export class RateGuard {
  constructor(max = 3, windowMs = 5000) {
    this.max = Math.max(1, Number(max) || 1);
    this.windowMs = Math.max(1, Number(windowMs) || 1);
    this.hits = [];
  }
  #prune(now) {
    while (this.hits.length && now - this.hits[0] >= this.windowMs) this.hits.shift();
  }
  remaining(now = Date.now()) {
    this.#prune(now);
    if (this.hits.length < this.max) return 0;
    return Math.max(0, this.windowMs - (now - this.hits[0]));
  }
  take(now = Date.now()) {
    const retryIn = this.remaining(now);
    if (retryIn > 0) return { ok: false, retryIn };
    this.hits.push(now);
    return { ok: true, retryIn: 0 };
  }
  reset() { this.hits = []; }
}

export function onceAsync(fn) {
  let running = false;
  return async (...args) => {
    if (running) return;
    running = true;
    try { return await fn(...args); } finally { running = false; }
  };
}

export function highlightMentions(text, nick) {
  const safe = escapeHtml(text);
  const mention = escapeHtml("@" + nick);
  return safe.split(mention).join(`<span class="mention">${mention}</span>`);
}

/* custom pull-to-refresh that also works on the fixed room layout */
let ptrWired = false;
function wirePullToRefresh() {
  if (ptrWired || typeof document === "undefined") return;
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  ptrWired = true;

  const box = document.createElement("div");
  box.className = "ptr";
  box.setAttribute("aria-hidden", "true");
  box.innerHTML = '<span class="ptr-spinner"></span><span class="ptr-label"></span>';
  document.body.append(box);
  const label = box.querySelector(".ptr-label");
  const fa = () => document.documentElement.lang === "fa";
  const THRESHOLD = 76;
  const state = { startY: 0, startX: 0, tracking: false, pulling: false, pull: 0, ready: false, busy: false };

  const atTop = (target) => {
    for (let n = target instanceof Element ? target : null; n && n !== document.body; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 2) return n.scrollTop <= 0;
    }
    return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
  };
  const blocked = (target) => !!target?.closest?.(
    "input, textarea, select, [contenteditable='true'], .sheet-grip, .ptr, .modal-backdrop, [data-no-ptr]"
  );
  const paint = (pull) => {
    state.pull = pull;
    const p = Math.min(1, pull / THRESHOLD);
    box.style.setProperty("--ptr-y", `${Math.round(pull)}px`);
    box.style.setProperty("--ptr-rot", `${Math.round(p * 280)}deg`);
    const ready = pull >= THRESHOLD;
    if (ready !== state.ready) {
      state.ready = ready;
      box.classList.toggle("ready", ready);
      label.textContent = ready ? (fa() ? "رها کن" : "Release") : (fa() ? "برای به‌روزرسانی بکش" : "Pull to refresh");
      if (ready && navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
    }
  };
  const refresh = async () => {
    state.busy = true;
    state.pulling = false;
    box.classList.add("loading");
    box.style.setProperty("--ptr-y", "58px");
    label.textContent = fa() ? "به‌روزرسانی…" : "Refreshing…";
    try {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg) await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 700))]);
    } catch {}
    setTimeout(() => safeReload(), 240);
  };

  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || state.busy) return;
    const t = e.target;
    if (blocked(t) || !atTop(t)) return;
    state.startX = e.touches[0].clientX;
    state.startY = e.touches[0].clientY;
    state.tracking = true;
    state.pulling = false;
    state.ready = false;
    state.pull = 0;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!state.tracking || e.touches.length !== 1 || state.busy) return;
    const dy = e.touches[0].clientY - state.startY;
    const dx = e.touches[0].clientX - state.startX;
    if (!state.pulling) {
      if (dy < 6) {
        if (dy < -8 || Math.abs(dx) > 14) state.tracking = false;
        return;
      }
      if (Math.abs(dx) > dy * 0.9) { state.tracking = false; return; }
      if (!atTop(e.target)) { state.tracking = false; return; }
      state.pulling = true;
      document.body.classList.add("ptr-active");
      label.textContent = fa() ? "برای به‌روزرسانی بکش" : "Pull to refresh";
    }
    if (e.cancelable) e.preventDefault();
    paint(Math.min(118, Math.max(0, dy) * 0.72));
  }, { passive: false });

  const end = () => {
    if (!state.tracking || state.busy) return;
    const should = state.ready && state.pull >= THRESHOLD;
    state.tracking = false;
    if (state.pulling && should) return refresh();
    if (state.pulling) {
      document.body.classList.remove("ptr-active");
      state.pulling = false;
      state.ready = false;
      box.classList.remove("ready");
      box.style.setProperty("--ptr-y", "0px");
    }
  };
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", end, { passive: true });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wirePullToRefresh, { once: true });
  else wirePullToRefresh();
}

let installWired = false;
export function wireInstallPrompt() {
  if (installWired || typeof window === "undefined") return;
  installWired = true;
  let deferred = null;
  let chip = null;

  const ensureChip = () => {
    if (chip) return chip;
    chip = el("button", { class: "install-chip", id: "installApp", type: "button" });
    chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';
    const label = el("span", { "data-i18n": "pwa.install", text: t("pwa.install") });
    chip.append(label);
    chip.addEventListener("click", async () => {
      if (!deferred) return;
      const evt = deferred;
      deferred = null;
      try { evt.prompt(); } catch {}
      const choice = await evt.userChoice?.catch?.(() => null);
      if (choice?.outcome === "accepted") {
        chip.classList.add("hidden");
        toast(t("pwa.installed"), "success");
      }
    });
    document.body.append(chip);
    return chip;
  };

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    ensureChip().classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    chip?.classList.add("hidden");
  });
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  if (!local && location.protocol !== "https:") return;
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
      reg.update().catch(() => {});
      const ensureUpdateChip = (worker) => {
        let chip = document.getElementById("updateChip");
        if (!chip) {
          chip = el("div", { class: "update-chip", id: "updateChip" });
          const text = el("span", { class: "uc-text", text: t("update.ready") });
          const apply = el("button", { class: "btn btn-primary btn-sm", type: "button", text: t("update.apply") });
          const later = el("button", { class: "link-btn", type: "button", text: t("update.later") });
          apply.addEventListener("click", () => {
            try { sessionStorage.setItem("wt.swApply", "1"); } catch {}
            chip.classList.add("hidden");
            /* a newer install can replace the worker we first saw; target
               whichever worker is waiting right now */
            const activate = reg.waiting || worker;
            try { activate?.postMessage({ type: "SKIP_WAITING" }); } catch {}
            toast(t("update.applied"), "info", 4000);
          });
          later.addEventListener("click", () => chip.classList.add("hidden"));
          chip.append(text, apply, later);
          document.body.append(chip);
        }
        chip.classList.remove("hidden");
      };
      const offer = (worker) => {
        if (!worker || !navigator.serviceWorker.controller) return;
        ensureUpdateChip(worker);
      };
      if (reg.waiting) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) offer(reg.waiting || worker);
        });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        let applied = false;
        try { applied = sessionStorage.getItem("wt.swApply") === "1"; } catch {}
        if (!applied) return;
        try { sessionStorage.removeItem("wt.swApply"); } catch {}
        safeReload({ force: true });
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    } catch {}
  });
}

let netStatusWired = false;
export function wireNetworkStatus() {
  if (netStatusWired || typeof document === "undefined") return;
  netStatusWired = true;
  let bar = null;
  const paint = (online) => {
    if (online) {
      if (bar) { bar.classList.add("leaving"); setTimeout(() => bar?.remove(), 260); bar = null; }
      return;
    }
    if (!bar) {
      bar = el("div", { class: "offline-bar", id: "offlineBar", role: "status", "aria-live": "polite" });
      const icon = el("span", { class: "ob-icon" });
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l18 18M8.5 8.6A6 6 0 0 1 12 8c3 0 5.5 2 6.5 4M5 12a9 9 0 0 1 3-2.4M12 18h.01"/></svg>';
      const text = el("span", { class: "ob-text", id: "offlineText" });
      const retry = el("button", { class: "ob-retry", type: "button", text: t("offline.retry") });
      retry.addEventListener("click", () => safeReload({ force: true }));
      bar.append(icon, text, retry);
      document.body.append(bar);
    }
    const text = document.getElementById("offlineText");
    if (text) text.textContent = `${t("offline.title")} — ${t("offline.body")}`;
  };
  window.addEventListener("online", () => paint(true));
  window.addEventListener("offline", () => paint(false));
  document.addEventListener("langchange", () => { if (bar) paint(false); });
  paint(navigator.onLine);
}

if (typeof document !== "undefined") wireNetworkStatus();

/* Decorative animation stops while the tab is hidden (battery). */
if (typeof document !== "undefined") {
  const paintVisibility = () => {
    document.documentElement.dataset.visibility = document.hidden ? "hidden" : "visible";
  };
  document.addEventListener("visibilitychange", paintVisibility);
  paintVisibility();
}
