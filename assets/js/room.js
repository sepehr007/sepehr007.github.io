import { initI18n, t, applyI18n, getLang } from "./i18n.js";
import {
  $, $$, el, escapeHtml, colorFor, initials, fmtTime, fmtClock, toast, urgentToast,
  confirmDialog, copyText, store, validateMediaUrl, createLimiter, debounce,
  registerServiceWorker, applyUIPrefs, getPrefs, savePrefs, resetPrefs, ACCENTS, lightenHex, safeReload
} from "./core.js";
import { Net, ROLE_PERMS, ROOM_PERMS, ROLE_RANK, rankOf, effectivePerms } from "./net.js";
import { LiveFeed } from "./livefeed.js";
import { Player, parseSubtitles } from "./player.js";
import { Voice } from "./voice.js";
import { initRoomMgmt } from "./room-mgmt.js";
import { currentUser, isLocallyBanned } from "./auth.js";
import { touchLobby, forceCloseLobby } from "./lobbies.js";
import { dbPut, dbGetByIndex, dbDelete, recordActivity } from "./db.js";
import { avatarSrc } from "./avatars.js";
import { CAPS } from "./capabilities.js";
import { notifPrefs, notifPermission, setRoomNotif, notifyChat, notifyActivity } from "./notifications.js";
import { loadSiteConfig, applySiteConfig, applyGlobalTheme, featureOn, accessOn, isMaintenanceBlocked, listenLiveConfig } from "./site-config.js";
import { isBundle, unpackBundle, registerBundle, releaseBundle, packBundle } from "./hls-bundle.js";
import {
  resolveFlags, applyFlagsToDom, buildFlagContext, flagOn, recordFeatureUse, readFeatureCenter
} from "./feature-flags.js";

initI18n();
applyUIPrefs();
registerServiceWorker();

globalThis.addEventListener?.("wt:api-unauthorized", () => toast(t("profile.session"), "error", 7000));

const params = new URLSearchParams(location.search);
const code = (params.get("room") || "").toUpperCase();
const isHost = params.get("host") === "1";
const authUser = currentUser();
if (!code) {
  location.replace("./");
} else if (!authUser) {
  const next = `room.html${location.search}`;
  location.replace(`auth.html?next=${encodeURIComponent(next)}`);
}

const roomNameParam = params.get("name") || "";
const capacityParam = Number(params.get("cap")) || 6;
let privacyParam = params.get("privacy") === "password" ? "password" : "public";
const ROOM_PWD_TTL_MS = 30 * 60_000;
function readRoomPassword() {
  try {
    const raw = sessionStorage.getItem(`pwd:${code}`);
    if (!raw) return "";
    const saved = JSON.parse(raw);
    if (saved?.pwd && Number(saved.exp) > Date.now()) return String(saved.pwd);
  } catch {}
  sessionStorage.removeItem(`pwd:${code}`);
  return "";
}
function saveRoomPassword(pwd) {
  roomPassword = pwd;
  try {
    sessionStorage.setItem(`pwd:${code}`, JSON.stringify({ pwd, exp: Date.now() + ROOM_PWD_TTL_MS }));
  } catch {}
  window.dispatchEvent(new CustomEvent("wt:room-pwd", { detail: pwd }));
}
let roomPassword = readRoomPassword();

let nick = (authUser?.nick || params.get("nick") || store.get("wt.nick") || "").trim();
const me = { id: "", role: "member", nick: "", avatar: authUser?.avatar || "", perms: {} };
let net = null;
let player = null;
let voice = null;
let members = [];
let seenMemberIds = null;
let queueItems = [];
let roomInfo = null;
let activeTabName = "chat";
let unreadChat = 0;
const LIVE_EMOJIS = ["❤️", "😂", "😮", "👏", "🔥", "🍿"];
const WAKE_KEY = "wt.wake";
let wakeWanted = store.get(WAKE_KEY, true) !== false;
let wakeSentinel = null;
let wakePending = false;
const QUEUE_AUTO_KEY = "wt.queueAuto";
let queueAuto = store.get(QUEUE_AUTO_KEY, true) !== false;
const REACT_DOCK_KEY = "wt.reactDock";
let reactionsOn = store.get(REACT_DOCK_KEY, true) !== false;
const CINE_CHAT_KEY = "wt.cineChat";
let cineOn = store.get(CINE_CHAT_KEY, true) !== false;
const SHEET_DOCK_KEY = "wt.sheetDock";
let sheetDockOn = store.get(SHEET_DOCK_KEY, true) !== false;
const USER_AUDIO_KEY = "wt.userAudio";
let userAudio = store.get(USER_AUDIO_KEY, {}) || {};
let cineExpanded = false;
let cineUnread = 0;
let cineMsgs = [];
let cineFeed = null;
const MAX_CINE = 40;
let lastReactAt = 0;
let cineAutoOpened = false;
let chatQueuedToastAt = 0;
const SAMPLE_SOURCES = [
  "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
  "https://media.w3.org/2010/05/sintel/trailer.mp4"
];
let samplePending = false;
let sampleIndex = 0;
let mediaWatchdog = 0;
let lastGestureAt = 0;
let autoplayHintShown = false;
const PTT_KEY = "wt.ptt";
let pttOn = store.get(PTT_KEY, false) === true;
let pttHeld = false;
let pttRestoreMute = true;
const SUB_COLOR_KEY = "wt.subColor";
const SUB_BG_KEY = "wt.subBg";
const SUB_SIZE_KEY = "wt.subSize";
const SUB_OFFSET_KEY = "wt.subOffset";
let subColor = store.get(SUB_COLOR_KEY, "#ffffff");
let subBg = Number(store.get(SUB_BG_KEY, 0.72));
let subSize = Number(store.get(SUB_SIZE_KEY, 120)) || 120;
let subOffset = Number(store.get(SUB_OFFSET_KEY, 0)) || 0;
let selfVoice = false;
let screenSharing = false;
let screenStream = null;
let screenSentTo = new Set();
let screenHasAudio = false;
let screenAudioMuted = false;
let screenAudioBlocked = false;
let screenRetryTimers = new Map();
let screenRetryCount = new Map();
const screenViews = new Map();
let activeScreen = "";
let currentPlayback = null;
let localMode = false;
let currentLocalUrl = null;
let localFileId = "";
let pendingLocalState = null;
let fileOfferId = "";
let currentBundleId = "";
const linkUpgrades = new Set();
let tracksHintTimer = 0;
let siteCfg = null;
let chatEnabled = true;
let flagStates = {};
let flagContext = { role: "member", user: "", plan: "", room: code, server: "local" };

function allow(flagId, message) {
  if (flagOn(flagStates, flagId)) return true;
  if (message) toast(message, "error");
  return false;
}

function fileUploadAllowed() {
  return siteCfg?.room?.allowFileUpload !== false && flagOn(flagStates, "watch.localFile");
}

function refreshRuntimeFlags() {
  flagContext = buildFlagContext({ user: authUser, room: code, server: "local" });
  const center = readFeatureCenter();
  flagStates = resolveFlags(siteCfg, center.scopes, flagContext);
  applyFlagsToDom(siteCfg, center, flagContext, document, flagStates);
  applyFeatureFlags();
  syncPrefsGate();
  return flagStates;
}

let prefsReady = false;
let markThemeUI = () => {};
let markAccentUI = () => {};

function syncPrefsGate() {
  if (!prefsReady) return;
  const blocked = !flagOn(flagStates, "account.customThemes");
  const note = $("#prefsLockedNote");
  if (note) note.hidden = !blocked;
  $("#prefCard")?.classList.toggle("prefs-locked", blocked);
  $$("#themeRow .theme-opt").forEach((b) => { b.disabled = blocked; });
  $$("#accentRow .accent-swatch").forEach((b) => { b.disabled = blocked; });
  const custom = $("#accentCustom");
  if (custom) custom.disabled = blocked;
  $("#accentCustomWrap")?.classList.toggle("is-disabled", blocked);
  if (blocked) {
    if (siteCfg) applyGlobalTheme(siteCfg);
  } else {
    applyUIPrefs(getPrefs());
    markThemeUI();
    markAccentUI();
  }
}

function applyPrivacyFlags() {
  if (!isHost) return;
  const open = flagOn(flagStates, "rooms.public");
  const priv = flagOn(flagStates, "rooms.private") && flagOn(flagStates, "rooms.password");
  if (privacyParam === "password" && !priv && open) privacyParam = "public";
  else if (privacyParam === "public" && !open && priv && roomPassword) privacyParam = "password";
}

const chatList = $("#chatList");
const peopleList = $("#peopleList");
const queueList = $("#queueList");
const typingUsers = new Map();
let canSend = createLimiter(12, 8000);
let replyTo = null;
let editingId = null;
let searchTerm = "";
let chatJumpCount = 0;
let lastChatMsgAt = 0;
const CHAT_TIMER_KEY = "wt.chatTimer";
let chatTimerElapsed = 0;
let chatTimerSince = null;
const ALWAYS_SCROLL_KEY = "wt.alwaysScroll";
let alwaysScroll = store.get(ALWAYS_SCROLL_KEY, false) === true;
let chatHidden = store.get("wt.chatHidden", false) === true;
let cineStayOpen = getPrefs().cineStayOpen !== false;
const pendingChat = new Map();
const pendingDeletes = new Set();
let chatCooldownUntil = 0;
let chatCooldownTimer = 0;
let chatFollow = true;
let chatUserPaused = false;
let chatScrollLock = false;
let chatLockTimer = 0;
let chatBottomFrame = 0;
let chatBottomTimer = 0;
let broadcastTimer = 0;
let chatTimerInterval = 0;
let typingTimer = 0;
const MAX_CHAT_NODES = 400;

function cssEscape(value) {
  const raw = String(value ?? "");
  if (globalThis.CSS?.escape) return CSS.escape(raw);
  return raw.replace(/["\\]/g, "\\$&");
}

/* ================= boot ================= */
if (code && authUser) boot();

async function boot() {
  siteCfg = await loadSiteConfig();
  applySiteConfig(siteCfg);
  refreshRuntimeFlags();
  applyPrivacyFlags();
  listenLiveConfig((cfg) => {
    siteCfg = cfg;
    applySiteConfig(cfg);
    refreshRuntimeFlags();
    applyPrivacyFlags();
  });
  window.addEventListener("wt:config", () => { applySiteConfig(siteCfg); refreshRuntimeFlags(); applyPrivacyFlags(); });
  if (isMaintenanceBlocked(siteCfg)) return;
  if (isLocallyBanned(authUser.username)) {
    location.replace("index.html");
    return;
  }
  if (!flagOn(flagStates, "system.realtime")) {
    toast(getLang() === "fa" ? "موتور اتصال زنده توسط مالک سایت غیرفعال شده است." : "Live connectivity has been disabled by the site owner.", "error");
    setTimeout(() => location.replace("./"), 1600);
    return;
  }
  if (isHost && !flagOn(flagStates, "rooms.create")) {
    toast(getLang() === "fa" ? "ساخت اتاق موقتاً بسته شده است." : "Room creation is temporarily closed.", "error");
    setTimeout(() => location.replace("./"), 1400);
    return;
  }
  if (!isHost && !flagOn(flagStates, "rooms.join")) {
    toast(getLang() === "fa" ? "ورود به اتاق‌ها موقتاً بسته شده است." : "Joining rooms is temporarily closed.", "error");
    setTimeout(() => location.replace("./"), 1400);
    return;
  }
  recordFeatureUse(isHost ? "rooms.create" : "rooms.join", {
    plan: flagContext.plan, role: flagContext.role, room: ""
  });
  const chatMax = Math.max(1, Number(siteCfg.limits.chatPerWindow) || 6);
  const chatWindow = Math.max(500, Number(siteCfg.limits.chatWindowMs) || 3000);
  canSend = createLimiter(chatMax * 2, chatWindow * 2);
  if (!nick) nick = await askName();
  if (!nick) { location.replace("./"); return; }
  store.set("wt.nick", nick);
  me.nick = nick;

  $("#roomTitle").textContent = isHost ? (roomNameParam || `Room ${code}`) : `Room ${code}`;
  $("#roomCodeLabel").textContent = code;

  player = new Player({
    video: $("#video"),
    frame: $("#videoFrame"),
    canControl: () => {
      if (!me.id) return false;
      return canControl();
    },
    onControl: ({ action, time, value, denied }) => {
      if (denied) { toast(t("toast.cantControl"), "error"); return; }
      if (localMode) { applyLocalControl(action, time, value); return; }
      if (action === "play") net.command("control", { action: "play" });
      else if (action === "pause") net.command("control", { action: "pause", time });
      else if (action === "seek") net.command("control", { action: "seek", time });
      else if (action === "rate") net.command("control", { action: "rate", value, time });
    },
    onTime: ({ current, duration }) => {
      $("#timeLabel").textContent = `${fmtTime(current)} / ${fmtTime(duration)}`;
      if (duration) $("#seek").value = String(Math.round((current / duration) * 1000));
      paintSeekFill(current, duration);
    },
    onLoaded: () => { clearMediaWatchdog(); hideMediaLoading(); hidePlayerError(); finishSample(true); syncStageEmpty(); },
    onError: (kind) => { hideMediaLoading(); if (!retrySample()) showPlayerError(kind); },
    onBuffering: (on) => {
      $("#videoFrame")?.classList.toggle("buffering", !!on && !!player?.url);
    },
    onLevels: (info) => renderQuality(info),
    onAudio: (info) => renderAudio(info),
    onText: (info) => renderTextTracks(info)
  });

  voice = new Voice({
    net,
    selfId: "",
    onSpeaking: (id, active) => markSpeaking(id, active),
    onPeers: () => renderVoiceTiles(),
    onError: (reason) => {
      const key = reason === "mic-denied" ? "toast.micDenied"
        : reason === "mic-missing" ? "toast.micMissing"
          : reason === "mic-insecure" ? "toast.micInsecure"
            : "toast.voiceDenied";
      toast(t(key), "error", 6000);
    }
  });

  guardPlaybackFlags();
  wirePlayer();
  wireChat();
  wireChatTimer();
  wireTabs();
  wirePeople();
  wireQueue();
  wireSettings();
  wireWakeLock();
  wireSleepTimer();
  wireQueueAuto();
  wireReactions();
  wireCineChat();
  wirePrefs();
  wireVoice();
  wireScreen();
  wirePtt();
  wireMisc();
  wireTooltips();
  wireViewport();
  wireSheet();
  wireFileLoad();
  applyCapabilityGates();
  wireRoomNotifToggle();
  wireInterruptions();
  applyFeatureFlags();
  broadcastTimer = setInterval(() => { if (!document.hidden) broadcastLocalState(); }, 4000);

  createNet();
  initRoomMgmt({ code, nick, onEvent: handleServerRoomEvent }).catch(() => {});
}

function handleServerRoomEvent(event) {
  if (!event || typeof event !== "object") return;
  if (event.event === "closed" || (event.type === "room" && event.event === "removed")) {
    toast(t(event.event === "closed" ? "room.closedToast" : "room.removedSelf"), "error", 6000);
    setTimeout(() => { location.href = "rooms.html"; }, 2600);
  }
}

function applyCapabilityGates() {
  const shareBtn = $("#shareBtn");
  if (shareBtn && !CAPS.screenShare) {
    shareBtn.classList.add("cap-off");
    shareBtn.title = t("toast.screenUnsupported");
    shareBtn.setAttribute("aria-label", shareBtn.title);
  }
  const pipBtn = $("#pipBtn");
  if (pipBtn && !CAPS.pip) {
    pipBtn.classList.add("cap-off");
    pipBtn.title = t("toast.pipUnsupported");
    pipBtn.setAttribute("aria-label", pipBtn.title);
  }
  const fullBtn = $("#fullBtn");
  if (fullBtn && !CAPS.fullscreen) {
    fullBtn.classList.add("cap-limited");
    fullBtn.title = t("toast.fullscreenFallback");
  }
  const voiceBtn = $("#voiceBtn");
  if (voiceBtn && (!CAPS.mic || !CAPS.webrtc)) {
    voiceBtn.classList.add("cap-off");
    voiceBtn.title = t("toast.voiceUnsupported");
    voiceBtn.setAttribute("aria-label", voiceBtn.title);
  }
  if (CAPS.vibrate && !CAPS.hover) document.documentElement.dataset.vibrate = "1";
}

function wireRoomNotifToggle() {
  const btn = $("#roomNotifBtn");
  if (!btn) return;
  if (!CAPS.notifications) { btn.classList.add("hidden"); return; }
  const uid = authUser?.username || "";
  const paint = () => {
    const perm = notifPermission();
    const tag = $("#roomNotifTag");
    if (!tag) return;
    if (perm !== "granted") tag.textContent = t("room.notifEnableTag");
    else tag.textContent = t(notifPrefs(uid).muted[code] ? "room.notifOffTag" : "room.notifOnTag");
    btn.title = tag.textContent;
  };
  btn.addEventListener("click", () => {
    const perm = notifPermission();
    if (perm === "default") { location.href = "profile.html#deviceCard"; return; }
    if (perm === "denied") return toast(t("profile.notifBlocked"), "error", 6500);
    if (perm === "unsupported") return toast(t("profile.notifUnsupported"), "error", 5000);
    const muted = !!notifPrefs(uid).muted[code];
    const roomTitle = $("#roomTitle")?.textContent || `Room ${code}`;
    setRoomNotif(uid, code, muted, roomTitle);
    toast(t(muted ? "room.notifUnmuted" : "room.notifMuted"), "info");
    paint();
  });
  document.addEventListener("langchange", paint);
  paint();
}
function applyFeatureFlags() {
  chatEnabled = flagOn(flagStates, "chat.text");
  document.querySelector(".room-shell")?.classList.toggle("no-chat", !chatEnabled);
  if (!chatEnabled) {
    $("#chatBadge")?.classList.add("hidden");
  }
  if (!flagOn(flagStates, "watch.queue")) {
    $$('.tab[data-tab="queue"]').forEach((n) => n.classList.add("feature-off"));
    $("#queueForm")?.classList.add("feature-off");
  }
  if (!flagOn(flagStates, "watch.subtitles")) {
    $("#subsPickBtn")?.closest(".setting")?.classList.add("feature-off");
  }
  const uploadOff = !fileUploadAllowed();
  $("#pickFileBtn")?.classList.toggle("feature-off", uploadOff);
  $("#fileInput")?.classList.toggle("feature-off", uploadOff);
  applyReactionVis();
  applyCineChat();
  const userAudioOn = flagOn(flagStates, "voice.volume");
  $$(".people-tools").forEach((n) => n.classList.toggle("hidden", !userAudioOn));
  if (!userAudioOn && voice) {
    for (const m of members) voice.setLocalMuted(m.id, false);
  }
  syncChatFab();
}

function createNet() {
  const maxCap = Number(siteCfg?.limits?.maxCapacity) || capacityParam;
  net = new Net({
    code, nick, isHost,
    password: roomPassword,
    roomName: roomNameParam,
    capacity: Math.min(capacityParam, maxCap),
    privacy: privacyParam,
    avatar: me.avatar,
    limits: siteCfg.limits
  });
  voice.net = net;
  wireNet();
  net.start();
}

/* ================= name / password gates ================= */
function overlayPrompt({ title, sub, type = "text", maxLength = 20, okLabel }) {
  return new Promise((resolve) => {
    const back = el("div", { class: "modal-backdrop" });
    const box = el("div", { class: "modal card" });
    const h = el("h2", { text: title });
    const p = el("p", { class: "muted", text: sub || "" });
    const input = el("input", { type, maxlength: maxLength, style: "margin-top:14px" });
    const actions = el("div", { class: "modal-actions" });
    const ok = el("button", { class: "btn btn-primary", text: okLabel || t("common.ok") });
    actions.append(ok);
    box.append(h, p, input, actions);
    back.append(box);
    document.body.append(back);
    setTimeout(() => input.focus(), 60);
    const done = (v) => { back.remove(); resolve(v); };
    ok.onclick = () => {
      const v = input.value.trim();
      if (!v) return input.focus();
      done(v);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") ok.click();
      if (e.key === "Escape") done(null);
    };
    back.onclick = (e) => { if (e.target === back) done(null); };
  });
}

function askName() {
  return overlayPrompt({
    title: getLang() === "fa" ? "اسم نمایشی تو" : "Your display name",
    sub: getLang() === "fa" ? "این اسم برای دوستات نمایش داده می‌شود." : "Friends will see this name."
  }).then((v) => v ? v.slice(0, 20) : null);
}

function askPassword() {
  return overlayPrompt({
    title: getLang() === "fa" ? "رمز اتاق" : "Room password",
    sub: getLang() === "fa" ? "این اتاق رمز دارد." : "This room is password protected.",
    type: "password",
    maxLength: 32,
    okLabel: getLang() === "fa" ? "ورود" : "Join"
  });
}

/* ================= net events ================= */
function wireNet() {
  net.on("status", (s) => {
    const dot = $("#netStatus");
    dot.dataset.state = s;
    $("#netLabel").textContent = s === "online" ? t("net.online") : s === "connecting" ? t("net.connecting") : t("net.offline");
    if (s === "online") {
      $("#connLostBar")?.classList.add("hidden");
      resendPendingChat();
      requestPlaybackSync();
    }
    if (s !== "online") {
      $("#netPing")?.classList.add("hidden");
      $("#netLink")?.classList.add("hidden");
    }
  });

  net.on("latency", ({ ms } = {}) => {
    const chip = $("#netPing");
    if (!chip || !Number.isFinite(ms)) return;
    chip.textContent = me.role === "owner" ? `${t("net.host")} · ${ms} ms` : `${ms} ms`;
    chip.title = me.role === "owner" ? t("net.pingHostTitle") : t("net.pingTitle");
    chip.classList.remove("hidden", "good", "warn", "bad");
    chip.classList.add(ms < 90 ? "good" : ms < 200 ? "warn" : "bad");
  });

  net.on("link", ({ relay } = {}) => {
    const chip = $("#netLink");
    if (!chip || me.role === "owner") return;
    chip.textContent = relay ? t("net.relay") : t("net.p2p");
    chip.classList.remove("hidden");
    chip.classList.toggle("relay", !!relay);
  });

  net.on("welcome", (data) => {
    me.id = data.self.id;
    me.role = data.self.role;
    me.nick = data.self.nick;
    me.avatar = data.self.avatar || me.avatar;
    me.perms = data.self.perms || {};
    voice.selfId = me.id;
    roomInfo = data.room;
    members = data.members || [];
    $("#roomTitle").textContent = data.room?.name || $("#roomTitle").textContent;
    renderMembers();
    renderQueue(data.queue || []);
    applyRoomSettings(data.room);
    for (const msg of data.chat || []) appendMessage(msg, false);
    syncChatEmpty();
    scrollChat(true);
    if (data.playback?.url) {
      currentPlayback = rebasePlayback(data.playback);
      player.applyState(currentPlayback);
      updatePlayUI(currentPlayback.playing);
    }
    syncStageEmpty();
    $("#netLabel").textContent = t("net.online");
    $("#connLostBar")?.classList.add("hidden");
    if (isHost) touchLobby(currentUser(), code).catch(() => {});
    recordActivity(authUser, isHost ? "room.host" : "room.join", { room: code }).catch(() => {});
    const ping = $("#netPing");
    if (ping && me.role === "owner") {
      ping.textContent = t("net.host");
      ping.title = t("net.pingHostTitle");
      ping.classList.remove("hidden");
    }
  });

  net.on("members", (list) => {
    members = list;
    const mine = list.find((m) => m.id === me.id);
    if (mine) { me.role = mine.role; me.nick = mine.nick; me.perms = mine.perms || {}; if (mine.avatar) me.avatar = mine.avatar; }
    const ids = new Set(list.map((m) => m.id));
    if (seenMemberIds) {
      for (const m of list) {
        if (m.id && m.id !== me.id && !seenMemberIds.has(m.id)) {
          notifyActivity(authUser?.username, {
            roomId: code,
            roomName: $("#roomTitle")?.textContent || `Room ${code}`,
            text: t("notif.joinText", { name: m.nick || "" }),
            url: location.pathname + location.search
          });
        }
      }
    }
    seenMemberIds = ids;
    syncAdminTools();
    paintManagerOptions(roomInfo);
    renderMembers();
    if (sheetMemberId) {
      const open = memberById(sheetMemberId);
      if (open) renderPersonSheet(open);
      else closePersonSheet();
    }
    refreshChatAvatars();
    const voices = list.filter((m) => m.voice && m.id !== me.id).map((m) => m.id);
    if (selfVoice) voices.forEach((id) => voice.peerVoice(id, true));
    syncScreenSharePeers();
  });

  net.on("memberSelf", ({ role, perms } = {}) => {
    if (role) me.role = role;
    if (perms) me.perms = perms;
    syncAdminTools();
    renderMembers();
  });

  net.on("notice", ({ text } = {}) => {
    if (text) toast(text, "info", 4200);
  });

  net.on("chat", (msg) => {
    reconcileChat(msg);
    notifyChat(authUser?.username, {
      roomId: code,
      roomName: $("#roomTitle")?.textContent || `Room ${code}`,
      msg,
      selfNick: me.nick,
      url: location.pathname + location.search
    });
    persistChatEntry(msg);
    const near = isChatNearBottom();
    const mine = msg.by === me.id;
    const follow = mine || near || (alwaysScroll && !chatUserPaused);
    appendMessage(msg, true);
    noteIncomingChat();
    if (follow) {
      chatFollow = true;
      chatUserPaused = false;
      scrollChatSoon(true);
    } else {
      chatFollow = false;
      paintChatJump();
    }
    if (near || mine) chatJumpCount = 0;
    else if (msg.by !== me.id) chatJumpCount = Math.min(99, chatJumpCount + 1);
    paintChatJump();
  });
  net.on("reaction", (r) => {
    if (!r?.emoji) return;
    const mine = r.by ? r.by === me.id : (r.nick && r.nick === me.nick && Date.now() - (r.at || 0) < 250);
    if (mine) return;
    floatReaction(r.emoji);
  });
  net.on("chatUpdate", (msg) => updateMessage(msg));
  net.on("chatClear", ({ by } = {}) => {
    clearChatHistory();
    toast(t("toast.chatClearedBy", { name: by || "?" }), "success");
  });
  net.on("typing", ({ id, nick: n }) => {
    if (id === me.id) return;
    typingUsers.set(id, { nick: n, at: Date.now() });
    renderTyping();
  });
  net.on("slow", (wait) => toast(t("toast.slowWait", { s: String(wait || 1) }), "info"));
  net.on("playback", (state) => {
    if (state?.kind === "local") {
      pendingLocalState = state;
      if (localFileId && state.id === localFileId && player.url) {
        localMode = true;
        $("#localBadge").classList.remove("hidden");
        $("#localBadge").textContent = t("room.localBadgeGuest");
        applyLocalState(state);
        syncStageEmpty();
      }
      return;
    }
    if (state?.url && state.url !== (player.state?.url || player.url)) { localMode = false; }
    localFileId = "";
    fileOfferId = "";
    $("#fileOfferBar").classList.add("hidden");
    $("#localBadge").classList.add("hidden");
    currentPlayback = rebasePlayback(state);
    player.applyState(currentPlayback);
    updatePlayUI(currentPlayback.playing);
    syncStageEmpty();
    if (currentPlayback.playing) watchAutoplay(currentPlayback);
    if (currentPlayback.url) maybeUpgradeLink(currentPlayback.url);
  });

  net.on("fileOffer", ({ id, name, size }) => {
    if (isHost || !id) return;
    if (localFileId === id && player.url) return;
    fileOfferId = id;
    $("#foName").textContent = name || "video";
    $("#foSub").textContent = t("room.fileOfferSub", { size: fmtBytes(size) });
    $("#fileOfferBar").classList.remove("hidden");
  });

  net.on("fileProgress", ({ id, received, size }) => {
    if (!fileOfferId || id !== fileOfferId) return;
    const p = size ? received / size : 0;
    setPrepProgress(p);
    $("#prepSub").textContent = `${fmtBytes(received)} / ${fmtBytes(size)} · ${Math.round(p * 100)}%`;
  });

  net.on("localFile", (file) => receiveLocalFile(file));
  net.on("subs", (cues) => {
    if (isHost || !Array.isArray(cues) || !cues.length) return;
    player.setCues(cues, t("subs.host"));
    renderSubsSets();
    toast(t("toast.subsShared"), "success");
  });
  net.on("queue", (items) => renderQueue(items));
  net.on("room", (room) => { roomInfo = room; applyRoomSettings(room); });

  net.on("deny", async (reason) => {
    if (reason === "password") {
      const pwd = await askPassword();
      if (!pwd) { location.replace("./"); return; }
      saveRoomPassword(pwd);
      try { net.destroy(); } catch {}
      createNet();
      return;
    }
    const map = {
      locked: t("toast.roomLocked"), full: t("toast.roomFull"),
      not_found: t("toast.connLost"), unreachable: t("toast.signalUnreachable"),
      banned: t("toast.youWereBanned"), removed: t("toast.youWereRemoved"),
      rejected: getLang() === "fa" ? "میزبان ورود را تأیید نکرد" : "Host declined the request"
    };
    const removal = reason === "removed" || reason === "banned";
    if (removal) urgentToast(map[reason], "error", 8000);
    else toast(map[reason] || t("toast.connLost"), "error", 6000);
    $("#connLostBar")?.classList.add("hidden");
    const netLabel = $("#netLabel");
    if (netLabel) netLabel.textContent = t("net.offline");
    const grace = removal ? 4200 : 2200;
    setTimeout(() => location.replace("./"), grace);
  });

  net.on("kicked", ({ reason, by } = {}) => {
    $("#connLostBar")?.classList.add("hidden");
    try { net.destroy(); } catch {}
    const text = by
      ? t("toast.removedBy", { name: by })
      : reason === "ban" ? t("toast.youWereBanned") : t("toast.youWereKicked");
    urgentToast(text, "error", 8000);
    const stage = $("#connLostBar");
    if (stage) stage.classList.add("hidden");
    setTimeout(() => location.replace("./"), 4200);
  });

  let retryTimer = 0;
  const showLost = () => {
    $("#connLostBar")?.classList.remove("hidden");
    $("#netLabel").textContent = t("net.lostTitle");
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (navigator.onLine && !net.isReady()) safeReload();
    }, 5000);
  };
  net.on("disconnected", showLost);
  window.addEventListener("offline", showLost);
  window.addEventListener("online", () => {
    if (net.isReady()) {
      $("#connLostBar")?.classList.add("hidden");
      toast(t("net.backOnline"), "success", 2400);
    } else {
      try { net.retry(); } catch {}
      setTimeout(() => { if (navigator.onLine && !net.isReady()) safeReload(); }, 4500);
    }
  });
  net.on("closed", () => {
    $("#connLostBar")?.classList.add("hidden");
    toast(t("toast.lobbyClosed"), "info", 3200);
    setTimeout(() => location.replace("./"), 1400);
  });

  net.on("denied", (reason) => {
    if (reason === "control") toast(t("toast.cantControl"), "error");
    else if (reason === "blocked") toast(t("toast.blockedDomain"), "error");
    else if (reason === "chat_clear") toast(t("chat.clearDenied"), "error");
    else if (reason === "chat_delete") toast(t("chat.deleteFailed"), "error");
    else toast(t("toast.videoInvalid"), "error");
  });

  net.on("chatClearResult", ({ ok, code } = {}) => {
    if (ok) return;
    if (code === "empty") toast(t("chat.clearEmpty"), "info", 3200);
    else toast(t("chat.clearDenied"), "error");
  });

  net.on("chatDeleteResult", ({ ok } = {}) => {
    if (!ok) toast(t("chat.deleteFailed"), "error");
  });

  net.on("throttle", () => toast(t("toast.slowDown"), "error"));

  net.on("chatAck", (ack) => ackChat(ack));

  net.on("chatBlocked", ({ code, cid, retryAfter } = {}) => {
    if (cid) dropPendingChat(cid, { restore: true });
    if (code === "muted") {
      toast(t("chat.mutedSelf"), "error", 4200);
      return;
    }
    if (code === "chat_disabled") {
      toast(t("toast.chatDisabled"), "error", 4200);
      return;
    }
    if (retryAfter > 0) startChatCooldown(retryAfter);
    else toast(t("toast.slowDown"), "error");
  });

  net.on("joinRequest", async ({ peerId, nick: n }) => {
    const ok = await confirmDialog({
      title: getLang() === "fa" ? "درخواست ورود" : "Join request",
      text: `${n} ${getLang() === "fa" ? "می‌خواهد وارد شود" : "wants to join"}`,
      okLabel: t("common.ok")
    });
    net.approve(peerId, ok);
  });

  net.on("forceMute", (muted) => {
    voice.setMuted(muted);
    syncMicUI();
    toast(getLang() === "fa" ? "میکروفون تو توسط مدیر بسته شد" : "A moderator muted you", "error");
  });

  net.on("voice", ({ id, on }) => {
    if (!selfVoice || id === me.id) return;
    voice.peerVoice(id, on);
    if (on) applyUserAudio(id, nickFor(id));
    renderVoiceTiles();
  });

  net.on("incomingCall", (call) => voice.handleCall(call));

  net.on("incomingScreen", ({ from }) => { net.answerScreen(from).catch(() => {}); });
  net.on("screenStream", ({ from, stream }) => {
    screenViews.delete(from);
    screenViews.set(from, stream);
    if (!activeScreen || activeScreen === from) showScreenView(from, stream);
  });
  net.on("screenEnded", (from) => {
    if (!screenViews.has(from)) return;
    screenViews.delete(from);
    const who = nickFor(from);
    if (activeScreen === from) {
      const next = [...screenViews.entries()].pop();
      if (next) showScreenView(next[0], next[1]);
      else hideScreenView();
    }
    toast(t("toast.screenEnded", { name: who }), "info");
  });
  net.on("screenStopRequested", () => {
    if (!screenSharing) return;
    toast(t("toast.screenManagerStopped"), "info", 6000);
    stopScreenShare({ quiet: true });
  });
  net.on("screenPeerRetry", (peerId) => scheduleScreenRetry(peerId));
  net.on("screenConnected", (peerId) => { screenRetryCount.delete(peerId); });
  net.on("status", (status) => { if (status === "online") syncScreenSharePeers(); });

  net.on("error", (kind) => {
    if (kind === "code-taken") toast(getLang() === "fa" ? "این کد در حال استفاده است" : "Code already in use", "error");
    else if (kind === "unreachable") toast(t("toast.signalUnreachable"), "error");
    else toast(t("toast.connLost"), "error");
  });
}

