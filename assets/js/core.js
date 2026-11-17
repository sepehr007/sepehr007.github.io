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

const PALETTE = ["#7c5cff", "#22d3ee", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#a78bfa", "#fb7185"];
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

let toastTimer = [];
export function toast(message, type = "info", ms = 3200) {
  const wrap = document.getElementById("toasts");
  if (!wrap) return;
  const node = el("div", { class: `toast ${type === "info" ? "" : type}`, text: message });
  wrap.append(node);
  const timer = setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(-6px)";
    setTimeout(() => node.remove(), 220);
  }, ms);
  toastTimer.push(timer);
  while (wrap.children.length > 4) wrap.firstElementChild.remove();
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
  accent: "#7c5cff",
  accent2: "#22d3ee",
  brightness: 100,
  chatSize: 13.4,
  chatAlpha: 72,
  chatBright: 100
};

export function getPrefs() {
  const saved = store.get("wt.prefs", null);
  return { ...PREF_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
}

export function savePrefs(patch) {
  const next = { ...getPrefs(), ...patch };
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
  root.setProperty("--grad", `linear-gradient(135deg,${prefs.accent} 0%,${prefs.accent2} 100%)`);
  root.setProperty("--chat-size", `${prefs.chatSize}px`);
  root.setProperty("--side-alpha", String(prefs.chatAlpha / 100));
  root.setProperty("--chat-bright", String(prefs.chatBright / 100));
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
  { a: "#7c5cff", b: "#22d3ee" },
  { a: "#f472b6", b: "#f59e0b" },
  { a: "#34d399", b: "#22d3ee" },
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
    setTimeout(() => location.reload(), 240);
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
  if (["localhost", "127.0.0.1"].includes(location.hostname)) return;
  if (location.protocol !== "https:") return;
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
      reg.update().catch(() => {});
      if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController || reloaded) return;
        let seen = false;
        try { seen = sessionStorage.getItem("wt.swReload") === "1"; } catch {}
        if (seen) return;
        reloaded = true;
        try { sessionStorage.setItem("wt.swReload", "1"); } catch {}
        location.reload();
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    } catch {}
  });
}
