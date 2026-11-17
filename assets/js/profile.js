import { initI18n, t } from "./i18n.js";
import {
  $, el, toast, initials, applyUIPrefs, getPrefs, savePrefs, resetPrefs,
  ACCENTS, registerServiceWorker
} from "./core.js";
import {
  currentUser, getProfile, saveProfile, changeUsername, changePassword,
  setAvatar, addFriend, removeFriend, logout, passwordScore, isPassword
} from "./auth.js";

applyUIPrefs();
initI18n();
registerServiceWorker();

let profile = null;
let saving = false;

const me = currentUser();
if (!me) {
  location.replace("auth.html?next=profile.html");
} else {
  boot();
}

function boot() {
  profile = getProfile(me.username);
  if (!profile) {
    location.replace("auth.html?next=profile.html&force=1");
    return;
  }
  document.title = `${t("profile.title")} — هم‌تماشا`;
  const birth = $("#pBirth");
  if (birth) birth.max = new Date().toISOString().slice(0, 10);

  fillForm();
  paintAvatar();
  renderFriends();
  wireAccount();
  wirePassword();
  wireDetails();
  wireFriends();
  wireAvatar();
  wireAppearance();
  wireMisc();
  document.addEventListener("langchange", () => {
    document.title = `${t("profile.title")} — هم‌تماشا`;
    paintAvatar();
    renderFriends();
    paintMemberSince();
  });
}

function fillForm() {
  $("#pNick").value = profile.nick;
  $("#pUsername").value = profile.username;
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

function paintAvatar() {
  const box = $("#avatarBox");
  const span = $("#avatarInitials");
  box.style.background = profile.color;
  box.style.backgroundImage = profile.avatar ? `url("${profile.avatar}")` : "";
  box.style.backgroundSize = "cover";
  box.style.backgroundPosition = "center";
  span.textContent = profile.avatar ? "" : initials(profile.nick);
  $("#avatarRemove").classList.toggle("hidden", !profile.avatar);
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

    saving = true;
    let res;
    try {
      res = saveProfile({ nick, birthdate: profile.birthdate, city: profile.city, bio: profile.bio });
    } catch {
      saving = false;
      return msg(out, t("profile.session"));
    }
    saving = false;
    if (!res.ok) {
      return msg(out, res.error === "name" ? t("profile.invalidNick") : res.error === "birthdate" ? t("profile.invalidBirth") : t("profile.saveFailed"));
    }
    profile.nick = res.nick;
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
}

/* ---------- details ---------- */
function wireDetails() {
  $("#detailsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (saving) return;
    const out = $("#detailsMsg");
    clearMsg(out);
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
  });
}

/* ---------- avatar ---------- */
function wireAvatar() {
  $("#avatarPick").addEventListener("click", () => $("#avatarInput").click());
  $("#avatarInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await fileToAvatar(file);
      const res = setAvatar(dataUrl);
      if (!res.ok) throw new Error(res.error);
      profile.avatar = res.avatar;
      paintAvatar();
      toast(t("profile.saved"), "success");
    } catch (err) {
      toast(t(err?.message === "image" ? "profile.image" : "profile.saveFailed"), "error");
    }
  });
  $("#avatarRemove").addEventListener("click", () => {
    try {
      setAvatar("");
      profile.avatar = "";
      paintAvatar();
      toast(t("profile.saved"), "success");
    } catch { toast(t("profile.saveFailed"), "error"); }
  });
}

async function fileToAvatar(file) {
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) throw new Error("image");
  if (file.size > 8 * 1024 * 1024) throw new Error("image");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("image"));
      i.src = url;
    });
    const S = 192;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext("2d");
    const scale = Math.max(S / img.width, S / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- friends ---------- */
function wireFriends() {
  $("#friendForm").addEventListener("submit", (e) => {
    e.preventDefault();
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
    av.textContent = rec.avatar ? "" : initials(rec.nick);
    av.style.background = rec.color;
    if (rec.avatar) {
      av.style.backgroundImage = `url("${rec.avatar}")`;
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
    [...row.children].forEach((b) => b.classList.toggle("active", b.dataset.a === prefs.accent));
  };
  for (const acc of ACCENTS) {
    const b = el("button", { class: "accent-swatch", type: "button", "data-a": acc.a, title: acc.a });
    b.style.background = `linear-gradient(135deg,${acc.a},${acc.b})`;
    b.addEventListener("click", () => {
      savePrefs({ accent: acc.a, accent2: acc.b });
      paint();
    });
    row.append(b);
  }
  paint();
  $("#lookReset").addEventListener("click", () => {
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