/* ================= player ui ================= */
function guardPlaybackFlags() {
  const originalTogglePlay = player.togglePlay.bind(player);
  player.togglePlay = (...args) => {
    const idle = player.video?.paused;
    if (idle && !allow("watch.play", "پخش توسط مالک سایت محدود شده است.")) return false;
    if (!idle && !allow("watch.pause", "توقف پخش توسط مالک سایت محدود شده است.")) return false;
    recordFeatureUse(idle ? "watch.play" : "watch.pause", { plan: flagContext.plan, role: flagContext.role, room: code });
    centerPingAt = performance.now();
    return originalTogglePlay(...args);
  };
  const originalSeekTo = player.seekTo.bind(player);
  player.seekTo = (time) => {
    if (!allow("watch.seek", "جابه‌جایی زمان توسط مالک سایت محدود شده است.")) return false;
    recordFeatureUse("watch.seek", { plan: flagContext.plan, role: flagContext.role, room: code });
    return originalSeekTo(time);
  };
  const originalSeekBy = player.seekBy.bind(player);
  player.seekBy = (delta) => {
    if (!allow("watch.seek", "جابه‌جایی زمان توسط مالک سایت محدود شده است.")) return false;
    return originalSeekBy(delta);
  };
  const originalRate = player.cycleRate.bind(player);
  player.cycleRate = () => {
    if (!allow("watch.rate", "تغییر سرعت توسط مالک سایت محدود شده است.")) return player.video?.playbackRate || 1;
    recordFeatureUse("watch.rate", { plan: flagContext.plan, role: flagContext.role, room: code });
    return originalRate();
  };
  const originalPiP = player.togglePiP.bind(player);
  player.togglePiP = () => {
    if (!allow("watch.pip", "تصویر در تصویر توسط مالک سایت محدود شده است.")) return;
    return originalPiP();
  };
  const originalTheater = player.toggleTheater.bind(player);
  player.toggleTheater = () => {
    if (!allow("watch.theater", "حالت سینما توسط مالک سایت محدود شده است.")) return false;
    return originalTheater();
  };
}

function wirePlayer() {
  const video = $("#video");
  $("#playBtn").addEventListener("click", resumeOrTogglePlay);
  $("#bigPlayBtn")?.addEventListener("click", resumeOrTogglePlay);
  $("#back5").addEventListener("click", () => player.seekBy(-5));
  $("#back10").addEventListener("click", () => player.seekBy(-10));
  $("#fwd5").addEventListener("click", () => player.seekBy(5));
  $("#fwd10").addEventListener("click", () => player.seekBy(10));
  $("#speedBtn").addEventListener("click", () => {
    const r = player.cycleRate();
    $("#speedBtn").textContent = `${r}×`;
  });
  $("#fullBtn").addEventListener("click", async () => {
    if (!document.fullscreenElement && !CAPS.fullscreen) {
      player.toggleTheater();
      return toast(t("toast.fullscreenFallback"), "info");
    }
    const ok = await player.toggleFullscreen();
    if (!ok) toast(t("toast.fullscreenFallback"), "info");
    if (document.fullscreenElement && CAPS.orientationLock && CAPS.coarse) {
      const v = player.video;
      if (v.videoWidth > v.videoHeight) screen.orientation.lock("landscape").catch(() => {});
    }
  });
  $("#pipBtn").addEventListener("click", () => {
    if (!CAPS.pip) return toast(t("toast.pipUnsupported"), "error", 5000);
    player.togglePiP();
  });
  $("#castBtn")?.addEventListener("click", async () => {
    try { await video.remote.prompt(); }
    catch { toast(t("toast.castFail"), "error"); }
  });
  if ("remote" in HTMLVideoElement.prototype && video.remote) $("#castBtn").classList.remove("hidden");
  $("#theaterBtn").addEventListener("click", () => player.toggleTheater());
  $("#subsBtn").addEventListener("click", () => activateTab("settings"));

  const seek = $("#seek");
  const tip = $("#seekTip");
  const seekTimeAt = (clientX) => {
    const rect = seek.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    return { time: ratio * (video.duration || 0), ratio };
  };
  const showSeekTip = (e) => {
    if (!tip || !video.duration) return;
    const { time } = seekTimeAt(e.clientX);
    const rect = seek.getBoundingClientRect();
    const frame = $("#videoFrame").getBoundingClientRect();
    tip.textContent = fmtTime(time);
    tip.style.left = `${Math.max(24, Math.min(frame.width - 24, e.clientX - frame.left))}px`;
    tip.style.bottom = `${Math.max(10, frame.bottom - rect.top + 12)}px`;
    tip.classList.remove("hidden");
  };
  const hideSeekTip = () => { if (!seek.classList.contains("dragging")) tip?.classList.add("hidden"); };

  seek.addEventListener("input", (e) => {
    const d = video.duration || 0;
    const pct = Number(e.target.value) / 10;
    const track = seek.closest(".seek-wrap") || seek;
    track.style.setProperty("--seek-progress", `${pct}%`);
    seek.style.setProperty("--seek-progress", `${pct}%`);
    $("#timeLabel").textContent = `${fmtTime((e.target.value / 1000) * d)} / ${fmtTime(d)}`;
  });
  seek.addEventListener("change", (e) => {
    const d = video.duration || 0;
    if (d) player.seekTo((e.target.value / 1000) * d);
  });
  seek.addEventListener("pointermove", showSeekTip);
  seek.addEventListener("pointerdown", (e) => {
    seek.classList.add("dragging");
    showSeekTip(e);
  });
  const stopSeekDrag = () => {
    seek.classList.remove("dragging");
    tip?.classList.add("hidden");
  };
  seek.addEventListener("pointerup", stopSeekDrag);
  seek.addEventListener("pointercancel", stopSeekDrag);
  window.addEventListener("pointerup", stopSeekDrag, { passive: true });
  seek.addEventListener("pointerleave", hideSeekTip);
  const paintFromVideo = () => paintSeekFill(video.currentTime || 0, video.duration || 0);
  video.addEventListener("progress", paintFromVideo);
  video.addEventListener("durationchange", paintFromVideo);
  video.addEventListener("loadedmetadata", paintFromVideo);

  $("#loadVideoBtn").addEventListener("click", loadVideoFromInput);
  $("#sampleBtn").addEventListener("click", () => {
    if (samplePending) return;
    startSample(0);
  });
  $("#peFileBtn")?.addEventListener("click", () => $("#fileInput")?.click());
  $("#peSampleBtn")?.addEventListener("click", () => {
    hidePlayerError();
    if (!player.canControl()) return toast(t("toast.cantControl"), "error");
    if (!samplePending) startSample(0);
  });
  $("#peCloseBtn")?.addEventListener("click", hidePlayerError);
  $("#videoUrlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") loadVideoFromInput(); });

  const showTapHint = (side) => {
    const frame = $("#videoFrame");
    const hint = el("div", { class: `tap-hint ${side}`, text: side === "left" ? "−10s" : "+10s" });
    frame.append(hint);
    setTimeout(() => hint.remove(), 620);
  };

  let lastTap = 0;
  video.addEventListener("click", (e) => {
    if (performance.now() - lastGestureAt < 400) return;
    if (!matchMedia("(pointer: coarse)").matches) { player.togglePlay(); return; }
    const now = performance.now();
    if (now - lastTap < 280) {
      /* Android does not reliably synthesise dblclick for touches, so the
         second tap itself performs the ±10s seek */
      lastTap = 0;
      if (!player?.url) return;
      const rect = video.getBoundingClientRect();
      const ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
      if (ratio >= 0.3 && ratio <= 0.7) return;
      const forward = ratio > 0.7;
      player.seekBy(forward ? 10 : -10);
      showTapHint(forward ? "right" : "left");
      return;
    }
    lastTap = now;
    setTimeout(() => {
      if (lastTap !== now) return;
      lastTap = 0;
      player.togglePlay();
    }, 240);
  });
  video.addEventListener("dblclick", (e) => {
    if (matchMedia("(pointer: coarse)").matches) return;
    if (!player?.url) return;
    const rect = video.getBoundingClientRect();
    const ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
    if (ratio >= 0.3 && ratio <= 0.7) return;
    const forward = ratio > 0.7;
    player.seekBy(forward ? 10 : -10);
    showTapHint(forward ? "right" : "left");
  });
  wireVideoGestures(video);
  video.addEventListener("play", () => updatePlayUI(true));
  video.addEventListener("pause", () => updatePlayUI(false));

  const volRange = $("#volRange");
  const volBtn = $("#volBtn");
  const storedVol = store.get("wt.vol", null);
  const initialVol = typeof storedVol === "number" ? Math.min(1, Math.max(0, storedVol)) : 1;
  video.volume = initialVol;
  video.muted = store.get("wt.muted", false) === true;
  const syncVolume = () => {
    const silent = video.muted || video.volume === 0;
    const pct = Math.round(video.volume * 100);
    volRange.value = String(pct);
    volRange.style.setProperty("--vol", `${pct}%`);
    $(".i-vol", volBtn).classList.toggle("hidden", silent);
    $(".i-mute", volBtn).classList.toggle("hidden", !silent);
    volBtn.title = silent ? "Unmute" : "Mute";
  };
  volRange.addEventListener("input", () => {
    const level = Number(volRange.value) / 100;
    video.volume = level;
    video.muted = level === 0;
    volRange.style.setProperty("--vol", `${Math.round(level * 100)}%`);
    store.set("wt.vol", level);
    store.set("wt.muted", video.muted);
  });
  volBtn.addEventListener("click", () => {
    if (video.muted || video.volume === 0) {
      if (video.volume === 0) video.volume = 0.6;
      video.muted = false;
    } else {
      video.muted = true;
    }
    store.set("wt.muted", video.muted);
    store.set("wt.vol", video.volume);
  });
  video.addEventListener("volumechange", syncVolume);
  syncVolume();

  document.addEventListener("keydown", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("input,textarea,select,[contenteditable]")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      if (overlayStatePushed) popOverlayState();
      else $("#sidebar").classList.remove("open");
      return;
    }
    if (!player?.url) return;
    const k = e.key.toLowerCase();
    const back = getLang() === "fa" ? 1 : -1;
    if (k === " " && target?.closest("button,a")) return;
    if (k === " " || k === "k") { e.preventDefault(); player.togglePlay(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); player.seekBy(5 * -back); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); player.seekBy(5 * back); }
    else if (k === "j") { e.preventDefault(); player.seekBy(-10); }
    else if (k === "l") { e.preventDefault(); player.seekBy(10); }
    else if (k === "f") { e.preventDefault(); player.toggleFullscreen(); }
    else if (k === "t") { e.preventDefault(); player.toggleTheater(); }
    else if (k === "p") { e.preventDefault(); player.togglePiP(); }
    else if (k === "m" && selfVoice) { e.preventDefault(); $("#micBtn").click(); }
  });

  let idleTimer = null;
  const controls = $("#stageControls");
  const frame = $("#videoFrame");
  const wake = () => {
    controls.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused) controls.classList.add("idle"); }, 2600);
  };
  ["mousemove", "touchstart", "click"].forEach((ev) => frame.addEventListener(ev, wake));
  wake();
}

function paintSeekFill(current, duration) {
  const seek = $("#seek");
  if (!seek) return;
  const total = Number(duration) || 0;
  const time = Math.max(0, Number(current) || 0);
  const watched = total ? Math.min(100, Math.max(0, (time / total) * 100)) : 0;
  let buffered = 0;
  const video = $("#video");
  try {
    const ranges = video?.buffered;
    for (let i = 0; ranges && i < ranges.length; i++) {
      if (ranges.start(i) <= time + 0.3 && ranges.end(i) >= time) buffered = ranges.end(i);
    }
  } catch {}
  const bufferedPct = total ? Math.min(100, Math.max(watched, (buffered / total) * 100)) : 0;
  const track = seek.closest(".seek-wrap") || seek;
  track.style.setProperty("--seek-progress", `${watched}%`);
  track.style.setProperty("--seek-buffer", `${bufferedPct}%`);
  seek.style.setProperty("--seek-progress", `${watched}%`);
  seek.style.setProperty("--seek-buffer", `${bufferedPct}%`);
}

