import { initI18n, t, getLang } from "./i18n.js";
import {
  $, toast, makeCode, store, registerServiceWorker, applyUIPrefs, wireInstallPrompt,
  createLimiter, confirmDialog, copyText
} from "./core.js";
import { currentUser, mountUserChip, isDisplayName } from "./auth.js";
import { seedAccountsFromLocal } from "./db.js";
import {
  createLobby, getActiveLobby, closeLobby, touchLobby, lobbyStats,
  lobbyQuery, lobbyInviteUrl, pruneExpiredLobbies
} from "./lobbies.js";
import { loadSiteConfig, applySiteConfig, isConfigPreview, accessOn, listenLiveConfig } from "./site-config.js";
import { resolveFlags, applyFlagsToDom, buildFlagContext, flagOn, readFeatureCenter } from "./feature-flags.js";
import { seedPlans, requestPlan } from "./plans.js";

applyUIPrefs();
initI18n();
registerServiceWorker();
wireInstallPrompt();

mountUserChip();

let siteCfg = null;
let roomCreateOpen = true;
let roomJoinOpen = true;
let flagStates = {};
let flagCenter = null;
let flagContext = buildFlagContext({ user: currentUser() });

const user = currentUser();

function refreshFlags() {
  flagContext = buildFlagContext({ user: currentUser() });
  flagCenter = readFeatureCenter();
  flagStates = resolveFlags(siteCfg, flagCenter.scopes, flagContext);
  applyFlagsToDom(siteCfg, flagCenter, flagContext, document, flagStates);
  applyPrivacyOptions();
}

async function bootSite() {
  siteCfg = await loadSiteConfig();
  applySiteConfig(siteCfg);
  roomCreateOpen = accessOn("roomCreate", siteCfg);
  roomJoinOpen = accessOn("roomJoin", siteCfg);
  const roomMax = Math.max(1, Number(siteCfg.limits.roomActions) || 2);
  const roomWindow = Math.max(300, Number(siteCfg.limits.roomWindowMs) || 1800);
  createGuard = createLimiter(roomMax, roomWindow);
  joinGuard = createLimiter(roomMax * 2, roomWindow);
  refreshFlags();
  applyAccessState();
  applyAuthLinks();
  applyCapacityOptions();
  listenLiveConfig((cfg) => {
    siteCfg = cfg;
    applySiteConfig(cfg);
    roomCreateOpen = accessOn("roomCreate", cfg);
    roomJoinOpen = accessOn("roomJoin", cfg);
    refreshFlags();
    applyAccessState();
    applyAuthLinks();
  });
  await seedAccountsFromLocal();
  await seedPlans();
  wirePlanButtons();
  if (user) {
    await initLobbyUI();
    if (!(await resumePendingLobby())) resumePendingRoom();
    await resumePendingPlan();
  } else {
    $("#lobbyCard")?.classList.add("hidden");
  }
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
    applyPrivacyOptions();
    if (activeLobby) renderLobbyCard(activeLobby);
  });
}
bootSite();

/* ---------- subscription plans ---------- */
function wirePlanButtons() {
  document.querySelectorAll("[data-plan]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      const planId = btn.dataset.plan;
      const account = currentUser();
      if (!account) {
        try { sessionStorage.setItem("wt.pendingPlan", planId); } catch {}
        toast(t("v8.planNeedAccount"), "info");
        location.href = `auth.html?next=${encodeURIComponent("index.html#pricing")}`;
        return;
      }
      btn.disabled = true;
      try {
        const res = await requestPlan(account, planId);
        toast(res.ok ? t("v8.planPendingToast") : t("v8.planNeedAccount"), res.ok ? "success" : "error");
      } finally {
        btn.disabled = false;
      }
    });
  });
}

async function resumePendingPlan() {
  const account = currentUser();
  if (!account) return;
  let planId = "";
  try { planId = sessionStorage.getItem("wt.pendingPlan") || ""; } catch {}
  if (!planId) return;
  try { sessionStorage.removeItem("wt.pendingPlan"); } catch {}
  const res = await requestPlan(account, planId);
  if (res.ok) toast(t("v8.planPendingToast"), "success");
}

/* ---------- personal lobby (one active per account) ---------- */
let activeLobby = null;
let lobbyWired = false;
let lobbyStatsCache = { total: 0 };

