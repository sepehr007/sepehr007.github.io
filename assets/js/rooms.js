import { initI18n, t, fmtNumber } from "./i18n.js";
import { $, el, toast, applyUIPrefs, registerServiceWorker } from "./core.js";
import { apiFetch, apiGetToken } from "./api.js";
import { loadSiteConfig, applySiteConfig } from "./site-config.js";

const state = {
  me: null,
  q: "",
  publicRooms: [],
  recent: [],
  mine: [],
  joining: false,
  pwd: null,
  searchTimer: 0
};

applyUIPrefs();
initI18n();
registerServiceWorker();

document.title = `${t("rooms.title")} — هم‌تماشا`;

/* ------------------------------------------------------------------ helpers */

function errorText(err) {
  const code = String(err?.code || "");
  if (code === "room_full") return t("rooms.errFull");
  if (code === "private_room") return t("rooms.errPrivate");
  if (code === "room_closed") return t("rooms.errClosed");
  if (code === "wrong_password") return t("rooms.errPassword");
  const key = `social.err.${code}`;
  const text = t(key);
  if (text !== key) return text;
  if (err?.status === 401) return t("social.err.auth");
  if (err?.status === 403) return t("social.err.forbidden");
  if (err?.status === 429) return t("social.err.rate_limited");
  if (code === "network_error" || code === "timeout" || code === "not_configured") return t("social.gateServer");
  return t("social.failed");
}