function watchAutoplay(state) {
  setTimeout(() => {
    if (!state?.playing || !currentPlayback?.playing) return;
    if (!player.video.paused) return;
    if (player.video.readyState < 2) return;
    updatePlayUI(false);
    if (!autoplayHintShown) {
      autoplayHintShown = true;
      toast(t("toast.tapToPlay"), "info", 3200);
    }
  }, 1200);
}

function resumeOrTogglePlay() {
  if (currentPlayback?.playing && player.video.paused) {
    player.applyState(currentPlayback);
    return;
  }
  player.togglePlay();
}

function requestPlaybackSync() {
  if (!net || isHost || !net.ready) return;
  net.command("syncRequest");
}

let centerPingAt = 0;
let centerPingTimer = 0;

function flashCenter(playing) {
  const ping = $("#centerPing");
  if (!ping) return;
  $(".i-play", ping).classList.toggle("hidden", playing);
  $(".i-pause", ping).classList.toggle("hidden", !playing);
  ping.classList.remove("hidden", "pop");
  void ping.offsetWidth;
  ping.classList.add("pop");
  clearTimeout(centerPingTimer);
  centerPingTimer = setTimeout(() => ping.classList.add("hidden"), 640);
}

function updatePlayUI(playing) {
  $("#playBtn .i-play").classList.toggle("hidden", playing);
  $("#playBtn .i-pause").classList.toggle("hidden", !playing);
  const big = $("#bigPlayBtn");
  if (big) {
    big.classList.remove("hidden");
    big.classList.toggle("is-playing", !!playing);
    $(".i-play", big).classList.toggle("hidden", !!playing);
    $(".i-pause", big).classList.toggle("hidden", !playing);
    const label = t(playing ? "player.pause" : "player.play");
    big.title = label;
    big.setAttribute("aria-label", label);
    big.setAttribute("aria-pressed", String(!!playing));
    if (centerPingAt && performance.now() - centerPingAt < 500) {
      centerPingAt = 0;
      flashCenter(!!playing);
    }
  }
}

function syncStageEmpty() {
  const stageEmpty = $("#stageEmpty");
  if (!stageEmpty) return;
  const has = !!player?.url;
  stageEmpty.classList.toggle("hidden", has);
  if (!has) hidePlayerError();
  $("#emptyBackBtn")?.classList.toggle("hidden", !has);
  $("#videoFrame").classList.toggle("has-media", has);
  if (has) maybeAutoOpenCine();
}

function maybeAutoOpenCine() {
  if (cineAutoOpened) return;
  cineAutoOpened = true;
  const introKey = `wt.cineIntro:${code}`;
  try { if (sessionStorage.getItem(introKey)) return; } catch {}
  if (cineExpanded || !cineOn || !chatEnabled) return;
  if (!flagOn(flagStates, "watch.floatingChat")) return;
  try { sessionStorage.setItem(introKey, "1"); } catch {}
  if (window.matchMedia("(max-width: 640px)").matches) return;
  toast(getLang() === "fa" ? "چت شناور فعال است؛ پیام‌ها روی فیلم ظاهر می‌شوند." : "Floating chat is on; messages appear over the movie.", "info", 2800);
}

function showMediaLoading() {
  $("#mediaLoading")?.classList.remove("hidden");
  clearMediaWatchdog();
  mediaWatchdog = setTimeout(() => {
    hideMediaLoading();
    if (samplePending) {
      toast(t("toast.sampleFailed"), "error", 5000);
      samplePending = false;
      resetSampleBtn();
    }
  }, 18000);
}

function hideMediaLoading() {
  clearMediaWatchdog();
  $("#mediaLoading")?.classList.add("hidden");
}

function clearMediaWatchdog() {
  if (mediaWatchdog) clearTimeout(mediaWatchdog);
  mediaWatchdog = 0;
}

function resetSampleBtn() {
  const btn = $("#sampleBtn");
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = t("room.sample");
}

function finishSample(ok) {
  if (!samplePending) return;
  samplePending = false;
  resetSampleBtn();
  if (!ok) return;
  if (player?.canControl?.() && player.video.paused) net.command("control", { action: "play" });
  toast(t("toast.sampleReady"), "success", 2200);
}

function startSample(index = 0) {
  const btn = $("#sampleBtn");
  samplePending = true;
  sampleIndex = index;
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("room.sampleLoading");
  }
  showMediaLoading();
  net.command("loadVideo", { url: SAMPLE_SOURCES[index] });
  if (player.canControl()) net.command("control", { action: "play" });
}

function retrySample() {
  if (!samplePending) return false;
  sampleIndex += 1;
  if (sampleIndex >= SAMPLE_SOURCES.length) {
    samplePending = false;
    resetSampleBtn();
    toast(t("toast.sampleFailed"), "error", 5000);
    return true;
  }
  startSample(sampleIndex);
  return true;
}

/* ---------- media errors with real explanations ---------- */
function showPlayerError(kind) {
  const box = $("#playerError");
  if (!box) return;
  const fa = getLang() === "fa";
  const body = $("#playerErrorBody");
  if (body) {
    if (kind === "network") {
      body.textContent = fa
        ? "سرور فایل جواب نداد یا اتصال قطع شد. لینک مستقیم را چک کن؛ فایل محلی هم همیشه مطمئن‌ترین راه است."
        : "The file server did not respond. Check the direct link, or use a local file — that always works.";
    } else if (kind === "aborted") {
      body.textContent = fa
        ? "بارگذاری نیمه‌کاره ماند. دوباره پخش کن یا فایل را دوباره انتخاب کن."
        : "Loading was interrupted. Try playing again or re-select the file.";
    } else {
      body.textContent = t("player.errorBody");
    }
  }
  $("#videoFrame")?.classList.remove("buffering");
  box.classList.remove("hidden");
}

function hidePlayerError() {
  $("#playerError")?.classList.add("hidden");
}

/* ---------- touch gestures: swipe for brightness / volume ---------- */
function wireVideoGestures(video) {
  if (!video || !CAPS.coarse) return;
  const hud = $("#gestureHud");
  const fill = $("#gestureFill");
  const val = $("#gestureVal");
  const icon = $("#gestureIcon");
  if (!hud || !fill || !val || !icon) return;

  const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>';
  const VOL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg>';

  let bright = Number(store.get("wt.bright", 1)) || 1;
  const applyBright = (v) => {
    bright = Math.max(0.25, Math.min(1, v));
    store.set("wt.bright", bright);
    video.style.filter = `brightness(${bright.toFixed(2)})`;
    return bright;
  };
  applyBright(bright);

  let mode = "";
  let startY = 0;
  let startX = 0;
  let base = 1;
  let active = false;
  let pid = null;
  let hideTimer = 0;

  const paint = (pct) => {
    fill.style.width = `${pct}%`;
    val.textContent = `${Math.round(pct)}%`;
  };
  const open = (kind) => {
    mode = kind;
    icon.innerHTML = kind === "volume" ? VOL : SUN;
    hud.classList.remove("hidden");
    clearTimeout(hideTimer);
  };
  const close = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hud.classList.add("hidden"), 700);
  };

  video.addEventListener("pointerdown", (e) => {
    if (!player?.url || e.pointerType === "mouse" || !e.isPrimary) return;
    pid = e.pointerId;
    startY = e.clientY;
    startX = e.clientX;
    active = false;
    mode = "";
  });
  video.addEventListener("pointermove", (e) => {
    if (pid !== e.pointerId || !player?.url) return;
    const dy = startY - e.clientY;
    const dx = Math.abs(e.clientX - startX);
    if (!active) {
      if (Math.abs(dy) < 14 || Math.abs(dy) < dx * 1.2) return;
      active = true;
      const rect = video.getBoundingClientRect();
      const leftSide = startX < rect.left + rect.width / 2;
      if (leftSide) { open("bright"); base = bright; }
      else {
        open("volume");
        if (video.muted) { video.muted = false; store.set("wt.muted", false); }
        base = video.volume;
      }
      lastGestureAt = performance.now();
    }
    e.preventDefault();
    const height = Math.max(120, video.getBoundingClientRect().height);
    const delta = dy / height;
    if (mode === "bright") {
      paint(applyBright(base + delta * 1.1) * 100);
    } else {
      const v = Math.max(0, Math.min(1, base + delta * 1.4));
      video.volume = v;
      video.muted = v === 0;
      store.set("wt.vol", v);
      store.set("wt.muted", video.muted);
      paint(v * 100);
    }
  });
  const end = (e) => {
    if (pid !== e.pointerId) return;
    if (active) { close(); lastGestureAt = performance.now(); }
    pid = null;
    active = false;
    mode = "";
  };
  video.addEventListener("pointerup", end);
  video.addEventListener("pointercancel", end);
}

/* Remote clocks can differ wildly between devices; anchor the shared
   timeline to the moment this device received it instead. */
function rebasePlayback(state) {
  if (!state?.playing) return state;
  return { ...state, at: Date.now() };
}

function loadVideoFromInput() {
  const url = $("#videoUrlInput").value.trim();
  const v = validateMediaUrl(url);
  if (!v.ok) return toast(v.reason === "blocked" ? t("toast.blockedDomain") : t("toast.videoInvalid"), "error");
  if (!canControl()) return toast(t("toast.cantControl"), "error");
  if (!net || !net.ready) return toast(t("net.lostTitle"), "error");
  showMediaLoading();
  net.command("loadVideo", { url: v.url });
}

/* ================= local files & conversion ================= */
function applyLocalControl(action, time, value) {
  const v = player.video;
  player.applying = true;
  setTimeout(() => { player.applying = false; }, 60);
  if (action === "play") {
    v.play().catch(() => {});
    player.state = { ...player.state, url: player.url, playing: true, time: v.currentTime, at: Date.now() };
  } else if (action === "pause") {
    v.pause();
    player.state = { ...player.state, url: player.url, playing: false, time: v.currentTime, at: Date.now() };
  } else if (action === "seek") {
    player.programmaticSeekAt = performance.now();
    v.currentTime = Math.max(0, Number(time) || 0);
    player.state = { ...player.state, url: player.url, time: v.currentTime, at: Date.now() };
  } else if (action === "rate") {
    v.playbackRate = Number(value) || 1;
    player.state = { ...player.state, url: player.url, rate: v.playbackRate, time: v.currentTime, at: Date.now() };
  }
  updatePlayUI(!v.paused);
  broadcastLocalState();
}

function localStatePayload() {
  return {
    id: localFileId,
    playing: !player.video.paused,
    time: player.video.currentTime || 0,
    rate: player.video.playbackRate || 1
  };
}

function broadcastLocalState() {
  if (!isHost || !localMode || !localFileId) return;
  net.syncLocalState(localStatePayload());
}

function applyLocalState(state) {
  const v = player.video;
  if (!player.url) return;
  player.state = {
    url: player.url,
    playing: !!state.playing,
    time: Math.max(0, Number(state.time) || 0),
    at: Date.now(),
    rate: Number(state.rate) || 1
  };
  const target = player.expectedTime();
  if (Number.isFinite(target) && Math.abs((v.currentTime || 0) - target) > 0.6) {
    player.programmaticSeekAt = performance.now();
    v.currentTime = target;
  }
  v.playbackRate = Math.max(0.25, Math.min(4, player.state.rate));
  if (state.playing) v.play().catch(() => {});
  else v.pause();
  updatePlayUI(!!state.playing);
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(1)} GB`;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

function receiveLocalFile({ id, name, size, url, blob }) {
  if (blob && size) {
    isBundle(blob).then(async (bundle) => {
      if (bundle) {
        try {
          const files = await unpackBundle(blob);
          const reg = await registerBundle(files);
          if (currentBundleId) releaseBundle(currentBundleId);
          currentBundleId = reg.id;
          if (currentLocalUrl) { URL.revokeObjectURL(currentLocalUrl); currentLocalUrl = null; }
          localFileId = id;
          localMode = true;
          player.setUrl(reg.url);
          player.state = { url: reg.url, playing: false, time: 0, at: Date.now(), rate: 1 };
          finishLocalReceive(id);
          return;
        } catch (err) {
          console.warn("hls bundle failed, using plain file", err);
        }
      }
      receivePlainLocalFile({ id, url });
    });
    return;
  }
  receivePlainLocalFile({ id, url });
}

function receivePlainLocalFile({ id, url }) {
  if (currentLocalUrl && currentLocalUrl !== url) URL.revokeObjectURL(currentLocalUrl);
  currentLocalUrl = url;
  localFileId = id;
  localMode = true;
  player.destroyHls();
  player.url = url;
  player.state = { url, playing: false, time: 0, at: Date.now(), rate: 1 };
  player.video.src = url;
  player.video.load();
  finishLocalReceive(id);
}

function finishLocalReceive(id) {
  $("#fileOfferBar").classList.add("hidden");
  hidePrep();
  $("#localBadge").classList.remove("hidden");
  $("#localBadge").textContent = t("room.localBadgeGuest");
  syncStageEmpty();
  toast(t("toast.fileReceived"), "success");
  if (pendingLocalState?.id === id) applyLocalState(pendingLocalState);
  else if (pendingLocalState?.playing) applyLocalState(pendingLocalState);
}

function wireFileLoad() {
  const input = $("#fileInput");
  const stage = $("#stage");
  $("#pickFileBtn").addEventListener("click", () => {
    if (!isHost) return toast(t("toast.hostOnlyFile"), "error");
    input.click();
  });
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    input.value = "";
    if (f) loadLocalFile(f);
  });
  $("#changeSourceBtn").addEventListener("click", () => {
    $("#stageEmpty").classList.remove("hidden");
    $("#emptyBackBtn")?.classList.toggle("hidden", !player?.url);
    $("#videoUrlInput").focus();
  });
  $("#emptyBackBtn")?.addEventListener("click", () => syncStageEmpty());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const stage = $("#stageEmpty");
    if (!stage || stage.classList.contains("hidden") || !player?.url) return;
    if ($("#modalBackdrop") && !$("#modalBackdrop").classList.contains("hidden")) return;
    syncStageEmpty();
  });
  $("#foGetBtn").addEventListener("click", () => {
    if (!fileOfferId) return;
    $("#fileOfferBar").classList.add("hidden");
    showPrep();
    $("#prepTitle").textContent = t("room.downloading");
    $("#prepSub").textContent = "0%";
    net.command("fileRequest", { id: fileOfferId });
  });
  $("#foDismiss").addEventListener("click", () => $("#fileOfferBar").classList.add("hidden"));

  stage.addEventListener("dragover", (e) => {
    if (!isHost) return;
    e.preventDefault();
    stage.classList.add("dragging");
  });
  stage.addEventListener("dragleave", () => stage.classList.remove("dragging"));
  stage.addEventListener("drop", (e) => {
    if (!isHost) return;
    e.preventDefault();
    stage.classList.remove("dragging");
    const f = e.dataTransfer?.files?.[0];
    if (f) loadLocalFile(f);
  });
}

const PREP_TEXT = {
  probe: ["در حال بررسی فرمت…", "Checking format…"],
  loading: ["آماده‌سازی موتور تبدیل…", "Loading converter…"],
  remux: ["بسته‌بندی مجدد (سریع)…", "Remuxing (fast)…"],
  verify: ["تست پخش فایل ساخته‌شده…", "Verifying output…"],
  transcode: ["تبدیل کامل به H.264 — ممکن است طول بکشد…", "Transcoding to H.264 — this can take a while…"],
  done: ["آماده شد", "Ready"]
};

function prepText(key) {
  const row = PREP_TEXT[key];
  if (!row) return "";
  return row[getLang() === "fa" ? 0 : 1];
}

function showPrep() {
  $("#prepOverlay").classList.remove("hidden");
  $("#prepBar").style.width = "0%";
  $("#prepSub").textContent = "";
  $("#prepTitle").textContent = getLang() === "fa" ? "در حال آماده‌سازی ویدیو…" : "Preparing video…";
}

function setPrepStatus(s) {
  if (PREP_TEXT[s]) $("#prepSub").textContent = prepText(s);
  if (s === "transcode") $("#prepBar").style.width = "0%";
}

function setPrepProgress(p) {
  $("#prepBar").style.width = `${Math.round(p * 100)}%`;
}

function hidePrep() {
  $("#prepOverlay").classList.add("hidden");
}

async function loadLocalFile(file) {
  if (!isHost) return toast(t("toast.hostOnlyFile"), "error");
  if (!fileUploadAllowed()) return toast(t("toast.fileUploadOff"), "error", 5000);
  if (!/^video\//.test(file.type) && !/\.(mkv|avi|mov|flv|wmv|ts|m2ts|mpg|mpeg|webm|ogv|mp4|m4v)$/i.test(file.name)) {
    return toast(t("toast.videoInvalid"), "error");
  }
  const maxMB = Math.max(1, Number(siteCfg?.upload?.maxFileMB) || 50);
  if (file.size > maxMB * 1024 * 1024) {
    return toast(t("toast.fileTooLarge", { max: maxMB }), "error", 6000);
  }
  showPrep();
  try {
    const { prepareLocalVideo } = await import("./transcode.js");
    const res = await prepareLocalVideo(file, {
      onStatus: setPrepStatus,
      onProgress: setPrepProgress
    });
    if (res.hls) {
      const packed = await packBundle(res.files);
      const reg = await registerBundle(res.files);
      if (currentBundleId) releaseBundle(currentBundleId);
      currentBundleId = reg.id;
      res.url = reg.url;
      res.blob = packed;
    }
    if (currentLocalUrl) { URL.revokeObjectURL(currentLocalUrl); currentLocalUrl = null; }
    if (!res.hls) currentLocalUrl = res.url;
    startLocalPlayback(res, file.name);
    if (!res.hls) maybeUpgradeLocal(file);
  } catch (err) {
    console.error(err);
    toast(t(err?.message === "cdn-unavailable" ? "toast.converterOffline" : "toast.convertFailed"), "error");
  } finally {
    hidePrep();
  }
}

function startLocalPlayback(res, fileName) {
  const { url, hls, converted, blob } = res;
  localMode = true;
  player.destroyHls();
  if (hls) player.setUrl(url);
  else {
    player.url = url;
    player.video.src = url;
    player.video.load();
  }
  player.state = { url, playing: false, time: 0, at: Date.now(), rate: 1 };
  syncStageEmpty();
  $("#localBadge").classList.remove("hidden");
  $("#localBadge").textContent = t("room.localBadge");
  updatePlayUI(false);
  toast(
    hls
      ? t("toast.hlsReady", { name: fileName })
      : converted
        ? (getLang() === "fa" ? `«${fileName}» آماده شد` : `"${fileName}" is ready`)
        : (getLang() === "fa" ? `«${fileName}» در حال پخش` : `Playing "${fileName}"`),
    "success"
  );
  if (isHost) {
    localFileId = "lf" + Date.now().toString(36);
    net.syncLocalState({ id: localFileId, playing: false, time: 0, rate: 1 });
    const shareId = localFileId;
    if (blob) {
      net.shareLocalFile({ id: shareId, name: fileName, size: blob.size, blob });
    } else {
      (async () => {
        try {
          const plain = await (await fetch(url)).blob();
          if (localFileId === shareId && player.url === url) {
            net.shareLocalFile({ id: shareId, name: fileName, size: plain.size, blob: plain });
          }
        } catch {}
      })();
    }
    net.command("chat", {
      text: getLang() === "fa"
        ? `🎬 ${nick} فایل «${fileName}» را پخش می‌کند — برای تماشای هم‌زمان، فایل را دریافت کن.`
        : `🎬 ${nick} is playing "${fileName}" — download it to watch along.`
    });
  }
}

function swapToHls(original, virtual) {
  const v = player.video;
  const time = v.currentTime || 0;
  const playing = !v.paused;
  player.aliasSource(original, virtual);
  player.setUrl(virtual);
  const restore = () => {
    try { v.currentTime = time; } catch {}
    if (playing) v.play().catch(() => {});
  };
  v.addEventListener("loadedmetadata", restore, { once: true });
}

let localUpgradeFile = null;
function maybeUpgradeLocal(file) {
  localUpgradeFile = file;
  setTimeout(async () => {
    if (localUpgradeFile !== file) return;
    try {
      const { upgradeLocalVideo } = await import("./transcode.js");
      const out = await upgradeLocalVideo(file, file.name, {});
      if (!out || localUpgradeFile !== file) return;
      if (!(out.audio > 1 || out.subs > 0)) return;
      const packed = await packBundle(out.files);
      const reg = await registerBundle(out.files);
      if (currentBundleId) releaseBundle(currentBundleId);
      currentBundleId = reg.id;
      swapToHls(player.url, reg.url);
      if (isHost) {
        localFileId = "lf" + Date.now().toString(36);
        net.syncLocalState({ id: localFileId, playing: !player.video.paused, time: player.video.currentTime || 0, rate: player.video.playbackRate || 1 });
        net.shareLocalFile({ id: localFileId, name: file.name, size: packed.size, blob: packed });
      }
      toast(t("toast.tracksFound", { a: String(out.audio), s: String(out.subs) }), "success");
      setTracksHint(null);
    } catch (err) {
      console.warn("local track upgrade skipped", err);
    }
  }, 1200);
}

async function maybeUpgradeLink(url) {
  if (!url || linkUpgrades.has(url) || player.alias.has(url)) return;
  if (/\.m3u8($|\?)/i.test(url)) { setTracksHint(null); return; }
  if (!/^https?:/i.test(url)) return;
  linkUpgrades.add(url);
  setTracksHint("checking");
  try {
    const maxMB = Math.max(1, Number(siteCfg?.upload?.maxFileMB) || 50);
    const head = await fetch(url, { method: "HEAD" }).catch(() => null);
    if (head && !head.ok) { setTracksHint("none"); return; }
    const len = Number(head?.headers?.get("content-length")) || 0;
    if (len && len > maxMB * 1024 * 1024) { setTracksHint("none"); return; }
    const res = await fetch(url);
    if (!res.ok) { setTracksHint("none"); return; }
    const blob = await res.blob();
    if (!blob.size || blob.size > maxMB * 1024 * 1024) { setTracksHint("none"); return; }
    if (player.state?.url && player.state.url !== url) return;
    const raw = url.split("?")[0].split("#")[0].split("/").pop() || "video.mp4";
    const { upgradeLocalVideo } = await import("./transcode.js");
    const out = await upgradeLocalVideo(blob, decodeURIComponent(raw), {});
    if (!out || !(out.audio > 1 || out.subs > 0)) { setTracksHint("none"); return; }
    const reg = await registerBundle(out.files);
    if (currentBundleId) releaseBundle(currentBundleId);
    currentBundleId = reg.id;
    swapToHls(url, reg.url);
    setTracksHint(null);
    toast(t("toast.tracksFound", { a: String(out.audio), s: String(out.subs) }), "success");
  } catch (err) {
    console.warn("link track upgrade skipped", err);
    setTracksHint("none");
  }
}

function setTracksHint(kind) {
  const hint = $("#tracksHint");
  if (!hint) return;
  clearTimeout(tracksHintTimer);
  if (!kind) { hint.classList.add("hidden"); return; }
  hint.textContent = t(kind === "checking" ? "settings.tracksChecking" : "settings.tracksNone");
  hint.classList.remove("hidden");
  if (kind === "checking") {
    tracksHintTimer = setTimeout(() => {
      if (!hint.classList.contains("hidden")) setTracksHint("none");
    }, 25000);
  }
}

/* ================= chat ================= */
/* ================= personal watch timer ================= */
function chatTimerTotal() {
  return chatTimerElapsed + (chatTimerSince ? Date.now() - chatTimerSince : 0);
}
function fmtChatTimer(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function saveChatTimer() {
  store.set(CHAT_TIMER_KEY, { elapsed: chatTimerTotal(), running: !!chatTimerSince });
}
function paintChatTimer() {
  const label = $("#chatTimerLabel");
  if (!label) return;
  label.textContent = fmtChatTimer(chatTimerTotal());
  const btn = $("#chatTimerBtn");
  btn?.classList.toggle("running", !!chatTimerSince);
  if (btn) btn.title = t(chatTimerSince ? "chat.timerPause" : "chat.timerStart");
  $("#chatTimerReset")?.classList.toggle("hidden", chatTimerTotal() === 0);
}

function wireChatTimer() {
  if (!$("#chatTimerBtn")) return;
  const saved = store.get(CHAT_TIMER_KEY, null);
  if (saved && typeof saved === "object") {
    chatTimerElapsed = Math.max(0, Number(saved.elapsed) || 0);
    chatTimerSince = saved.running ? Date.now() : null;
  } else {
    chatTimerSince = Date.now();
  }
  paintChatTimer();
  $("#chatTimerBtn").addEventListener("click", () => {
    if (chatTimerSince) {
      chatTimerElapsed = chatTimerTotal();
      chatTimerSince = null;
    } else {
      chatTimerSince = Date.now();
    }
    saveChatTimer();
    paintChatTimer();
  });
  $("#chatTimerReset")?.addEventListener("click", () => {
    chatTimerElapsed = 0;
    chatTimerSince = null;
    saveChatTimer();
    paintChatTimer();
  });
  chatTimerInterval = setInterval(paintChatTimer, 1000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveChatTimer(); });
  window.addEventListener("beforeunload", saveChatTimer);
  saveChatTimer();
}

/* Every chat event (own and remote) reaches each client exactly once, so the
   messages store mirrors the live conversation of this room. */
const MESSAGE_LIMIT_PER_ROOM = 300;
let savedMessageCount = 0;

function persistChatEntry(entry) {
  if (!entry?.id || !entry.text) return;
  dbPut("messages", {
    id: String(entry.id),
    room: code,
    by: entry.by || "",
    nick: entry.nick || "",
    text: String(entry.text).slice(0, 500),
    createdAt: Number(entry.at) || Date.now(),
    replyTo: entry.replyTo || null
  }).then(() => {
    savedMessageCount += 1;
    if (savedMessageCount % 40 === 0) pruneRoomMessages();
  }).catch(() => {});
}

async function pruneRoomMessages() {
  try {
    const rows = await dbGetByIndex("messages", "room", code);
    if (rows.length <= MESSAGE_LIMIT_PER_ROOM) return;
    rows.sort((a, b) => b.createdAt - a.createdAt);
    for (const row of rows.slice(MESSAGE_LIMIT_PER_ROOM)) await dbDelete("messages", row.id);
  } catch {}
}

function newChatCid() {
  const raw = globalThis.crypto?.randomUUID?.() || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return String(raw).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

function chatCooldownLeft() {
  return Math.max(0, chatCooldownUntil - Date.now());
}

function paintChatCooldown() {
  const left = chatCooldownLeft();
  const secs = Math.ceil(left / 1000);
  for (const id of ["chatCooldown", "cineCooldown"]) {
    const node = $(`#${id}`);
    if (!node) continue;
    node.classList.toggle("hidden", left <= 0);
    if (left > 0) node.textContent = t("chat.cooldownLeft", { s: String(secs) });
  }
  const cooling = left > 0;
  $("#chatForm .send-btn")?.toggleAttribute("disabled", cooling);
  $("#cineForm .cine-send")?.toggleAttribute("disabled", cooling);
  if (!cooling) {
    if (chatCooldownTimer) { clearInterval(chatCooldownTimer); chatCooldownTimer = 0; }
    return;
  }
  if (!chatCooldownTimer) {
    chatCooldownTimer = setInterval(() => {
      if (chatCooldownLeft() > 0) {
        paintChatCooldown();
      } else {
        chatCooldownUntil = 0;
        paintChatCooldown();
        toast(t("chat.cooldownEnded"), "info", 2600);
      }
    }, 1000);
  }
}

