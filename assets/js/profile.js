import { initI18n, t } from "./i18n.js";
import {
  $, $$, el, toast, initials, applyUIPrefs, getPrefs, savePrefs, resetPrefs,
  ACCENTS, lightenHex, registerServiceWorker, RateGuard
} from "./core.js";
import {
  currentUser, getProfile, saveProfile, changeUsername, changePassword,
  setAvatar, addFriend, removeFriend, logout, passwordScore, isPassword,
  isLocallyBanned, syncRemoteSession, rotateRecoveryCode
} from "./auth.js";
import { AVATAR_PRESETS, avatarId, avatarSrc, presetValue } from "./avatars.js";
import { dbGetByIndex } from "./db.js";
import { subscriptionStatus } from "./plans.js";
import { loadSiteConfig, applySiteConfig, isMaintenanceBlocked, listenLiveConfig } from "./site-config.js";
import { resolveFlags, applyFlagsToDom, buildFlagContext, flagOn, recordFeatureUse, readFeatureCenter } from "./feature-flags.js";
import { capabilityRows, deviceSummary } from "./capabilities.js";
import {
  notifPrefs, saveNotifPrefs, notifPermission, requestNotifPermission,
  setRoomNotif, mutedRooms, testNotification
} from "./notifications.js";

applyUIPrefs();
initI18n();
registerServiceWorker();

let profile = null;
let remoteProfile = null;
let saving = false;
let avatarGender = "girl";
let siteCfg = null;
let flagStates = {};
let flagContext = { role: "member", user: "", plan: "", room: "", server: "local" };

function allow(flagId) {
  return flagOn(flagStates, flagId);
}

function refreshFlags(me) {
  flagContext = buildFlagContext({ user: me });
  const center = readFeatureCenter();
  flagStates = resolveFlags(siteCfg, center.scopes, flagContext);
  applyFlagsToDom(siteCfg, center, flagContext, document, flagStates);
  return flagStates;
}

(async () => {
  remoteProfile = await syncRemoteSession();
  const me = currentUser();
  if (!me) {
    location.replace("auth.html?next=profile.html");
    return;
  }
  await boot(me);
})();

async function boot(me) {
  siteCfg = await loadSiteConfig();
  applySiteConfig(siteCfg);
  if (isMaintenanceBlocked(siteCfg)) return;
  refreshFlags(me);
  if (!allow("account.profiles")) {
    location.replace("index.html");
    return;
  }
  listenLiveConfig((cfg) => {
    siteCfg = cfg;
    applySiteConfig(cfg);
    refreshFlags(me);
  });
  window.addEventListener("wt:config", () => { applySiteConfig(siteCfg); refreshFlags(me); });
  if (isLocallyBanned(me.username)) {
    logout();
    location.replace("auth.html?mode=login");
    return;
  }
  profile = getProfile(me.username);
  if (profile && remoteProfile?.email) profile.email = remoteProfile.email;
  if (profile && remoteProfile?.phone) profile.phone = remoteProfile.phone;
  if (profile && !profile.email && me.email) profile.email = me.email;
  if (!profile) {
    location.replace("auth.html?next=profile.html&force=1");
    return;
  }
  document.title = `${t("profile.title")} — هم‌تماشا`;
  const birth = $("#pBirth");
  if (birth) birth.max = new Date().toISOString().slice(0, 10);

  fillForm();
  avatarGender = avatarId(profile.avatar)?.startsWith("boy-") ? "boy" : "girl";
  paintAvatar();
  renderAvatarGallery();
  renderFriends();
  renderActivity();
  renderPlan();
  renderDeviceCard();
  wireAccount();
  wirePassword();
  wireDetails();
  wireFriends();
  wireAvatar();
  wireAppearance();
  wireMisc();
  wireNotifications();
  document.addEventListener("langchange", () => {
    applySiteConfig(siteCfg);
    document.title = `${t("profile.title")} — هم‌تماشا`;
    paintAvatar();
    renderAvatarGallery();
    renderFriends();
    renderActivity();
    renderPlan();
    renderDeviceCard();
    refreshNotifUI();
    paintMemberSince();
  });
}