function agoLabel(ts) {
  const fa = getLang() === "fa";
  const diff = Math.max(0, Date.now() - Number(ts || 0));
  const mins = Math.round(diff / 60000);
  if (mins < 1) return fa ? "همین حالا" : "just now";
  if (mins < 60) return fa ? `${mins} دقیقه پیش` : `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return fa ? `${hours} ساعت پیش` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  return fa ? `${days} روز پیش` : `${days} d ago`;
}

function renderLobbyCard(lobby, stats) {
  activeLobby = lobby || null;
  if (stats) lobbyStatsCache = stats;
  const card = $("#lobbyCard");
  if (!card) return;
  card.classList.toggle("hidden", !lobby);
  const note = $("#lobbyReplaceNote");
  if (note) note.classList.toggle("hidden", !lobby);
  if (!lobby) return;
  $("#lobbyCode").textContent = lobby.code;
  $("#lobbyName").textContent = lobby.name || "لابی من";
  $("#lobbyMeta").textContent = t("lobby.meta", {
    cap: String(lobby.capacity || 6),
    ago: agoLabel(lobby.createdAt)
  });
  const total = $("#lobbyTotal");
  if (total) total.textContent = t("lobby.total", { n: String(lobbyStatsCache?.total ?? 0) });
}

function wireLobbyCard() {
  if (lobbyWired) return;
  lobbyWired = true;
  $("#lobbyOpenBtn")?.addEventListener("click", async () => {
    const account = currentUser();
    if (!account || !activeLobby) return;
    try { await touchLobby(account, activeLobby.code); } catch {}
    location.href = `room.html?${lobbyQuery(activeLobby, { nick: account.nick })}`;
  });
  $("#lobbyCopyBtn")?.addEventListener("click", async () => {
    if (!activeLobby) return;
    const ok = await copyText(lobbyInviteUrl(activeLobby));
    toast(ok ? t("toast.copied") : t("lobby.copyFail"), ok ? "success" : "error");
  });
  $("#lobbyCloseBtn")?.addEventListener("click", async () => {
    const account = currentUser();
    if (!account || !activeLobby) return;
    const ok = await confirmDialog({
      title: t("lobby.closeTitle"),
      text: t("lobby.closeText"),
      okLabel: t("lobby.close")
    });
    if (!ok) return;
    await closeLobby(account, activeLobby.code, "manual");
    const stats = await lobbyStats(account);
    renderLobbyCard(null, stats);
    toast(t("lobby.closedToast"), "info");
  });
}

async function initLobbyUI() {
  wireLobbyCard();
  const account = currentUser();
  if (!account) return;
  try {
    await pruneExpiredLobbies(account);
    const [lobby, stats] = await Promise.all([getActiveLobby(account), lobbyStats(account)]);
    renderLobbyCard(lobby, stats);
  } catch {
    renderLobbyCard(null, { total: 0 });
  }
}

async function persistLobby(account, { code, name, nick, capacity, privacy }) {
  try {
    const res = await createLobby(account, { code, name, capacity, privacy });
    if (!res.ok) return;
    renderLobbyCard(res.lobby, await lobbyStats(account));
  } catch {}
}

async function resumePendingLobby() {
  let raw = "";
  try { raw = sessionStorage.getItem("wt.pendingLobby") || ""; } catch {}
  if (!raw) return false;
  try { sessionStorage.removeItem("wt.pendingLobby"); } catch {}
  const account = currentUser();
  if (!account) return false;
  let pending = null;
  try { pending = JSON.parse(raw); } catch { return false; }
  if (!pending || Date.now() - Number(pending.at || 0) > 30 * 60 * 1000) return false;
  if (!roomCreateOpen || !flagOn(flagStates, "rooms.create")) return false;
  const code = makeCode(6);
  const capacity = String(Math.max(2, Math.min(24, Number(pending.capacity) || 6)));
  const privacy = pending.privacy === "password" ? "password" : "public";
  const nick = String(pending.nick || account.nick || "").slice(0, 20);
  if (privacy === "password" && pending.password) {
    try { sessionStorage.setItem(`pwd:${code}`, String(pending.password)); } catch {}
  }
  await persistLobby(account, {
    code,
    name: String(pending.name || "").slice(0, 40),
    nick,
    capacity,
    privacy
  });
  const q = new URLSearchParams({
    room: code,
    host: "1",
    nick,
    name: String(pending.name || "").slice(0, 40),
    cap: capacity,
    privacy
  });
  location.replace(`room.html?${q}`);
  return true;
}

/* ---------- motion & hero shortcuts ---------- */
function initReveal() {
  const nodes = document.querySelectorAll("[data-reveal]");
  if (!nodes.length) return;
  if (!("IntersectionObserver" in window)) {
    nodes.forEach((node) => node.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      io.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -36px" });
  nodes.forEach((node) => io.observe(node));
  setTimeout(() => nodes.forEach((node) => node.classList.add("in")), 1600);
}

function wireHeroShortcuts() {
  $("#heroCreateBtn")?.addEventListener("click", () => {
    $("#create")?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => $("#createName")?.focus({ preventScroll: true }), 460);
  });
  $("#heroTourBtn")?.addEventListener("click", () => {
    $("#why")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}
document.documentElement.classList.add("v8-ready");
initReveal();
wireHeroShortcuts();

function applyPrivacyOptions() {
  const sel = $("#createPrivacy");
  if (!sel) return;
  const canPublic = flagOn(flagStates, "rooms.public");
  const canPrivate = flagOn(flagStates, "rooms.private") && flagOn(flagStates, "rooms.password");
  let changed = false;
  for (const opt of [...sel.options]) {
    const allowed = opt.value === "password" ? canPrivate : canPublic;
    opt.disabled = !allowed;
    opt.hidden = !allowed;
    if (!allowed && opt.selected) changed = true;
  }
  if (changed || (sel.selectedOptions[0]?.disabled ?? true)) {
    const target = canPublic ? "public" : canPrivate ? "password" : "";
    if (target) sel.value = target;
  }
  $("#passwordFieldWrap")?.classList.toggle("hidden", sel.value !== "password");
  const none = !canPublic && !canPrivate;
  let hint = $("#privacyClosedHint");
  const createBtn = $("#createBtn");
  if (none) {
    if (createBtn) createBtn.disabled = true;
    if (!hint) {
      hint = document.createElement("p");
      hint.className = "hint";
      hint.id = "privacyClosedHint";
      hint.textContent = getLang() === "fa" ? "ساخت اتاق توسط مالک سایت موقتاً غیرفعال است." : "Room creation is temporarily disabled by the site owner.";
      createBtn?.insertAdjacentElement("afterend", hint);
    }
  } else {
    hint?.remove();
    if (createBtn) createBtn.disabled = !roomCreateOpen;
  }
}

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
  if (createBtn) applyPrivacyOptions();
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

$("#createBtn").addEventListener("click", async () => {
  if (!roomCreateOpen) return toast(getLangIsFa() ? "ساخت اتاق موقتاً بسته است." : "Room creation is temporarily closed.", "error");
  if (!flagOn(flagStates, "rooms.create")) return toast(getLangIsFa() ? "ساخت اتاق غیرفعال شده است." : "Room creation is disabled.", "error");
  const nick = createNick.value.trim().slice(0, 20);
  if (!nick) return toast(t("toast.nameRequired"), "error");
  if (!isDisplayName(nick)) return toast(t("toast.realName"), "error");
  const privacy = privacyInput.value;
  if (privacy === "password" && !(flagOn(flagStates, "rooms.private") && flagOn(flagStates, "rooms.password"))) {
    return toast(getLangIsFa() ? "اتاق رمزدار غیرفعال شده است." : "Password rooms are disabled.", "error");
  }
  if (privacy === "public" && !flagOn(flagStates, "rooms.public")) {
    return toast(getLangIsFa() ? "اتاق عمومی غیرفعال شده است." : "Public rooms are disabled.", "error");
  }
  const pwd = pwdInput.value.trim();
  if (privacy === "password" && pwd.length < 3) {
    return toast(getLangIsFa() ? "رمز حداقل ۳ حرف باشد" : "Password must be at least 3 characters", "error");
  }
  const account = currentUser();
  if (!account) {
    try {
      sessionStorage.setItem("wt.pendingLobby", JSON.stringify({
        name: nameInput.value.trim().slice(0, 40),
        nick,
        capacity: capacityInput.value,
        privacy,
        password: pwd,
        at: Date.now()
      }));
    } catch {}
    location.href = `auth.html?next=${encodeURIComponent("index.html")}`;
    return;
  }
  const code = makeCode(6);
  store.set("wt.nick", nick);
  if (privacy === "password") sessionStorage.setItem(`pwd:${code}`, pwd);
  if (!createGuard()) { guardWarn(); return; }
  await persistLobby(account, {
    code,
    name: nameInput.value.trim().slice(0, 40),
    nick,
    capacity: capacityInput.value,
    privacy
  });
  const q = new URLSearchParams({
    room: code,
    host: "1",
    nick,
    name: nameInput.value.trim().slice(0, 40),
    cap: capacityInput.value,
    privacy
  });
  startRoom(q);
});

$("#joinBtn").addEventListener("click", joinRoom);
joinCode.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
joinNick.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });

function joinRoom() {
  if (!roomJoinOpen) return toast(getLangIsFa() ? "ورود به اتاق موقتاً بسته است." : "Joining rooms is temporarily closed.", "error");
  if (!flagOn(flagStates, "rooms.join")) return toast(getLangIsFa() ? "ورود به اتاق غیرفعال شده است." : "Joining rooms is disabled.", "error");
  const nick = joinNick.value.trim().slice(0, 20);
  if (!nick) return toast(t("toast.nameRequired"), "error");
  if (!isDisplayName(nick)) return toast(t("toast.realName"), "error");
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