function startChatCooldown(ms) {
  const wait = Math.max(1000, Number(ms) || 0);
  chatCooldownUntil = Math.max(chatCooldownUntil, Date.now() + wait);
  paintChatCooldown();
  toast(t("chat.cooldownLeft", { s: String(Math.ceil(wait / 1000)) }), "error", 3600);
}

function addOptimisticChat({ cid, text, replyTo: ref, inputId }) {
  const entry = {
    id: `p:${cid}`, cid, by: me.id, nick: me.nick, role: me.role,
    text, at: Date.now(), replyTo: ref || null, pending: true
  };
  appendMessage(entry, true);
  chatList.querySelector(`[data-id="p:${cssEscape(cid)}"]`)?.classList.add("pending");
  const timer = setTimeout(() => failPendingChat(cid), 12000);
  pendingChat.set(cid, { entry, timer, inputId });
}

function dropPendingChat(cid, { restore = true } = {}) {
  const rec = pendingChat.get(cid);
  if (!rec) return;
  pendingChat.delete(cid);
  clearTimeout(rec.timer);
  chatList.querySelector(`[data-id="p:${cssEscape(cid)}"]`)?.remove();
  const before = cineMsgs.length;
  cineMsgs = cineMsgs.filter((m) => m.id !== `p:${cid}`);
  if (cineMsgs.length !== before) renderCine();
  syncChatEmpty();
  if (restore) {
    const input = $(`#${rec.inputId}`) || $("#chatInput");
    if (input && !input.value.trim()) input.value = rec.entry.text;
  }
}

function failPendingChat(cid) {
  if (!pendingChat.has(cid)) return;
  dropPendingChat(cid, { restore: true });
  toast(t("chat.sendFailed"), "error", 4200);
}

function reconcileChat(msg) {
  if (!msg?.cid) return;
  const rec = pendingChat.get(msg.cid);
  if (!rec) return;
  pendingChat.delete(msg.cid);
  clearTimeout(rec.timer);
  chatList.querySelector(`[data-id="p:${cssEscape(msg.cid)}"]`)?.remove();
  cineMsgs = cineMsgs.filter((m) => m.id !== `p:${msg.cid}`);
}

function ackChat({ cid, id } = {}) {
  if (!cid || !id) return;
  const rec = pendingChat.get(cid);
  if (!rec) return;
  pendingChat.delete(cid);
  clearTimeout(rec.timer);
  const node = chatList.querySelector(`[data-id="p:${cssEscape(cid)}"]`);
  if (node) {
    node.dataset.id = id;
    node.classList.remove("pending");
    try {
      const data = JSON.parse(node.dataset.msg || "{}");
      data.id = id;
      node.dataset.msg = JSON.stringify(data);
    } catch {}
  }
  const cine = cineMsgs.find((m) => m.id === `p:${cid}`);
  if (cine) cine.id = id;
}

function resendPendingChat() {
  for (const [cid, rec] of pendingChat) {
    if (Date.now() - rec.entry.at < 2000) continue;
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => failPendingChat(cid), 12000);
    net.command("chat", { text: rec.entry.text, replyTo: rec.entry.replyTo, cid });
  }
}

function sendChatText(text) {
  if (!chatEnabled) {
    toast(getLang() === "fa" ? "چت توسط مدیر سایت موقتاً غیرفعال شده است." : "Chat is temporarily disabled by the site owner.", "error");
    return false;
  }
  const clean = String(text || "").trim();
  if (!clean) return false;
  if (chatCooldownLeft() > 0) {
    toast(t("chat.cooldownLeft", { s: String(Math.ceil(chatCooldownLeft() / 1000)) }), "error");
    paintChatCooldown();
    return false;
  }
  if (!canSend()) { toast(getLang() === "fa" ? "کمی صبر کن" : "Slow down", "error"); return false; }
  const slow = Number(roomInfo?.slow) || 0;
  const wait = slow ? Math.ceil((slow * 1000 - (Date.now() - lastChatMsgAt)) / 1000) : 0;
  if (wait > 0) { toast(t("toast.slowWait", { s: String(wait) }), "info"); return false; }
  const cid = newChatCid();
  const inputId = cineExpanded ? "cineInput" : "chatInput";
  const optimistic = !isHost || net.relayMode;
  if (optimistic) addOptimisticChat({ cid, text: clean, replyTo, inputId });
  const queued = !net.isReady();
  net.command("chat", { text: clean, replyTo, cid });
  if (queued && Date.now() - chatQueuedToastAt > 4000) {
    chatQueuedToastAt = Date.now();
    toast(t("toast.chatQueued"), "info", 2400);
  }
  recordFeatureUse("chat.text", { plan: flagContext.plan, role: flagContext.role, room: code });
  lastChatMsgAt = Date.now();
  replyTo = null;
  $("#replyBar")?.classList.add("hidden");
  return true;
}