function fillForm() {
  $("#pNick").value = profile.nick;
  $("#pUsername").value = profile.username;
  const mail = $("#pEmail");
  if (mail) mail.value = profile.email || remoteProfile?.email || "";
  const phone = $("#pPhone");
  if (phone) phone.value = profile.phone || remoteProfile?.phone || "";
  $("#pBirth").value = profile.birthdate || "";
  $("#pCity").value = profile.city || "";
  $("#pBio").value = profile.bio || "";
  paintMemberSince();
}

function paintMemberSince() {
  $("#sideName").textContent = profile.nick;
  $("#sideUsername").textContent = `@${profile.username}`;
  const node = $("#memberSince");
  if (!profile.createdAt) { node.textContent = ""; return; }
  const date = new Date(profile.createdAt).toLocaleDateString(document.documentElement.lang === "fa" ? "fa-IR" : "en-US", {
    year: "numeric", month: "long", day: "numeric"
  });
  node.textContent = `${t("profile.memberSince")} ${date}`;
}

const ACTIVITY_LABEL_KEYS = {
  "room.host": "activity.roomHost",
  "room.join": "activity.roomJoin",
  "lobby.create": "activity.lobbyCreate",
  "lobby.close": "activity.lobbyClose",
  "plan.request": "activity.planRequest"
};

const PLAN_LABEL_KEYS = { monthly: "v8.planMonthly", yearly: "v8.planYearly" };

async function renderPlan() {
  const title = $("#planStatusTitle");
  const meta = $("#planStatusMeta");
  const dot = $("#planStatusDot");
  if (!title || !meta || !dot || !profile) return;
  const status = await subscriptionStatus(profile.username);
  const fa = document.documentElement.lang === "fa";
  const planName = status.plan ? t(PLAN_LABEL_KEYS[status.plan.id] || "profile.planTitle") : "";
  dot.dataset.state = status.state;
  if (status.state === "active") {
    const date = new Date(Number(status.subscription.expiresAt)).toLocaleDateString(fa ? "fa-IR" : "en-US", {
      year: "numeric", month: "long", day: "numeric"
    });
    title.textContent = planName;
    meta.textContent = t("profile.planActive", { date });
  } else if (status.state === "pending") {
    title.textContent = planName;
    meta.textContent = t("profile.planPending");
  } else if (status.state === "expired") {
    title.textContent = planName;
    meta.textContent = t("profile.planExpired");
  } else {
    title.textContent = t("profile.planNone");
    meta.textContent = t("profile.planNote");
  }
}

async function renderActivity() {
  const list = $("#activityList");
  const empty = $("#activityEmpty");
  if (!list || !empty || !profile) return;
  const fa = document.documentElement.lang === "fa";
  let rows = [];
  try {
    rows = await dbGetByIndex("activity", "user", String(profile.username || "").toLowerCase());
  } catch {
    rows = [];
  }
  rows = rows
    .filter((r) => typeof r?.at === "number")
    .sort((a, b) => b.at - a.at)
    .slice(0, 6);
  list.innerHTML = "";
  empty.classList.toggle("hidden", rows.length > 0);
  for (const row of rows) {
    const li = el("li", { class: "activity-item" });
    const main = el("div", { class: "activity-main" });
    main.append(el("strong", { text: ACTIVITY_LABEL_KEYS[row.type] ? t(ACTIVITY_LABEL_KEYS[row.type]) : row.type }));
    const room = String(row.data?.room || row.data?.code || "");
    if (room) main.append(el("span", { class: "activity-room", dir: "ltr", text: room }));
    li.append(el("span", { class: "activity-dot" }), main);
    li.append(el("time", {
      text: new Date(row.at).toLocaleString(fa ? "fa-IR" : "en-US", {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
      })
    }));
    list.append(li);
  }
}

