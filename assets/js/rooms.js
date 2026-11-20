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
  recs: [],
  joining: false,
  pwd: null,
  searchTimer: 0,
  suggestTimer: 0,
  suggestSeq: 0,
  page: 1,
  total: 0,
  hasMore: false,
  loading: false,
  loadSeq: 0,
  sort: "activity",
  filters: new Set()
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

/* ------------------------------------------------------------- search history */

const HISTORY_MAX = 8;

function historyKey() {
  return `wt.searchHist.v1:${state.me?.id || "anon"}`;
}

function readHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(historyKey()) || "[]");
    return Array.isArray(raw) ? raw.filter((item) => typeof item === "string" && item.trim()).slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function writeHistory(list) {
  try { localStorage.setItem(historyKey(), JSON.stringify(list.slice(0, HISTORY_MAX))); } catch {}
}

function rememberQuery(query) {
  const clean = String(query || "").trim().slice(0, 60);
  if (clean.length < 2) return;
  const next = [clean, ...readHistory().filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(0, HISTORY_MAX);
  writeHistory(next);
  renderHistory();
}

function renderHistory() {
  const wrap = $("#searchHistory");
  const chips = $("#historyChips");
  if (!wrap || !chips) return;
  const items = readHistory();
  wrap.hidden = items.length === 0;
  chips.replaceChildren(...items.map((text) => el("button", {
    type: "button",
    class: "chip history-chip",
    text,
    onClick: () => {
      state.q = text;
      $("#searchInput").value = text;
      state.page = 1;
      loadPublic();
    }
  })));
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

function roomCard(room, { compact = false, reason = "" } = {}) {
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
  if (reason) badges.append(badge(reason, "rec"));

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
      rememberQuery(room.name);
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

function renderSkeletons() {
  const list = document.getElementById("publicList");
  if (!list) return;
  list.setAttribute("aria-busy", "true");
  list.replaceChildren(...Array.from({ length: 3 }, () => el("article", { class: "room-card skeleton", "aria-hidden": "true" }, [
    el("div", { class: "sk-line sk-title" }),
    el("div", { class: "sk-line" }),
    el("div", { class: "sk-line sk-short" })
  ])));
  empty("publicEmpty", false);
  const count = $("#publicCount");
  if (count) count.hidden = true;
  const more = $("#moreBtn");
  if (more) more.hidden = true;
}

function renderPublic() {
  const list = document.getElementById("publicList");
  if (!list) return;
  list.setAttribute("aria-busy", String(state.loading));
  renderList("publicList", state.publicRooms);
  const filtered = state.q.length > 0 || state.filters.size > 0;
  const title = $("#publicEmptyTitle");
  const text = $("#publicEmptyText");
  const titleKey = filtered ? "rooms.emptyMatchTitle" : "rooms.emptyTitle";
  const textKey = filtered ? "rooms.emptyMatch" : "rooms.empty";
  if (title) { title.dataset.i18n = titleKey; title.textContent = t(titleKey); }
  if (text) { text.dataset.i18n = textKey; text.textContent = t(textKey); }
  empty("publicEmpty", !state.loading && state.publicRooms.length === 0);
  const count = $("#publicCount");
  if (count) {
    count.hidden = state.loading || state.total === 0;
    count.textContent = t("rooms.resultsCount", { n: fmtNumber(state.total) });
  }
  const more = $("#moreBtn");
  if (more) {
    more.hidden = state.loading || !state.hasMore;
    more.disabled = state.loading;
  }
}

function renderAll() {
  renderPublic();
  renderList("recentList", state.recent, { compact: true });
  renderList("mineList", state.mine, { compact: true });
  empty("recentEmpty", state.recent.length === 0);
  empty("mineEmpty", state.mine.length === 0);
}

function renderRecs() {
  const wrap = $("#recList");
  const section = $("#recSection");
  if (!wrap || !section) return;
  section.hidden = state.recs.length === 0;
  wrap.replaceChildren(...state.recs.map((item) => {
    const reason = item.reason === "friend"
      ? (item.friendNick ? t("rooms.recFriendNamed", { name: item.friendNick }) : t("rooms.recFriend"))
      : item.reason === "live" ? t("rooms.recLive") : t("rooms.recFresh");
    return roomCard(item.room, { compact: true, reason });
  }));
}

/* -------------------------------------------------------------------- load */

async function loadPublic({ reset = true } = {}) {
  if (reset) state.page = 1;
  const seq = ++state.loadSeq;
  state.loading = true;
  if (reset) renderSkeletons();
  else renderPublic();
  try {
    const params = new URLSearchParams({ sort: state.sort, page: String(state.page), limit: "12" });
    if (state.q) params.set("q", state.q);
    if (state.filters.size) params.set("filter", [...state.filters].join(","));
    const res = await apiFetch(`/rooms/discover?${params}`, { timeoutMs: 12000 });
    if (seq !== state.loadSeq) return;
    const rooms = Array.isArray(res?.rooms) ? res.rooms : [];
    state.publicRooms = reset ? rooms : state.publicRooms.concat(rooms);
    state.total = Number(res?.total || 0);
    state.hasMore = Boolean(res?.hasMore);
  } catch (err) {
    if (seq !== state.loadSeq) return;
    if (reset) {
      state.publicRooms = [];
      state.total = 0;
      state.hasMore = false;
    }
    if (err?.code !== "discovery_closed") toast(errorText(err), "error");
    if (!reset) state.page = Math.max(1, state.page - 1);
  } finally {
    if (seq === state.loadSeq) {
      state.loading = false;
      renderPublic();
    }
  }
}

async function loadRecommendations() {
  try {
    const res = await apiFetch("/rooms/recommend?limit=6", { timeoutMs: 12000 });
    state.recs = Array.isArray(res?.rooms) ? res.rooms : [];
  } catch {
    state.recs = [];
  }
  renderRecs();
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
  return Promise.all([loadPublic(), loadRecent(), loadMine(), loadRecommendations()]);
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

async function updateSuggestions() {
  const term = state.q;
  const seq = ++state.suggestSeq;
  const list = $("#searchSuggest");
  if (!list) return;
  const lower = term.toLowerCase();
  const local = term ? readHistory().filter((item) => item.toLowerCase().includes(lower)) : readHistory();
  const options = local.map((name) => el("option", { value: name }));
  if (term.length >= 2) {
    try {
      const res = await apiFetch(`/rooms/suggest?q=${encodeURIComponent(term)}`, { timeoutMs: 8000 });
      if (seq !== state.suggestSeq) return;
      for (const item of res?.suggestions || []) {
        if (!item.name || options.some((node) => node.value === item.name)) continue;
        options.push(el("option", {
          value: item.name,
          label: `${item.code} · ${t("rooms.members", { n: fmtNumber(item.memberCount || 0) })}`
        }));
      }
    } catch {}
  }
  if (seq !== state.suggestSeq) return;
  list.replaceChildren(...options.slice(0, 10));
}

function wireStatic() {
  $("#createForm")?.addEventListener("submit", createRoom);
  $("#gateRetry")?.addEventListener("click", () => location.reload());
  $("#refreshBtn")?.addEventListener("click", loadAll);
  $("#searchInput")?.addEventListener("input", (event) => {
    state.q = event.target.value.trim();
    clearTimeout(state.searchTimer);
    clearTimeout(state.suggestTimer);
    state.searchTimer = setTimeout(() => loadPublic(), 300);
    state.suggestTimer = setTimeout(updateSuggestions, 200);
  });
  $("#searchInput")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    clearTimeout(state.searchTimer);
    rememberQuery(state.q);
    loadPublic();
  });
  $("#sortSelect")?.addEventListener("change", (event) => {
    state.sort = event.target.value;
    loadPublic();
  });
  $("#filterChips")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-filter]");
    if (!btn) return;
    const key = btn.dataset.filter;
    if (state.filters.has(key)) state.filters.delete(key);
    else state.filters.add(key);
    btn.setAttribute("aria-pressed", String(state.filters.has(key)));
    loadPublic();
  });
  $("#moreBtn")?.addEventListener("click", () => {
    if (state.loading || !state.hasMore) return;
    state.page += 1;
    loadPublic({ reset: false });
  });
  $("#clearHistory")?.addEventListener("click", () => {
    writeHistory([]);
    renderHistory();
    toast(t("rooms.historyCleared"), "success");
  });
  $("#codeForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = $("#codeInput").value.trim().toUpperCase();
    if (!code) return;
    rememberQuery(code);
    joinFlow(code);
  });
  document.addEventListener("langchange", () => {
    document.title = `${t("rooms.title")} — هم‌تماشا`;
    renderAll();
    renderRecs();
    renderHistory();
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
  renderHistory();
  await loadAll();
  await handleDeepLink();
})();
