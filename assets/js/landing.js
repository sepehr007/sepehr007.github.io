import { initI18n, t } from "./i18n.js";
import { $, toast, makeCode, store, registerServiceWorker } from "./core.js";
import { requireAuth, currentUser, mountUserChip, isRealName } from "./auth.js";

initI18n();
registerServiceWorker();

const user = currentUser();
if (!user) requireAuth("index.html");
else mountUserChip();

const nameInput = $("#createName");
const createNick = $("#createNick");
const capacityInput = $("#createCapacity");
const privacyInput = $("#createPrivacy");
const pwdWrap = $("#passwordFieldWrap");
const pwdInput = $("#createPassword");
const joinCode = $("#joinCode");
const joinNick = $("#joinNick");

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
  location.href = `room.html?${q.toString()}`;
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
  const q = new URLSearchParams({ room: code, nick });
  location.href = `room.html?${q.toString()}`;
}

function getLangIsFa() {
  return document.documentElement.lang === "fa";
}