function paintAvatar() {
  const box = $("#avatarBox");
  const span = $("#avatarInitials");
  const src = avatarSrc(profile.avatar);
  box.style.background = profile.color;
  box.style.backgroundImage = src ? `url("${src}")` : "";
  box.style.backgroundSize = "cover";
  box.style.backgroundPosition = "center";
  box.classList.toggle("has-img", !!src);
  span.textContent = src ? "" : initials(profile.nick);
  $("#avatarRemove").classList.toggle("hidden", !src);
}

function renderAvatarGallery() {
  const grid = $("#avatarGallery");
  if (!grid) return;
  grid.innerHTML = "";
  const fa = document.documentElement.lang === "fa";
  for (const p of AVATAR_PRESETS.filter((x) => x.gender === avatarGender)) {
    const label = fa ? p.labelFa : p.labelEn;
    const btn = el("button", {
      type: "button",
      class: `avatar-choice${profile.avatar === presetValue(p.id) ? " active" : ""}`,
      "data-avatar": p.id,
      title: label,
      "aria-label": label
    });
    btn.append(el("img", { src: p.src, alt: "", loading: "lazy", draggable: "false" }));
    grid.append(btn);
  }
  $$(".avatar-filter").forEach((b) => b.classList.toggle("active", b.dataset.avatarGender === avatarGender));
}

function msg(node, text, ok = false) {
  node.textContent = text || "";
  node.classList.toggle("ok", !!ok);
}
function clearMsg(...nodes) { nodes.forEach((n) => msg(n, "")); }

/* ---------- account ---------- */
function wireAccount() {
  $("#accountForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (saving) return;
    const out = $("#accountMsg");
    clearMsg(out);
    const nick = $("#pNick").value;
    const username = $("#pUsername").value.trim().toLowerCase();
    const phone = $("#pPhone")?.value || "";

    saving = true;
    let res;
    try {
      res = saveProfile({ nick, phone, birthdate: profile.birthdate, city: profile.city, bio: profile.bio });
    } catch {
      saving = false;
      return msg(out, t("profile.session"));
    }
    saving = false;
    if (!res.ok) {
      const key = res.error === "name" ? "profile.invalidNick"
        : res.error === "birthdate" ? "profile.invalidBirth"
        : res.error === "phone" ? "profile.invalidPhone"
        : "profile.saveFailed";
      return msg(out, t(key));
    }
    profile.nick = res.nick;
    if (phone !== undefined) profile.phone = res.phone;
    if (username !== profile.username) {
      saving = true;
      const ures = await changeUsername(username);
      saving = false;
      if (!ures.ok) {
        const key = ures.error === "exists" ? "profile.usernameTaken" : ures.error === "session" ? "profile.session" : "profile.invalidUsername";
        return msg(out, t(key));
      }
      profile.username = ures.username;
      profile.color = (getProfile(ures.username) || profile).color;
    }
    fillForm();
    paintAvatar();
    paintMemberSince();
    msg(out, t("profile.saved"), true);
    toast(t("profile.saved"), "success");
  });
}

/* ---------- password ---------- */
function renderMeter(pw) {
  const score = passwordScore(pw);
  const meter = $("#pMeter");
  meter.classList.toggle("hidden", !pw);
  meter.dataset.score = String(score);
  const fill = meter.firstElementChild;
  if (fill) fill.style.width = `${score * 25}%`;
  $("#pLabel").textContent = pw ? t(`auth.pwLevel${Math.max(1, score)}`) : "";
}

