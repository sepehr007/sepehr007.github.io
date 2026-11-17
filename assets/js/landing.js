import { initI18n, t, getLang } from "./i18n.js";
import { $, toast, makeCode, store, registerServiceWorker, applyUIPrefs, wireInstallPrompt, createLimiter } from "./core.js";
import { currentUser, mountUserChip, isRealName } from "./auth.js";
import { loadSiteConfig, applySiteConfig, isConfigPreview, accessOn } from "./site-config.js";

applyUIPrefs();
initI18n();
registerServiceWorker();
wireInstallPrompt();

mountUserChip();

let siteCfg = null;
let roomCreateOpen = true;
let roomJoinOpen = true;

const user = currentUser();

async function bootSite() {
  siteCfg = await loadSiteConfig();
  applySiteConfig(siteCfg);
  roomCreateOpen = accessOn("roomCreate", siteCfg);
  roomJoinOpen = accessOn("roomJoin", siteCfg);
  const roomMax = Math.max(1, Number(siteCfg.limits.roomActions) || 2);
  const roomWindow = Math.max(300, Number(siteCfg.limits.roomWindowMs) || 1800);
  createGuard = createLimiter(roomMax, roomWindow);
  joinGuard = createLimiter(roomMax * 2, roomWindow);
  applyAccessState();
  applyAuthLinks();
  applyCapacityOptions();
  if (user) resumePendingRoom();
  if (isConfigPreview()) {
    const badge = document.createElement("div");
    badge.className = "wt-preview-badge";
    badge.textContent = "پیش‌نمایش مالک";
    document.body.append(badge);
  }
  document.addEventListener("langchange", () => {
    applySiteConfig(siteCfg);
    applyAccessState();
    applyAuthLinks();
  });
}
bootSite();

function applyAccessState() {
  const createBtn = $("#createBtn");
  const joinBtn = $("#joinBtn");
  if (createBtn) {
    createBtn.disabled = !roomCreateOpen;
    let hint = $("#createClosedHint");
    if (!roomCreateOpen && !hint) {
      hint = document.createElement("p");
      hint.className = "hint";
      hint.id = "createClosedHint";
      hint.textContent = getLang() === "fa" ? "ساخت اتاق توسط مالک سایت موقتاً بسته شده است." : "Room creation is temporarily closed by the site owner.";
      createBtn.insertAdjacentElement("afterend", hint);
    }
    if (hint) hint.classList.toggle("hidden", roomCreateOpen);
  }
  if (joinBtn) {
    joinBtn.disabled = !roomJoinOpen;
    const hint = $("#joinHint");
    if (hint && !roomJoinOpen) hint.textContent = getLang() === "fa" ? "ورود به اتاق موقتاً بسته است." : "Joining rooms is temporarily closed.";
  }
}

function applyAuthLinks() {
  if (!siteCfg) return;
  const regOpen = accessOn("registration", siteCfg);
  const loginOpen = accessOn("login", siteCfg);
  $("#signupLink")?.classList.toggle("hidden", !regOpen);
  $("#loginLink")?.classList.toggle("hidden", !loginOpen);
  if (!currentUser()) $("#authActions")?.classList.toggle("hidden", !regOpen && !loginOpen);
}

function applyCapacityOptions() {
  const sel = $("#createCapacity");
  if (!sel || !siteCfg) return;
  const max = Math.max(2, Number(siteCfg.limits.maxCapacity) || 24);
  const wanted = Math.max(2, Math.min(max, Number(siteCfg.limits.defaultCapacity) || 6));
  const values = [...new Set([4, 6, 8, 12, 16, 20, 24, wanted].filter((v) => v <= max))].sort((a, b) => a - b);
  sel.replaceChildren(...values.map((v) => {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = String(v);
    opt.selected = v === wanted;
    return opt;
  }));
}