function wireChat() {
  const chatInput = $("#chatInput");
  const chatForm = $("#chatForm");

  const scrollOpt = $("#optAlwaysScroll");
  if (scrollOpt) {
    scrollOpt.checked = alwaysScroll;
    scrollOpt.addEventListener("change", () => {
      alwaysScroll = scrollOpt.checked;
      store.set(ALWAYS_SCROLL_KEY, alwaysScroll);
      toast(t(alwaysScroll ? "toast.alwaysScrollOn" : "toast.alwaysScrollOff"), "info");
      if (alwaysScroll) scrollChatSoon(true);
    });
  }
  const hideOpt = $("#optHideChat");
  if (hideOpt) {
    hideOpt.checked = chatHidden;
    hideOpt.addEventListener("change", () => setChatHidden(hideOpt.checked));
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!chatEnabled) {
      toast(getLang() === "fa" ? "چت توسط مدیر سایت موقتاً غیرفعال شده است." : "Chat is temporarily disabled by the site owner.", "error");
      return;
    }
    const text = chatInput.value.trim();
    if (!text) return;
    if (editingId) {
      if (!canSend()) { toast(getLang() === "fa" ? "کمی صبر کن" : "Slow down", "error"); return; }
      if (!allow("chat.edit", "ویرایش پیام غیرفعال شده است.")) return;
      net.command("chatEdit", { id: editingId, text });
      editingId = null;
      chatInput.placeholder = t("chat.placeholder");
      $("#replyBar").classList.add("hidden");
    } else if (!sendChatText(text)) {
      return;
    }
    chatInput.value = "";
    if (document.activeElement === chatInput) chatInput.focus({ preventScroll: true });
    scrollChat(true);
  });

  $("#replyCancel").addEventListener("click", () => {
    replyTo = null;
    $("#replyBar").classList.add("hidden");
  });

  $("#chatExportBtn")?.addEventListener("click", exportChat);

  const sendTyping = debounce(() => {
    if (!chatEnabled || !flagOn(flagStates, "chat.typing")) return;
    net.command("typing", {});
  }, 1200);
  chatInput.addEventListener("input", () => {
    if (chatInput.value.trim()) sendTyping();
  });

  /* ---- emoji picker: never steal focus, follow the visual viewport ---- */
  const pop = $("#emojiPop");
  if (pop.parentElement !== document.body) document.body.append(pop);
  pop.classList.add("hidden");

  const placePop = () => {
    if (pop.classList.contains("hidden")) return;
    const btn = $("#emojiBtn");
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth;
    const vh = vv ? vv.height : window.innerHeight;
    const ox = vv ? vv.offsetLeft : 0;
    const oy = vv ? vv.offsetTop : 0;
    const w = Math.min(272, Math.max(200, vw - 16));
    pop.style.width = `${w}px`;
    pop.style.maxHeight = `${Math.max(150, Math.min(280, vh - 24))}px`;
    const popH = Math.min(pop.scrollHeight || 240, Math.min(280, vh - 24));
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(ox + 8, Math.min(left, ox + vw - w - 8));
    let top = r.top - 8 - popH;
    if (top < oy + 8) top = Math.min(oy + vh - popH - 8, r.bottom + 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(oy + 8, top)}px`;
  };
  const setEmojiOpen = (on) => {
    pop.classList.toggle("hidden", !on);
    if (on) {
      placePop();
      requestAnimationFrame(placePop);
    }
  };

  // preventDefault on pointerdown keeps the on-screen keyboard and caret intact
  $("#emojiBtn").addEventListener("pointerdown", (e) => e.preventDefault());
  $("#emojiBtn").addEventListener("click", (e) => {
    e.preventDefault();
    setEmojiOpen(pop.classList.contains("hidden"));
  });

  const EMOJI = ["😀","😂","🥹","😍","😎","🤔","😴","🤯","😭","😡","👍","👎","🔥","❤️","🎉","🍿","👏","🙏","💯","😅","🤝","🫡","👀","✨"];
  pop.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) e.preventDefault();
  });
  pop.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-emoji]");
    if (!b) return;
    const em = b.dataset.emoji;
    const focused = document.activeElement === chatInput;
    if (focused && typeof chatInput.setRangeText === "function") {
      const start = chatInput.selectionStart ?? chatInput.value.length;
      const end = chatInput.selectionEnd ?? chatInput.value.length;
      chatInput.setRangeText(em, start, end, "end");
    } else {
      chatInput.value += em;
    }
    chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    if (focused) chatInput.focus({ preventScroll: true });
    placePop();
  });
  for (const em of EMOJI) {
    pop.append(el("button", { type: "button", text: em, "data-emoji": em, "aria-label": em }));
  }

  document.addEventListener("pointerdown", (e) => {
    if (pop.classList.contains("hidden")) return;
    if (pop.contains(e.target) || e.target.closest("#emojiBtn")) return;
    setEmojiOpen(false);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.classList.contains("hidden")) setEmojiOpen(false);
  });

  const refollow = () => { placePop(); };
  window.addEventListener("resize", refollow);
  window.visualViewport?.addEventListener("resize", refollow);
  window.visualViewport?.addEventListener("scroll", refollow);

  $("#chatSearch").addEventListener("input", (e) => {
    if (!allow("chat.search")) { e.target.value = ""; return; }
    searchTerm = e.target.value.trim().toLowerCase();
    $$(".msg", chatList).forEach((node) => {
      const text = (node.dataset.text || "").toLowerCase();
      node.style.display = !searchTerm || text.includes(searchTerm) ? "" : "none";
    });
    paintChatJump();
  });

  /* ---- jump to latest message ---- */
  const jumpBtn = $("#chatJump");
  const chatFormEl = $("#chatForm");
  const placeJump = () => {
    if (!jumpBtn) return;
    jumpBtn.style.bottom = `${(chatFormEl?.offsetHeight || 64) + 10}px`;
    paintChatJump();
  };
  jumpBtn?.addEventListener("click", () => {
    chatJumpCount = 0;
    chatFollow = true;
    chatUserPaused = false;
    scrollChat(true);
  });
  chatList.addEventListener("scroll", () => {
    if (!chatScrollLock) {
      const near = isChatNearBottom();
      chatFollow = near;
      chatUserPaused = !near;
      if (near) chatJumpCount = 0;
    }
    paintChatJump();
  }, { passive: true });
  if ("ResizeObserver" in window && chatFormEl) new ResizeObserver(placeJump).observe(chatFormEl);
  else window.addEventListener("resize", placeJump);
  window.visualViewport?.addEventListener("resize", placeJump);
  window.visualViewport?.addEventListener("scroll", placeJump);
  placeJump();

  chatList.addEventListener("click", onChatAction);
}

async function onChatAction(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) {
    const reply = e.target.closest(".msg-reply");
    if (reply) scrollToMessage(reply.dataset.ref);
    return;
  }
  const msgNode = btn.closest(".msg");
  const id = msgNode.dataset.id;
  const act = btn.dataset.act;
  const data = JSON.parse(msgNode.dataset.msg || "{}");

  if (act === "react") {
    if (!allow("chat.reactions", "واکنش‌ها غیرفعال شده است.")) return;
    net.command("react", { id, emoji: "👍" });
  } else if (act === "reply") {
    if (!allow("chat.replies", "پاسخ به پیام غیرفعال شده است.")) return;
    startReply(data);
  } else if (act === "pin") {
    if (!allow("chat.pins", "سنجاق پیام غیرفعال شده است.")) return;
    net.command("pin", { id });
  } else if (act === "edit") {
    if (!allow("chat.edit", "ویرایش پیام غیرفعال شده است.")) return;
    startEdit(data);
  } else if (act === "delete") {
    if (!allow("chat.delete", "حذف پیام غیرفعال شده است.")) return;
    if (data.by !== me.id) {
      const ok = await confirmDialog({
        title: t("chat.deleteConfirmTitle"),
        text: t("chat.deleteConfirmText"),
        okLabel: t("common.delete")
      });
      if (!ok) return;
    }
    markDeletePending(id);
    net.command("chatDelete", { id });
  } else if (act === "reaction") {
    if (!allow("chat.reactions", "واکنش‌ها غیرفعال شده است.")) return;
    net.command("react", { id, emoji: btn.dataset.emoji });
  }
}

function markDeletePending(id) {
  if (!id) return;
  pendingDeletes.add(id);
  setTimeout(() => {
    if (pendingDeletes.delete(id)) toast(t("chat.deleteFailed"), "error", 3600);
  }, 8000);
}

function startReply(msg) {
  replyTo = msg.id;
  const nickName = msg.nick || members.find((m) => m.id === msg.by)?.nick || "?";
  $("#replyBarText").textContent = `↩ ${nickName}: ${msg.text.slice(0, 60)}`;
  $("#replyBar").classList.remove("hidden");
  $("#chatInput").focus();
}

function startEdit(msg) {
  editingId = msg.id;
  $("#chatInput").value = msg.text;
  $("#chatInput").focus();
  $("#chatInput").placeholder = getLang() === "fa" ? "ویرایش پیام…" : "Editing…";
}

function appendMessage(msg, animate) {
  if (!msg) return;
  if (chatList.querySelector(`[data-id="${cssEscape(msg.id)}"]`)) return;
  pushCine(msg);
  const node = buildMessage(msg);
  chatList.append(node);
  while (chatList.children.length > MAX_CHAT_NODES) chatList.firstElementChild?.remove();
  if (animate) node.animate?.([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 180 });
  refreshPinned();
  syncChatEmpty();
}

function syncChatEmpty() {
  const empty = $("#chatEmpty");
  if (!empty) return;
  const has = chatList.children.length > 0;
  empty.classList.toggle("hidden", has);
  chatList.classList.toggle("hidden", !has);
}

function clearChatHistory() {
  const wasEditing = !!editingId;
  chatList.innerHTML = "";
  cineMsgs = [];
  cineUnread = 0;
  renderCine();
  paintCineUnread();
  replyTo = null;
  editingId = null;
  $("#replyBar")?.classList.add("hidden");
  if (wasEditing) {
    const input = $("#chatInput");
    if (input) { input.value = ""; input.placeholder = t("chat.placeholder"); }
  }
  chatJumpCount = 0;
  refreshPinned();
  syncChatEmpty();
  paintChatJump();
}

function exportChat() {
  const nodes = [...chatList.querySelectorAll(".msg")];
  if (!nodes.length) { toast(t("toast.chatExportEmpty"), "error"); return; }
  const fa = getLang() === "fa";
  const roomName = roomInfo?.name || $("#roomTitle").textContent.trim() || code;
  const lines = [
    fa ? "هم‌تماشا — خروجی گفتگو" : "Watch Together — chat transcript",
    `${fa ? "اتاق" : "Room"}: ${roomName} (${code})`,
    `${fa ? "تاریخ" : "Date"}: ${new Date().toLocaleString(fa ? "fa-IR" : "en-US")}`,
    `${fa ? "اعضا" : "Members"}: ${members.map((m) => m.nick).filter(Boolean).join(", ")}`,
    "-".repeat(48)
  ];
  for (const node of nodes) {
    let data = {};
    try { data = JSON.parse(node.dataset.msg || "{}"); } catch {}
    const time = node.querySelector(".msg-time")?.textContent?.trim() || "";
    const pinned = node.classList.contains("pinned-msg") ? "📌 " : "";
    const edited = node.classList.contains("edited") ? (fa ? " (ویرایش‌شده)" : " (edited)") : "";
    const reactions = [...node.querySelectorAll(".reaction")].map((b) => b.textContent.trim()).join(" ");
    const text = data.text || t("chat.deleted");
    lines.push(`[${time}] ${pinned}${data.nick || "?"}: ${text}${edited}${reactions ? ` [${reactions}]` : ""}`);
  }
  lines.push("", fa ? "پایان گفتگو" : "End of transcript");
  const blob = new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const safeCode = String(code).replace(/[^\w-]/g, "") || "room";
  const a = el("a", { href: url, download: `watch-together-${safeCode}-${stamp}.txt` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(t("toast.chatExported"), "success");
}

function formatChatText(raw) {
  const safe = escapeHtml(raw || "").replace(/https?:\/\/[^\s<]+/g, (full) => {
    const trail = full.match(/[.,!?;:)\]]+$/)?.[0] || "";
    const href = trail ? full.slice(0, -trail.length) : full;
    return `<a class="chat-link" href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${trail}`;
  });
  const mention = escapeHtml("@" + me.nick);
  return safe.split(mention).join(`<span class="mention">${mention}</span>`);
}

function buildMessage(msg) {
  const mine = msg.by === me.id;
  const isMod = msg.role === "owner" || msg.role === "mod";
  const node = el("div", { class: `msg${mine ? " own" : ""}${msg.edited ? " edited" : ""}${msg.pending ? " pending" : ""}`, "data-id": msg.id });
  node.dataset.text = msg.text || "";
  node.dataset.msg = JSON.stringify({ id: msg.id, by: msg.by, nick: msg.nick, text: msg.text, role: msg.role, pinned: !!msg.pinned, deleted: !!msg.deleted });

  const avatar = el("div", { class: "avatar", "data-by": msg.by || "", "data-nick": msg.nick || "" });
  paintAvatar(avatar, avatarFor(msg.by), msg.nick, msg.by || msg.nick);

  const body = el("div", { class: "msg-body" });

  if (msg.replyTo) {
    const ref = chatList.querySelector(`[data-id="${cssEscape(msg.replyTo)}"]`);
    const refData = ref ? JSON.parse(ref.dataset.msg || "{}") : null;
    const quote = el("div", { class: "msg-reply", "data-ref": msg.replyTo });
    quote.textContent = refData ? `${refData.nick}: ${String(refData.text).slice(0, 70)}` : "…";
    body.append(quote);
  }

  const head = el("div", { class: "msg-head" });
  head.append(el("span", { class: "nick", text: msg.nick || "?" }));
  if (msg.role && msg.role !== "member") {
    head.append(el("span", { class: `role-badge ${msg.role}`, text: t(`role.${msg.role}`) }));
  }
  head.append(el("span", { class: "msg-time", text: fmtClock(msg.at || Date.now()) }));

  const text = el("div", { class: "msg-text" });
  if (msg.deleted) {
    text.classList.add("deleted");
    text.textContent = t("chat.deleted");
  } else {
    text.innerHTML = formatChatText(msg.text);
  }

  const reactions = el("div", { class: "reactions" });
  body.append(head, text, reactions);
  if (msg.pinned) node.classList.add("pinned-msg");

  const actions = el("div", { class: "msg-actions" });
  actions.append(el("button", { type: "button", "data-act": "react", title: "👍", text: "👍" }));
  actions.append(el("button", { type: "button", "data-act": "reply", title: t("common.reply"), text: "↩" }));
  if (mine && !msg.deleted) actions.append(el("button", { type: "button", "data-act": "edit", title: t("common.edit"), text: "✎" }));
  if ((mine || isModSelf()) && !msg.deleted) actions.append(el("button", { type: "button", "data-act": "delete", title: t("common.delete"), text: "🗑" }));
  if (isModSelf()) actions.append(el("button", { type: "button", "data-act": "pin", title: msg.pinned ? t("common.unpin") : t("common.pin"), text: msg.pinned ? "📌" : "📍" }));

  node.append(avatar, body, actions);
  renderReactions(node, msg);
  return node;
}

function isModSelf() { return rankOf(me.role) >= ROLE_RANK.mod; }

function renderReactions(node, msg) {
  const wrap = node.querySelector(".reactions");
  if (!wrap) return;
  wrap.innerHTML = "";
  const reactions = msg.reactions || {};
  for (const [emoji, users] of Object.entries(reactions)) {
    if (!users?.length) continue;
    const b = el("button", { type: "button", class: `reaction${users.includes(me.id) ? " mine" : ""}`, "data-act": "reaction", "data-emoji": emoji });
    b.append(el("span", { text: emoji }), el("span", { text: String(users.length) }));
    wrap.append(b);
  }
}

function updateMessage(msg) {
  const node = chatList.querySelector(`[data-id="${cssEscape(msg.id)}"]`);
  if (!node) { appendMessage(msg, false); return; }
  node.dataset.msg = JSON.stringify({ id: msg.id, by: msg.by, nick: msg.nick, text: msg.text, role: msg.role, pinned: !!msg.pinned, deleted: !!msg.deleted });
  node.dataset.text = msg.text || "";
  node.classList.toggle("edited", !!msg.edited);
  node.classList.toggle("pinned-msg", !!msg.pinned);
  const textEl = node.querySelector(".msg-text");
  if (msg.deleted) {
    textEl.classList.add("deleted");
    textEl.textContent = t("chat.deleted");
    textEl.innerHTML = escapeHtml(t("chat.deleted"));
  } else {
    textEl.classList.remove("deleted");
    textEl.innerHTML = formatChatText(msg.text);
  }
  renderReactions(node, msg);
  refreshPinned();
  pushCine(msg, { quiet: true });
  if (msg.deleted && pendingDeletes.delete(msg.id)) {
    toast(t("chat.deleteDone"), "success", 2600);
  }
}

function refreshPinned() {
  const bar = $("#pinnedBar");
  if (!bar) return;
  const pinned = [...chatList.children]
    .filter((n) => n.classList.contains("pinned-msg"))
    .map((n) => {
      try { return JSON.parse(n.dataset.msg || "{}"); } catch { return {}; }
    })
    .filter((m) => m.id && !m.deleted && m.pinned !== false);
  if (!pinned.length) { bar.classList.add("hidden"); bar.innerHTML = ""; bar.onclick = null; return; }
  const last = pinned[pinned.length - 1];
  bar.classList.remove("hidden");
  bar.innerHTML = `<b>${t("pinned.label")}:</b> <span>${escapeHtml(`${last.nick}: ${String(last.text).slice(0, 80)}`)}</span>`;
  bar.onclick = () => scrollToMessage(last.id);
}

function scrollToMessage(id) {
  const node = chatList.querySelector(`[data-id="${cssEscape(id)}"]`);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.animate?.([{ background: "rgba(61,107,255,.35)" }, { background: "transparent" }], { duration: 1200 });
}

function chatBottomGap() {
  return chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight;
}

function isChatNearBottom() {
  return chatBottomGap() < 56;
}

function pinChatBottom() {
  chatScrollLock = true;
  chatFollow = true;
  chatUserPaused = false;
  clearTimeout(chatLockTimer);
  const apply = () => { chatList.scrollTop = chatList.scrollHeight; };
  apply();
  cancelAnimationFrame(chatBottomFrame);
  chatBottomFrame = requestAnimationFrame(() => {
    apply();
    chatBottomFrame = requestAnimationFrame(apply);
  });
  clearTimeout(chatBottomTimer);
  chatBottomTimer = setTimeout(apply, 70);
  chatLockTimer = setTimeout(() => {
    chatScrollLock = false;
    paintChatJump();
  }, 200);
}

function scrollChat(force = false) {
  if (force || chatFollow) pinChatBottom();
  paintChatJump();
}

function scrollChatSoon(force = false) {
  requestAnimationFrame(() => {
    if (force || chatFollow) pinChatBottom();
    paintChatJump();
    requestAnimationFrame(() => {
      if (force || chatFollow) pinChatBottom();
    });
  });
}

function setChatHidden(hidden, persist = true) {
  chatHidden = !!hidden;
  $(".room-shell")?.classList.toggle("chat-hidden", chatHidden);
  const opt = $("#optHideChat");
  if (opt) opt.checked = chatHidden;
  if (chatHidden) $("#sidebar")?.classList.remove("open");
  if (persist) store.set("wt.chatHidden", chatHidden);
  if (!chatHidden) scrollChatSoon(true);
  syncChatFab();
}

function syncChatFab() {
  const fab = $("#chatFab");
  if (!fab) return;
  const mobile = window.matchMedia("(max-width: 640px)").matches;
  fab.classList.toggle("fab-show", chatHidden && mobile);
  const badge = $("#chatFabBadge");
  if (badge) {
    badge.textContent = unreadChat > 9 ? "9+" : String(unreadChat);
    badge.classList.toggle("hidden", unreadChat === 0);
  }
}

function paintChatJump() {
  const btn = $("#chatJump");
  if (!btn) return;
  const gap = chatBottomGap();
  const show = !searchTerm && chatList.children.length > 0 && gap > 100;
  btn.classList.toggle("hidden", !show);
  const label = $("#chatJumpLabel");
  if (!label) return;
  if (chatJumpCount > 0) {
    label.textContent = t(chatJumpCount > 1 ? "chat.jumpMany" : "chat.jumpOne", { n: String(chatJumpCount) });
  } else {
    label.textContent = t("chat.jumpLatest");
  }
}

function renderTyping() {
  const now = Date.now();
  for (const [id, val] of typingUsers) if (now - val.at > 3200) typingUsers.delete(id);
  const count = typingUsers.size;
  $("#typingLine").textContent = count
    ? t(count > 1 ? "chat.typingMany" : "chat.typingOne", { n: count > 2 ? String(count) : [...typingUsers.values()].map((v) => v.nick).join(", ") })
    : "";
}
typingTimer = setInterval(renderTyping, 1200);

/* ================= people ================= */
function audioKey(nickName) {
  return String(nickName || "").trim().toLowerCase();
}

function userAudioFor(nickName) {
  return userAudio[audioKey(nickName)] || {};
}

function saveUserAudio(nickName, patch) {
  const key = audioKey(nickName);
  if (!key) return;
  const next = { ...(userAudio[key] || {}), ...patch };
  if (!next.mute) delete next.mute;
  if (next.vol != null && Math.round(next.vol * 100) === 100) delete next.vol;
  if (!next.mute && next.vol == null) delete userAudio[key];
  else userAudio[key] = next;
  store.set(USER_AUDIO_KEY, userAudio);
}

function applyUserAudio(peerId, nickName) {
  if (!voice || !peerId || peerId === me.id) return;
  const pref = userAudioFor(nickName);
  voice.setLocalMuted(peerId, !!pref.mute);
  if (pref.vol != null) voice.setVolume(peerId, pref.vol);
}

let sheetMemberId = "";

function isManagerSelf() {
  return me.role === "owner" || (!!roomInfo?.managerId && roomInfo.managerId === me.id);
}

function isAdminSelf() {
  return isManagerSelf() || rankOf(me.role) >= ROLE_RANK.admin;
}

function selfPerms() {
  if (isManagerSelf()) return { ...ROLE_PERMS.owner };
  return effectivePerms(me.role, me.perms);
}

function canDo(cap) {
  if (isManagerSelf()) return true;
  if (cap === "video") {
    if (typeof me.perms?.video === "boolean") return me.perms.video;
    const policy = roomInfo?.control || "mods";
    if (rankOf(me.role) >= ROLE_RANK.mod) return policy !== "host";
    return policy === "all";
  }
  return Boolean(selfPerms()[cap]);
}

function memberPerms(m) {
  if (!m) return {};
  if (m.id === me.id && isManagerSelf()) return { ...ROLE_PERMS.owner };
  if (m.role === "owner" || roomInfo?.managerId === m.id) return { ...ROLE_PERMS.owner };
  return effectivePerms(m.role, m.perms);
}

function outranksMe(m) {
  return rankOf(m?.role) >= (isManagerSelf() ? ROLE_RANK.owner : rankOf(me.role));
}

function memberById(id) {
  return members.find((m) => m.id === id) || null;
}

function roleLabel(m) {
  if (!m) return "";
  if (roomInfo?.managerId === m.id && m.role !== "owner") return t("people.successor");
  return t(`role.${m.role || "member"}`);
}

function toggleLocalMute(id, name) {
  if (!allow("voice.volume", "کنترل صدای اعضا غیرفعال شده است.")) return;
  if (!id) return;
  const next = !userAudioFor(name).mute;
  voice.setLocalMuted(id, next);
  saveUserAudio(name, { mute: next });
  for (const node of peopleList.querySelectorAll(`.person[data-id="${cssEscape(id)}"]`)) {
    node.classList.toggle("muted-local", next);
    node.querySelectorAll("[data-lmute]").forEach((btn) => {
      btn.classList.toggle("on", next);
      btn.textContent = next ? "🔇" : "🔊";
      btn.setAttribute("aria-pressed", String(next));
      const label = t(next ? "people.localUnmute" : "people.localMute");
      btn.title = label;
      btn.setAttribute("aria-label", label);
    });
  }
  const label = t(next ? "people.localUnmute" : "people.localMute");
  const sheetBtn = $("#psActions [data-sheet='localmute']");
  if (sheetBtn) {
    sheetBtn.classList.toggle("on", next);
    sheetBtn.textContent = `${next ? "🔇" : "🔊"} ${label}`;
  }
  toast(t(next ? "toast.mutedForMe" : "toast.unmutedForMe", { name }), "info", 2600);
  return next;
}

async function runModAction(action, id) {
  const m = memberById(id);
  if (!m) return;
  if (action === "kick" || action === "ban") {
    const ok = await confirmDialog({
      title: t(action === "kick" ? "people.kick" : "people.ban"),
      text: getLang() === "fa" ? "این کار قابل بازگشت نیست." : "This can't be undone.",
      okLabel: t("common.ok")
    });
    if (!ok) return;
    net.command("mod", { action, target: id });
    return;
  }
  if (action === "mute") {
    net.command("mod", { action: "mute", target: id });
    return;
  }
  if (action === "info") {
    openPersonSheet(id);
    return;
  }
  if (action.startsWith("role:")) {
    const role = action.slice(5);
    net.command("mod", { action: "setrole", target: id, role });
    toast(t("people.roleChanged", { name: m.nick }), "success", 3000);
  }
}

function setMemberPerm(id, key, value) {
  const m = memberById(id);
  if (!m) return;
  const next = { ...memberPerms(m), [key]: Boolean(value) };
  net.command("mod", { action: "perms", target: id, perms: next });
}

function setVolumeFor(id, nick, value) {
  if (!allow("voice.volume", "کنترل صدای اعضا غیرفعال شده است.")) return;
  const v = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  voice.setVolume(id, v);
  saveUserAudio(nick, { vol: v });
  const person = peopleList.querySelector(`.person[data-id="${cssEscape(id)}"] .person-vol`);
  if (person) person.value = String(Math.round(v * 100));
  const tile = document.querySelector(`.voice-tile[data-id="${cssEscape(id)}"] .tile-vol`);
  if (tile) tile.value = String(Math.round(v * 100));
  const sheetVol = $("#psVol");
  if (sheetVol) sheetVol.value = String(Math.round(v * 100));
}

function renderPersonSheet(m) {
  const actions = $("#psActions");
  if (!actions || !m) return;
  actions.innerHTML = "";
  $("#psName").textContent = m.nick + (m.id === me.id ? (getLang() === "fa" ? " (تو)" : " (you)") : "");
  $("#psSub").textContent = roleLabel(m);

  const info = el("div", { class: "ps-info" });
  const joined = m.joinedAt ? new Date(m.joinedAt) : null;
  if (joined) info.append(el("span", { text: t("people.joinedAt", { time: fmtClock(m.joinedAt) }) }));
  if (m.voice) info.append(el("span", { text: t("people.inVoice") }));
  if (m.muted) info.append(el("span", { text: t("people.mutedByMod") }));
  if (info.children.length) actions.append(info);
  if (m.id === me.id) return;

  if (flagOn(flagStates, "voice.volume")) {
    const pref = userAudioFor(m.nick);
    const muteBtn = el("button", {
      type: "button", class: `ps-btn${pref.mute ? " on" : ""}`, "data-sheet": "localmute",
      text: `${pref.mute ? "🔇" : "🔊"} ${t(pref.mute ? "people.localUnmute" : "people.localMute")}`
    });
    actions.append(muteBtn);
    const volWrap = el("label", { class: "ps-vol" });
    volWrap.append(el("span", { text: t("people.volume") }));
    const vol = el("input", {
      id: "psVol", type: "range", min: "0", max: "100", step: "1",
      value: String(Math.round((pref.vol ?? 1) * 100))
    });
    vol.addEventListener("input", (e) => setVolumeFor(m.id, m.nick, e.target.value));
    volWrap.append(vol);
    actions.append(volWrap);
  }

  if (m.role !== "owner" && !outranksMe(m)) {
    if (canDo("mute")) {
      actions.append(el("button", { type: "button", class: "ps-btn", "data-sheet": "mod:mute", text: `🔇 ${m.muted ? t("people.unmute") : t("people.mute")}` }));
    }
    if (canDo("remove")) {
      actions.append(el("button", { type: "button", class: "ps-btn danger", "data-sheet": "mod:kick", text: `⤫ ${t("people.kick")}` }));
      if (isManagerSelf()) {
        actions.append(el("button", { type: "button", class: "ps-btn danger", "data-sheet": "mod:ban", text: `🚫 ${t("people.ban")}` }));
      }
    }
  }

  if (isManagerSelf() && m.role !== "owner") {
    const isMgr = roomInfo?.managerId === m.id;
    actions.append(el("button", {
      type: "button", class: `ps-btn${isMgr ? " on" : ""}`, "data-sheet": "manager",
      text: `👑 ${isMgr ? t("people.clearManager") : t("people.makeManager")}`
    }));
    const roleRow = el("div", { class: "ps-roles" });
    roleRow.append(el("span", { class: "ps-section", text: t("people.changeRole") }));
    for (const role of ["admin", "mod", "member", "guest"]) {
      if (m.role === role || isMgr) continue;
      roleRow.append(el("button", {
        type: "button", class: `ps-chip${m.role === role ? " on" : ""}`,
        "data-sheet": `role:${role}`, text: t(`role.${role}`),
        "aria-pressed": String(m.role === role)
      }));
    }
    actions.append(roleRow);
  }

  if (isManagerSelf() && m.role !== "owner") {
    const grid = el("div", { class: "ps-perms" });
    grid.append(el("span", { class: "ps-section", text: t("people.permissions") }));
    const perms = memberPerms(m);
    for (const key of ROOM_PERMS) {
      const label = el("label", { class: "ps-perm" });
      const input = el("input", { type: "checkbox" });
      input.checked = perms[key] === true;
      input.addEventListener("change", () => setMemberPerm(m.id, key, input.checked));
      label.append(input, el("span", { text: t(`perm.${key}`) }));
      grid.append(label);
    }
    actions.append(grid);
  }
}

function openPersonSheet(id) {
  const m = memberById(id);
  const sheet = $("#personSheet");
  if (!m || !sheet) return;
  sheetMemberId = id;
  renderPersonSheet(m);
  sheet.classList.remove("hidden");
  $("#personSheetBackdrop")?.classList.remove("hidden");
  requestAnimationFrame(() => sheet.classList.add("open"));
}

function closePersonSheet() {
  const sheet = $("#personSheet");
  if (!sheet) return;
  sheet.classList.remove("open");
  $("#personSheetBackdrop")?.classList.add("hidden");
  setTimeout(() => { if (!sheet.classList.contains("open")) sheet.classList.add("hidden"); }, 180);
  sheetMemberId = "";
}

async function handleSheetAction(kind) {
  const m = memberById(sheetMemberId);
  if (!m) return;
  if (kind === "localmute") { toggleLocalMute(m.id, m.nick); renderPersonSheet(m); return; }
  if (kind === "manager") {
    const next = roomInfo?.managerId === m.id ? "" : m.id;
    net.command("settings", { patch: { managerId: next } });
    if (next) toast(t("toast.managerChanged"), "success");
    closePersonSheet();
    return;
  }
  if (kind.startsWith("mod:")) {
    const action = kind.slice(4);
    closePersonSheet();
    await runModAction(action, m.id);
    return;
  }
  if (kind.startsWith("role:")) {
    await runModAction(kind, m.id);
    renderPersonSheet(memberById(sheetMemberId) || m);
  }
}

function wirePersonSheet() {
  const sheet = $("#personSheet");
  if (!sheet) return;
  $("#psClose")?.addEventListener("click", closePersonSheet);
  $("#personSheetBackdrop")?.addEventListener("click", closePersonSheet);
  $("#psActions").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sheet]");
    if (!btn) return;
    handleSheetAction(btn.dataset.sheet);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheet.classList.contains("open")) closePersonSheet();
  });
}

function wirePeople() {
  wirePersonSheet();
  peopleList.addEventListener("click", (e) => {
    if (e.target.closest("[data-pmore]")) {
      openPersonSheet(e.target.closest(".person")?.dataset.id || "");
      return;
    }
    const local = e.target.closest("[data-lmute]");
    if (local) {
      const person = local.closest(".person");
      toggleLocalMute(person?.dataset.id, person?.dataset.nick || "");
      return;
    }
    const btn = e.target.closest("[data-pmod]");
    if (!btn) return;
    runModAction(btn.dataset.pmod, btn.closest(".person").dataset.id);
  });

  peopleList.addEventListener("input", (e) => {
    const range = e.target.closest(".person-vol");
    if (!range) return;
    const person = range.closest(".person");
    setVolumeFor(person.dataset.id, person.dataset.nick, range.value);
  });

  let pressTimer = 0;
  let pressStart = null;
  let suppressTapUntil = 0;
  peopleList.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || e.target.closest("button, input, a")) return;
    const person = e.target.closest(".person");
    if (!person || person.dataset.id === me.id) return;
    pressStart = { x: e.clientX, y: e.clientY, at: Date.now(), id: person.dataset.id };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      openPersonSheet(person.dataset.id);
      navigator.vibrate?.(12);
      suppressTapUntil = Date.now() + 700;
      pressStart = null;
    }, 480);
  });
  const cancelPress = () => { clearTimeout(pressTimer); pressStart = null; };
  peopleList.addEventListener("pointermove", (e) => {
    if (!pressStart) return;
    if (Math.abs(e.clientX - pressStart.x) > 10 || Math.abs(e.clientY - pressStart.y) > 10) cancelPress();
  });
  peopleList.addEventListener("pointerup", (e) => {
    const meta = pressStart;
    cancelPress();
    if (!meta || Date.now() < suppressTapUntil) return;
    if (Date.now() - meta.at > 420) return;
    if (Math.abs(e.clientX - meta.x) > 10 || Math.abs(e.clientY - meta.y) > 10) return;
    openPersonSheet(meta.id);
  });
  peopleList.addEventListener("pointercancel", cancelPress);
  peopleList.addEventListener("pointerleave", cancelPress);

  const muteAll = () => {
    if (!allow("voice.volume", "کنترل صدای اعضا غیرفعال شده است.")) return;
    for (const m of members) {
      if (m.id === me.id) continue;
      saveUserAudio(m.nick, { mute: true });
      voice.setLocalMuted(m.id, true);
    }
    renderMembers();
    toast(t("settings.muteAll"), "info", 2600);
  };
  const unmuteAll = () => {
    if (!allow("voice.volume", "کنترل صدای اعضا غیرفعال شده است.")) return;
    for (const m of members) {
      if (m.id === me.id) continue;
      saveUserAudio(m.nick, { mute: false });
      voice.setLocalMuted(m.id, false);
    }
    renderMembers();
    toast(t("settings.unmuteAll"), "info", 2600);
  };
  $("#muteAllBtn")?.addEventListener("click", muteAll);
  $("#unmuteAllBtn")?.addEventListener("click", unmuteAll);
}

function avatarFor(id) {
  if (!id) return "";
  if (id === me.id) return me.avatar || "";
  return members.find((m) => m.id === id)?.avatar || "";
}

function paintAvatar(node, value, label, colorSeed) {
  const src = avatarSrc(value);
  node.classList.toggle("has-img", !!src);
  node.style.backgroundImage = src ? `url("${src}")` : "";
  if (src) node.textContent = "";
  else {
    node.style.background = colorFor(colorSeed || label || "x");
    node.textContent = initials(label || "?");
  }
}

function refreshChatAvatars() {
  chatList.querySelectorAll(".msg .avatar[data-by]").forEach((av) => {
    paintAvatar(av, avatarFor(av.dataset.by), av.dataset.nick || "?", av.dataset.by);
  });
}

function renderMembers() {
  $("#peopleCount").textContent = String(members.length);
  peopleList.innerHTML = "";
  const sorted = [...members].sort((a, b) => (rankOf(b.role) - rankOf(a.role)) || a.nick.localeCompare(b.nick));
  for (const m of sorted) {
    const node = el("div", { class: "person", "data-id": m.id });
    node.dataset.nick = m.nick;
    const avatar = el("div", { class: "avatar" });
    paintAvatar(avatar, m.avatar, m.nick, m.id);
    const info = el("div", { class: "person-info" });
    const nameRow = el("div", { class: "person-name" });
    nameRow.append(el("span", { text: m.nick + (m.id === me.id ? (getLang() === "fa" ? " (تو)" : " (you)") : "") }));
    if (m.role !== "member") nameRow.append(el("span", { class: `role-badge ${m.role}`, text: t(`role.${m.role}`) }));
    if (roomInfo?.managerId === m.id && m.role !== "owner") {
      nameRow.append(el("span", { class: "role-badge manager", text: t("people.successor") }));
    }
    const sub = el("div", { class: "person-sub", text: m.voice ? (getLang() === "fa" ? "در صدا" : "In voice") : "" });
    info.append(nameRow, sub);

    const tools = el("div", { class: "person-tools" });
    if (m.id !== me.id && flagOn(flagStates, "voice.volume")) {
      const pref = userAudioFor(m.nick);
      const audioRow = el("div", { class: "person-audio" });
      const muteBtn = el("button", {
        type: "button", class: pref.mute ? "on" : "", "data-lmute": "1",
        title: t(pref.mute ? "people.localUnmute" : "people.localMute"),
        "aria-label": t(pref.mute ? "people.localUnmute" : "people.localMute"),
        "aria-pressed": String(!!pref.mute),
        text: pref.mute ? "🔇" : "🔊"
      });
      const vol = el("input", {
        type: "range", min: "0", max: "100", step: "1", class: "person-vol",
        value: String(Math.round((pref.vol ?? 1) * 100)),
        "aria-label": t("people.volume")
      });
      audioRow.append(muteBtn, vol);
      tools.append(audioRow);
      node.classList.toggle("muted-local", !!pref.mute);
      applyUserAudio(m.id, m.nick);
    }

    const actions = el("div", { class: "person-actions" });
    if (m.id !== me.id && m.role !== "owner" && !outranksMe(m)) {
      if (canDo("mute")) {
        actions.append(el("button", { type: "button", "data-pmod": "mute", title: t("people.mute"), text: m.muted ? "🔈" : "🔇" }));
      }
      if (canDo("remove")) {
        actions.append(el("button", { type: "button", "data-pmod": "kick", title: t("people.kick"), class: "danger", text: "⤫" }));
      }
      if (isManagerSelf()) {
        const quick = el("button", {
          type: "button", "data-pmod": "info",
          title: t("people.permissions"), text: "⚙",
          "aria-label": t("people.permissions")
        });
        actions.append(quick);
      }
    }
    if (actions.children.length) tools.append(actions);
    node.append(avatar, info);
    if (tools.children.length) node.append(tools);
    if (m.id !== me.id && flagOn(flagStates, "voice.volume")) {
      const pref = userAudioFor(m.nick);
      node.append(el("button", {
        type: "button", class: `person-quick-mute${pref.mute ? " on" : ""}`, "data-lmute": "1",
        title: t(pref.mute ? "people.localUnmute" : "people.localMute"),
        "aria-label": t(pref.mute ? "people.localUnmute" : "people.localMute"),
        "aria-pressed": String(!!pref.mute),
        text: pref.mute ? "🔇" : "🔊"
      }));
    }
    if (m.id !== me.id) {
      node.append(el("button", {
        type: "button", class: "person-more", "data-pmore": "1",
        title: t("people.more"), "aria-label": t("people.more"), "aria-haspopup": "dialog",
        text: "⋯"
      }));
    }
    if (m.voice && !m.muted) node.dataset.voice = "1";
    peopleList.append(node);
  }
  renderVoiceTiles();
}

function markSpeaking(id, active) {
  if (id === "self") {
    const tile = document.querySelector(`.voice-tile[data-id="${cssEscape(me.id)}"]`);
    tile?.classList.toggle("speaking", active);
    const person = peopleList.querySelector(`.person[data-id="${cssEscape(me.id)}"]`);
    person?.classList.toggle("speaking", active);
    return;
  }
  const tile = document.querySelector(`.voice-tile[data-id="${cssEscape(id)}"]`);
  tile?.classList.toggle("speaking", active);
  const person = peopleList.querySelector(`.person[data-id="${cssEscape(id)}"]`);
  person?.classList.toggle("speaking", active);
}

/* ================= queue ================= */
function wireQueue() {
  $("#queueForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!allow("watch.queue", "صف پخش غیرفعال شده است.")) return;
    const input = $("#queueInput");
    const v = validateMediaUrl(input.value.trim());
    if (!v.ok) return toast(v.reason === "blocked" ? t("toast.blockedDomain") : t("toast.videoInvalid"), "error");
    net.command("queueAdd", { url: v.url });
    recordFeatureUse("watch.queue", { plan: flagContext.plan, role: flagContext.role, room: code });
    input.value = "";
  });

  queueList.addEventListener("click", (e) => {
    const vote = e.target.closest("[data-vote]");
    if (vote) {
      if (!allow("watch.voting", "رأی‌گیری صف غیرفعال شده است.")) return;
      recordFeatureUse("watch.voting", { plan: flagContext.plan, role: flagContext.role, room: code });
      return net.command("queueVote", { id: vote.dataset.vote });
    }
    const play = e.target.closest("[data-qplay]");
    if (play) {
      if (!allow("watch.queue", "صف پخش غیرفعال شده است.")) return;
      return net.command("queuePlay", { id: play.dataset.qplay });
    }
  });
}

function renderQueue(items) {
  queueItems = items || [];
  $("#queueCount").textContent = String(queueItems.length);
  queueList.innerHTML = "";
  if (!queueItems.length) {
    queueList.append(el("p", { class: "hint", text: t("queue.empty") }));
    return;
  }
  const voting = flagOn(flagStates, "watch.voting");
  const sorted = voting ? [...queueItems].sort((a, b) => b.votes.length - a.votes.length) : [...queueItems];
  for (const item of sorted) {
    const node = el("div", { class: "queue-item" });
    const main = el("div", { class: "q-main" });
    const title = item.url.split("/").pop()?.split("?")[0] || item.url;
    main.append(
      el("div", { class: "q-title", text: title || item.url }),
      el("div", { class: "q-sub", text: `${item.by} · ${fmtTime(0)}` })
    );
    node.append(main);
    if (voting) {
      const voted = item.votes.includes(me.id);
      const vote = el("button", { type: "button", class: `vote-btn${voted ? " voted" : ""}`, "data-vote": item.id });
      vote.append(el("span", { text: "▲" }), el("span", { text: String(item.votes.length) }));
      node.append(vote);
    }
    if (canControl()) {
      node.append(el("button", { type: "button", class: "vote-btn", "data-qplay": item.id, title: t("queue.play"), text: "▶" }));
    }
    queueList.append(node);
  }
}

function canControl() {
  return canDo("video");
}

/* ================= settings ================= */
let lastManagerSeen = null;

function paintManagerOptions(room) {
  const sel = $("#optManager");
  if (!sel || !room) return;
  const current = room.managerId || "";
  sel.innerHTML = "";
  sel.append(el("option", { value: "", text: t("settings.successorNone") }));
  for (const m of members) {
    if (m.role === "owner") continue;
    sel.append(el("option", { value: m.id, text: m.nick + (m.id === me.id ? (getLang() === "fa" ? " (تو)" : " (you)") : "") }));
  }
  if (current && !members.some((m) => m.id === current)) {
    sel.append(el("option", { value: current, text: t("people.successor") }));
  }
  sel.value = current;
}

function applyRoomSettings(room) {
  if (!room) return;
  roomInfo = room;
  const manager = isManagerSelf();
  $("#optControl").value = ["host", "mods", "all"].includes(room.control) ? room.control : "mods";
  $("#optLock").checked = !!room.locked;
  $("#optApproval").checked = !!room.approval;
  $("#optSlow").value = String(room.slow || 0);
  paintManagerOptions(room);
  const canSettings = canDo("settings");
  [$("#optControl"), $("#optLock"), $("#optApproval"), $("#optSlow")].forEach((n) => { if (n) n.disabled = !canSettings; });
  if ($("#optManager")) $("#optManager").disabled = !manager;
  if (room.managerId && room.managerId === me.id && lastManagerSeen !== me.id) {
    toast(t("toast.youAreManager"), "success");
  }
  lastManagerSeen = room.managerId || "";
  syncAdminTools();
  renderMembers();
}

function syncAdminTools() {
  $("#adminRow")?.classList.toggle("hidden", !isModSelf());
}

/* ================= screen wake lock ================= */
async function applyWakeLock() {
  const video = $("#video");
  const should = () => wakeWanted && !document.hidden && !!video && !video.paused;
  if (should()) {
    if (wakeSentinel || wakePending) return;
    wakePending = true;
    let sentinel = null;
    try {
      sentinel = await navigator.wakeLock.request("screen");
      sentinel.addEventListener("release", () => { wakeSentinel = null; }, { once: true });
    } catch { sentinel = null; }
    wakePending = false;
    wakeSentinel = sentinel;
    if (sentinel && !should()) {
      wakeSentinel = null;
      try { await sentinel.release(); } catch {}
    }
  } else if (wakeSentinel) {
    const sentinel = wakeSentinel;
    wakeSentinel = null;
    try { await sentinel.release(); } catch {}
  }
}

function wireWakeLock() {
  const input = $("#optWake");
  if (!input) return;
  if (!("wakeLock" in navigator)) {
    $("#wakeRow")?.classList.add("hidden");
    return;
  }
  input.checked = wakeWanted;
  input.addEventListener("change", () => {
    wakeWanted = input.checked;
    store.set(WAKE_KEY, wakeWanted);
    applyWakeLock();
  });
  const video = $("#video");
  video.addEventListener("play", applyWakeLock);
  video.addEventListener("pause", applyWakeLock);
  document.addEventListener("visibilitychange", applyWakeLock);
  applyWakeLock();
}

/* ================= sleep timer ================= */
let sleepTimeout = null;

function wireSleepTimer() {
  const select = $("#optSleep");
  if (!select) return;
  const stop = () => {
    if (sleepTimeout) { clearTimeout(sleepTimeout); sleepTimeout = null; }
  };
  select.addEventListener("change", () => {
    stop();
    const minutes = Number(select.value) || 0;
    if (!minutes) return;
    toast(t("toast.sleepSet").replace("{m}", String(minutes)));
    sleepTimeout = setTimeout(() => {
      sleepTimeout = null;
      select.value = "0";
      if (!$("#video")?.paused) player.togglePlay();
      toast(t("toast.sleepDone"), "info", 5000);
    }, minutes * 60000);
  });
}

/* ================= queue auto-advance ================= */
function queueTitle(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
    return name || url;
  } catch { return url; }
}

function wireQueueAuto() {
  const input = $("#optQueueAuto");
  if (!input) return;
  if (!isHost) { $("#queueAutoRow")?.classList.add("hidden"); return; }
  input.checked = queueAuto;
  input.addEventListener("change", () => {
    queueAuto = input.checked;
    store.set(QUEUE_AUTO_KEY, queueAuto);
  });
  $("#video").addEventListener("ended", () => {
    if (!isHost || !queueAuto || !queueItems.length) return;
    const best = [...queueItems].sort((a, b) => b.votes.length - a.votes.length || a.at - b.at)[0];
    if (!best) return;
    toast(t("toast.queueNext", { name: queueTitle(best.url) }), "info", 4500);
    net.command("queuePlay", { id: best.id });
    setTimeout(() => net.command("control", { action: "play" }), 250);
  });
}

function wireSettings() {
  const push = (patch) => net.command("settings", { patch });
  $("#optControl").addEventListener("change", (e) => push({ control: e.target.value }));
  $("#optLock").addEventListener("change", (e) => push({ locked: e.target.checked }));
  $("#optApproval").addEventListener("change", (e) => {
    if (!allow("rooms.approval", "اتاق با تأیید غیرفعال شده است.")) { e.target.checked = false; return; }
    push({ approval: e.target.checked });
  });
  $("#optSlow").addEventListener("change", (e) => push({ slow: Number(e.target.value) }));
  $("#optManager")?.addEventListener("change", (e) => push({ managerId: e.target.value }));
  $("#optQuality").addEventListener("change", (e) => {
    if (!allow("watch.quality", "انتخاب کیفیت غیرفعال شده است.")) return;
    player.setLevel(e.target.value);
  });
  $("#optAudio").addEventListener("change", (e) => {
    if (!allow("watch.audioTracks", "انتخاب ترک صوتی غیرفعال شده است.")) return;
    player.setAudio(e.target.value);
  });
  $("#optSubsTrack")?.addEventListener("change", (e) => {
    if (!allow("watch.subtitles", "زیرنویس غیرفعال شده است.")) return;
    player.setTextTrack(Number(e.target.value));
  });

  $("#subsPickBtn")?.addEventListener("click", () => {
    if (!allow("watch.subtitles", "زیرنویس غیرفعال شده است.")) return;
    $("#subsFile").click();
  });
  $("#subsFile").addEventListener("change", async (e) => {
    if (!allow("watch.subtitles", "زیرنویس غیرفعال شده است.")) { e.target.value = ""; return; }
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    let total = 0;
    let loaded = 0;
    const existing = new Set((player.getSubtitleSets() || []).map((s) => s.name));
    for (const file of files) {
      const cues = parseSubtitles(await file.text());
      if (!cues.length) continue;
      let name = (file.name || "").replace(/\.[^.]+$/, "").slice(0, 40) || t("settings.subs");
      if (existing.has(name)) {
        let n = 2;
        while (existing.has(`${name} (${n})`)) n++;
        name = `${name} (${n})`;
      }
      existing.add(name);
      player.setCues(cues, name);
      total += cues.length;
      loaded++;
    }
    const label = $("#subsFileName");
    if (label) {
      label.textContent = loaded === 1 ? files[0].name : (getLang() === "fa" ? `${loaded} فایل زیرنویس` : `${loaded} subtitle files`);
    }
    renderSubsSets();
    if (isHost) shareActiveSubs();
    if (loaded) {
      recordFeatureUse("watch.subtitles", { plan: flagContext.plan, role: flagContext.role, room: code });
      toast(getLang() === "fa" ? `${total} خط زیرنویس از ${loaded} فایل بارگذاری شد` : `${total} cues loaded from ${loaded} file(s)`, "success");
    } else {
      toast(getLang() === "fa" ? "زیرنویس معتبر نبود" : "Invalid subtitle file", "error");
    }
    e.target.value = "";
  });
  const layer = $("#subtitleLayer");
  const videoEl = $("#video");
  const applySubStyle = () => {
    const bg = `rgba(0,0,0,${subBg})`;
    if (layer) {
      layer.style.setProperty("--sub-color", subColor);
      layer.style.setProperty("--sub-bg", bg);
    }
    if (videoEl) {
      videoEl.style.setProperty("--sub-color", subColor);
      videoEl.style.setProperty("--sub-bg", bg);
    }
  };
  const sizeInput = $("#subsSize");
  const offsetInput = $("#subsOffset");
  if (sizeInput) {
    sizeInput.value = String(subSize);
    player.setSubsSize(subSize);
    sizeInput.addEventListener("input", (e) => {
      subSize = Number(e.target.value) || 120;
      store.set(SUB_SIZE_KEY, subSize);
      player.setSubsSize(subSize);
    });
  }
  if (offsetInput) {
    offsetInput.value = String(subOffset);
    player.setSubsOffset(subOffset);
    offsetInput.addEventListener("input", (e) => {
      subOffset = Number(e.target.value) || 0;
      store.set(SUB_OFFSET_KEY, subOffset);
      player.setSubsOffset(subOffset);
    });
  }
  $$("#subsColors .subs-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.color === subColor);
    btn.addEventListener("click", () => {
      subColor = btn.dataset.color || "#ffffff";
      store.set(SUB_COLOR_KEY, subColor);
      $$("#subsColors .subs-swatch").forEach((b) => b.classList.toggle("active", b === btn));
      applySubStyle();
    });
  });
  const bgSel = $("#subsBg");
  if (bgSel) {
    bgSel.value = String(subBg);
    bgSel.addEventListener("change", () => {
      subBg = Number(bgSel.value) || 0;
      store.set(SUB_BG_KEY, subBg);
      applySubStyle();
    });
  }
  applySubStyle();

  $("#clearChatBtn")?.addEventListener("click", async () => {
    if (!isModSelf()) { toast(t("chat.clearDenied"), "error"); return; }
    if (!chatList.children.length) { toast(t("chat.clearEmpty"), "info", 3400); return; }
    const ok = await confirmDialog({
      title: t("settings.clearChat"),
      text: t("settings.clearChatHint"),
      okLabel: t("settings.clearChat")
    });
    if (!ok) return;
    net.command("chatClear");
  });
}

function renderQuality(info) {
  const row = $("#qualityRow");
  const sel = $("#optQuality");
  if (!row || !sel) return;
  if (!info || !info.levels?.length) {
    row.classList.add("hidden");
    return;
  }
  const heights = [...new Set(info.levels.map((l) => l.height).filter(Boolean))].sort((a, b) => b - a);
  if (heights.length < 2) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");
  sel.innerHTML = "";
  sel.append(el("option", { value: "-1", text: t("settings.qualityAuto") }));
  for (const h of heights) {
    const idx = info.levels.findIndex((l) => l.height === h);
    sel.append(el("option", { value: String(idx), text: `${h}p` }));
  }
  sel.value = info.auto ? "-1" : String(Math.max(0, info.current));
}

function renderAudio(info) {
  const row = $("#audioRow");
  const sel = $("#optAudio");
  if (!row || !sel) return;
  if (!info || info.tracks.length < 2) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");
  setTracksHint(null);
  sel.innerHTML = "";
  for (const track of info.tracks) {
    const label = track.name || track.lang || `Track ${track.i + 1}`;
    sel.append(el("option", { value: String(track.i), text: label }));
  }
  sel.value = String(Math.max(0, info.current));
}

function renderTextTracks(info) {
  const row = $("#subsTrackRow");
  const sel = $("#optSubsTrack");
  if (!row || !sel) return;
  if (!info || !info.tracks?.length) {
    row.classList.add("hidden");
    sel.innerHTML = "";
    return;
  }
  row.classList.remove("hidden");
  setTracksHint(null);
  sel.innerHTML = "";
  sel.append(el("option", { value: "-1", text: t("settings.subsTrackOff") }));
  for (const track of info.tracks) {
    sel.append(el("option", { value: String(track.i), text: track.name }));
  }
  sel.value = String(info.current >= 0 ? info.current : -1);
}

function shareActiveSubs() {
  if (!isHost || !player) return;
  const cues = player.getSubtitleCues();
  if (cues.length) net.shareSubtitles(cues);
}

function renderSubsSets() {
  const wrap = $("#subsList");
  if (!wrap) return;
  const sets = player?.getSubtitleSets() || [];
  wrap.innerHTML = "";
  wrap.classList.toggle("hidden", !sets.length);
  for (const s of sets) {
    const item = el("div", { class: `subs-item${s.active ? " active" : ""}` });
    const name = el("button", { class: "subs-name", type: "button", text: s.name });
    name.addEventListener("click", () => {
      player.activateSubtitleSet(s.name);
      renderSubsSets();
      shareActiveSubs();
    });
    const count = el("span", { class: "subs-count", text: String(s.count) });
    const rm = el("button", { class: "subs-x", type: "button", text: "×", "aria-label": "Remove" });
    rm.addEventListener("click", () => {
      player.removeSubtitleSet(s.name);
      renderSubsSets();
      shareActiveSubs();
    });
    item.append(name, count, rm);
    wrap.append(item);
  }
}

/* ================= personal appearance ================= */
function wirePrefs() {
  const prefs = getPrefs();
  const row = $("#accentRow");
  const makeSwatch = (acc) => {
    const b = el("button", {
      class: "accent-swatch",
      type: "button",
      "aria-label": acc.a,
      title: acc.a
    });
    b.style.background = `linear-gradient(135deg,${acc.a},${acc.b})`;
    b.dataset.a = acc.a;
    b.dataset.b = acc.b;
    b.addEventListener("click", () => {
      if (!allow("account.customThemes", t("prefs.locked"))) return;
      savePrefs({ accent: acc.a, accent2: acc.b });
      markAccent();
    });
    return b;
  };
  function markAccent() {
    const p = getPrefs();
    const preset = ACCENTS.some((acc) => acc.a === p.accent);
    $$(".accent-swatch", row).forEach((s) => s.classList.toggle("active", s.dataset.a === p.accent));
    const wrap = $("#accentCustomWrap");
    const input = $("#accentCustom");
    if (input) input.value = p.accent;
    if (wrap) {
      wrap.classList.toggle("active", !preset);
      wrap.style.background = preset ? "" : `linear-gradient(135deg,${p.accent},${p.accent2})`;
    }
  }
  const themeRow = $("#themeRow");
  function markTheme() {
    if (!themeRow) return;
    const cur = getPrefs().theme === "light" ? "light" : "dark";
    $$(".theme-opt", themeRow).forEach((b) => b.classList.toggle("active", b.dataset.themeOpt === cur));
  }
  if (themeRow) {
    $$(".theme-opt", themeRow).forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!allow("account.customThemes", t("prefs.locked"))) return;
        savePrefs({ theme: btn.dataset.themeOpt });
        markTheme();
      });
    });
  }
  markTheme();
  ACCENTS.forEach((acc) => row.append(makeSwatch(acc)));
  const customInput = $("#accentCustom");
  if (customInput) {
    customInput.addEventListener("input", () => {
      if (!allow("account.customThemes", t("prefs.locked"))) return;
      savePrefs({ accent: customInput.value, accent2: lightenHex(customInput.value) });
      markAccent();
    });
    customInput.addEventListener("change", () => toast(t("toast.customAccent"), "success"));
  }
  markAccent();

  const bindRange = (id, valId, key, fmt) => {
    const inp = $(id);
    const out = $(valId);
    inp.value = String(prefs[key]);
    out.textContent = fmt(prefs[key]);
    inp.addEventListener("input", () => {
      const v = Number(inp.value);
      savePrefs({ [key]: v });
      out.textContent = fmt(v);
    });
  };
  bindRange("#prefBrightness", "#prefBrightnessVal", "brightness", (v) => `${v}%`);
  bindRange("#prefChatSize", "#prefChatSizeVal", "chatSize", (v) => String(v.toFixed(1)));
  bindRange("#prefChatAlpha", "#prefChatAlphaVal", "chatAlpha", (v) => `${v}%`);
  bindRange("#prefChatBright", "#prefChatBrightVal", "chatBright", (v) => `${v}%`);
  bindRange("#prefCineBright", "#prefCineBrightVal", "cineBright", (v) => `${v}%`);
  bindRange("#prefCineSize", "#prefCineSizeVal", "cineSize", (v) => String(v.toFixed(1)));
  bindRange("#prefGlass", "#prefGlassVal", "glass", (v) => `${v}%`);
  markAccent();

  $("#prefsReset").addEventListener("click", () => {
    if (!allow("account.customThemes", t("prefs.locked"))) return;
    const d = resetPrefs();
    $("#prefBrightness").value = String(d.brightness);
    $("#prefBrightnessVal").textContent = `${d.brightness}%`;
    $("#prefChatSize").value = String(d.chatSize);
    $("#prefChatSizeVal").textContent = d.chatSize.toFixed(1);
    $("#prefChatAlpha").value = String(d.chatAlpha);
    $("#prefChatAlphaVal").textContent = `${d.chatAlpha}%`;
    $("#prefChatBright").value = String(d.chatBright);
    $("#prefChatBrightVal").textContent = `${d.chatBright}%`;
    $("#prefCineBright").value = String(d.cineBright);
    $("#prefCineBrightVal").textContent = `${d.cineBright}%`;
    $("#prefCineSize").value = String(d.cineSize);
    $("#prefCineSizeVal").textContent = d.cineSize.toFixed(1);
    $("#prefGlass").value = String(d.glass);
    $("#prefGlassVal").textContent = `${d.glass}%`;
    markAccent();
    markTheme();
    toast(t("prefs.resetDone"), "success");
  });

  markAccentUI = markAccent;
  markThemeUI = markTheme;
  prefsReady = true;
  syncPrefsGate();
}

/* ================= tabs ================= */
function paintUnreadChat() {
  const badge = $("#chatBadge");
  if (badge) {
    badge.textContent = unreadChat > 9 ? "9+" : String(unreadChat);
    badge.classList.toggle("hidden", unreadChat === 0);
  }
  syncChatFab();
}

function noteIncomingChat() {
  if (!chatHidden && activeTabName === "chat" && document.visibilityState === "visible") return;
  unreadChat = Math.min(99, unreadChat + 1);
  paintUnreadChat();
}

function clearUnreadChat() {
  if (!unreadChat) return;
  unreadChat = 0;
  paintUnreadChat();
}

function wireTabs() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && activeTabName === "chat") clearUnreadChat();
  });
}

function activateTab(name) {
  activeTabName = name;
  if (name === "chat") clearUnreadChat();
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
  $("#sidebar").classList.add("open");
  if (name === "chat") setTimeout(() => scrollChatSoon(true), 50);
}

/* ================= voice ================= */
function wireVoice() {
  $("#voiceBtn").addEventListener("click", () => {
    if (!selfVoice && (!CAPS.webrtc || !CAPS.mic)) return toast(t("toast.voiceUnsupported"), "error", 6000);
    if (!selfVoice && !allow("voice.chat", "صدای زنده غیرفعال شده است.")) return;
    toggleVoice();
  });
  $("#voiceLeaveBtn").addEventListener("click", leaveVoice);
  $("#micBtn").addEventListener("click", () => {
    if (!selfVoice) return toast(t("toast.notInVoice"));
    if (pttOn) return;
    if (!allow("voice.mic", "میکروفن غیرفعال شده است.")) return;
    voice.setMuted(!voice.muted);
    syncMicUI();
  });
  $("#deafenBtn").addEventListener("click", () => {
    if (!selfVoice) return toast(t("toast.notInVoice"));
    if (!allow("voice.deafen", "ناشنوایی غیرفعال شده است.")) return;
    voice.setDeafened(!voice.deafened);
    syncDeafenUI();
    renderVoiceTiles();
    toast(t(voice.deafened ? "toast.deafened" : "toast.undeafened"), "info");
  });
  $("#cameraBtn")?.addEventListener("click", () => {
    if (!allow("voice.camera", "دوربین غیرفعال شده است.")) return;
    syncCameraUI();
    toast(t("toast.cameraSoon"), "info");
  });
  if (voice) { syncMicUI(); syncDeafenUI(); syncCameraUI(); }
}

async function toggleVoice() {
  if (selfVoice) return leaveVoice();
  if (!allow("voice.chat", "صدای زنده غیرفعال شده است.")) return;
  const ok = await voice.join();
  if (!ok) return;
  selfVoice = true;
  if (pttOn) voice.setMuted(true);
  for (const m of members) if (m.voice && m.id !== me.id) applyUserAudio(m.id, m.nick);
  net.command("voice", { on: true });
  recordFeatureUse("voice.chat", { plan: flagContext.plan, role: flagContext.role, room: code });
  $("#voiceBtn").classList.add("active");
  $("#voiceDock").classList.remove("hidden");
  syncMicUI();
  renderVoiceTiles();
  toast(t("toast.voiceJoined"), "success");
}

function leaveVoice() {
  if (!selfVoice) return;
  voice.leave();
  selfVoice = false;
  net.command("voice", { on: false });
  $("#voiceBtn").classList.remove("active");
  $("#voiceDock").classList.add("hidden");
  renderVoiceTiles();
  toast(t("toast.voiceLeft"));
}

function syncMicUI() {
  const btn = $("#micBtn");
  btn.classList.toggle("active", !voice.muted);
  btn.classList.toggle("state-on", !voice.muted);
  btn.classList.toggle("state-off", voice.muted);
  btn.title = t(voice.muted ? "voice.unmute" : "voice.mute");
  btn.setAttribute("aria-label", btn.title);
  btn.setAttribute("aria-pressed", String(!voice.muted));
  btn.innerHTML = voice.muted
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4l16 16M9 4v3M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const tile = document.querySelector(`.voice-tile[data-id="${cssEscape(me.id)}"]`);
  tile?.classList.toggle("muted", voice.muted);
}

function syncDeafenUI() {
  const btn = $("#deafenBtn");
  if (!btn) return;
  btn.classList.toggle("active", voice.deafened);
  btn.classList.toggle("state-on", !voice.deafened);
  btn.classList.toggle("state-off", voice.deafened);
  btn.title = t(voice.deafened ? "voice.undeafen" : "voice.deafen");
  btn.setAttribute("aria-label", btn.title);
  btn.setAttribute("aria-pressed", String(voice.deafened));
  btn.innerHTML = voice.deafened
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4l16 16M4 14v-2a8 8 0 0 1 3.1-6.3"/><path d="M14.5 4.4A8 8 0 0 1 20 12v2"/><rect x="3" y="13" width="4" height="7" rx="1.5"/><rect x="17" y="13" width="4" height="7" rx="1.5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="7" rx="1.5"/><rect x="17" y="13" width="4" height="7" rx="1.5"/></svg>';
}

function syncCameraUI() {
  const btn = $("#cameraBtn");
  if (!btn) return;
  btn.classList.remove("active", "state-on");
  btn.classList.add("state-off");
  btn.title = t("voice.cameraSoon");
  btn.setAttribute("aria-label", btn.title);
  btn.setAttribute("aria-pressed", "false");
}

/* ================= screen share ================= */
function nickFor(id) {
  return members.find((m) => m.id === id)?.nick || me.nick || "?";
}

let shareEndTimer = 0;
let shareEndBlinkTimer = 0;
function clearShareEndState() {
  clearTimeout(shareEndTimer);
  clearTimeout(shareEndBlinkTimer);
  shareEndTimer = 0;
  shareEndBlinkTimer = 0;
  const btn = $("#shareBtn");
  btn?.classList.remove("share-ended", "blink");
}

function paintScreenState() {
  const btn = $("#shareBtn");
  if (!btn) return;
  btn.classList.toggle("active", screenSharing);
  btn.classList.toggle("state-on", screenSharing);
  btn.classList.remove("state-off");
  btn.title = t(screenSharing ? "screen.stop" : "screen.start");
  btn.setAttribute("aria-label", btn.title);
  btn.setAttribute("aria-pressed", String(screenSharing));
}

function paintShareEnded() {
  const btn = $("#shareBtn");
  if (!btn) return;
  clearShareEndState();
  btn.classList.add("share-ended", "blink");
  btn.title = t("screen.ended");
  btn.setAttribute("aria-label", btn.title);
  shareEndBlinkTimer = setTimeout(() => btn.classList.remove("blink"), 5000);
  shareEndTimer = setTimeout(() => {
    btn.classList.remove("share-ended", "blink");
    btn.title = t("screen.start");
    btn.setAttribute("aria-label", btn.title);
  }, 10000);
}

function sendScreenTo(peerId) {
  if (!net || !screenStream || !peerId || peerId === me.id) return;
  net.shareScreenTo(peerId, screenStream);
  screenSentTo.add(peerId);
}

function syncScreenSharePeers() {
  if (!screenSharing || !net) return;
  const live = new Set(members.map((m) => m.id).filter((id) => id && id !== me.id));
  for (const id of live) if (!net.screenCalls?.has(id)) sendScreenTo(id);
  for (const id of [...screenSentTo]) {
    if (live.has(id)) continue;
    screenSentTo.delete(id);
    net.closeScreen(id, false);
    screenRetryCount.delete(id);
    clearTimeout(screenRetryTimers.get(id));
    screenRetryTimers.delete(id);
  }
}

function screenErrorKey(err) {
  switch (err?.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "toast.screenDenied";
    case "NotFoundError":
      return "toast.screenMissing";
    case "NotSupportedError":
      return "toast.screenUnsupported";
    case "NotReadableError":
    case "TrackStartError":
    case "InvalidStateError":
      return "toast.screenBusy";
    case "SecurityError":
      return "toast.screenInsecure";
    default:
      return "toast.screenUnsupported";
  }
}

async function requestDisplayStream() {
  const video = { frameRate: { ideal: 30, max: 60 } };
  const attempts = [
    {
      video,
      audio: { suppressLocalAudioPlayback: true },
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      monitorTypeSurfaces: "include"
    },
    { video, audio: true },
    { video, audio: false }
  ];
  let lastErr;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (err) {
      lastErr = err;
      if (!["TypeError", "NotSupportedError"].includes(err?.name)) throw err;
    }
  }
  throw lastErr;
}

function scheduleScreenRetry(peerId) {
  if (!screenSharing || !peerId) return;
  const tries = screenRetryCount.get(peerId) || 0;
  if (tries >= 3) {
    toast(t("toast.screenRetryFailed"), "error", 7000);
    return;
  }
  screenRetryCount.set(peerId, tries + 1);
  toast(t("toast.screenReconnecting"), "info", 3500);
  clearTimeout(screenRetryTimers.get(peerId));
  screenRetryTimers.set(peerId, setTimeout(() => {
    screenRetryTimers.delete(peerId);
    if (screenSharing) syncScreenSharePeers();
  }, 1800 * (tries + 1)));
}

async function startScreenShare() {
  if (screenSharing) return;
  if (!allow("screen.share", "اشتراک صفحه غیرفعال شده است.")) return;
  if (!window.isSecureContext) return toast(t("toast.screenInsecure"), "error", 6500);
  if (!navigator.mediaDevices?.getDisplayMedia) return toast(t("toast.screenUnsupported"), "error");
  let stream;
  try {
    stream = await requestDisplayStream();
  } catch (err) {
    if (err?.name === "AbortError") return;
    return toast(t(screenErrorKey(err)), "error", 6500);
  }
  screenStream = stream;
  screenSharing = true;
  screenHasAudio = stream.getAudioTracks().length > 0;
  screenAudioMuted = false;
  screenAudioBlocked = false;
  clearShareEndState();
  screenSentTo = new Set();
  screenRetryCount = new Map();
  for (const timer of screenRetryTimers.values()) clearTimeout(timer);
  screenRetryTimers = new Map();
  recordFeatureUse("screen.share", { plan: flagContext.plan, role: flagContext.role, room: code });
  stream.getTracks().forEach((track) => track.addEventListener("ended", () => stopScreenShare()));
  for (const m of members) sendScreenTo(m.id);
  showScreenView("self", stream);
  paintScreenState();
  toast(t(screenHasAudio ? "toast.screenStartedAudio" : "toast.screenStarted"), "success");
}

function stopScreenShare({ quiet = false } = {}) {
  if (!screenSharing) return;
  screenSharing = false;
  for (const timer of screenRetryTimers.values()) clearTimeout(timer);
  screenRetryTimers = new Map();
  screenRetryCount = new Map();
  for (const id of screenSentTo) net?.closeScreen(id, true);
  screenSentTo.clear();
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  screenHasAudio = false;
  try {
    const audio = $("#screenAudio");
    audio.pause();
    audio.srcObject = null;
  } catch {}
  if (activeScreen === "self") {
    const next = [...screenViews.entries()].pop();
    if (next) showScreenView(next[0], next[1]);
    else hideScreenView();
  }
  paintScreenState();
  if (!quiet) {
    paintShareEnded();
    toast(t("toast.screenStopped"));
  }
}

function syncScreenBar() {
  const audioBtn = $("#screenAudioBtn");
  const stopBtn = $("#screenStopBtn");
  if (!audioBtn || !stopBtn) return;
  const local = activeScreen === "self";
  const stream = local ? screenStream : screenViews.get(activeScreen);
  const remoteAudio = !local && (stream?.getAudioTracks?.().length || 0) > 0;
  audioBtn.classList.toggle("hidden", !remoteAudio);
  audioBtn.classList.toggle("is-muted", screenAudioMuted || screenAudioBlocked);
  audioBtn.classList.toggle("is-blocked", screenAudioBlocked);
  audioBtn.title = t(screenAudioMuted ? "screen.audioOff" : "screen.audioOn");
  audioBtn.setAttribute("aria-label", audioBtn.title);
  audioBtn.setAttribute("aria-pressed", String(!screenAudioMuted));
  const canForce = !local && !!activeScreen && canControl();
  stopBtn.classList.toggle("hidden", !local && !canForce);
  stopBtn.title = t(local ? "screen.stopShare" : "screen.forceStop");
  stopBtn.setAttribute("aria-label", stopBtn.title);
}

function showScreenView(id, stream) {
  activeScreen = id;
  const local = id === "self";
  $("#screenWho").textContent = local ? t("screen.sharingYou") : t("screen.viewing", { name: nickFor(id) });
  const video = $("#screenVideo");
  video.srcObject = stream;
  video.muted = true;
  video.play?.().catch(() => {});
  const audio = $("#screenAudio");
  const audioTracks = stream.getAudioTracks?.() || [];
  if (!local && audioTracks.length) {
    audio.srcObject = stream;
    audio.muted = screenAudioMuted;
    audio.play?.().then(() => {
      screenAudioBlocked = false;
      syncScreenBar();
    }).catch(() => {
      screenAudioBlocked = true;
      syncScreenBar();
      toast(t("screen.audioBlocked"), "info", 6000);
    });
  } else {
    try {
      audio.pause();
      audio.srcObject = null;
    } catch {}
    screenAudioBlocked = false;
  }
  $("#screenLayer").classList.remove("hidden");
  $("#screenPeek").classList.add("hidden");
  syncScreenBar();
}

function hideScreenView() {
  activeScreen = "";
  const video = $("#screenVideo");
  try { video.pause(); } catch {}
  video.srcObject = null;
  try {
    const audio = $("#screenAudio");
    audio.pause();
    audio.srcObject = null;
  } catch {}
  const layer = $("#screenLayer");
  if (layer?.classList.contains("expanded")) popOverlayState();
  layer?.classList.add("hidden");
  layer?.classList.remove("expanded");
  $("#screenPeek").classList.toggle("hidden", screenViews.size === 0);
  syncScreenBar();
}

function wireScreen() {
  if (!$("#shareBtn")) return;
  $("#shareBtn").addEventListener("click", () => {
    if (screenSharing) stopScreenShare();
    else startScreenShare();
  });
  $("#screenHideBtn").addEventListener("click", () => hideScreenView());
  $("#screenAudioBtn").addEventListener("click", async () => {
    const audio = $("#screenAudio");
    screenAudioMuted = !screenAudioMuted;
    audio.muted = screenAudioMuted;
    if (!screenAudioMuted) {
      try {
        await audio.play();
        screenAudioBlocked = false;
      } catch {
        screenAudioBlocked = true;
      }
    }
    syncScreenBar();
  });
  $("#screenStopBtn").addEventListener("click", () => {
    if (activeScreen === "self") return stopScreenShare();
    if (!activeScreen || !canControl()) return;
    net?.stopRemoteScreen(activeScreen);
    toast(t("screen.forceStopSent"), "info");
  });
  $("#screenFitBtn").addEventListener("click", () => {
    const layer = $("#screenLayer");
    layer.classList.toggle("expanded");
    if (layer.classList.contains("expanded")) pushOverlayState();
    else popOverlayState();
  });
  $("#screenPeek").addEventListener("click", () => {
    const next = [...screenViews.entries()].pop();
    if (next) showScreenView(next[0], next[1]);
    else hideScreenView();
  });
  document.addEventListener("langchange", () => {
    paintScreenState();
    if (activeScreen) {
      $("#screenWho").textContent = activeScreen === "self"
        ? t("screen.sharingYou")
        : t("screen.viewing", { name: nickFor(activeScreen) });
    }
    syncScreenBar();
  });
  paintScreenState();
  syncScreenBar();
}

/* ---------- push-to-talk ---------- */
function wirePtt() {
  const input = $("#optPtt");
  if (!input) return;
  input.checked = pttOn;
  input.addEventListener("change", () => {
    if (input.checked && !allow("voice.ptt", "Push To Talk غیرفعال شده است.")) {
      input.checked = false;
      return;
    }
    pttOn = input.checked;
    store.set(PTT_KEY, pttOn);
    if (pttHeld) pttRelease();
    if (pttOn) {
      if (selfVoice && !voice.muted) { voice.setMuted(true); syncMicUI(); }
      toast(t("toast.pttOn"), "info", 4200);
    } else {
      toast(t("toast.pttOff"));
    }
  });

  const typing = (target) => target instanceof Element && !!target.closest("input,textarea,select,[contenteditable]");
  document.addEventListener("keydown", (e) => {
    if (!pttOn || !selfVoice) return;
    if (e.key.toLowerCase() !== "v" || e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing(e.target)) return;
    e.preventDefault();
    pttPress();
  });
  document.addEventListener("keyup", (e) => {
    if (e.key.toLowerCase() === "v") pttRelease();
  });
  window.addEventListener("blur", pttRelease);

  /* holding the mic button also works (touch friendly) */
  const mic = $("#micBtn");
  let micHeld = false;
  mic.addEventListener("pointerdown", (e) => {
    if (!pttOn || !selfVoice) return;
    micHeld = true;
    try { mic.setPointerCapture(e.pointerId); } catch {}
    pttPress();
  });
  const releaseMic = () => {
    if (!micHeld) return;
    micHeld = false;
    pttRelease();
  };
  mic.addEventListener("pointerup", releaseMic);
  mic.addEventListener("pointercancel", releaseMic);
  mic.addEventListener("lostpointercapture", releaseMic);
}

function pttPress() {
  if (!pttOn || !selfVoice) return;
  if (!pttHeld) {
    pttRestoreMute = voice.muted;
    pttHeld = true;
  }
  if (voice.muted) { voice.setMuted(false); syncMicUI(); }
}

function pttRelease() {
  if (!pttHeld) return;
  pttHeld = false;
  if (pttRestoreMute && selfVoice && !voice.muted) {
    voice.setMuted(true);
    syncMicUI();
  }
}

function renderVoiceTiles() {
  const strip = $("#voiceStrip");
  strip.innerHTML = "";
  if (!selfVoice) return;
  const inVoice = members.filter((m) => m.voice);
  if (!inVoice.some((m) => m.id === me.id)) inVoice.push({ id: me.id, nick: me.nick, muted: voice.muted });
  for (const m of inVoice) {
    const mutedLocal = m.id !== me.id && voice.isLocalMuted(m.id);
    const tile = el("div", { class: `voice-tile${m.muted ? " muted" : ""}${mutedLocal ? " muted-local" : ""}`, "data-id": m.id });
    const av = el("div", { class: "avatar-sm" });
    paintAvatar(av, m.avatar || avatarFor(m.id), m.nick, m.id);
    const name = el("span", { text: m.id === me.id ? (getLang() === "fa" ? "تو" : "You") : m.nick });
    tile.append(av, name);
    if (m.id !== me.id) {
      const vol = el("input", { type: "range", min: "0", max: "100", class: "tile-vol", value: String(Math.round((voice.volumes.get(m.id) ?? 1) * 100)) });
      vol.addEventListener("input", (e) => {
        const v = Number(e.target.value) / 100;
        voice.setVolume(m.id, v);
        saveUserAudio(m.nick, { vol: v });
        const person = peopleList.querySelector(`.person[data-id="${cssEscape(m.id)}"] .person-vol`);
        if (person) person.value = e.target.value;
      });
      tile.append(vol);
    }
    strip.append(tile);
  }
}

/* ================= floating cinema chat ================= */
function pushCine(msg, { quiet = false } = {}) {
  if (!msg?.id) return;
  const i = cineMsgs.findIndex((m) => m.id === msg.id);
  const entry = {
    id: msg.id, by: msg.by, nick: msg.nick || "?",
    text: msg.text || "", deleted: !!msg.deleted
  };
  if (i >= 0) cineMsgs[i] = { ...cineMsgs[i], ...entry };
  else cineMsgs.push(entry);
  if (cineMsgs.length > MAX_CINE) cineMsgs = cineMsgs.slice(-MAX_CINE);
  renderCine();
  const fresh = !msg.at || Date.now() - msg.at < 60000;
  if (!quiet && fresh && !cineExpanded && msg.by !== me.id) {
    cineUnread = Math.min(99, cineUnread + 1);
    paintCineUnread();
  }
  const frame = $(".video-frame");
  const feedAllowed = cineOn && chatEnabled && flagOn(flagStates, "watch.floatingChat");
  if (feedAllowed && !quiet && fresh && !cineExpanded && !entry.deleted && cineFeed && frame?.classList.contains("has-media")) {
    cineFeed.push({ name: entry.nick, text: entry.text, mine: msg.by === me.id });
  }
}

function renderCine() {
  const list = $("#cineList");
  if (!list) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 46;
  list.innerHTML = "";
  if (!cineMsgs.length) {
    list.append(el("div", { class: "cine-empty", text: t("cine.empty") }));
    return;
  }
  for (const m of cineMsgs) {
    const row = el("div", {
      class: `cine-msg${m.by === me.id ? " own" : ""}${m.deleted ? " deleted" : ""}`
    });
    row.append(
      el("b", { class: "cine-name", text: m.nick || "?" }),
      el("span", { class: "cine-sep", text: " : " }),
      el("span", { class: "cine-text", text: m.deleted ? t("chat.deleted") : m.text })
    );
    list.append(row);
  }
  if (nearBottom || cineExpanded) list.scrollTop = list.scrollHeight;
}

function paintCineUnread() {
  const badge = $("#cineUnread");
  if (badge) {
    badge.textContent = cineUnread > 9 ? "9+" : String(cineUnread);
    badge.classList.toggle("hidden", cineUnread === 0);
  }
  $("#cineCtlDot")?.classList.toggle("hidden", cineUnread === 0 || cineExpanded);
}

function setCineExpanded(on) {
  cineExpanded = !!on && cineOn && chatEnabled && flagOn(flagStates, "watch.floatingChat");
  const box = $("#cineChat");
  if (!box) return;
  box.classList.toggle("min", !cineExpanded);
  $("#cineExpandBtn")?.setAttribute("aria-expanded", String(cineExpanded));
  const ctl = $("#cineCtlBtn");
  ctl?.classList.toggle("active", cineExpanded);
  ctl?.setAttribute("aria-expanded", String(cineExpanded));
  cineFeed?.setPaused(cineExpanded);
  if (cineExpanded) {
    cineUnread = 0;
    paintCineUnread();
    renderCine();
    requestAnimationFrame(() => { const l = $("#cineList"); if (l) l.scrollTop = l.scrollHeight; });
  } else {
    const input = $("#cineInput");
    if (input && document.activeElement === input) input.blur();
    paintCineUnread();
  }
}

function applyCineChat() {
  const box = $("#cineChat");
  if (!box) return;
  const enabled = cineOn && chatEnabled && flagOn(flagStates, "watch.floatingChat");
  if (!enabled && cineExpanded) setCineExpanded(false);
  box.classList.toggle("hidden", !enabled);
  box.classList.toggle("min", !cineExpanded);
  $("#cineCtlBtn")?.classList.toggle("hidden", !enabled);
  cineFeed?.setPaused(!enabled || cineExpanded);
  if (enabled) {
    renderCine();
    paintCineUnread();
  }
}

function wireCineChat() {
  const box = $("#cineChat");
  if (!box) return;
  cineFeed = new LiveFeed($("#cineFeed"), { gap: 1500, hold: 4600, max: 6 });
  cineFeed.setPaused(cineExpanded);
  const styleBtn = $("#cineStyleBtn");
  const styleBox = $("#cineStyle");
  const brightRange = $("#cineBrightRange");
  const sizeRange = $("#cineSizeRange");
  const stayOpt = $("#cineStayOpen");
  if (stayOpt) {
    stayOpt.checked = cineStayOpen;
    stayOpt.addEventListener("change", () => {
      cineStayOpen = stayOpt.checked;
      savePrefs({ cineStayOpen });
      toast(t(cineStayOpen ? "cine.stayOn" : "cine.stayOff"), "info", 2600);
    });
  }
  const fillStyleRanges = () => {
    const p = getPrefs();
    if (brightRange) brightRange.value = String(p.cineBright);
    if (sizeRange) sizeRange.value = String(p.cineSize);
    if (stayOpt) stayOpt.checked = cineStayOpen;
  };
  const syncPrefRows = () => {
    const p = getPrefs();
    if ($("#prefCineBright")) {
      $("#prefCineBright").value = String(p.cineBright);
      $("#prefCineBrightVal").textContent = `${p.cineBright}%`;
    }
    if ($("#prefCineSize")) {
      $("#prefCineSize").value = String(p.cineSize);
      $("#prefCineSizeVal").textContent = p.cineSize.toFixed(1);
    }
  };
  fillStyleRanges();
  styleBtn?.addEventListener("click", () => {
    const open = styleBox?.classList.toggle("hidden") === false;
    if (open) fillStyleRanges();
    styleBtn.setAttribute("aria-expanded", String(open));
  });
  brightRange?.addEventListener("input", () => {
    savePrefs({ cineBright: Number(brightRange.value) });
    syncPrefRows();
  });
  sizeRange?.addEventListener("input", () => {
    savePrefs({ cineSize: Number(sizeRange.value) });
    syncPrefRows();
  });
  $("#prefCineBright")?.addEventListener("input", fillStyleRanges);
  $("#prefCineSize")?.addEventListener("input", fillStyleRanges);
  $("#cineExpandBtn")?.addEventListener("click", () => setCineExpanded(!cineExpanded));
  $("#cineMinBtn")?.addEventListener("click", () => setCineExpanded(false));
  $("#cineCtlBtn")?.addEventListener("click", () => {
    if (!allow("watch.floatingChat", "چت شناور غیرفعال شده است.")) return;
    setCineExpanded(!cineExpanded);
  });
  $("#cineForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#cineInput");
    const text = input.value.trim();
    if (!sendChatText(text)) { input.focus(); return; }
    input.value = "";
    input.focus();
    scrollChat(true);
    if (!cineStayOpen) setTimeout(() => { if (cineExpanded) setCineExpanded(false); }, 450);
  });
  box.querySelector(".cine-head")?.addEventListener("click", (e) => {
    if (e.target.closest(".cine-min") || e.target.closest(".cine-title-btn")) return;
    setCineExpanded(!cineExpanded);
  });
  $("#cineExpandBtn")?.addEventListener("focus", () => {
    if (!cineExpanded) setCineExpanded(true);
  });
  const opt = $("#optCineChat");
  if (opt) {
    opt.checked = cineOn;
    opt.addEventListener("change", () => {
      cineOn = opt.checked;
      store.set(CINE_CHAT_KEY, cineOn);
      applyCineChat();
    });
  }
  applyCineChat();
}

/* ================= live reactions ================= */
function closeReactTray() {
  $("#reactTray")?.classList.remove("open");
  $("#reactToggle")?.setAttribute("aria-expanded", "false");
  const ctl = $("#reactCtlBtn");
  ctl?.classList.remove("active");
  ctl?.setAttribute("aria-expanded", "false");
}

function openReactTray() {
  if (!reactionsOn || !flagOn(flagStates, "chat.reactions")) return;
  $("#reactTray")?.classList.add("open");
  $("#reactToggle")?.setAttribute("aria-expanded", "true");
  const ctl = $("#reactCtlBtn");
  ctl?.classList.add("active");
  ctl?.setAttribute("aria-expanded", "true");
}

function applyReactionVis() {
  const ok = reactionsOn && flagOn(flagStates, "chat.reactions");
  $("#reactDock")?.classList.toggle("is-off", !ok);
  $("#reactCtlBtn")?.classList.toggle("hidden", !ok);
  if (!ok) closeReactTray();
}

function floatReaction(emoji) {
  if (!reactionsOn || !flagOn(flagStates, "chat.reactions")) return;
  const frame = $("#videoFrame");
  if (!frame) return;
  const node = el("span", { class: "live-reaction", text: emoji });
  node.style.setProperty("--x", `${12 + Math.random() * 76}%`);
  node.style.setProperty("--dx", `${Math.round((Math.random() - 0.5) * 90)}px`);
  frame.append(node);
  // Safety net for Windows/Edge: if OS motion settings shortens the CSS
  // animation, replay the float with the Web Animations API so it never
  // sticks invisible at opacity 0.
  requestAnimationFrame(() => {
    if (!node.isConnected) return;
    const [css] = node.getAnimations ? node.getAnimations() : [];
    const dur = css?.effect?.getTiming?.().duration;
    if (css && !(dur > 300)) {
      try { css.cancel(); } catch {}
      node.animate(
        [
          { opacity: 0, transform: "translate(-50%,14px) scale(.9)" },
          { opacity: 1, transform: "translate(-50%,0) scale(1)", offset: 0.12 },
          { opacity: 1, transform: "translate(-50%,-6px) scale(1)", offset: 0.78 },
          { opacity: 0, transform: "translate(-50%,-18px) scale(1.05)" }
        ],
        { duration: 2200, easing: "ease-out", fill: "forwards" }
      ).onfinish = () => node.remove();
    }
  });
  setTimeout(() => node.remove(), 2400);
}

function sendReaction(emoji) {
  if (!allow("chat.reactions", "واکنش‌ها غیرفعال شده است.")) return;
  const now = Date.now();
  if (now - lastReactAt < 600) return;
  lastReactAt = now;
  floatReaction(emoji);
  recordFeatureUse("chat.reactions", { plan: flagContext.plan, role: flagContext.role, room: code });
  net.command("reaction", { emoji });
}

function wireReactions() {
  const dock = $("#reactDock");
  const tray = $("#reactTray");
  const toggle = $("#reactToggle");
  if (!dock || !tray || !toggle) return;
  let hoverTimer = 0;
  let closeTimer = 0;

  for (const emoji of LIVE_EMOJIS) {
    tray.append(el("button", {
      type: "button", role: "menuitem", text: emoji, "aria-label": emoji,
      onclick: () => sendReaction(emoji)
    }));
  }
  toggle.addEventListener("click", () => {
    if (tray.classList.contains("open")) closeReactTray();
    else openReactTray();
  });
  $("#reactCtlBtn")?.addEventListener("click", () => {
    if (!allow("chat.reactions", "واکنش‌ها غیرفعال شده است.")) return;
    if (tray.classList.contains("open")) closeReactTray();
    else openReactTray();
  });
  dock.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "touch") return;
    clearTimeout(closeTimer);
    hoverTimer = setTimeout(openReactTray, 140);
  });
  dock.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "touch") return;
    clearTimeout(hoverTimer);
    closeTimer = setTimeout(closeReactTray, 350);
  });
  tray.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "touch") return;
    clearTimeout(closeTimer);
    clearTimeout(hoverTimer);
    openReactTray();
  });
  tray.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "touch") return;
    clearTimeout(hoverTimer);
    closeTimer = setTimeout(closeReactTray, 350);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!tray.classList.contains("open")) return;
    if (dock.contains(e.target) || e.target.closest("#reactCtlBtn")) return;
    closeReactTray();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && tray.classList.contains("open")) closeReactTray();
  });
  const opt = $("#optReactions");
  if (opt) {
    opt.checked = reactionsOn;
    opt.addEventListener("change", () => {
      reactionsOn = opt.checked;
      store.set(REACT_DOCK_KEY, reactionsOn);
      applyReactionVis();
      if (!reactionsOn) toast(t("react.off"), "info", 2400);
    });
  }
  applyReactionVis();
}

/* ================= misc ================= */
/* Back button (Android) closes overlays before leaving the room. */
let overlayStatePushed = false;
function pushOverlayState() {
  if (overlayStatePushed) return;
  overlayStatePushed = true;
  try { history.pushState({ wtOverlay: 1 }, ""); } catch { overlayStatePushed = false; }
}
function popOverlayState() {
  if (!overlayStatePushed) return;
  overlayStatePushed = false;
  try { history.back(); } catch {}
}
function closeOverlaysForBack() {
  overlayStatePushed = false;
  $("#sidebar")?.classList.remove("open");
  $("#topMenu")?.classList.add("hidden");
  $("#moreBtn")?.setAttribute("aria-expanded", "false");
  $("#screenLayer")?.classList.remove("expanded");
}
window.addEventListener("popstate", () => { if (overlayStatePushed) closeOverlaysForBack(); });

function wireMisc() {
  const invite = async (useShare) => {
    const base = `${location.origin}${location.pathname.replace(/room\.html$/, "")}room.html`;
    const q = new URLSearchParams({ room: code });
    if (roomInfo?.privacy === "password") q.set("pwd", "1");
    const url = `${base}?${q.toString()}`;
    if (useShare && navigator.share && matchMedia("(pointer: coarse)").matches) {
      try {
        await navigator.share({
          title: "هم‌تماشا",
          text: getLang() === "fa" ? `بیا با هم فیلم ببینیم — اتاق ${code}` : `Let's watch together — room ${code}`,
          url
        });
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
    }
    const ok = await copyText(url);
    if (ok) toast(t("toast.copied"), "success");
  };
  $("#copyLinkBtn").addEventListener("click", () => invite(false));
  $("#inviteBtn").addEventListener("click", () => invite(true));

  const moreBtn = $("#moreBtn");
  const topMenu = $("#topMenu");
  if (moreBtn && topMenu) {
    const closeMenu = () => {
      const wasOpen = !topMenu.classList.contains("hidden");
      topMenu.classList.add("hidden");
      moreBtn.setAttribute("aria-expanded", "false");
      if (wasOpen) popOverlayState();
    };
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = topMenu.classList.contains("hidden");
      topMenu.classList.toggle("hidden", !willOpen);
      moreBtn.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) pushOverlayState();
      else popOverlayState();
    });
    document.addEventListener("click", (e) => {
      if (topMenu.classList.contains("hidden")) return;
      if (topMenu.contains(e.target) || moreBtn.contains(e.target)) return;
      closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });
    document.addEventListener("langchange", () => {
      topMenu.classList.add("hidden");
      moreBtn.setAttribute("aria-expanded", "false");
    });
  }

  $("#leaveBtn").addEventListener("click", async () => {
    const manager = isManagerSelf();
    const ok = await confirmDialog({
      title: manager ? t("leave.closeTitle") : (getLang() === "fa" ? "خروج از اتاق" : "Leave room"),
      text: manager ? t("leave.closeText") : (getLang() === "fa" ? "از اتاق خارج می‌شوی." : "You will leave this room."),
      okLabel: getLang() === "fa" ? "خروج" : "Leave"
    });
    if (!ok) return;
    if (manager) {
      forceCloseLobby(code, "leave").catch(() => {});
      net.command("closeLobby");
      setTimeout(() => { cleanup(); location.replace("./"); }, 260);
      return;
    }
    cleanup();
    location.replace("./");
  });

  $("#reconnectBtn")?.addEventListener("click", () => safeReload());

  document.addEventListener("focusin", (e) => {
    if (e.target.matches?.("input, textarea, select")) document.body.classList.add("kb-open");
  });
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!document.activeElement?.matches?.("input, textarea, select")) document.body.classList.remove("kb-open");
    }, 80);
  });
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", () => {
      const shrunk = window.innerHeight - vv.height > 130;
      document.body.classList.toggle("kb-open", shrunk);
    });
  }

  $("#sideBtn")?.addEventListener("click", () => {
    if (chatHidden) return setChatHidden(false);
    const mq = window.matchMedia;
    const drawer = mq("(min-width:641px) and (max-width:819px)").matches;
    if (drawer) {
      const side = $("#sidebar");
      side.classList.toggle("open");
      if (side.classList.contains("open")) pushOverlayState();
      else popOverlayState();
      return;
    }
    setChatHidden(!chatHidden);
  });
  setChatHidden(chatHidden, false);

  const restoreChat = () => {
    if (window.matchMedia("(max-width: 640px)").matches) {
      sheetDockOn = true;
      store.set(SHEET_DOCK_KEY, sheetDockOn);
      const opt = $("#optSheetDock");
      if (opt) opt.checked = true;
      $("#sidebar")?.classList.add("open");
    }
    setChatHidden(false);
    clearUnreadChat();
    activateTab("chat");
  };
  const chatFab = $("#chatFab");
  chatFab?.addEventListener("click", restoreChat);
  if (chatFab) {
    let grabY = null;
    chatFab.addEventListener("pointerdown", (e) => { grabY = e.clientY; });
    chatFab.addEventListener("pointerup", (e) => {
      if (grabY != null && e.clientY - grabY < -18) restoreChat();
      grabY = null;
    });
    chatFab.addEventListener("pointercancel", () => { grabY = null; });
  }
  window.addEventListener("resize", () => syncChatFab());

  document.addEventListener("langchange", () => {
    if (siteCfg) applySiteConfig(siteCfg);
    renderMembers();
    renderQueue(queueItems);
    renderCine();
    applyRoomSettings(roomInfo);
    updatePlayUI(!$("#video").paused);
    paintScreenState();
  });

  window.addEventListener("beforeunload", cleanup);
  window.addEventListener("pagehide", (e) => { if (!e.persisted) cleanup(); });
}

