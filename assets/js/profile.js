import { initI18n, t, fmtDateTime } from "./i18n.js";
import { apiFetch } from "./api.js";
import {
  $, $$, el, toast, initials, applyUIPrefs, getPrefs, savePrefs, resetPrefs,
  ACCENTS, lightenHex, registerServiceWorker, RateGuard,
  THEME_PRESETS, normalizeHex, listUserThemes, saveUserTheme, deleteUserTheme,
  currentThemeId, applyThemeById, hasPreviousTheme, restorePreviousTheme
} from "./core.js";
import {
  currentUser, getProfile, saveProfile, changeUsername, changePassword,
  setAvatar, addFriend, removeFriend, logout, passwordScore, isPassword,
  isLocallyBanned, syncRemoteSession, rotateRecoveryCode
} from "./auth.js";
import { AVATAR_PRESETS, avatarId, avatarSrc, presetValue } from "./avatars.js";
import { uploadFile, absoluteFileUrl, uploadProgressRow } from "./uploader.js";
import { dbGetByIndex } from "./db.js";
import { subscriptionStatus } from "./plans.js";
import { loadSiteConfig, applySiteConfig, applyGlobalTheme, isMaintenanceBlocked, listenLiveConfig } from "./site-config.js";
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
  syncAppearanceGate();
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
  wireSessions();
  wirePrivacy();
  wireDelete();
  loadSessions();
  loadPrivacy();
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
    paintAppearance();
    renderSessions();
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
const CYCLE_LABEL = { monthly: "ماهانه", yearly: "سالانه", lifetime: "مادام‌العمر" };

function planMoney(amount, currency = "IRT") {
  const n = Number(amount) || 0;
  return currency === "USD" ? `$${n.toLocaleString("fa-IR")}` : `${n.toLocaleString("fa-IR")} تومان`;
}

function planDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function serverBillingMe() {
  try {
    return await apiFetch("/billing/me", { timeoutMs: 6000 });
  } catch {
    return null;
  }
}

async function renderPlanChoices(refresh) {
  const box = $("#planChoices");
  if (!box) return;
  const fa = document.documentElement.lang === "fa";
  let data = null;
  try {
    data = await apiFetch("/billing/plans", { auth: false, timeoutMs: 6000 });
  } catch {
    data = null;
  }
  const plans = (Array.isArray(data?.plans) ? data.plans : []).filter((plan) => plan.active !== false && !plan.archived);
  if (!plans.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  const head = el("div", { class: "plan-choices-head" });
  head.append(el("strong", { text: fa ? "پلن‌ها" : "Plans" }));
  const coupon = el("input", {
    type: "text",
    class: "plan-coupon",
    placeholder: fa ? "کد تخفیف (اختیاری)" : "Coupon (optional)",
    dir: "ltr",
    maxlength: "40"
  });
  head.append(coupon);
  box.append(head);
  const msg = el("p", { class: "plan-msg", text: "" });

  for (const plan of plans) {
    const card = el("div", { class: `plan-option${plan.popular ? " popular" : ""}` });
    const info = el("div", { class: "plan-option-info" });
    const cycleText = CYCLE_LABEL[plan.cycle] || plan.cycle;
    const trialText = Number(plan.trialDays) > 0 ? ` · ${plan.trialDays} ${fa ? "روز آزمایشی" : "trial days"}` : "";
    info.append(
      el("strong", { text: plan.name }),
      el("span", { class: "plan-option-price", text: Number(plan.price) > 0 ? planMoney(plan.price, plan.currency) : (fa ? "رایگان" : "Free") }),
      el("small", { class: "muted", text: `${cycleText} · ${plan.days} ${fa ? "روز" : "days"}${trialText}` })
    );
    if (plan.description) info.append(el("small", { class: "muted", text: plan.description }));
    const actions = el("div", { class: "plan-option-actions" });
    const buy = el("button", { class: "btn btn-primary btn-sm", type: "button", text: fa ? "خرید / تمدید" : "Subscribe" });
    buy.addEventListener("click", async () => {
      buy.disabled = true;
      try {
        const res = await apiFetch("/billing/orders", {
          method: "POST",
          body: { planId: plan.id, coupon: coupon.value.trim() || undefined }
        });
        if (res?.intent?.checkoutUrl) {
          location.href = res.intent.checkoutUrl;
          return;
        }
        if (res?.intent && res.intent.ok === false) {
          msg.textContent = fa
            ? `درگاه پرداخت آماده نیست؛ متغیرهای سرویس لازم است: ${(res.intent.requirements || []).join("، ")}`
            : "Payment provider is not configured.";
        } else {
          const id = res?.order?.id ? ` (${res.order.id})` : "";
          msg.textContent = fa
            ? `سفارش${id} ثبت شد. ${res?.intent?.instructions || "فعال‌سازی فقط بعد از تایید سمت سرور انجام می‌شود."}`
            : "Order created; activation happens after server verification.";
        }
        toast(fa ? "سفارش ثبت شد" : "Order created", "success");
        refresh?.();
      } catch (err) {
        msg.textContent = err?.message || (fa ? "ثبت سفارش نشد." : "Order failed.");
      } finally {
        buy.disabled = false;
      }
    });
    actions.append(buy);
    if (Number(plan.trialDays) > 0) {
      const trial = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: fa ? "دورهٔ آزمایشی" : "Start trial" });
      trial.addEventListener("click", async () => {
        trial.disabled = true;
        try {
          await apiFetch("/billing/orders", { method: "POST", body: { planId: plan.id, trial: true } });
          toast(fa ? "دورهٔ آزمایشی فعال شد" : "Trial started", "success");
          refresh?.();
        } catch (err) {
          toast(err?.message || (fa ? "دورهٔ آزمایشی شروع نشد." : "Trial failed"), "error");
        } finally {
          trial.disabled = false;
        }
      });
      actions.append(trial);
    }
    card.append(info, actions);
    box.append(card);
  }
  box.append(msg);
}

