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

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function makeCode(len = 6) {
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

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost") return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