/* phone calls, app switches, screen locks and network drops */
function wireInterruptions() {
  window.addEventListener("offline", () => toast(t("net.offline"), "error", 5200));
  window.addEventListener("online", () => {
    try { net?.retry?.(); } catch {}
    if (currentPlayback?.playing && player?.url && player.video.paused) player.applyState(currentPlayback);
    requestPlaybackSync();
  });

  let wasPlaying = false;
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    const v = player?.video;
    if (!v) return;
    if (document.hidden) {
      hiddenAt = Date.now();
      wasPlaying = !!currentPlayback?.playing && !v.paused;
      return;
    }
    if (wasPlaying && currentPlayback?.playing && v.paused) {
      player.applyState(currentPlayback);
    }
    wasPlaying = false;
    requestPlaybackSync();
    if (v.readyState >= 3) $("#videoFrame")?.classList.remove("buffering");
    if (hiddenAt && Date.now() - hiddenAt > 90000 && !net?.isReady?.()) {
      try { net?.retry?.(); } catch {}
      setTimeout(() => { if (!net?.isReady?.()) safeReload({ force: true }); }, 5000);
    }
    hiddenAt = 0;
  });

  if (screen.orientation) {
    screen.orientation.addEventListener?.("change", () => {
      setTimeout(() => {
        $("#stageControls")?.classList.remove("idle");
        paintSeekFill(player?.video?.currentTime || 0, player?.video?.duration || 0);
      }, 150);
    });
  }
}