async function renderPlan() {
  const title = $("#planStatusTitle");
  const meta = $("#planStatusMeta");
  const dot = $("#planStatusDot");
  const choices = $("#planChoices");
  if (!title || !meta || !dot || !profile) return;
  const fa = document.documentElement.lang === "fa";
  const server = await serverBillingMe();
  if (server) {
    const state = server.state || "none";
    dot.dataset.state = state === "trial" ? "active" : state;
    const planName = server.plan?.name || (server.plan ? t(PLAN_LABEL_KEYS[server.plan.id] || "profile.planTitle") : "");
    const end = planDate(server.subscription?.expiresAt);
    if (state === "active" || state === "trial") {
      const days = Number(server.daysLeft);
      const endText = end ? end.toLocaleDateString(fa ? "fa-IR" : "en-US", { year: "numeric", month: "long", day: "numeric" }) : "";
      title.textContent = planName || t("profile.planTitle");
      if (state === "trial") {
        meta.textContent = fa ? `دورهٔ آزمایشی${endText ? ` تا ${endText}` : ""}${Number.isFinite(days) ? ` · ${days} روز باقی‌مانده` : ""}` : "Trial active";
      } else if (server.subscription?.cancelAtPeriodEnd) {
        meta.textContent = fa ? `تا پایان دوره فعال است${endText ? ` (${endText})` : ""} و بعد تمدید نمی‌شود.` : "Active until period end";
      } else {
        meta.textContent = fa ? `فعال${endText ? ` تا ${endText}` : ""}${Number.isFinite(days) ? ` · ${days} روز باقی‌مانده` : ""}` : "Active";
      }
    } else if (state === "pending") {
      title.textContent = planName || t("profile.planTitle");
      meta.textContent = fa ? "سفارش ثبت شده و در انتظار تایید پرداخت سمت سرور است." : "Pending server verification";
    } else if (state === "expired") {
      title.textContent = planName || t("profile.planTitle");
      meta.textContent = fa ? "اشتراک منقضی شده؛ برای ادامه یکی از پلن‌ها را تمدید کن." : "Expired";
    } else {
      title.textContent = t("profile.planNone");
      meta.textContent = t("profile.planNote");
    }
    await renderPlanChoices(() => renderPlan());
    return;
  }

  if (choices) {
    choices.hidden = true;
    choices.replaceChildren();
  }
  const status = await subscriptionStatus(profile.username);
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
  const me = currentUser();
  if (me && ["owner", "super_owner"].includes(me.role)) {
    const card = $("#pwForm")?.closest(".profile-card");
    if (card) {
      card.replaceChildren();
      const title = el("h2");
      title.textContent = t("profile.security");
      const hint = el("p", { class: "hint" });
      hint.textContent = "رمز مالک فقط از کنسول مالک (owner.html) و با تأیید ایمیل یا پیامک تغییر می‌کند.";
      card.append(title, hint);
    }
    return;
  }
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

  const uploadBox = $("#avatarUpload");
  if (uploadBox) {
    const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", class: "hidden" });
    const uploadBtn = el("button", { class: "link-btn", type: "button", text: "آپلود عکس (PNG/JPG/WebP تا ۲ مگابایت)" });
    const progress = uploadProgressRow("بارگذاری عکس");
    progress.classList.add("hidden");
    uploadBtn.addEventListener("click", () => {
      if (!allow("account.avatarUploads") || !allowAvatar()) return;
      fileInput.click();
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        toast("حجم عکس بیشتر از ۲ مگابایت است.", "error");
        fileInput.value = "";
        return;
      }
      uploadBtn.disabled = true;
      progress.classList.remove("hidden");
      try {
        const data = await uploadFile(file, { kind: "avatar", onProgress: (p) => progress.setProgress(p) });
        const res = setAvatar(absoluteFileUrl(data.url));
        if (!res.ok) throw new Error("این فایل به‌عنوان آواتار پذیرفته نشد.");
        profile.avatar = res.avatar;
        recordFeatureUse("account.avatarUploads", { plan: flagContext.plan, role: flagContext.role });
        paintAvatar();
        renderAvatarGallery();
        toast("عکس پروفایل به‌روز شد.", "success");
      } catch (err) {
        toast(err.message || "بارگذاری عکس انجام نشد.", "error");
      } finally {
        uploadBtn.disabled = false;
        fileInput.value = "";
        setTimeout(() => progress.classList.add("hidden"), 1200);
      }
    });
    uploadBox.append(uploadBtn, fileInput, progress);
  }
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
let appearanceReady = false;
let paintAppearance = () => {};

