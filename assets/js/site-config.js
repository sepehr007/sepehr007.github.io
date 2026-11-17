import { store } from "./core.js";
import { renderPricingSection } from "./pricing.js";

const CONFIG_URL = new URL("../data/site-config.json", import.meta.url);
const SESSION_KEY = "wt.ownerSession";
const PREVIEW_KEY = "wt.ownerPreview";

export const SITE_CONFIG_DEFAULTS = {
  version: 1,
  updatedAt: "",
  owner: {
    login: "sepehr007",
    repo: "sepehr007/sepehr007.github.io",
    branch: "main"
  },
  site: {
    nameFa: "هم‌تماشا",
    nameEn: "Watch Together",
    taglineFa: "تماشای هم‌زمان فیلم با دوستان؛ چت، صدا و پخش همگام در مرورگر.",
    taglineEn: "Watch together in sync, with chat and live voice in your browser.",
    metaTitleFa: "",
    metaTitleEn: "",
    metaDescFa: "",
    metaDescEn: "",
    defaultTheme: "dark",
    accent: "#7c5cff",
    accent2: "#22d3ee",
    supportUrl: ""
  },
  announcement: {
    enabled: false,
    type: "info",
    textFa: "",
    textEn: ""
  },
  maintenance: {
    enabled: false,
    messageFa: "سایت موقتاً برای به‌روزرسانی در دسترس نیست. کمی بعد برگرد.",
    messageEn: "The site is temporarily unavailable for maintenance. Please check back soon."
  },
  access: {
    registration: true,
    login: true,
    roomCreate: true,
    roomJoin: true
  },
  features: {
    chat: true,
    voice: true,
    liveReactions: true,
    screenShare: true,
    queue: true,
    subtitles: true,
    localFile: true
  },
  limits: {
    defaultCapacity: 6,
    maxCapacity: 24,
    chatPerWindow: 6,
    chatWindowMs: 3000,
    avatarChanges: 3,
    avatarWindowMs: 5000,
    roomActions: 2,
    roomWindowMs: 1800
  },
  plans: {
    premiumEnabled: false,
    premiumUrl: "",
    premiumPriceFa: "به‌زودی",
    premiumPriceEn: "Coming soon",
    premiumNoteFa: "چند اتاق هم‌زمان، آپلود ابری و ظاهرهای بیشتر.",
    premiumNoteEn: "Multiple rooms, cloud uploads and more themes."
  },
  billing: {
    currency: "IRT",
    plans: []
  }
};

let current = clone(SITE_CONFIG_DEFAULTS);
let loaded = false;
let loading = null;
let fromPreview = false;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function merge(base, extra) {
  if (Array.isArray(base)) return Array.isArray(extra) ? extra : base;
  if (!base || typeof base !== "object") {
    return extra === undefined ? base : extra;
  }
  const out = { ...base };
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return out;
  for (const [key, value] of Object.entries(extra)) {
    if (key in base) out[key] = merge(base[key], value);
    else out[key] = value;
  }
  return out;
}