/* ================= instant tooltips ================= */
function wireTooltips() {
  const SELECT = "button, a[href], [role='button'], input[type='range'], select";
  let tip = null;
  let timer = 0;
  let current = null;
  let pressTimer = 0;

  const ensure = () => {
    if (!tip) {
      tip = el("div", { class: "qtip", role: "tooltip" });
      document.body.append(tip);
    }
    return tip;
  };
  const textFor = (node) =>
    String(node.getAttribute("title") || node.getAttribute("aria-label") || node.dataset.tip || "").trim();
  const show = (node) => {
    const text = textFor(node);
    if (!text) return;
    node.dataset.tip = text;
    if (node.hasAttribute("title")) node.removeAttribute("title");
    const box = ensure();
    current = node;
    box.textContent = text;
    const r = node.getBoundingClientRect();
    const below = r.top < 48;
    box.classList.toggle("below", below);
    const half = box.offsetWidth / 2;
    const x = Math.min(Math.max(r.left + r.width / 2, half + 6), window.innerWidth - half - 6);
    box.style.left = `${Math.round(x)}px`;
    box.style.top = `${Math.round(below ? r.bottom : r.top)}px`;
    box.classList.add("on");
  };
  const hide = () => {
    clearTimeout(timer);
    clearTimeout(pressTimer);
    current = null;
    tip?.classList.remove("on");
  };

  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const node = e.target.closest?.(SELECT);
    if (!node || node === current) return;
    hide();
    timer = setTimeout(() => show(node), 80);
  });
  document.addEventListener("pointerout", (e) => {
    if (e.pointerType === "touch") return;
    const node = e.target.closest?.(SELECT);
    if (node && node === current && !node.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (e) => {
    const node = e.target.closest?.(SELECT);
    if (node?.matches(":focus-visible")) show(node);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const node = e.target.closest?.(SELECT);
    if (!node) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      show(node);
      try { navigator.vibrate?.(6); } catch {}
      setTimeout(hide, 2400);
    }, 420);
  }, { passive: true });
  ["pointerup", "pointercancel", "pointermove"].forEach((ev) => {
    document.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true });
  });
  document.addEventListener("click", hide, true);
  window.addEventListener("scroll", hide, { capture: true, passive: true });
}

