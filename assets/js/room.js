import { initI18n, t, applyI18n, getLang } from "./i18n.js";
import {
  $, $$, el, escapeHtml, colorFor, initials, fmtTime, fmtClock, toast,
  confirmDialog, copyText, store, validateMediaUrl, createLimiter, debounce,
  registerServiceWorker, applyUIPrefs, getPrefs, savePrefs, resetPrefs, ACCENTS, lightenHex
} from "./core.js";
import { Net } from "./net.js";
import { Player, parseSubtitles } from "./player.js";
import { Voice } from "./voice.js";
import { currentUser } from "./auth.js";
import { avatarSrc } from "./avatars.js";

initI18n();
applyUIPrefs();
registerServiceWorker();

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
const privacyParam = params.get("privacy") === "password" ? "password" : "public";
let roomPassword = sessionStorage.getItem(`pwd:${code}`) || "";

let nick = (authUser?.nick || params.get("nick") || store.get("wt.nick") || "").trim();
const me = { id: "", role: "member", nick: "", avatar: authUser?.avatar || "" };
let net = null;
let player = null;
let voice = null;
let members = [];
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
const screenViews = new Map();
let activeScreen = "";
let currentPlayback = null;
let localMode = false;
let currentLocalUrl = null;
let localFileId = "";
let pendingLocalState = null;
let fileOfferId = "";

const chatList = $("#chatList");
const peopleList = $("#peopleList");
const queueList = $("#queueList");
const typingUsers = new Map();
const canSend = createLimiter(12, 8000);
let replyTo = null;
let editingId = null;
let searchTerm = "";
let chatJumpCount = 0;
let lastChatMsgAt = 0;
const CHAT_TIMER_KEY = "wt.chatTimer";
let chatTimerElapsed = 0;
let chatTimerSince = null;

/* ================= boot ================= */
if (code && authUser) boot();

async function boot() {
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
      if (me.role === "owner") return true;
      const control = roomInfo?.control || (isHost ? "mods" : "mods");
      if (control === "all") return true;
      if (control === "mods" && me.role === "mod") return true;
      return false;
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
    },
    onLoaded: () => syncStageEmpty(),
    onError: () => toast(t("toast.videoInvalid"), "error"),
    onLevels: (info) => renderQuality(info),
    onAudio: (info) => renderAudio(info)
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
  wirePrefs();
  wireVoice();
  wireScreen();
  wirePtt();
  wireMisc();
  wireViewport();
  wireSheet();
  wireFileLoad();
  setInterval(() => broadcastLocalState(), 4000);

  createNet();
}