export function normalizeSiteConfig(raw) {
  const merged = merge(SITE_CONFIG_DEFAULTS, raw || {});
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  merged.version = num(merged.version, 1, 1, 9999);
  merged.limits.defaultCapacity = num(merged.limits.defaultCapacity, 6, 2, 24);
  merged.limits.maxCapacity = num(merged.limits.maxCapacity, 24, merged.limits.defaultCapacity, 24);
  merged.limits.chatPerWindow = num(merged.limits.chatPerWindow, 6, 2, 30);
  merged.limits.chatWindowMs = num(merged.limits.chatWindowMs, 3000, 1000, 30000);
  merged.limits.avatarChanges = num(merged.limits.avatarChanges, 3, 1, 20);
  merged.limits.avatarWindowMs = num(merged.limits.avatarWindowMs, 5000, 1000, 30000);
  merged.limits.roomActions = num(merged.limits.roomActions, 2, 1, 20);
  merged.limits.roomWindowMs = num(merged.limits.roomWindowMs, 1800, 500, 30000);
  if (!["info", "warn", "critical"].includes(merged.announcement.type)) merged.announcement.type = "info";
  if (!["dark", "light"].includes(merged.site.defaultTheme)) merged.site.defaultTheme = "dark";
  if (!/^#[0-9a-f]{6}$/i.test(merged.site.accent)) merged.site.accent = "#7c5cff";
  if (!/^#[0-9a-f]{6}$/i.test(merged.site.accent2)) merged.site.accent2 = "#22d3ee";
  if (!/^[\w.-]+\/[\w.-]+$/.test(merged.owner.repo)) merged.owner.repo = SITE_CONFIG_DEFAULTS.owner.repo;
  if (!/^[A-Za-z0-9_.-]+$/.test(merged.owner.branch)) merged.owner.branch = "main";
  if (!/^[A-Za-z0-9-]+$/.test(merged.owner.login)) merged.owner.login = SITE_CONFIG_DEFAULTS.owner.login;
  const httpUrl = (value) => {
    if (!value) return "";
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
    } catch { return ""; }
  };
  merged.site.supportUrl = httpUrl(merged.site.supportUrl);
  merged.plans.premiumUrl = httpUrl(merged.plans.premiumUrl);
  if (!["IRT", "USD"].includes(merged.billing.currency)) merged.billing.currency = "IRT";
  if (!Array.isArray(merged.billing.plans)) merged.billing.plans = [];
  merged.billing.plans = merged.billing.plans.slice(0, 60);
  const text = (v, max) => String(v ?? "").trim().slice(0, max);
  merged.site.metaTitleFa = text(merged.site.metaTitleFa, 70);
  merged.site.metaTitleEn = text(merged.site.metaTitleEn, 70);
  merged.site.metaDescFa = text(merged.site.metaDescFa, 160);
  merged.site.metaDescEn = text(merged.site.metaDescEn, 160);
  return merged;
}

export function getSiteConfig() {
  return current;
}

export async function loadSiteConfig() {
  if (loaded) return current;
  if (loading) return loading;
  loading = (async () => {
    let cfg = clone(SITE_CONFIG_DEFAULTS);
    try {
      const res = await fetch(`${CONFIG_URL.href}?t=${Math.floor(Date.now() / 300000)}`, { cache: "no-store" });
      if (res.ok) cfg = normalizeSiteConfig(await res.json());
    } catch {}
    const params = new URLSearchParams(location.search);
    if (params.get("preview") === "1" && ownerSessionValid()) {
      const draft = store.get(PREVIEW_KEY, null);
      if (draft && typeof draft === "object") {
        cfg = normalizeSiteConfig(draft);
        fromPreview = true;
      }
    }
    current = cfg;
    loaded = true;
    return current;
  })();
  return loading;
}

export function isConfigPreview() {
  return fromPreview;
}

const OWNER_SESSION_TTL = 12 * 3600 * 1000;
const OWNER_SESSION_PEPPER = "wt-owner-session-v2";

function readOwnerSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}