function syncAppearanceGate() {
  if (!appearanceReady) return;
  const blocked = !allow("account.customThemes");
  $("#appearanceBody")?.classList.toggle("hidden", blocked);
  $("#appearanceLocked")?.classList.toggle("hidden", !blocked);
  if (blocked) {
    if (siteCfg) applyGlobalTheme(siteCfg);
    $("#appearanceMsg").textContent = "";
  } else {
    applyUIPrefs(getPrefs());
    paintAppearance();
  }
}

function wireAppearance() {
  const body = $("#appearanceBody");
  if (!body) return;
  appearanceReady = true;
  const msg = $("#appearanceMsg");
  const note = (text, kind = "") => { if (msg) { msg.textContent = text; msg.className = `form-msg ${kind}`.trim(); } };
  const guard = () => {
    if (allow("account.customThemes")) return true;
    toast(t("profile.appearanceLockedToast"), "error");
    return false;
  };

  const modeRow = $("#themeRow");
  const presetGrid = $("#themePresetGrid");
  const accentRow = $("#accentRow");
  const savedList = $("#savedThemes");
  const savedEmpty = $("#savedThemesEmpty");
  const restoreBtn = $("#themeRestorePrev");
  const hex1 = $("#accentHex");
  const hex2 = $("#accent2Hex");

  for (const preset of THEME_PRESETS) {
    const b = el("button", { class: "theme-preset", type: "button", "data-preset": preset.id });
    const chip = el("span", { class: "tp-chip-lg", "aria-hidden": "true" });
    chip.style.background = `linear-gradient(135deg,${preset.accent},${preset.accent2})`;
    const name = el("span", { class: "tp-preset-name", text: t(`profile.preset.${preset.id}`) });
    const mode = el("span", { class: "tp-preset-mode", text: preset.theme === "light" ? t("profile.themeLight") : t("profile.themeDark") });
    b.append(chip, name, mode);
    b.addEventListener("click", () => {
      if (!guard()) return;
      applyThemeById(preset.id);
      paint();
      note(t("profile.themeApplied"), "ok");
    });
    presetGrid.append(b);
  }

  for (const acc of ACCENTS) {
    const b = el("button", { class: "accent-swatch", type: "button", "data-a": acc.a, title: acc.a });
    b.style.background = `linear-gradient(135deg,${acc.a},${acc.b})`;
    b.addEventListener("click", () => {
      if (!guard()) return;
      savePrefs({ accent: acc.a, accent2: acc.b });
      paint();
    });
    accentRow.append(b);
  }

  [...modeRow.querySelectorAll(".theme-mode")].forEach((b) => {
    b.addEventListener("click", () => {
      if (!guard()) return;
      savePrefs({ theme: b.dataset.themeMode });
      paint();
      note(t("profile.themeApplied"), "ok");
    });
  });

  const custom = $("#accentCustom");
  if (custom) {
    custom.addEventListener("input", () => {
      if (!guard()) return;
      savePrefs({ accent: custom.value, accent2: lightenHex(custom.value) });
      paint();
    });
  }

  function wireHex(input, key) {
    if (!input) return;
    const commit = (silent) => {
      if (!guard()) { paint(); return; }
      const hex = normalizeHex(input.value);
      if (!hex) {
        if (!silent) {
          note(t("profile.hexInvalid"), "err");
          paint();
        }
        return;
      }
      if (hex !== getPrefs()[key]) savePrefs({ [key]: hex });
      paint();
      if (!silent) note(t("profile.themeApplied"), "ok");
    };
    input.addEventListener("input", () => commit(true));
    input.addEventListener("change", () => commit(false));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(false); }
    });
  }
  wireHex(hex1, "accent");
  wireHex(hex2, "accent2");

  function wireOptionalHex(input, key) {
    if (!input) return;
    const commit = (silent) => {
      if (!guard()) { paint(); return; }
      const raw = input.value.trim();
      const hex = raw ? normalizeHex(raw) : "";
      if (raw && !hex) {
        if (!silent) {
          note(t("profile.hexInvalid"), "err");
          paint();
        }
        return;
      }
      if (hex !== (getPrefs()[key] || "")) savePrefs({ [key]: hex });
      paint();
      if (!silent) note(t("profile.themeApplied"), "ok");
    };
    input.addEventListener("input", () => commit(true));
    input.addEventListener("change", () => commit(false));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(false); }
    });
  }
  const bgInput = $("#bgColorHex");
  const textInput = $("#textColorHex");
  wireOptionalHex(bgInput, "bgColor");
  wireOptionalHex(textInput, "textColor");

  function renderSaved() {
    savedList.textContent = "";
    const items = listUserThemes();
    savedEmpty.classList.toggle("hidden", items.length > 0);
    const activeId = currentThemeId();
    for (const th of items) {
      const li = el("li", { class: "saved-theme" });
      if (th.id === activeId) li.classList.add("active");
      const chip = el("span", { class: "tp-chip-lg", "aria-hidden": "true" });
      chip.style.background = `linear-gradient(135deg,${th.accent},${th.accent2})`;
      const meta = el("div", { class: "saved-theme-meta" });
      meta.append(
        el("strong", { text: th.name }),
        el("span", { class: "hint", text: th.theme === "light" ? t("profile.themeLight") : t("profile.themeDark") })
      );
      const use = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: t("profile.themeApply") });
      use.addEventListener("click", () => {
        if (!guard()) return;
        applyThemeById(th.id);
        paint();
        note(t("profile.themeApplied"), "ok");
      });
      const del = el("button", { class: "link-btn saved-del", type: "button", text: t("profile.themeDelete") });
      del.addEventListener("click", () => {
        if (!guard()) return;
        deleteUserTheme(th.id);
        paint();
        note(t("profile.themeDeleted"), "ok");
      });
      li.append(chip, meta, use, del);
      savedList.append(li);
    }
  }

  function paint() {
    const prefs = getPrefs();
    const cur = currentThemeId();
    [...modeRow.querySelectorAll(".theme-mode")].forEach((b) => {
      const on = b.dataset.themeMode === prefs.theme;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    [...presetGrid.children].forEach((b) => {
      const on = b.dataset.preset === cur;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const presetAccent = ACCENTS.some((a) => a.a === prefs.accent);
    [...accentRow.children].forEach((b) => {
      const on = b.dataset.a === prefs.accent;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const wrap = $("#accentCustomWrap");
    if (custom) custom.value = prefs.accent;
    if (wrap) {
      wrap.classList.toggle("active", !presetAccent);
      wrap.style.background = presetAccent ? "" : `linear-gradient(135deg,${prefs.accent},${prefs.accent2})`;
    }
    if (hex1 && document.activeElement !== hex1) hex1.value = prefs.accent;
    if (hex2 && document.activeElement !== hex2) hex2.value = prefs.accent2;
    if (bgInput && document.activeElement !== bgInput) bgInput.value = prefs.bgColor || "";
    if (textInput && document.activeElement !== textInput) textInput.value = prefs.textColor || "";
    const darkMode = prefs.theme !== "light";
    if (bgInput) bgInput.placeholder = darkMode ? "#0c0b1d" : "#f4f2ff";
    if (textInput) textInput.placeholder = darkMode ? "#f4ede1" : "#1b1712";
    const saved = listUserThemes().find((x) => x.id === cur);
    const preset = THEME_PRESETS.find((p) => p.id === cur);
    $("#themePreviewName").textContent = saved
      ? saved.name
      : preset
        ? t(`profile.preset.${preset.id}`)
        : t("profile.themeCustom");
    $("#themePreview").dataset.mode = prefs.theme === "light" ? "light" : "dark";
    restoreBtn.disabled = !hasPreviousTheme();
    renderSaved();
  }

  paintAppearance = paint;
  paint();
  syncAppearanceGate();

  $("#themeSave").addEventListener("click", () => {
    if (!guard()) return;
    const res = saveUserTheme($("#themeName").value);
    if (!res.ok) {
      note(res.reason === "name" ? t("profile.themeNameInvalid") : t("profile.themeSaveFail"), "err");
      return;
    }
    $("#themeName").value = "";
    paint();
    note(res.replaced ? t("profile.themeReplaced") : t("profile.themeSaved"), "ok");
  });
  $("#themeName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#themeSave").click(); }
  });
  restoreBtn.addEventListener("click", () => {
    if (!guard()) return;
    if (!restorePreviousTheme()) {
      note(t("profile.themeNoPrev"), "err");
      paint();
      return;
    }
    paint();
    note(t("profile.themeRestored"), "ok");
  });
  $("#lookReset").addEventListener("click", () => {
    if (!guard()) return;
    resetPrefs();
    paint();
    note(t("profile.lookResetDone"), "ok");
  });
}

/* ---------- sessions ---------- */
let sessionsCache = [];

function apiMessage(err, fallback) {
  if (err?.payload?.code === "wrong_password") return t("profile.deleteWrong");
  if (err?.status === 401) return t("social.err.auth");
  if (err?.status === 409) return t("profile.serverOnly");
  return fallback || t("profile.serverOnly");
}

function sessionDeviceLabel(ua) {
  const s = String(ua || "");
  const browser = /Edg\//.test(s) ? "Edge"
    : /OPR\//.test(s) ? "Opera"
      : /Firefox\//.test(s) ? "Firefox"
        : /Chrome\//.test(s) ? "Chrome"
          : /Safari\//.test(s) ? "Safari"
            : "";
  const os = /Windows/.test(s) ? "Windows"
    : /Android/.test(s) ? "Android"
      : /iPhone|iPad|iPod/.test(s) ? "iOS"
        : /Mac OS X/.test(s) ? "macOS"
          : /Linux/.test(s) ? "Linux"
            : "";
  const label = [browser, os].filter(Boolean).join(" · ");
  return label || t("profile.sessionUnknown");
}

function renderSessions() {
  const list = $("#sessionList");
  if (!list) return;
  list.innerHTML = "";
  if (!sessionsCache.length) {
    list.append(el("li", { class: "friend-empty", text: t("profile.sessionsEmpty") }));
    return;
  }
  for (const s of sessionsCache) {
    const li = el("li", { class: "friend-item" });
    const info = el("div", { class: "friend-info" });
    const meta = [];
    if (s.ip) meta.push(s.ip);
    if (s.lastSeenAt) meta.push(`${t("profile.sessionLastSeen")}: ${fmtDateTime(s.lastSeenAt)}`);
    else if (s.createdAt) meta.push(`${t("profile.sessionCreated")}: ${fmtDateTime(s.createdAt)}`);
    info.append(
      el("strong", { text: sessionDeviceLabel(s.ua) }),
      el("span", { class: "friend-user", dir: "ltr", text: meta.join(" · ") })
    );
    li.append(info);
    if (s.current) {
      li.append(el("span", { class: "cap-pill ok", text: t("profile.sessionsCurrent") }));
    } else {
      const btn = el("button", { class: "friend-remove", type: "button", title: t("profile.sessionsRevoke") });
      btn.textContent = "✕";
      btn.addEventListener("click", () => revokeSession(s.id));
      li.append(btn);
    }
    list.append(li);
  }
}

async function loadSessions() {
  const msg = $("#sessionsMsg");
  if (msg) {
    msg.textContent = "";
    msg.classList.remove("ok");
  }
  try {
    const data = await apiFetch("/auth/sessions", { timeoutMs: 6000 });
    sessionsCache = Array.isArray(data?.sessions) ? data.sessions : [];
  } catch (err) {
    sessionsCache = [];
    if (msg) msg.textContent = apiMessage(err);
  }
  renderSessions();
}

async function revokeSession(id) {
  const msg = $("#sessionsMsg");
  try {
    await apiFetch(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: 6000 });
    toast(t("profile.sessionsRevoked"), "success");
    await loadSessions();
  } catch (err) {
    if (msg) msg.textContent = apiMessage(err);
  }
}

function wireSessions() {
  $("#sessionsRefresh")?.addEventListener("click", loadSessions);
  $("#sessionsRevokeOthers")?.addEventListener("click", async () => {
    const msg = $("#sessionsMsg");
    if (!window.confirm(t("profile.sessionsRevokeOthers"))) return;
    try {
      await apiFetch("/auth/sessions/revoke-others", { method: "POST", timeoutMs: 6000 });
      toast(t("profile.sessionsOthersDone"), "success");
      await loadSessions();
    } catch (err) {
      if (msg) msg.textContent = apiMessage(err);
    }
  });
}

/* ---------- privacy ---------- */
async function loadPrivacy() {
  const msg = $("#privacyMsg");
  try {
    const data = await apiFetch("/auth/privacy", { timeoutMs: 6000 });
    if ($("#privacyProfile")) $("#privacyProfile").value = data.profileVisibility || "public";
    if ($("#privacyLastActive")) $("#privacyLastActive").value = data.lastActiveVisibility || "friends";
    if ($("#privacyActivity")) $("#privacyActivity").value = data.activityVisibility || "friends";
  } catch (err) {
    if (msg) msg.textContent = apiMessage(err);
  }
}

function wirePrivacy() {
  $("#privacyForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#privacyMsg");
    try {
      await apiFetch("/auth/privacy", {
        method: "PATCH",
        timeoutMs: 6000,
        body: {
          profileVisibility: $("#privacyProfile").value,
          lastActiveVisibility: $("#privacyLastActive").value
        }
      });
      msg.textContent = t("profile.privacySaved");
      msg.classList.add("ok");
    } catch (err) {
      msg.classList.remove("ok");
      msg.textContent = apiMessage(err);
    }
  });
}

/* ---------- delete account ---------- */
function wireDelete() {
  const form = $("#deleteForm");
  if (!form) return;
  const btn = $("#deleteBtn");
  const check = $("#deleteConfirm");
  check?.addEventListener("change", () => {
    btn.disabled = !check.checked;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#deleteMsg");
    const password = $("#deletePassword").value;
    if (!password) {
      msg.textContent = t("profile.deletePassword");
      return;
    }
    btn.disabled = true;
    try {
      await apiFetch("/auth/me", { method: "DELETE", body: { password }, timeoutMs: 8000 });
      msg.classList.add("ok");
      msg.textContent = t("profile.deleteDone");
      logout();
      setTimeout(() => location.replace("./"), 700);
    } catch (err) {
      btn.disabled = false;
      msg.classList.remove("ok");
      msg.textContent = err?.payload?.code === "owner_protected" ? t("profile.deleteOwner") : apiMessage(err);
    }
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