function createNet() {
  net = new Net({
    code, nick, isHost,
    password: roomPassword,
    roomName: roomNameParam,
    capacity: capacityParam,
    privacy: privacyParam,
    avatar: me.avatar
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
    if (s === "online") $("#connLostBar")?.classList.add("hidden");
  });

  net.on("welcome", (data) => {
    me.id = data.self.id;
    me.role = data.self.role;
    me.nick = data.self.nick;
    me.avatar = data.self.avatar || me.avatar;
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
  });

  net.on("members", (list) => {
    members = list;
    const mine = list.find((m) => m.id === me.id);
    if (mine) { me.role = mine.role; me.nick = mine.nick; if (mine.avatar) me.avatar = mine.avatar; }
    syncAdminTools();
    renderMembers();
    refreshChatAvatars();
    const voices = list.filter((m) => m.voice && m.id !== me.id).map((m) => m.id);
    if (selfVoice) voices.forEach((id) => voice.peerVoice(id, true));
    syncScreenSharePeers();
  });

  net.on("chat", (msg) => {
    const near = isChatNearBottom();
    appendMessage(msg, true);
    noteIncomingChat();
    scrollChat();
    if (near) chatJumpCount = 0;
    else if (msg.by !== me.id) chatJumpCount = Math.min(99, chatJumpCount + 1);
    paintChatJump();
  });
  net.on("reaction", (r) => floatReaction(r.emoji));
  net.on("chatUpdate", (msg) => updateMessage(msg));
  net.on("chatClear", ({ by } = {}) => {
    clearChatHistory();
    toast(t("toast.chatClearedBy", { name: by || "?" }), "info");
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
    if (state?.url && state.url !== player.url) localMode = false;
    localFileId = "";
    fileOfferId = "";
    $("#fileOfferBar").classList.add("hidden");
    $("#localBadge").classList.add("hidden");
    currentPlayback = rebasePlayback(state);
    player.applyState(currentPlayback);
    updatePlayUI(currentPlayback.playing);
    syncStageEmpty();
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
      roomPassword = pwd;
      sessionStorage.setItem(`pwd:${code}`, pwd);
      try { net.destroy(); } catch {}
      createNet();
      return;
    }
    const map = {
      locked: t("toast.roomLocked"), full: t("toast.roomFull"),
      not_found: t("toast.connLost"), unreachable: t("toast.signalUnreachable"), banned: t("toast.roomLocked"),
      rejected: getLang() === "fa" ? "میزبان ورود را تأیید نکرد" : "Host declined the request"
    };
    toast(map[reason] || t("toast.connLost"), "error");
    $("#connLostBar")?.classList.add("hidden");
    const netLabel = $("#netLabel");
    if (netLabel) netLabel.textContent = t("net.offline");
    setTimeout(() => location.replace("./"), 2200);
  });

  net.on("kicked", () => {
    $("#connLostBar")?.classList.add("hidden");
    toast(t("toast.youWereKicked"), "error");
    setTimeout(() => location.replace("./"), 1500);
  });

  net.on("disconnected", () => {
    $("#connLostBar")?.classList.remove("hidden");
  });

  net.on("denied", (reason) => {
    if (reason === "control") toast(t("toast.cantControl"), "error");
    else if (reason === "blocked") toast(t("toast.blockedDomain"), "error");
    else toast(t("toast.videoInvalid"), "error");
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
    renderVoiceTiles();
  });

  net.on("incomingCall", (call) => voice.handleCall(call));

  net.on("incomingScreen", ({ from }) => { net.answerScreen(from).catch(() => {}); });
  net.on("screenStream", ({ from, stream }) => {
    screenViews.delete(from);
    screenViews.set(from, stream);
    if (!activeScreen) showScreenView(from, stream);
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

  net.on("error", (kind) => {
    if (kind === "code-taken") toast(getLang() === "fa" ? "این کد در حال استفاده است" : "Code already in use", "error");
    else if (kind === "unreachable") toast(t("toast.signalUnreachable"), "error");
    else toast(t("toast.connLost"), "error");
  });
}

/* ================= player ui ================= */
function wirePlayer() {
  const video = $("#video");
  $("#playBtn").addEventListener("click", () => player.togglePlay());
  $("#back5").addEventListener("click", () => player.seekBy(-5));
  $("#back10").addEventListener("click", () => player.seekBy(-10));
  $("#fwd5").addEventListener("click", () => player.seekBy(5));
  $("#fwd10").addEventListener("click", () => player.seekBy(10));
  $("#speedBtn").addEventListener("click", () => {
    const r = player.cycleRate();
    $("#speedBtn").textContent = `${r}×`;
  });
  $("#fullBtn").addEventListener("click", () => player.toggleFullscreen());
  $("#pipBtn").addEventListener("click", () => player.togglePiP());
  $("#castBtn")?.addEventListener("click", async () => {
    try { await video.remote.prompt(); }
    catch { toast(t("toast.castFail"), "error"); }
  });
  if ("remote" in HTMLVideoElement.prototype && video.remote) $("#castBtn").classList.remove("hidden");
  $("#theaterBtn").addEventListener("click", () => player.toggleTheater());
  $("#subsBtn").addEventListener("click", () => activateTab("settings"));

  $("#seek").addEventListener("input", (e) => {
    const d = video.duration || 0;
    $("#timeLabel").textContent = `${fmtTime((e.target.value / 1000) * d)} / ${fmtTime(d)}`;
  });
  $("#seek").addEventListener("change", (e) => {
    const d = video.duration || 0;
    if (d) player.seekTo((e.target.value / 1000) * d);
  });

  $("#loadVideoBtn").addEventListener("click", loadVideoFromInput);
  $("#sampleBtn").addEventListener("click", () => {
    net.command("loadVideo", { url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" });
  });
  $("#videoUrlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") loadVideoFromInput(); });

  const showTapHint = (side) => {
    const frame = $("#videoFrame");
    const hint = el("div", { class: `tap-hint ${side}`, text: side === "left" ? "−10s" : "+10s" });
    frame.append(hint);
    setTimeout(() => hint.remove(), 620);
  };

  let lastTap = 0;
  video.addEventListener("click", (e) => {
    if (!matchMedia("(pointer: coarse)").matches) { player.togglePlay(); return; }
    const now = performance.now();
    if (now - lastTap < 280) { lastTap = 0; return; }
    lastTap = now;
    setTimeout(() => {
      if (lastTap !== now) return;
      lastTap = 0;
      player.togglePlay();
    }, 240);
  });
  video.addEventListener("dblclick", (e) => {
    if (!player?.url) return;
    const rect = video.getBoundingClientRect();
    const ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
    if (ratio >= 0.3 && ratio <= 0.7) return;
    const forward = ratio > 0.7;
    player.seekBy(forward ? 10 : -10);
    showTapHint(forward ? "right" : "left");
  });
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
    volRange.value = String(Math.round(video.volume * 100));
    $(".i-vol", volBtn).classList.toggle("hidden", silent);
    $(".i-mute", volBtn).classList.toggle("hidden", !silent);
    volBtn.title = silent ? "Unmute" : "Mute";
  };
  volRange.addEventListener("input", () => {
    const level = Number(volRange.value) / 100;
    video.volume = level;
    video.muted = level === 0;
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
    if (e.key === "Escape") { $("#sidebar").classList.remove("open"); return; }
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

function updatePlayUI(playing) {
  $("#playBtn .i-play").classList.toggle("hidden", playing);
  $("#playBtn .i-pause").classList.toggle("hidden", !playing);
}

function syncStageEmpty() {
  const stageEmpty = $("#stageEmpty");
  if (!stageEmpty) return;
  const has = !!player?.url;
  stageEmpty.classList.toggle("hidden", has);
  $("#videoFrame").classList.toggle("has-media", has);
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

function receiveLocalFile({ id, name, size, url }) {
  if (currentLocalUrl && currentLocalUrl !== url) URL.revokeObjectURL(currentLocalUrl);
  currentLocalUrl = url;
  localFileId = id;
  localMode = true;
  player.destroyHls();
  player.url = url;
  player.state = { url, playing: false, time: 0, at: Date.now(), rate: 1 };
  player.video.src = url;
  player.video.load();
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
    $("#videoUrlInput").focus();
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
  if (!/^video\//.test(file.type) && !/\.(mkv|avi|mov|flv|wmv|ts|m2ts|mpg|mpeg|webm|ogv|mp4|m4v)$/i.test(file.name)) {
    return toast(t("toast.videoInvalid"), "error");
  }
  showPrep();
  try {
    const { prepareLocalVideo } = await import("./transcode.js");
    const { url, converted } = await prepareLocalVideo(file, {
      onStatus: setPrepStatus,
      onProgress: setPrepProgress
    });
    if (currentLocalUrl) URL.revokeObjectURL(currentLocalUrl);
    currentLocalUrl = url;
    startLocalPlayback(url, file.name, converted);
  } catch (err) {
    console.error(err);
    toast(t(err?.message === "cdn-unavailable" ? "toast.converterOffline" : "toast.convertFailed"), "error");
  } finally {
    hidePrep();
  }
}

function startLocalPlayback(url, fileName, converted) {
  localMode = true;
  player.destroyHls();
  player.url = url;
  player.state = { url, playing: false, time: 0, at: Date.now(), rate: 1 };
  player.video.src = url;
  player.video.load();
  syncStageEmpty();
  $("#localBadge").classList.remove("hidden");
  $("#localBadge").textContent = t("room.localBadge");
  updatePlayUI(false);
  toast(
    converted
      ? (getLang() === "fa" ? `«${fileName}» آماده شد` : `"${fileName}" is ready`)
      : (getLang() === "fa" ? `«${fileName}» در حال پخش` : `Playing "${fileName}"`),
    "success"
  );
  if (isHost) {
    localFileId = "lf" + Date.now().toString(36);
    net.syncLocalState({ id: localFileId, playing: false, time: 0, rate: 1 });
    const shareId = localFileId;
    (async () => {
      try {
        const blob = await (await fetch(url)).blob();
        if (localFileId === shareId && player.url === url) {
          net.shareLocalFile({ id: shareId, name: fileName, size: blob.size, blob });
        }
      } catch {}
    })();
    net.command("chat", {
      text: getLang() === "fa"
        ? `🎬 ${nick} فایل «${fileName}» را پخش می‌کند — برای تماشای هم‌زمان، فایل را دریافت کن.`
        : `🎬 ${nick} is playing "${fileName}" — download it to watch along.`
    });
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
  setInterval(paintChatTimer, 1000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveChatTimer(); });
  window.addEventListener("beforeunload", saveChatTimer);
  saveChatTimer();
}

function wireChat() {
  const chatInput = $("#chatInput");
  const chatForm = $("#chatForm");

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    if (!canSend()) { toast(getLang() === "fa" ? "کمی صبر کن" : "Slow down", "error"); return; }
    if (editingId) {
      net.command("chatEdit", { id: editingId, text });
      editingId = null;
      chatInput.placeholder = t("chat.placeholder");
      $("#replyBar").classList.add("hidden");
    } else {
      const slow = Number(roomInfo?.slow) || 0;
      const wait = slow ? Math.ceil((slow * 1000 - (Date.now() - lastChatMsgAt)) / 1000) : 0;
      if (wait > 0) { toast(t("toast.slowWait", { s: String(wait) }), "info"); return; }
      net.command("chat", { text, replyTo });
      lastChatMsgAt = Date.now();
      replyTo = null;
      $("#replyBar").classList.add("hidden");
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

  const sendTyping = debounce(() => net.command("typing", {}), 1200);
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
    chatList.scrollTop = chatList.scrollHeight;
    paintChatJump();
  });
  chatList.addEventListener("scroll", () => {
    if (isChatNearBottom()) chatJumpCount = 0;
    paintChatJump();
  }, { passive: true });
  if ("ResizeObserver" in window && chatFormEl) new ResizeObserver(placeJump).observe(chatFormEl);
  else window.addEventListener("resize", placeJump);
  placeJump();

  chatList.addEventListener("click", onChatAction);
}

function onChatAction(e) {
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

  if (act === "react") net.command("react", { id, emoji: "👍" });
  else if (act === "reply") startReply(data);
  else if (act === "pin") net.command("pin", { id });
  else if (act === "edit") startEdit(data);
  else if (act === "delete") net.command("chatDelete", { id });
  else if (act === "reaction") net.command("react", { id, emoji: btn.dataset.emoji });
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
  if (chatList.querySelector(`[data-id="${msg.id}"]`)) return;
  const node = buildMessage(msg);
  chatList.append(node);
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
  const node = el("div", { class: `msg${mine ? " own" : ""}${msg.edited ? " edited" : ""}`, "data-id": msg.id });
  node.dataset.text = msg.text || "";
  node.dataset.msg = JSON.stringify({ id: msg.id, by: msg.by, nick: msg.nick, text: msg.text, role: msg.role });

  const avatar = el("div", { class: "avatar", "data-by": msg.by || "", "data-nick": msg.nick || "" });
  paintAvatar(avatar, avatarFor(msg.by), msg.nick, msg.by || msg.nick);

  const body = el("div", { class: "msg-body" });

  if (msg.replyTo) {
    const ref = chatList.querySelector(`[data-id="${msg.replyTo}"]`);
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

function isModSelf() { return me.role === "owner" || me.role === "mod"; }

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
  const node = chatList.querySelector(`[data-id="${msg.id}"]`);
  if (!node) { appendMessage(msg, false); return; }
  node.dataset.msg = JSON.stringify({ id: msg.id, by: msg.by, nick: msg.nick, text: msg.text, role: msg.role });
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
}

function refreshPinned() {
  const bar = $("#pinnedBar");
  const pinned = [...chatList.children]
    .filter((n) => n.classList.contains("pinned-msg"))
    .map((n) => JSON.parse(n.dataset.msg || "{}"));
  if (!pinned.length) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  const last = pinned[pinned.length - 1];
  bar.classList.remove("hidden");
  bar.innerHTML = `<b>${t("pinned.label")}:</b> <span>${escapeHtml(`${last.nick}: ${String(last.text).slice(0, 80)}`)}</span>`;
  bar.onclick = () => scrollToMessage(last.id);
}

function scrollToMessage(id) {
  const node = chatList.querySelector(`[data-id="${id}"]`);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.animate?.([{ background: "rgba(124,92,255,.35)" }, { background: "transparent" }], { duration: 1200 });
}

function isChatNearBottom() {
  return chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 160;
}

function scrollChat(force = false) {
  if (force || isChatNearBottom()) chatList.scrollTop = chatList.scrollHeight;
  paintChatJump();
}

function paintChatJump() {
  const btn = $("#chatJump");
  if (!btn) return;
  const gap = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight;
  const show = !searchTerm && chatList.children.length > 0 && gap > 140;
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
setInterval(renderTyping, 1200);

/* ================= people ================= */
function wirePeople() {
  peopleList.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-pmod]");
    if (!btn) return;
    const id = btn.closest(".person").dataset.id;
    const action = btn.dataset.pmod;
    if (action === "kick" || action === "ban") {
      const ok = await confirmDialog({
        title: t(action === "kick" ? "people.kick" : "people.ban"),
        text: getLang() === "fa" ? "این کار قابل بازگشت نیست." : "This can't be undone.",
        okLabel: t("common.ok")
      });
      if (!ok) return;
    }
    net.command("mod", { action, target: id });
  });
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
  const order = { owner: 0, mod: 1, member: 2 };
  const sorted = [...members].sort((a, b) => (order[a.role] - order[b.role]) || a.nick.localeCompare(b.nick));
  for (const m of sorted) {
    const node = el("div", { class: "person", "data-id": m.id });
    node.dataset.nick = m.nick;
    const avatar = el("div", { class: "avatar" });
    paintAvatar(avatar, m.avatar, m.nick, m.id);
    const info = el("div", { class: "person-info" });
    const nameRow = el("div", { class: "person-name" });
    nameRow.append(el("span", { text: m.nick + (m.id === me.id ? (getLang() === "fa" ? " (تو)" : " (you)") : "") }));
    if (m.role !== "member") nameRow.append(el("span", { class: `role-badge ${m.role}`, text: t(`role.${m.role}`) }));
    const sub = el("div", { class: "person-sub", text: m.voice ? (getLang() === "fa" ? "در صدا" : "In voice") : "" });
    info.append(nameRow, sub);

    const actions = el("div", { class: "person-actions" });
    if (isModSelf() && m.id !== me.id && m.role !== "owner") {
      actions.append(el("button", { type: "button", "data-pmod": "mute", title: t("people.mute"), text: m.muted ? "🔈" : "🔇" }));
      actions.append(el("button", { type: "button", "data-pmod": "kick", title: t("people.kick"), class: "danger", text: "⤫" }));
      actions.append(el("button", { type: "button", "data-pmod": "ban", title: t("people.ban"), class: "danger", text: "🚫" }));
      if (me.role === "owner") {
        actions.append(el("button", { type: "button", "data-pmod": m.role === "mod" ? "demote" : "promote", title: m.role === "mod" ? t("people.demote") : t("people.promote"), text: m.role === "mod" ? "↓" : "↑" }));
      }
    }
    node.append(avatar, info, actions);
    if (m.voice && !m.muted) node.dataset.voice = "1";
    peopleList.append(node);
  }
  renderVoiceTiles();
}

function markSpeaking(id, active) {
  if (id === "self") {
    const tile = document.querySelector(`.voice-tile[data-id="${me.id}"]`);
    tile?.classList.toggle("speaking", active);
    const person = peopleList.querySelector(`.person[data-id="${me.id}"]`);
    person?.classList.toggle("speaking", active);
    return;
  }
  const tile = document.querySelector(`.voice-tile[data-id="${id}"]`);
  tile?.classList.toggle("speaking", active);
  const person = peopleList.querySelector(`.person[data-id="${id}"]`);
  person?.classList.toggle("speaking", active);
}

/* ================= queue ================= */
function wireQueue() {
  $("#queueForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#queueInput");
    const v = validateMediaUrl(input.value.trim());
    if (!v.ok) return toast(v.reason === "blocked" ? t("toast.blockedDomain") : t("toast.videoInvalid"), "error");
    net.command("queueAdd", { url: v.url });
    input.value = "";
  });

  queueList.addEventListener("click", (e) => {
    const vote = e.target.closest("[data-vote]");
    if (vote) return net.command("queueVote", { id: vote.dataset.vote });
    const play = e.target.closest("[data-qplay]");
    if (play) return net.command("queuePlay", { id: play.dataset.qplay });
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
  const sorted = [...queueItems].sort((a, b) => b.votes.length - a.votes.length);
  for (const item of sorted) {
    const node = el("div", { class: "queue-item" });
    const main = el("div", { class: "q-main" });
    const title = item.url.split("/").pop()?.split("?")[0] || item.url;
    main.append(
      el("div", { class: "q-title", text: title || item.url }),
      el("div", { class: "q-sub", text: `${item.by} · ${fmtTime(0)}` })
    );
    const voted = item.votes.includes(me.id);
    const vote = el("button", { type: "button", class: `vote-btn${voted ? " voted" : ""}`, "data-vote": item.id });
    vote.append(el("span", { text: "▲" }), el("span", { text: String(item.votes.length) }));
    node.append(main, vote);
    if (canControl()) {
      node.append(el("button", { type: "button", class: "vote-btn", "data-qplay": item.id, title: t("queue.play"), text: "▶" }));
    }
    queueList.append(node);
  }
}

function canControl() {
  if (me.role === "owner") return true;
  const control = roomInfo?.control || "mods";
  if (control === "all") return true;
  if (control === "mods" && me.role === "mod") return true;
  return false;
}

/* ================= settings ================= */
function applyRoomSettings(room) {
  if (!room) return;
  roomInfo = room;
  const isOwner = me.role === "owner";
  $("#optControl").value = room.control || "mods";
  $("#optLock").checked = !!room.locked;
  $("#optApproval").checked = !!room.approval;
  $("#optSlow").value = String(room.slow || 0);
  [$("#optControl"), $("#optLock"), $("#optApproval"), $("#optSlow")].forEach((n) => { n.disabled = !isOwner; });
  syncAdminTools();
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
  $("#optApproval").addEventListener("change", (e) => push({ approval: e.target.checked }));
  $("#optSlow").addEventListener("change", (e) => push({ slow: Number(e.target.value) }));
  $("#optQuality").addEventListener("change", (e) => player.setLevel(e.target.value));
  $("#optAudio").addEventListener("change", (e) => player.setAudio(e.target.value));

  $("#subsPickBtn")?.addEventListener("click", () => $("#subsFile").click());
  $("#subsFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const raw = await file.text();
    const cues = parseSubtitles(raw);
    if (!cues.length) return toast(getLang() === "fa" ? "زیرنویس معتبر نبود" : "Invalid subtitle file", "error");
    const name = (file.name || "").replace(/\.[^.]+$/, "").slice(0, 40) || t("settings.subs");
    const label = $("#subsFileName");
    if (label) label.textContent = file.name;
    player.setCues(cues, name);
    renderSubsSets();
    if (isHost) net.shareSubtitles(cues);
    toast(getLang() === "fa" ? `${cues.length} خط زیرنویس بارگذاری شد` : `${cues.length} cues loaded`, "success");
    e.target.value = "";
  });
  const layer = $("#subtitleLayer");
  const applySubStyle = () => {
    if (!layer) return;
    layer.style.setProperty("--sub-color", subColor);
    layer.style.setProperty("--sub-bg", `rgba(0,0,0,${subBg})`);
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
    if (!isModSelf() || !chatList.children.length) return;
    const ok = await confirmDialog({
      title: t("settings.clearChat"),
      text: t("settings.clearChatHint"),
      okLabel: t("settings.clearChat")
    });
    if (ok) net.command("chatClear");
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
  sel.innerHTML = "";
  for (const track of info.tracks) {
    const label = track.name || track.lang || `Track ${track.i + 1}`;
    sel.append(el("option", { value: String(track.i), text: label }));
  }
  sel.value = String(Math.max(0, info.current));
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
    });
    const count = el("span", { class: "subs-count", text: String(s.count) });
    const rm = el("button", { class: "subs-x", type: "button", text: "×", "aria-label": "Remove" });
    rm.addEventListener("click", () => {
      player.removeSubtitleSet(s.name);
      renderSubsSets();
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
  markAccent();

  $("#prefsReset").addEventListener("click", () => {
    const d = resetPrefs();
    $("#prefBrightness").value = String(d.brightness);
    $("#prefBrightnessVal").textContent = `${d.brightness}%`;
    $("#prefChatSize").value = String(d.chatSize);
    $("#prefChatSizeVal").textContent = d.chatSize.toFixed(1);
    $("#prefChatAlpha").value = String(d.chatAlpha);
    $("#prefChatAlphaVal").textContent = `${d.chatAlpha}%`;
    $("#prefChatBright").value = String(d.chatBright);
    $("#prefChatBrightVal").textContent = `${d.chatBright}%`;
    markAccent();
    markTheme();
    toast(t("prefs.resetDone"), "success");
  });
}

/* ================= tabs ================= */
function paintUnreadChat() {
  const badge = $("#chatBadge");
  if (!badge) return;
  badge.textContent = unreadChat > 9 ? "9+" : String(unreadChat);
  badge.classList.toggle("hidden", unreadChat === 0);
}

function noteIncomingChat() {
  if (activeTabName === "chat" && document.visibilityState === "visible") return;
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
  if (name === "chat") setTimeout(() => scrollChat(true), 50);
}

/* ================= voice ================= */
function wireVoice() {
  $("#voiceBtn").addEventListener("click", toggleVoice);
  $("#voiceLeaveBtn").addEventListener("click", leaveVoice);
  $("#micBtn").addEventListener("click", () => {
    if (!selfVoice) return toast(t("toast.notInVoice"));
    if (pttOn) return;
    voice.setMuted(!voice.muted);
    syncMicUI();
  });
  $("#deafenBtn").addEventListener("click", () => {
    if (!selfVoice) return toast(t("toast.notInVoice"));
    voice.setDeafened(!voice.deafened);
    syncDeafenUI();
    renderVoiceTiles();
  });
}

async function toggleVoice() {
  if (selfVoice) return leaveVoice();
  const ok = await voice.join();
  if (!ok) return;
  selfVoice = true;
  if (pttOn) voice.setMuted(true);
  net.command("voice", { on: true });
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
  btn.innerHTML = voice.muted
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4l16 16M9 4v3M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const tile = document.querySelector(`.voice-tile[data-id="${me.id}"]`);
  tile?.classList.toggle("muted", voice.muted);
}

function syncDeafenUI() {
  $("#deafenBtn").classList.toggle("active", voice.deafened);
}

/* ================= screen share ================= */
function nickFor(id) {
  return members.find((m) => m.id === id)?.nick || me.nick || "?";
}

function paintScreenState() {
  const btn = $("#shareBtn");
  if (!btn) return;
  btn.classList.toggle("active", screenSharing);
  btn.title = t(screenSharing ? "screen.stop" : "screen.start");
  btn.setAttribute("aria-label", btn.title);
}

function sendScreenTo(peerId) {
  if (!net || !screenStream || !peerId || peerId === me.id) return;
  net.shareScreenTo(peerId, screenStream);
  screenSentTo.add(peerId);
}

function syncScreenSharePeers() {
  if (!screenSharing || !net) return;
  const live = new Set(members.map((m) => m.id).filter((id) => id && id !== me.id));
  for (const id of live) if (!screenSentTo.has(id)) sendScreenTo(id);
  for (const id of [...screenSentTo]) {
    if (live.has(id)) continue;
    screenSentTo.delete(id);
    net.closeScreen(id, false);
  }
}

async function startScreenShare() {
  if (screenSharing) return;
  if (!navigator.mediaDevices?.getDisplayMedia) return toast(t("toast.screenUnsupported"), "error");
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 24 }, audio: false });
  } catch (err) {
    if (err?.name === "AbortError") return;
    const key = err?.name === "NotFoundError" ? "toast.screenMissing"
      : err?.name === "NotSupportedError" ? "toast.screenUnsupported"
        : "toast.screenDenied";
    return toast(t(key), "error");
  }
  screenStream = stream;
  screenSharing = true;
  screenSentTo = new Set();
  stream.getVideoTracks().forEach((track) => track.addEventListener("ended", stopScreenShare));
  for (const m of members) sendScreenTo(m.id);
  showScreenView("self", stream);
  paintScreenState();
  toast(t("toast.screenStarted"), "success");
}