async function sessionSig(exp) {
  if (!crypto.subtle) return "";
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${OWNER_SESSION_PEPPER}|${exp}`));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { return ""; }
}

export function ownerSessionValid() {
  const s = readOwnerSession();
  if (!s || !(Number(s.exp) > Date.now())) return false;
  if (s.v === 2) return typeof s.sig === "string" && s.sig.length === 64;
  return true;
}

export async function verifyOwnerSession() {
  const s = readOwnerSession();
  if (!s || s.v !== 2 || !(Number(s.exp) > Date.now())) return false;
  const sig = await sessionSig(Number(s.exp));
  return Boolean(sig) && sig === s.sig;
}

export async function setOwnerSession(on = true) {
  try {
    if (!on) {
      sessionStorage.removeItem(SESSION_KEY);
      return;
    }
    const exp = Date.now() + OWNER_SESSION_TTL;
    const sig = await sessionSig(exp);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ v: 2, exp, at: Date.now(), sig }));
  } catch {}
}

export function savePreviewDraft(draft) {
  store.set(PREVIEW_KEY, draft);
}

export function featureOn(name, cfg = current) {
  return cfg?.features?.[name] !== false;
}

export function accessOn(name, cfg = current) {
  return cfg?.access?.[name] !== false;
}

export function isMaintenanceBlocked(cfg = current) {
  return !!cfg?.maintenance?.enabled && !ownerSessionValid();
}

function announceDismissKey(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return `wt.announce.${h}`;
}

export function applySiteConfig(cfg = current, { root = document } = {}) {
  const lang = root.documentElement.lang === "en" ? "en" : "fa";
  const fa = lang === "fa";
  const name = fa ? cfg.site.nameFa : cfg.site.nameEn;

  root.querySelectorAll(".brand-text").forEach((n) => { n.textContent = name; });
  const metaTitle = (fa ? cfg.site.metaTitleFa : cfg.site.metaTitleEn).trim();
  if (metaTitle) document.title = metaTitle;
  else if (document.title) document.title = document.title.replace("هم‌تماشا", cfg.site.nameFa).replace("Watch Together", cfg.site.nameEn);
  const desc = root.querySelector('meta[name="description"]');
  const metaDesc = (fa ? cfg.site.metaDescFa : cfg.site.metaDescEn).trim();
  if (desc) desc.content = metaDesc || (fa ? cfg.site.taglineFa : cfg.site.taglineEn);
  const ogTitle = root.querySelector('meta[property="og:title"]');
  if (ogTitle && metaTitle) ogTitle.content = metaTitle;
  const ogSite = root.querySelector('meta[property="og:site_name"]');
  if (ogSite) ogSite.content = name;

  if (!store.get("wt.prefs", null)) {
    root.documentElement.dataset.theme = cfg.site.defaultTheme;
    const rootStyle = root.documentElement.style;
    rootStyle.setProperty("--accent", cfg.site.accent);
    rootStyle.setProperty("--accent-2", cfg.site.accent2);
    rootStyle.setProperty("--grad", `linear-gradient(135deg,${cfg.site.accent} 0%,${cfg.site.accent2} 100%)`);
    const meta = root.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = cfg.site.defaultTheme === "light" ? "#f3f5fa" : "#07080d";
  }

  root.querySelectorAll("[data-wt-announce]").forEach((n) => n.remove());
  const text = fa ? cfg.announcement.textFa : cfg.announcement.textEn;
  if (cfg.announcement.enabled && text.trim()) {
    const key = announceDismissKey(text);
    let dismissed = false;
    try { dismissed = sessionStorage.getItem(key) === "1"; } catch {}
    if (!dismissed) {
      const bar = document.createElement("div");
      bar.className = `site-announce ${cfg.announcement.type || "info"}`;
      bar.dataset.wtAnnounce = "1";
      bar.setAttribute("role", "status");
      const body = document.createElement("span");
      body.textContent = text;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "site-announce-x";
      close.setAttribute("aria-label", "Close");
      close.textContent = "×";
      close.addEventListener("click", () => {
        try { sessionStorage.setItem(key, "1"); } catch {}
        bar.remove();
      });
      bar.append(body, close);
      root.body.append(bar);
    }
  }

  root.querySelectorAll("[data-wt-maint]").forEach((n) => n.remove());
  if (isMaintenanceBlocked(cfg) && !root.body.classList.contains("owner-body")) {
    const back = document.createElement("div");
    back.className = "wt-maint";
    back.dataset.wtMaint = "1";
    back.setAttribute("role", "alertdialog");
    back.setAttribute("aria-modal", "true");
    const box = document.createElement("div");
    box.className = "wt-maint-box";
    const logo = document.createElement("div");
    logo.className = "wt-maint-logo";
    logo.textContent = "⏳";
    const h = document.createElement("h1");
    h.textContent = fa ? `${cfg.site.nameFa} در حال به‌روزرسانی است` : `${cfg.site.nameEn} is under maintenance`;
    const p = document.createElement("p");
    p.textContent = fa ? cfg.maintenance.messageFa : cfg.maintenance.messageEn;
    box.append(logo, h, p);
    back.append(box);
    root.body.append(back);
  }

  root.querySelectorAll("[data-wt-tagline]").forEach((n) => n.remove());
  const footer = root.querySelector(".site-footer");
  const tagline = fa ? cfg.site.taglineFa : cfg.site.taglineEn;
  if (footer && tagline.trim()) {
    const p = document.createElement("p");
    p.className = "site-tagline";
    p.dataset.wtTagline = "1";
    p.textContent = tagline.trim();
    footer.prepend(p);
  }

  root.querySelectorAll("[data-wt-support]").forEach((n) => n.remove());
  if (footer && /^https?:\/\//i.test(cfg.site.supportUrl || "")) {
    const a = document.createElement("a");
    a.className = "site-support";
    a.dataset.wtSupport = "1";
    a.href = cfg.site.supportUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = fa ? "پشتیبانی سایت ↗" : "Site support ↗";
    footer.prepend(a);
  }

  renderPricingSection(cfg, root);

  const premiumCard = root.querySelector(".price-soon");
  if (premiumCard) {
    const strong = premiumCard.querySelector(".price-val strong");
    const button = premiumCard.querySelector("button");
    const note = premiumCard.querySelector(".hint");
    if (strong) strong.textContent = fa ? cfg.plans.premiumPriceFa : cfg.plans.premiumPriceEn;
    if (note) note.textContent = fa ? cfg.plans.premiumNoteFa : cfg.plans.premiumNoteEn;
    if (cfg.plans.premiumEnabled && cfg.plans.premiumUrl) {
      premiumCard.classList.remove("price-soon");
      if (button) {
        button.disabled = false;
        button.textContent = fa ? "خرید پریمیوم" : "Get Premium";
        button.onclick = () => window.open(cfg.plans.premiumUrl, "_blank", "noopener");
      }
    } else if (button) {
      button.disabled = true;
      button.textContent = fa ? "به‌زودی" : "Coming soon";
    }
  }

  const support = root.querySelector("[data-wt-support]");
  if (support && cfg.site.supportUrl) {
    support.href = cfg.site.supportUrl;
    support.classList.remove("hidden");
  } else if (support) {
    support.classList.add("hidden");
  }
  return cfg;
}