function ago(ts) {
  const value = Number(ts || 0);
  if (!value) return "";
  const diff = Math.max(0, Date.now() - value);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("social.justNow");
  if (minutes < 60) return t("social.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("social.hoursAgo", { n: hours });
  return t("social.daysAgo", { n: Math.floor(hours / 24) });
}

function displayName(user) {
  return String(user?.nick || user?.username || "").trim();
}

function badge(text, cls = "") {
  return el("span", { class: `room-badge ${cls}`.trim(), text });
}

function setColor(node, color) {
  if (/^#[0-9a-f]{6}$/i.test(String(color || ""))) node.style.setProperty("--room-color", color);
}

function empty(nodeId, isEmpty) {
  const node = document.getElementById(nodeId);
  if (node) node.hidden = !isEmpty;
}

function redirectLogin() {
  const next = encodeURIComponent(`rooms.html${location.search || ""}`);
  location.href = `auth.html?next=${next}`;
}

function roomHref(code) {
  return `room.html?room=${encodeURIComponent(String(code || "").toUpperCase())}`;
}

/* --------------------------------------------------------------- password */

function askPassword(room, { error = "" } = {}) {
  const backdrop = $("#pwdBackdrop");
  const input = $("#pwdInput");
  const name = $("#pwdRoomName");
  const msg = $("#pwdMsg");
  name.textContent = room?.name || String(room?.code || "");
  input.value = "";
  msg.textContent = error;
  msg.hidden = !error;
  backdrop.classList.remove("hidden");
  setTimeout(() => input.focus(), 30);
  return new Promise((resolve) => {
    state.pwd = { resolve };
    const done = (value) => {
      backdrop.classList.add("hidden");
      state.pwd = null;
      $("#pwdOk").removeEventListener("click", ok);
      $("#pwdCancel").removeEventListener("click", cancel);
      input.removeEventListener("keydown", key);
      backdrop.removeEventListener("click", outside);
      resolve(value);
    };
    const ok = () => done(input.value.trim() || "");
    const cancel = () => done(null);
    const key = (event) => {
      if (event.key === "Enter") { event.preventDefault(); ok(); }
      if (event.key === "Escape") cancel();
    };
    const outside = (event) => { if (event.target === backdrop) cancel(); };
    $("#pwdOk").addEventListener("click", ok);
    $("#pwdCancel").addEventListener("click", cancel);
    input.addEventListener("keydown", key);
    backdrop.addEventListener("click", outside);
  });
}

/* -------------------------------------------------------------------- join */

async function joinFlow(code, { inviteCode = "" } = {}) {
  const clean = String(code || "").toUpperCase().trim();
  if (!clean) return;
  if (!apiGetToken()) {
    redirectLogin();
    return;
  }
  if (state.joining) return;
  state.joining = true;
  let password = "";
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await apiFetch(`/rooms/${encodeURIComponent(clean)}/join`, {
          method: "POST",
          body: { password, inviteCode },
          timeoutMs: 15000
        });
        toast(t("rooms.joined"), "success");
        if (password) {
          try { sessionStorage.setItem(`pwd:${clean}`, password); } catch {}
        }
        location.href = roomHref(res?.room?.code || clean);
        return;
      } catch (err) {
        if (err?.code === "wrong_password") {
          const entered = await askPassword({ code: clean }, { error: t("rooms.errPassword") });
          if (entered === null) return;
          password = entered;
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    state.joining = false;
  }
}

async function handleDeepLink() {
  let params;
  try { params = new URL(location.href).searchParams; } catch { return; }
  const room = String(params.get("room") || "").trim();
  const invite = String(params.get("invite") || "").trim();
  if (room) {
    joinFlow(room, { inviteCode: invite });
    return;
  }
  if (!invite) return;
  try {
    const res = await apiFetch("/social/invites/accept", {
      method: "POST",
      body: { code: invite },
      timeoutMs: 15000
    });
    if (res?.roomCode) joinFlow(res.roomCode);
    else toast(t("social.err.invite_invalid"), "error");
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/* ------------------------------------------------------------------ render */

function roomCard(room, { compact = false } = {}) {
  const card = el("article", { class: "room-card" });
  setColor(card, room.color);
  if (!room.isActive) card.classList.add("is-closed");

  const head = el("div", { class: "room-card-head" });
  const mark = el("span", { class: "room-card-mark" });
  if (room.iconUrl) {
    mark.append(el("img", { src: room.iconUrl, alt: "", loading: "lazy" }));
  } else {
    mark.textContent = "▷";
  }
  const title = el("div", { class: "room-card-title" });
  title.append(el("strong", { text: room.name || t("rooms.title") }));
  const owner = displayName(room.manager);
  title.append(el("small", { text: owner ? t("rooms.by", { name: owner }) : t("rooms.guest") }));
  head.append(mark, title);

  const badges = el("div", { class: "room-card-badges" });
  if (room.isActive && Number(room.lastActivityAt || 0) && Date.now() - Number(room.lastActivityAt) < 10 * 60000) {
    badges.append(badge(t("social.live"), "live"));
  }
  if (!room.isActive) badges.append(badge(t("rooms.closedBadge"), "danger"));
  if (room.hasPassword) badges.append(badge(t("rooms.passwordBadge"), "warn"));
  if (room.visibility === "private") badges.append(badge(t("rooms.privateBadge"), "warn"));
  if (room.isActive && Number(room.memberCount || 0) >= Number(room.capacity || 6)) {
    badges.append(badge(t("rooms.fullBadge"), "danger"));
  }
  if (room.joined) badges.append(badge(t("rooms.guest"), "accent"));

  card.append(head);
  if (!compact) card.append(el("p", { class: "room-card-desc", text: room.description || "" }));
  if (badges.childElementCount) card.append(badges);

  const foot = el("div", { class: "room-card-foot" });
  const meta = el("div", { class: "room-card-meta" });
  const count = el("b", { text: t("rooms.members", { n: fmtNumber(room.memberCount || 0) }) });
  meta.append(count);
  const activity = ago(room.lastActivityAt);
  if (activity) meta.append(el("span", { text: ` · ${activity}` }));
  foot.append(meta);

  const closed = !room.isActive;
  const label = closed ? t("rooms.closedBadge") : room.joined ? t("rooms.open") : t("rooms.join");
  const action = el("button", {
    type: "button",
    class: `btn ${closed ? "btn-secondary" : "btn-primary"} btn-sm`,
    text: label,
    onClick: () => {
      if (closed) return;
      joinFlow(room.code);
    }
  });
  action.disabled = closed;
  foot.append(action);
  card.append(foot);
  return card;
}

function renderList(nodeId, rooms, opts = {}) {
  const node = document.getElementById(nodeId);
  if (!node) return;
  node.replaceChildren(...rooms.map((room) => roomCard(room, opts)));
}

function renderAll() {
  renderList("publicList", state.publicRooms);
  renderList("recentList", state.recent, { compact: true });
  renderList("mineList", state.mine, { compact: true });
  empty("publicEmpty", state.publicRooms.length === 0);
  empty("recentEmpty", state.recent.length === 0);
  empty("mineEmpty", state.mine.length === 0);
}

/* -------------------------------------------------------------------- load */

async function loadPublic() {
  try {
    const q = state.q ? `?q=${encodeURIComponent(state.q)}` : "";
    const res = await apiFetch(`/rooms/discover${q}`, { timeoutMs: 12000 });
    state.publicRooms = Array.isArray(res?.rooms) ? res.rooms : [];
  } catch (err) {
    state.publicRooms = [];
    if (err?.code !== "discovery_closed") toast(errorText(err), "error");
  }
  renderAll();
}

async function loadRecent() {
  try {
    const res = await apiFetch("/rooms/recent", { timeoutMs: 12000 });
    state.recent = Array.isArray(res?.rooms) ? res.rooms : [];
  } catch {
    state.recent = [];
  }
  renderAll();
}

async function loadMine() {
  try {
    const res = await apiFetch("/rooms/mine", { timeoutMs: 12000 });
    state.mine = Array.isArray(res?.rooms) ? res.rooms : [];
  } catch (err) {
    state.mine = [];
    if (err?.status !== 401) toast(errorText(err), "error");
  }
  renderAll();
}

function loadAll() {
  renderAll();
  return Promise.all([loadPublic(), loadRecent(), loadMine()]);
}

/* ---------------------------------------------------------------- actions */

async function createRoom(event) {
  event.preventDefault();
  const name = $("#newName").value.trim();
  if (!name) {
    $("#newName").focus();
    return;
  }
  const payload = {
    name,
    description: $("#newDesc").value.trim(),
    rules: $("#newRules").value.trim(),
    color: $("#newColor").value,
    visibility: $("#newVisibility").value,
    capacity: Number($("#newCapacity").value) || 6,
    password: $("#newPassword").value
  };
  const submit = event.currentTarget.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const res = await apiFetch("/rooms", { method: "POST", body: payload, timeoutMs: 15000 });
    toast(t("rooms.created"), "success");
    $("#createForm").reset();
    $("#newColor").value = "#6c5cff";
    $("#newCapacity").value = "6";
    const code = res?.room?.code;
    if (code) joinFlow(code);
    else await loadAll();
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    submit.disabled = false;
  }
}

function wireStatic() {
  $("#createForm")?.addEventListener("submit", createRoom);
  $("#gateRetry")?.addEventListener("click", () => location.reload());
  $("#refreshBtn")?.addEventListener("click", loadAll);
  $("#searchInput")?.addEventListener("input", (event) => {
    state.q = event.target.value.trim();
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(loadPublic, 300);
  });
  $("#codeForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = $("#codeInput").value.trim().toUpperCase();
    if (!code) return;
    joinFlow(code);
  });
  document.addEventListener("langchange", () => {
    document.title = `${t("rooms.title")} — هم‌تماشا`;
    renderAll();
  });
  window.addEventListener("wt:api-unauthorized", () => showGate("login"));
}

/* -------------------------------------------------------------------- boot */

function showGate(kind) {
  const text = $("#roomsGate p");
  if (text) {
    text.dataset.i18n = kind === "server" ? "social.gateServer" : "rooms.gateText";
    text.textContent = t(text.dataset.i18n);
  }
  $("#roomsGate").hidden = false;
  $("#roomsBody").hidden = true;
}

(async () => {
  try {
    const cfg = await loadSiteConfig();
    applySiteConfig(cfg);
  } catch {}
  wireStatic();
  if (!apiGetToken()) {
    showGate("login");
    return;
  }
  try {
    const res = await apiFetch("/auth/me", { timeoutMs: 10000 });
    state.me = res?.user || null;
  } catch (err) {
    showGate("server");
    return;
  }
  if (!state.me) {
    showGate("login");
    return;
  }
  $("#roomsGate").hidden = true;
  $("#roomsBody").hidden = false;
  await loadAll();
  await handleDeepLink();
})();
