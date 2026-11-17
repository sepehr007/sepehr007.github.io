import { initI18n, t } from "./i18n.js";
import { $, toast, makeCode, store, registerServiceWorker, applyUIPrefs, wireInstallPrompt, createLimiter } from "./core.js";
import { currentUser, mountUserChip, isRealName } from "./auth.js";

applyUIPrefs();
initI18n();
registerServiceWorker();
wireInstallPrompt();

mountUserChip();

const user = currentUser();
if (user) resumePendingRoom();

function resumePendingRoom() {
  let raw = "";
  try { raw = sessionStorage.getItem("wt.pending") || ""; } catch {}
  if (!raw) return;
  try { sessionStorage.removeItem("wt.pending"); } catch {}
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

const createGuard = createLimiter(1, 1800);
const joinGuard = createLimiter(2, 1800);
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