function resumePendingRoom() {
  let raw = "";
  try { raw = sessionStorage.getItem("wt.pending") || ""; } catch {}
  if (!raw) return;
  try { sessionStorage.removeItem("wt.pending"); } catch {}
  if (!roomJoinOpen) return;
  let pending = null;
  try { pending = JSON.parse(raw); } catch { return; }
  if (!pending?.q || Date.now() - (pending.at || 0) > 30 * 60 * 1000) return;
  location.replace(`room.html?${pending.q}`);
}

function startRoom(q) {
  if (!currentUser()) {
    try { sessionStorage.setItem("wt.pending", JSON.stringify({ q: q.toString(), at: Date.now() })); } catch {}
    location.href = `auth.html?next=${encodeURIComponent("index.html")}`;
    return;
  }
  location.href = `room.html?${q.toString()}`;
}

const nameInput = $("#createName");
const createNick = $("#createNick");
const capacityInput = $("#createCapacity");
const privacyInput = $("#createPrivacy");
const pwdWrap = $("#passwordFieldWrap");
const pwdInput = $("#createPassword");
const joinCode = $("#joinCode");
const joinNick = $("#joinNick");

let createGuard = createLimiter(1, 1800);
let joinGuard = createLimiter(2, 1800);
let guardWarnAt = 0;
function guardWarn() {
  const now = Date.now();
  if (now - guardWarnAt < 1500) return;
  guardWarnAt = now;
  toast(t("toast.slowDown"), "error");
}

const savedNick = user?.nick || store.get("wt.nick", "");
if (savedNick) { createNick.value = savedNick; joinNick.value = savedNick; }

privacyInput.addEventListener("change", () => {
  pwdWrap.classList.toggle("hidden", privacyInput.value !== "password");
});

$("#createBtn").addEventListener("click", () => {
  if (!roomCreateOpen) return toast(getLangIsFa() ? "ساخت اتاق موقتاً بسته است." : "Room creation is temporarily closed.", "error");
  const nick = createNick.value.trim().slice(0, 20);
  if (!nick) return toast(t("toast.nameRequired"), "error");
  if (!isRealName(nick)) return toast(t("toast.realName"), "error");
  const privacy = privacyInput.value;
  const pwd = pwdInput.value.trim();
  if (privacy === "password" && pwd.length < 3) {
    return toast(getLangIsFa() ? "رمز حداقل ۳ حرف باشد" : "Password must be at least 3 characters", "error");
  }
  const code = makeCode(6);
  store.set("wt.nick", nick);
  if (privacy === "password") sessionStorage.setItem(`pwd:${code}`, pwd);
  const q = new URLSearchParams({
    room: code,
    host: "1",
    nick,
    name: nameInput.value.trim().slice(0, 40),
    cap: capacityInput.value,
    privacy
  });
  if (!createGuard()) { guardWarn(); return; }
  startRoom(q);
});

$("#joinBtn").addEventListener("click", joinRoom);
joinCode.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
joinNick.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });

function joinRoom() {
  if (!roomJoinOpen) return toast(getLangIsFa() ? "ورود به اتاق موقتاً بسته است." : "Joining rooms is temporarily closed.", "error");
  const nick = joinNick.value.trim().slice(0, 20);
  if (!nick) return toast(t("toast.nameRequired"), "error");
  if (!isRealName(nick)) return toast(t("toast.realName"), "error");
  const raw = joinCode.value.trim();
  if (!raw) return toast(t("toast.roomRequired"), "error");

  let code = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      code = u.searchParams.get("room") || "";
    }
  } catch {}
  code = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (code.length < 4) {
    $("#joinHint").textContent = getLangIsFa() ? "کد اتاق معتبر نیست" : "Invalid room code";
    return;
  }
  store.set("wt.nick", nick);
  if (!joinGuard()) { guardWarn(); return; }
  startRoom(new URLSearchParams({ room: code, nick }));
}

function getLangIsFa() {
  return document.documentElement.lang === "fa";
}