function stopScreenShare() {
  if (!screenSharing) return;
  screenSharing = false;
  for (const id of screenSentTo) net?.closeScreen(id, true);
  screenSentTo.clear();
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  if (activeScreen === "self") {
    const next = [...screenViews.entries()].pop();
    if (next) showScreenView(next[0], next[1]);
    else hideScreenView();
  }
  paintScreenState();
  toast(t("toast.screenStopped"));
}

function showScreenView(id, stream) {
  activeScreen = id;
  $("#screenWho").textContent = id === "self" ? t("screen.you") : nickFor(id);
  const video = $("#screenVideo");
  video.srcObject = stream;
  video.play?.().catch(() => {});
  $("#screenLayer").classList.remove("hidden");
  $("#screenPeek").classList.add("hidden");
}

function hideScreenView() {
  activeScreen = "";
  const video = $("#screenVideo");
  try { video.pause(); } catch {}
  video.srcObject = null;
  $("#screenLayer").classList.add("hidden");
  $("#screenLayer").classList.remove("expanded");
  $("#screenPeek").classList.toggle("hidden", screenViews.size === 0);
}

function wireScreen() {
  if (!$("#shareBtn")) return;
  $("#shareBtn").addEventListener("click", () => {
    if (screenSharing) stopScreenShare();
    else startScreenShare();
  });
  $("#screenHideBtn").addEventListener("click", () => {
    if (activeScreen === "self") stopScreenShare();
    else hideScreenView();
  });
  $("#screenFitBtn").addEventListener("click", () => $("#screenLayer").classList.toggle("expanded"));
  $("#screenPeek").addEventListener("click", () => {
    const next = [...screenViews.entries()].pop();
    if (next) showScreenView(next[0], next[1]);
    else hideScreenView();
  });
  document.addEventListener("langchange", () => {
    paintScreenState();
    if (!activeScreen) return;
    $("#screenWho").textContent = activeScreen === "self" ? t("screen.you") : nickFor(activeScreen);
  });
  paintScreenState();
}