function wirePassword() {
  $("#pNew").addEventListener("input", (e) => renderMeter(e.target.value));
  $("#pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (saving) return;
    const out = $("#pwMsg");
    clearMsg(out);
    const current = $("#pCur").value;
    const next = $("#pNew").value;
    if (!current) return msg(out, t("profile.pwWrong"));
    if (!isPassword(next)) return msg(out, t("auth.pwWeak"));
    if (next !== $("#pNew2").value) return msg(out, t("profile.pwMismatch"));

    saving = true;
    const res = await changePassword({ current, next });
    saving = false;
    if (!res.ok) {
      const key = res.error === "current" ? "profile.pwWrong" : res.error === "password" ? "auth.pwWeak" : res.error === "session" ? "profile.session" : "profile.secure";
      return msg(out, t(key));
    }
    $("#pCur").value = "";
    $("#pNew").value = "";
    $("#pNew2").value = "";
    renderMeter("");
    msg(out, t("profile.pwChanged"), true);
    toast(t("profile.pwChanged"), "success");
  });

  $("#recoveryGen")?.addEventListener("click", async () => {
    const out = $("#recoveryMsg");
    clearMsg(out);
    const current = $("#pCur").value;
    if (!current) return msg(out, t("profile.recoveryNeedPw"));
    const btn = $("#recoveryGen");
    btn.disabled = true;
    const res = await rotateRecoveryCode({ password: current });
    btn.disabled = false;
    if (!res.ok) {
      const key = res.error === "current" ? "profile.pwWrong" : res.error === "session" ? "profile.session" : "profile.secure";
      return msg(out, t(key));
    }
    const line = t("profile.recoveryDone", { code: res.recoveryCode });
    msg(out, line, true);
    toast(t("profile.recoveryDone", { code: res.recoveryCode }), "success");
  });
}

/* ---------- details ---------- */
function wireDetails() {
  $("#detailsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (saving) return;
    saving = true;
    const submit = e.currentTarget.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    const out = $("#detailsMsg");
    clearMsg(out);
    try {
      let res;
      try {
        res = saveProfile({
          nick: $("#pNick").value,
          birthdate: $("#pBirth").value,
          city: $("#pCity").value,
          bio: $("#pBio").value
        });
      } catch {
        return msg(out, t("profile.session"));
      }
      if (!res.ok) {
        const key = res.error === "name" ? "profile.invalidNick" : res.error === "birthdate" ? "profile.invalidBirth" : "profile.saveFailed";
        return msg(out, t(key));
      }
      profile.nick = res.nick;
      profile.birthdate = $("#pBirth").value;
      profile.city = $("#pCity").value.trim();
      profile.bio = $("#pBio").value.trim();
      paintAvatar();
      paintMemberSince();
      msg(out, t("profile.saved"), true);
      toast(t("profile.saved"), "success");
    } finally {
      saving = false;
      if (submit) submit.disabled = false;
    }
  });
}

/* ---------- avatar ---------- */
function wireAvatar() {
  const windowMs = Math.max(5000, Number(siteCfg?.limits?.avatarWindowMs) || 5000);
  const avatarGuard = new RateGuard(3, windowMs);
  const gallery = $("#avatarGallery");
  let lockTimer = 0;
  let warnAt = 0;
  const lockPicker = (ms) => {
    gallery.classList.add("locked");
    gallery.setAttribute("aria-disabled", "true");
    clearTimeout(lockTimer);
    lockTimer = setTimeout(() => {
      gallery.classList.remove("locked");
      gallery.removeAttribute("aria-disabled");
    }, Math.max(250, ms));
  };
  const allowAvatar = () => {
    const res = avatarGuard.take();
    if (res.ok) return true;
    const now = Date.now();
    if (now - warnAt > 900) {
      warnAt = now;
      toast(t("toast.avatarSpam"), "error");
    }
    lockPicker(res.retryIn);
    return false;
  };

  gallery.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-avatar]");
    if (!btn || !allow("account.avatarUploads") || !allowAvatar()) return;
    try {
      const res = setAvatar(presetValue(btn.dataset.avatar));
      if (!res.ok) throw new Error(res.error);
      profile.avatar = res.avatar;
      recordFeatureUse("account.avatarUploads", { plan: flagContext.plan, role: flagContext.role });
      paintAvatar();
      renderAvatarGallery();
      toast(t("profile.saved"), "success");
    } catch {
      toast(t("profile.saveFailed"), "error");
    }
  });
  $$(".avatar-filter").forEach((b) => b.addEventListener("click", () => {
    avatarGender = b.dataset.avatarGender;
    renderAvatarGallery();
  }));
  $("#avatarRemove").addEventListener("click", () => {
    if (!allow("account.avatarUploads") || !allowAvatar()) return;
    try {
      setAvatar("");
      profile.avatar = "";
      paintAvatar();
      renderAvatarGallery();
      toast(t("profile.saved"), "success");
    } catch { toast(t("profile.saveFailed"), "error"); }
  });
}

