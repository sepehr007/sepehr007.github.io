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
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
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
  if (url.protocol !== "https:") return { ok: false, reason: "invalid" };
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (BLOCKED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { ok: false, reason: "blocked" };
  }
  return { ok: true, url: url.href };
}

/* ---------- personal appearance ---------- */
export const PREF_DEFAULTS = {
  theme: "dark",
  accent: "#3d6bff",
  accent2: "#f5b23e",
  brightness: 100,
  chatSize: 13.4,
  chatAlpha: 72,
  chatBright: 100,
  glass: 60,
  cineBright: 100,
  cineSize: 14
};

/* Users who never picked a color still carry the old violet defaults — move
   them to the new brand palette once, without touching custom choices. */
const LEGACY_ACCENTS = { "#7c5cff": "#3d6bff", "#22d3ee": "#f5b23e" };

function hexToRgbTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

export function getPrefs() {
  const saved = store.get("wt.prefs", null);
  const merged = { ...PREF_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
  if (saved && saved.palette !== 2) {
    if (LEGACY_ACCENTS[merged.accent]) merged.accent = LEGACY_ACCENTS[merged.accent];
    if (LEGACY_ACCENTS[merged.accent2]) merged.accent2 = LEGACY_ACCENTS[merged.accent2];
  }
  return merged;
}

export function savePrefs(patch) {
  const next = { ...getPrefs(), ...patch, palette: 2 };
  store.set("wt.prefs", next);
  applyUIPrefs(next);
  return next;
}

export function resetPrefs() {
  store.del("wt.prefs");
  applyUIPrefs(PREF_DEFAULTS);
  return { ...PREF_DEFAULTS };
}

export function applyUIPrefs(prefs = getPrefs()) {
  const theme = prefs.theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#f3f5fa" : "#07080d";
  const root = document.documentElement.style;
  root.setProperty("--accent", prefs.accent);
  root.setProperty("--accent-2", prefs.accent2);
  const rgb1 = hexToRgbTriplet(prefs.accent);
  const rgb2 = hexToRgbTriplet(prefs.accent2);
  if (rgb1) root.setProperty("--brand-rgb", rgb1);
  if (rgb2) root.setProperty("--brand-2-rgb", rgb2);
  root.setProperty("--grad", `linear-gradient(135deg,${prefs.accent} 0%,#38bdf8 58%,${prefs.accent2} 100%)`);
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
}

export function lightenHex(hex, amount = 0.35) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0");
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

export const ACCENTS = [
  { a: "#3d6bff", b: "#f5b23e" },
  { a: "#f472b6", b: "#f59e0b" },
  { a: "#34d399", b: "#f5b23e" },
  { a: "#fb7185", b: "#a855f7" },
  { a: "#60a5fa", b: "#818cf8" },
  { a: "#f5b64a", b: "#f97316" }
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