/* ---------- push-to-talk ---------- */
function wirePtt() {
  const input = $("#optPtt");
  if (!input) return;
  input.checked = pttOn;
  input.addEventListener("change", () => {
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
    const tile = el("div", { class: `voice-tile${m.muted ? " muted" : ""}`, "data-id": m.id });
    const av = el("div", { class: "avatar-sm" });
    paintAvatar(av, m.avatar || avatarFor(m.id), m.nick, m.id);
    const name = el("span", { text: m.id === me.id ? (getLang() === "fa" ? "تو" : "You") : m.nick });
    tile.append(av, name);
    if (m.id !== me.id) {
      const vol = el("input", { type: "range", min: "0", max: "100", class: "tile-vol", value: String(Math.round((voice.volumes.get(m.id) ?? 1) * 100)) });
      vol.addEventListener("input", (e) => voice.setVolume(m.id, Number(e.target.value) / 100));
      tile.append(vol);
    }
    strip.append(tile);
  }
}

/* ================= live reactions ================= */
function floatReaction(emoji) {
  const frame = $("#videoFrame");
  if (!frame || !frame.classList.contains("has-media")) return;
  const node = el("span", { class: "live-reaction", text: emoji });
  node.style.setProperty("--x", `${12 + Math.random() * 76}%`);
  node.style.setProperty("--dx", `${Math.round((Math.random() - 0.5) * 90)}px`);
  frame.append(node);
  setTimeout(() => node.remove(), 2300);
}

function wireReactions() {
  const dock = $("#reactDock");
  const tray = $("#reactTray");
  const toggle = $("#reactToggle");
  if (!dock || !tray || !toggle) return;
  const close = () => {
    tray.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
  };
  for (const emoji of LIVE_EMOJIS) {
    tray.append(el("button", {
      type: "button", role: "menuitem", text: emoji, "aria-label": emoji,
      onclick: () => { close(); net.command("reaction", { emoji }); }
    }));
  }
  toggle.addEventListener("click", () => {
    const open = tray.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("pointerdown", (e) => {
    if (tray.classList.contains("open") && !dock.contains(e.target)) close();
  });
}

/* ================= misc ================= */
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

  $("#leaveBtn").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: getLang() === "fa" ? "خروج از اتاق" : "Leave room",
      text: getLang() === "fa" ? "از اتاق خارج می‌شوی." : "You will leave this room.",
      okLabel: getLang() === "fa" ? "خروج" : "Leave"
    });
    if (!ok) return;
    cleanup();
    location.replace("./");
  });

  $("#reconnectBtn")?.addEventListener("click", () => location.reload());

  $("#sideBtn")?.addEventListener("click", () => {
    if (window.matchMedia("(max-width:1080px)").matches) {
      $("#sidebar").classList.toggle("open");
      return;
    }
    const hidden = $(".room-shell").classList.toggle("chat-hidden");
    store.set("wt.chatHidden", hidden);
  });
  if (store.get("wt.chatHidden", false) && window.matchMedia("(min-width:1081px)").matches) {
    $(".room-shell").classList.add("chat-hidden");
  }

  document.addEventListener("langchange", () => {
    renderMembers();
    renderQueue(queueItems);
    applyRoomSettings(roomInfo);
  });

  window.addEventListener("beforeunload", cleanup);
}

function cleanup() {
  try { voice?.leave(); } catch {}
  try { player?.destroy(); } catch {}
  try { net?.destroy(); } catch {}
}

/* keep sidebar accessible on mobile */
document.addEventListener("click", (e) => {
  if (window.innerWidth > 1080) return;
  if (e.target.closest("#sideBtn")) return;
  const side = $("#sidebar");
  if (!side.classList.contains("open")) return;
  if (side.contains(e.target)) return;
  side.classList.remove("open");
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
    if (!mq.matches) { shell.style.removeProperty("--sheet-h"); return; }
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
    setH(drag.h + dy);
  });
  const stop = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    document.body.classList.remove("sheet-drag");
    try { grip.releasePointerCapture(drag.id); } catch {}
    if (drag.moved < 7) snapTo(current > (midH() + maxH()) / 2 ? midH() : maxH());
    else snap();
    drag = null;
  };
  grip.addEventListener("pointerup", stop);
  grip.addEventListener("pointercancel", stop);
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    snapTo(current > midH() + 40 ? midH() : maxH());
  });

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