/* ---------- friends ---------- */
function wireFriends() {
  $("#friendForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!allow("account.friends")) return;
    const out = $("#friendMsg");
    clearMsg(out);
    const val = $("#friendInput").value.trim();
    if (!val) return;
    try {
      const res = addFriend(val);
      if (!res.ok) {
        const key = {
          self: "profile.friendSelf",
          missing: "profile.friendMissing",
          exists: "profile.friendExists",
          username: "profile.invalidUsername"
        }[res.error] || "profile.saveFailed";
        return msg(out, t(key));
      }
      $("#friendInput").value = "";
      toast(t("profile.friendAdded"), "success");
      renderFriends();
    } catch { msg(out, t("profile.session")); }
  });
}

function renderFriends() {
  const list = $("#friendList");
  const friends = (getProfile(profile.username)?.friends) || [];
  profile.friends = friends;
  list.innerHTML = "";
  if (!friends.length) {
    list.append(el("li", { class: "friend-empty", text: t("profile.noFriends") }));
    return;
  }
  for (const name of friends) {
    const rec = getProfile(name);
    if (!rec) continue;
    const li = el("li", { class: "friend-item" });
    const av = el("span", { class: "avatar" });
    const src = avatarSrc(rec.avatar);
    av.textContent = src ? "" : initials(rec.nick);
    av.style.background = rec.color;
    if (src) {
      av.style.backgroundImage = `url("${src}")`;
      av.style.backgroundSize = "cover";
      av.style.backgroundPosition = "center";
    }
    const info = el("div", { class: "friend-info" });
    info.append(
      el("strong", { text: rec.nick }),
      el("span", { class: "friend-user", text: `@${rec.username}`, dir: "ltr" })
    );
    const rm = el("button", {
      class: "friend-remove", type: "button", title: t("profile.remove")
    });
    rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>';
    rm.addEventListener("click", () => {
      if (!allow("account.friends")) return;
      try {
        removeFriend(name);
        toast(t("profile.friendRemoved"), "success");
        renderFriends();
      } catch {}
    });
    li.append(av, info, rm);
    list.append(li);
  }
  if (!list.children.length) list.append(el("li", { class: "friend-empty", text: t("profile.noFriends") }));
}

/* ---------- appearance ---------- */
function wireAppearance() {
  const row = $("#accentRow");
  const paint = () => {
    const prefs = getPrefs();
    const preset = ACCENTS.some((a) => a.a === prefs.accent);
    [...row.children].forEach((b) => b.classList.toggle("active", b.dataset.a === prefs.accent));
    const input = $("#accentCustom");
    const wrap = $("#accentCustomWrap");
    if (input) input.value = prefs.accent;
    if (wrap) {
      wrap.classList.toggle("active", !preset);
      wrap.style.background = preset ? "" : `linear-gradient(135deg,${prefs.accent},${prefs.accent2})`;
    }
  };
  for (const acc of ACCENTS) {
    const b = el("button", { class: "accent-swatch", type: "button", "data-a": acc.a, title: acc.a });
    b.style.background = `linear-gradient(135deg,${acc.a},${acc.b})`;
    b.addEventListener("click", () => {
      if (!allow("account.customThemes")) return;
      savePrefs({ accent: acc.a, accent2: acc.b });
      paint();
    });
    row.append(b);
  }
  const custom = $("#accentCustom");
  if (custom) {
    custom.addEventListener("input", () => {
      if (!allow("account.customThemes")) return;
      savePrefs({ accent: custom.value, accent2: lightenHex(custom.value) });
      paint();
    });
  }
  paint();
  $("#lookReset").addEventListener("click", () => {
    if (!allow("account.customThemes")) return;
    resetPrefs();
    paint();
    toast(t("profile.lookResetDone"), "success");
  });
}