function cleanup() {
  clearInterval(broadcastTimer);
  clearInterval(chatTimerInterval);
  clearInterval(typingTimer);
  broadcastTimer = chatTimerInterval = typingTimer = 0;
  try { voice?.leave(); } catch {}
  try { player?.destroy(); } catch {}
  try { net?.destroy(); } catch {}
  if (currentLocalUrl) {
    try { URL.revokeObjectURL(currentLocalUrl); } catch {}
    currentLocalUrl = null;
  }
}

/* keep sidebar accessible on mobile */
document.addEventListener("click", (e) => {
  if (window.innerWidth >= 820) return;
  if (e.target.closest("#sideBtn")) return;
  const side = $("#sidebar");
  if (!side.classList.contains("open")) return;
  if (side.contains(e.target)) return;
  side.classList.remove("open");
  popOverlayState();
});

/* draggable split between video and chat on phones */
function wireSheet() {
  const grip = $("#sheetGrip");
  const shell = $(".room-shell");
  const sidebar = $("#sidebar");
  if (!grip || !shell || !sidebar) return;
  const mq = window.matchMedia("(max-width: 640px)");
  const KEY = "wt.sheetH";
  const PEEK = 190;
  const topbarH = () => $(".topbar")?.offsetHeight || 56;
  const maxH = () => Math.max(PEEK + 90, window.innerHeight - topbarH() - 148);
  const midH = () => Math.min(maxH() - 70, Math.max(PEEK + 110, Math.round(window.innerHeight * 0.46)));
  const clamp = (v) => Math.max(PEEK, Math.min(maxH(), v));
  let current = 0;
  let drag = null;

  const setH = (v) => {
    current = clamp(v);
    shell.style.setProperty("--sheet-h", `${Math.round(current)}px`);
    document.body.style.setProperty("--sheet-h", `${Math.round(current)}px`);
    grip.setAttribute("aria-expanded", String(current > midH() + 40));
  };
  const save = () => {
    try { sessionStorage.setItem(KEY, String(Math.round(current))); } catch {}
  };
  const snapTo = (v) => { setH(v); save(); };
  const snap = () => {
    const pts = [PEEK, midH(), maxH()];
    snapTo(pts.reduce((a, b) => (Math.abs(b - current) < Math.abs(a - current) ? b : a)));
  };
  const init = () => {
    if (!mq.matches) {
      shell.style.removeProperty("--sheet-h");
      document.body.style.removeProperty("--sheet-h");
      return;
    }
    let saved = 0;
    try { saved = Number(sessionStorage.getItem(KEY)) || 0; } catch {}
    setH(saved || midH());
  };

  grip.addEventListener("pointerdown", (e) => {
    if (!mq.matches || document.body.classList.contains("chat-focus")) return;
    e.preventDefault();
    drag = { y: e.clientY, h: sidebar.getBoundingClientRect().height, moved: 0, id: e.pointerId };
    try { grip.setPointerCapture(e.pointerId); } catch {}
    document.body.classList.add("sheet-drag");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = drag.y - e.clientY;
    drag.moved = Math.max(drag.moved, Math.abs(dy));
    drag.raw = drag.h + dy;
    setH(drag.raw);
    const drop = PEEK - 30 - drag.raw;
    sidebar.style.opacity = drop > 0 ? String(Math.max(0.12, 1 - drop / 110)) : "";
  });
  const stop = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    document.body.classList.remove("sheet-drag");
    sidebar.style.opacity = "";
    try { grip.releasePointerCapture(drag.id); } catch {}
    const dismissed = drag.raw != null && drag.raw < PEEK - 70;
    const moved = drag.moved;
    drag = null;
    if (dismissed) {
      sheetDockOn = false;
      store.set(SHEET_DOCK_KEY, false);
      const opt = $("#optSheetDock");
      if (opt) opt.checked = false;
      setChatHidden(true);
      toast(t("toast.sheetHidden"), "info", 4200);
      return;
    }
    if (moved < 7) snapTo(current > (midH() + maxH()) / 2 ? midH() : maxH());
    else snap();
  };
  grip.addEventListener("pointerup", stop);
  grip.addEventListener("pointercancel", stop);
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    snapTo(current > midH() + 40 ? midH() : maxH());
  });

  const dockOpt = $("#optSheetDock");
  if (dockOpt) {
    dockOpt.checked = sheetDockOn;
    dockOpt.addEventListener("change", () => {
      sheetDockOn = dockOpt.checked;
      store.set(SHEET_DOCK_KEY, sheetDockOn);
      if (!mq.matches) return;
      setChatHidden(!sheetDockOn);
      if (sheetDockOn) setTimeout(() => init(), 140);
    });
  }

  mq.addEventListener?.("change", init);
  window.addEventListener("resize", () => {
    if (!mq.matches) return;
    if (drag) setH(current);
    else snapTo(clamp(current || midH()));
  });
  init();
}

/* keyboard-aware mobile layout: chat takes the visible area while typing */
function wireViewport() {
  const chatInput = $("#chatInput");
  const mq = window.matchMedia("(max-width: 640px)");
  const rootStyle = document.documentElement.style;
  const vv = window.visualViewport;
  const TEXT_FIELDS = "textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color])";

  const isSideInput = () => {
    const a = document.activeElement;
    return !!a && $("#sidebar").contains(a) && a.matches(TEXT_FIELDS);
  };
  const sync = () => {
    if (!mq.matches || !vv) {
      rootStyle.removeProperty("--vvh");
      document.body.classList.remove("kb-open");
      return;
    }
    const focused = isSideInput();
    const kbOpen = vv.height < window.innerHeight - 90;
    document.body.classList.toggle("kb-open", kbOpen);
    if (focused || kbOpen) rootStyle.setProperty("--vvh", `${Math.round(vv.height)}px`);
    else rootStyle.removeProperty("--vvh");
  };

  vv?.addEventListener("resize", sync);
  vv?.addEventListener("scroll", sync);
  window.addEventListener("resize", sync);
  (mq.addEventListener ? mq.addEventListener.bind(mq) : mq.addListener.bind(mq))("change", sync);

  const sidebar = $("#sidebar");
  sidebar.addEventListener("focusin", (e) => {
    if (!mq.matches || !e.target.matches(TEXT_FIELDS)) return;
    document.body.classList.add("chat-focus");
    document.body.classList.toggle("head-focus", !!e.target.closest(".panel-head"));
    sync();
  });
  sidebar.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!mq.matches) return;
      if (isSideInput()) {
        document.body.classList.toggle("head-focus", !!document.activeElement?.closest?.(".panel-head"));
        return;
      }
      document.body.classList.remove("chat-focus");
      document.body.classList.remove("head-focus");
      sync();
    }, 160);
  });
  chatInput.addEventListener("focus", () => {
    if (!mq.matches) return;
    sync();
    setTimeout(() => { scrollChat(true); sync(); }, 180);
    setTimeout(() => { scrollChat(true); sync(); }, 520);
  });
  vv?.addEventListener("resize", () => {
    if (mq.matches && document.body.classList.contains("chat-focus")) scrollChat(true);
  });
  sidebar.addEventListener("click", (e) => {
    if (mq.matches && e.target.closest(".tab") && !e.target.closest('[data-tab="chat"]')) {
      chatInput.blur();
    }
  });
}