/* ---------- misc ---------- */
function wireMisc() {
  $("#logoutBtn").addEventListener("click", () => {
    logout();
    location.replace("./");
  });
}

function renderDeviceCard() {
  const lang = document.documentElement.lang === "fa" ? "fa" : "en";
  const sum = $("#deviceSummary");
  if (sum) sum.textContent = deviceSummary(lang);
  const list = $("#capList");
  if (!list) return;
  list.innerHTML = "";
  for (const row of capabilityRows(lang)) {
    const pill = t(row.status === "ok" ? "profile.capOk" : row.status === "limited" ? "profile.capLimited" : "profile.capNo");
    list.append(el("li", { class: `cap-row cap-${row.status}` }, [
      el("div", { class: "cap-head" }, [
        el("span", { class: "cap-label", text: row.label }),
        el("span", { class: `cap-pill ${row.status}`, text: pill })
      ]),
      el("small", { class: "cap-note", text: row.note })
    ]));
  }
  refreshNotifUI();
}

function refreshNotifUI() {
  const enable = $("#notifEnable");
  if (!enable) return;
  const uid = profile.username;
  const perm = notifPermission();
  const prefs = notifPrefs(uid);
  const msg = $("#notifMsg");
  msg.textContent = "";
  msg.classList.remove("ok");
  enable.hidden = false;
  enable.disabled = false;
  enable.dataset.confirmed = "";
  $("#notifExplain").classList.add("hidden");

  if (perm === "unsupported") {
    enable.hidden = true;
    msg.textContent = t("profile.notifUnsupported");
  } else if (perm === "denied") {
    enable.hidden = true;
    msg.textContent = t("profile.notifBlocked");
  } else if (perm === "granted") {
    enable.hidden = true;
    $("#notifExplain").classList.add("hidden");
  }

  const granted = perm === "granted";
  $("#notifPrefs").classList.toggle("hidden", !granted);
  $("#notifTest").hidden = !granted;
  $("#notifMutedWrap").classList.toggle("hidden", !granted);
  if (granted) {
    $("#notifMentions").checked = !!prefs.mentions;
    $("#notifChat").checked = !!prefs.chat;
    $("#notifActivity").checked = !!prefs.activity;
    $("#notifPreview").checked = !!prefs.preview;
  }
  renderMutedRooms();
}

function renderMutedRooms() {
  const list = $("#notifMutedRooms");
  if (!list) return;
  const rooms = mutedRooms(profile.username);
  list.innerHTML = "";
  $("#notifMutedEmpty").classList.toggle("hidden", rooms.length > 0);
  for (const room of rooms) {
    list.append(el("li", { class: "muted-room" }, [
      el("span", { text: room.name }),
      el("button", {
        type: "button",
        class: "link-btn",
        text: t("profile.notifUnmute"),
        onclick: () => {
          setRoomNotif(profile.username, room.roomId, true);
          renderMutedRooms();
        }
      })
    ]));
  }
}

function wireNotifications() {
  $("#notifEnable")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const msg = $("#notifMsg");
    if (!btn.dataset.confirmed) {
      btn.dataset.confirmed = "1";
      $("#notifExplain").classList.remove("hidden");
      return;
    }
    const result = await requestNotifPermission();
    if (result === "granted") {
      saveNotifPrefs(profile.username, { enabled: true });
      msg.textContent = t("profile.notifGranted");
      msg.classList.add("ok");
      refreshNotifUI();
    } else if (result === "denied") {
      refreshNotifUI();
    }
  });

  const prefsMap = {
    notifMentions: "mentions",
    notifChat: "chat",
    notifActivity: "activity",
    notifPreview: "preview"
  };
  for (const [id, key] of Object.entries(prefsMap)) {
    $("#" + id)?.addEventListener("change", (ev) => {
      saveNotifPrefs(profile.username, { [key]: ev.currentTarget.checked, enabled: true });
    });
  }

  $("#notifTest")?.addEventListener("click", () => {
    testNotification();
    const msg = $("#notifMsg");
    msg.textContent = t("profile.notifTestSent");
    msg.classList.add("ok");
  });
}
