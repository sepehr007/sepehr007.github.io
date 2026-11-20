import { initI18n, t, getLang, fmtNumber } from "./i18n.js";
import {
  $, $$, el, toast, initials, applyUIPrefs, registerServiceWorker,
  confirmDialog, copyText
} from "./core.js";
import { apiFetch, apiGetToken, apiConnectSocket } from "./api.js";
import { avatarSrc } from "./avatars.js";
import { loadSiteConfig, applySiteConfig, listenLiveConfig } from "./site-config.js";
import { notifPermission, requestNotifPermission } from "./notifications.js";

const STAFF_ROLES = ["moderator", "administrator", "owner", "super_owner"];
const PANES = ["people", "messages", "search", "notifications", "history", "library", "invites", "support", "polls", "reports"];
const REPORT_STATUSES = ["open", "reviewing", "resolved", "dismissed"];
const REPORT_REASONS = ["harassment", "spam", "impersonation", "content", "other"];
const REACTIONS = ["👍", "❤️", "😂", "😮", "🙏"];

const state = {
  me: null,
  staff: false,
  pane: "people",
  people: [],
  friends: [],
  requests: { incoming: [], outgoing: [] },
  blocks: [],
  convs: [],
  convsLoading: false,
  dmTab: "all",
  dmQuery: "",
  activeConv: null,
  messages: [],
  threadToken: 0,
  threadLoading: false,
  threadPaging: false,
  threadHasMore: false,
  threadOldestSeq: 0,
  newDividerSeq: 0,
  newCount: 0,
  scrollBottom: true,
  replyTo: null,
  readTimer: 0,
  readSentSeq: 0,
  notifs: [],
  notifPrefs: {},
  notifUnread: 0,
  notifBefore: "",
  help: null,
  helpLoaded: false,
  agents: [],
  history: [],
  library: [],
  invites: [],
  lastInviteCode: "",
  tickets: [],
  activeTicket: null,
  polls: [],
  pollsLoaded: false,
  pollsRoom: "",
  pollSelection: new Map(),
  myReports: [],
  staffReports: [],
  searchData: null,
  searchPage: 1,
  searchSeq: 0,
  searchHasMore: false,
  searchLoading: false,
  ws: null,
  wsReady: false,
  wsClosedByUs: false,
  wsRetry: 0,
  wsDropped: false,
  friendsTimer: 0
};

applyUIPrefs();
initI18n();
registerServiceWorker();

/* ------------------------------------------------------------------ helpers */

function enc(value) {
  return encodeURIComponent(String(value ?? ""));
}

async function api(path, options = {}) {
  const { quiet = false, ...rest } = options;
  try {
    return await apiFetch(path, { timeoutMs: 12000, ...rest });
  } catch (err) {
    if (err?.code === "network_error" || err?.code === "timeout" || err?.code === "not_configured") {
      if (!quiet) toast(t("social.gateServer"), "error");
      throw err;
    }
    if (!quiet) toast(errorText(err), "error");
    throw err;
  }
}

function errorText(err) {
  const code = String(err?.code || "");
  const key = `social.err.${code}`;
  const text = t(key);
  if (text !== key) return text;
  if (err?.status === 401) return t("social.err.auth");
  if (err?.status === 403) return t("social.err.forbidden");
  if (err?.status === 429) return t("social.err.rate_limited");
  return t("social.failed");
}

function btn(label, kind = "secondary", onClick = null) {
  return el("button", {
    type: "button",
    class: `btn btn-${kind}`,
    text: label,
    onClick
  });
}

function smallBtn(label, kind = "ghost", onClick = null) {
  return el("button", {
    type: "button",
    class: `btn btn-${kind} btn-sm`,
    text: label,
    onClick
  });
}

function field(labelText, input) {
  return el("label", { class: "field" }, [el("span", { text: labelText }), input]);
}

function emptyState(nodeId, filled) {
  const node = document.getElementById(nodeId);
  if (node) node.hidden = filled;
}

function ago(ts) {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - Number(ts));
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("social.justNow");
  if (minutes < 60) return t("social.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("social.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("social.daysAgo", { n: days });
  return fmtDate(ts);
}

function fmtDate(ts) {
  try {
    return new Date(Number(ts)).toLocaleDateString(getLang() === "fa" ? "fa-IR" : "en-US", {
      year: "numeric", month: "short", day: "numeric"
    });
  } catch {
    return "";
  }
}

function fmtTime(ts) {
  try {
    return new Date(Number(ts)).toLocaleTimeString(getLang() === "fa" ? "fa-IR" : "en-US", {
      hour: "2-digit", minute: "2-digit"
    });
  } catch {
    return "";
  }
}

function displayName(user) {
  return (user?.nick || user?.username || "—").toString();
}

function avatarEl(user, cls = "person-avatar") {
  const box = el("span", { class: cls });
  const raw = String(user?.avatar || "");
  const src = /^https?:/i.test(raw) ? raw : avatarSrc(raw);
  if (src) box.append(el("img", { src, alt: "", loading: "lazy", decoding: "async" }));
  else box.textContent = initials(user?.nick || user?.username || "?");
  return box;
}

function isOnline(user) {
  const seen = Number(user?.lastSeenAt || 0);
  return Boolean(seen) && Date.now() - seen < 5 * 60000;
}

function paintCount(id, count) {
  const node = document.getElementById(id);
  if (!node) return;
  const value = Number(count) || 0;
  node.textContent = value > 0 ? String(value) : "";
  node.classList.toggle("hot", value > 0);
}

function isBlocked(user) {
  return Boolean(user?.blocked) || state.blocks.some((item) => String(item.id) === String(user?.id));
}

function isFriend(user) {
  return Boolean(user?.isFriend) || state.friends.some((item) => String(item.id) === String(user?.id));
}

function closeModal() {
  $("#socialModal").classList.add("hidden");
}

function openModal(title, build) {
  $("#socialModalTitle").textContent = title;
  const body = $("#socialModalBody");
  body.replaceChildren();
  const actions = el("div", { class: "modal-actions" });
  build(body, actions);
  if (!actions.childElementCount) {
    actions.append(smallBtn(t("social.close"), "ghost", closeModal));
  }
  body.append(actions);
  $("#socialModal").classList.remove("hidden");
}

/* -------------------------------------------------------------------- boot */

document.title = `${t("social.title")} — هم‌تماشا`;

(async () => {
  try {
    const cfg = await loadSiteConfig();
    applySiteConfig(cfg);
    listenLiveConfig((next) => applySiteConfig(next));
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
    if (err?.code === "network_error" || err?.code === "timeout" || err?.code === "not_configured") {
      showGate("server");
    } else {
      showGate("login");
    }
    return;
  }
  if (!state.me) {
    showGate("login");
    return;
  }
  state.staff = STAFF_ROLES.includes(String(state.me.role || ""));
  $("#socialGate").hidden = true;
  $("#socialLayout").hidden = false;
  renderSearchHistory();
  const requested = location.hash.replace(/^#/, "");
  switchPane(PANES.includes(requested) ? requested : "people");
  refreshBadges();
  connectWs();
  syncMessagingViewport();
})();

function showGate(kind) {
  $("#socialGate").hidden = false;
  $("#socialLayout").hidden = true;
  $("#wsState").hidden = true;
  const text = document.getElementById("gateText");
  if (text) {
    text.dataset.i18n = kind === "server" ? "social.gateServer" : "social.gateText";
    text.textContent = t(text.dataset.i18n);
  }
}

function wireStatic() {
  $$("#socialNav button").forEach((node) => {
    node.addEventListener("click", () => switchPane(node.dataset.pane, true));
  });
  $("#gateRetry")?.addEventListener("click", () => location.reload());
  $("#socialModal")?.addEventListener("click", (event) => {
    if (event.target === $("#socialModal")) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });
  window.addEventListener("hashchange", () => {
    const next = location.hash.replace(/^#/, "");
    if (PANES.includes(next) && next !== state.pane) switchPane(next);
  });
  window.addEventListener("wt:api-unauthorized", () => {
    disconnectWs();
    showGate("login");
  });
  document.addEventListener("langchange", () => {
    document.title = `${t("social.title")} — هم‌تماشا`;
    rerenderAll();
  });
  window.addEventListener("pagehide", () => {
    state.wsClosedByUs = true;
    disconnectWs();
  });
}

/* --------------------------------------------------------------- navigation */

function switchPane(pane, push = false) {
  if (!PANES.includes(pane)) pane = "people";
  state.pane = pane;
  document.body.classList.toggle("social-msg", pane === "messages");
  $$("#socialNav button").forEach((node) => node.classList.toggle("active", node.dataset.pane === pane));
  $$(".social-pane").forEach((node) => { node.hidden = node.dataset.pane !== pane; });
  document.title = `${t(`social.nav.${pane}`)} — هم‌تماشا`;
  if (push) {
    try { history.replaceState(null, "", `#${pane}`); } catch {}
  }
  loadPane(pane);
  if (pane === "messages") requestAnimationFrame(syncMessagingViewport);
}

async function loadPane(pane) {
  try {
    if (pane === "people") await loadPeoplePane();
    else if (pane === "messages") await loadConversations();
    else if (pane === "notifications") {
      await loadNotifications();
      await loadNotifPrefs();
    } else if (pane === "history") await loadHistory();
    else if (pane === "library") await loadLibrary();
    else if (pane === "invites") await loadInvites();
    else if (pane === "support") {
      await loadTickets();
      await loadHelp();
      if (state.staff) await loadAgents();
      renderHelp();
    }
    else if (pane === "polls") {
      if (state.pollsRoom) await loadPolls(true);
      else renderPolls();
    } else if (pane === "reports") await loadReports();
  } catch {}
}

function rerenderAll() {
  paintWs();
  renderPeople();
  renderFriends();
  renderRequests();
  renderBlocks();
  renderConvs();
  if (state.activeConv) {
    paintConvHead();
    renderMessages(true);
  }
  renderNotifs();
  renderHistory();
  renderLibrary();
  renderInvites();
  renderTickets();
  renderPolls();
  renderReports();
  renderSearch();
}

/* ------------------------------------------------------------------- people */

let peopleTimer = 0;

$("#peopleSearch")?.addEventListener("input", () => {
  clearTimeout(peopleTimer);
  peopleTimer = setTimeout(() => loadPeople(true), 320);
});
$("#peopleRefresh")?.addEventListener("click", () => loadPeoplePane());

async function loadPeoplePane() {
  await Promise.allSettled([loadRequests(), loadFriends(), loadPeople(), loadBlocks()]);
}

async function loadPeople(quiet = false) {
  const q = $("#peopleSearch")?.value.trim() || "";
  const data = await api(`/social/people${q ? `?q=${enc(q)}` : ""}`, { quiet });
  state.people = data.people || [];
  renderPeople();
}

async function loadFriends() {
  const data = await api("/social/friends", { quiet: true });
  state.friends = data.friends || [];
  renderFriends();
}

async function loadRequests() {
  const data = await api("/social/requests", { quiet: true });
  state.requests = { incoming: data.incoming || [], outgoing: data.outgoing || [] };
  renderRequests();
  paintCount("countRequests", state.requests.incoming.length);
}

async function loadBlocks() {
  const data = await api("/social/blocks", { quiet: true });
  state.blocks = data.blocks || [];
  renderBlocks();
}

function renderPeople() {
  const list = $("#peopleList");
  if (!list) return;
  list.replaceChildren(...state.people.map((user) => personRow(user, { directory: true })));
  emptyState("peopleEmpty", state.people.length > 0);
  const count = $("#peopleCount");
  if (count) count.textContent = state.people.length ? t("social.roomMembers", { n: state.people.length }) : "";
}

function renderFriends() {
  const list = $("#friendList");
  if (!list) return;
  list.replaceChildren(...state.friends.map((user) => personRow(user, { friend: true })));
  emptyState("friendsEmpty", state.friends.length > 0);
}

function renderRequests() {
  const list = $("#requestList");
  if (!list) return;
  const rows = [];
  for (const request of state.requests.incoming) {
    rows.push(requestRow(request, true));
  }
  for (const request of state.requests.outgoing) {
    rows.push(requestRow(request, false));
  }
  list.replaceChildren(...rows);
  emptyState("requestsEmpty", rows.length > 0);
}

function renderBlocks() {
  const list = $("#blockList");
  if (!list) return;
  list.replaceChildren(...state.blocks.map((user) => personRow(user, { blocked: true })));
  emptyState("blocksEmpty", state.blocks.length > 0);
}

function personRow(user, options = {}) {
  const li = el("li", { class: "person-row" });
  li.append(avatarEl(user));
  const main = el("div", { class: "person-main" });
  const title = el("strong");
  title.append(el("span", { class: `online-dot${isOnline(user) ? " on" : ""}` }));
  title.append(document.createTextNode(displayName(user)));
  main.append(title);
  const sub = el("small");
  sub.textContent = `@${user.username || ""}`;
  main.append(sub);
  li.append(main);

  const actions = el("div", { class: "person-actions" });
  const self = String(user.id) === String(state.me?.id);

  if (self) {
    actions.append(el("span", { class: "person-state", text: t("social.you") }));
  } else if (options.blocked || isBlocked(user)) {
    actions.append(smallBtn(t("social.unblock"), "secondary", () => unblockUser(user)));
  } else if (options.friend || isFriend(user)) {
    actions.append(smallBtn(t("social.message"), "primary", () => openDmWith(user)));
    actions.append(smallBtn(t("social.removeFriend"), "ghost", () => removeFriend(user)));
    actions.append(smallBtn("⋯", "ghost", () => openUserMenu(user)));
  } else if (user.requestIncoming) {
    actions.append(el("span", { class: "person-state", text: t("social.statePendingIn") }));
    actions.append(smallBtn(t("social.message"), "ghost", () => openDmWith(user)));
  } else if (user.requestPending) {
    actions.append(el("span", { class: "person-state", text: t("social.statePendingOut") }));
    actions.append(smallBtn(t("social.message"), "ghost", () => openDmWith(user)));
  } else {
    actions.append(smallBtn(t("social.addFriend"), "primary", () => addFriend(user)));
    actions.append(smallBtn(t("social.message"), "ghost", () => openDmWith(user)));
    actions.append(smallBtn("⋯", "ghost", () => openUserMenu(user)));
  }
  li.append(actions);
  return li;
}

function requestRow(request, incoming) {
  const peer = incoming ? request.from : request.to;
  const li = el("li", { class: "request-row" });
  li.append(avatarEl(peer));
  const main = el("div", { class: "person-main" });
  const title = el("strong");
  title.append(el("span", { class: "online-dot" + (isOnline(peer) ? " on" : "") }));
  title.append(document.createTextNode(displayName(peer)));
  main.append(title);
  const line = el("small");
  line.textContent = `@${peer?.username || ""}`;
  main.append(line);
  if (request.message) main.append(el("small", { text: request.message, dir: "auto" }));
  main.append(el("small", { text: ago(request.createdAt) }));
  li.append(main);

  const actions = el("div", { class: "person-actions" });
  if (incoming) {
    actions.append(smallBtn(t("social.accept"), "primary", () => respondRequest(request, true)));
    actions.append(smallBtn(t("social.decline"), "ghost", () => respondRequest(request, false)));
  } else {
    actions.append(el("span", { class: "person-state", text: t("social.statePendingOut") }));
    actions.append(smallBtn(t("social.cancel"), "ghost", () => cancelRequest(request)));
  }
  li.append(actions);
  return li;
}

async function addFriend(user) {
  try {
    await api("/social/friends/request", { method: "POST", body: { username: user.username } });
    toast(t("social.requestSent"), "success");
    await loadPeoplePane();
    refreshBadges();
  } catch {}
}

async function respondRequest(request, accept) {
  try {
    await api("/social/friends/respond", {
      method: "POST",
      body: { requestId: request.id, accept }
    });
    toast(accept ? t("social.requestAccepted") : t("social.requestDeclined"), "success");
    await loadPeoplePane();
    refreshBadges();
  } catch {}
}

async function cancelRequest(request) {
  try {
    await api(`/social/friends/request/${enc(request.id)}`, { method: "DELETE" });
    await loadPeoplePane();
    refreshBadges();
  } catch {}
}

async function removeFriend(user) {
  const ok = await confirmDialog({ title: t("social.removeFriend"), text: t("social.confirmRemoveFriend"), okLabel: t("social.delete") });
  if (!ok) return;
  try {
    await api(`/social/friends/${enc(user.username)}`, { method: "DELETE" });
    toast(t("social.friendRemoved"), "success");
    await loadPeoplePane();
  } catch {}
}

async function blockUser(user) {
  const ok = await confirmDialog({ title: t("social.block"), text: t("social.confirmBlock"), okLabel: t("social.block") });
  if (!ok) return;
  try {
    await api("/social/blocks", { method: "POST", body: { username: user.username } });
    toast(t("social.userBlocked"), "success");
    await loadPeoplePane();
  } catch {}
}

async function unblockUser(user) {
  try {
    await api(`/social/blocks/${enc(user.username)}`, { method: "DELETE" });
    toast(t("social.userUnblocked"), "success");
    await loadPeoplePane();
  } catch {}
}

function openUserMenu(user) {
  openModal(displayName(user), (body) => {
    const list = el("div", { class: "menu-list" });
    const item = (label, fn, danger = false) => el("button", {
      type: "button",
      class: `menu-item${danger ? " danger" : ""}`,
      text: label,
      onClick: () => { closeModal(); fn(); }
    });
    list.append(item(t("social.message"), () => openDmWith(user)));
    list.append(item(`${t("social.copy")} @${user.username}`, async () => {
      await copyText(user.username);
      toast(t("social.copied"), "success");
    }));
    if (isBlocked(user)) list.append(item(t("social.unblock"), () => unblockUser(user)));
    else list.append(item(t("social.block"), () => blockUser(user), true));
    list.append(item(t("social.report"), () => openReport({ type: "user", id: user.username, label: displayName(user) }), true));
    body.append(list);
  });
}

/* ----------------------------------------------------------------- reports */

function openReport(target) {
  openModal(t("social.reportUserTitle", { name: target.label || target.id }), (body, actions) => {
    const reason = el("select", {}, REPORT_REASONS.map((key) =>
      el("option", { value: key, text: t(`social.reason.${key}`) })
    ));
    const details = el("textarea", { rows: "4", maxlength: "4000", placeholder: t("social.reportDetails") });
    const evidence = el("input", { type: "url", dir: "ltr", maxlength: "4000", placeholder: t("social.reportEvidence") });
    const msg = el("p", { class: "form-msg", role: "alert" });
    body.append(field(t("social.reportTarget"), reason), field(t("social.reportDetails"), details), field(t("social.reportEvidence"), evidence), msg);
    actions.append(smallBtn(t("social.cancel"), "ghost", closeModal));
    actions.append(btn(t("social.reportSubmit"), "primary", async () => {
      if (!details.value.trim()) { msg.textContent = t("social.reportDetailsEmpty"); return; }
      try {
        await api("/social/reports", {
          method: "POST",
          body: {
            targetType: target.type,
            targetId: target.id,
            category: reason.value,
            details: details.value.trim(),
            evidence: evidence.value.trim()
          }
        });
        closeModal();
        toast(t("social.reportSent"), "success");
        if (state.pane === "reports") loadReports();
      } catch {}
    }));
  });
}

/* ---------------------------------------------------------------------- DM */

$("#dmSearch")?.addEventListener("input", () => {
  state.dmQuery = $("#dmSearch")?.value || "";
  renderConvs();
});
$("#dmShowArchived")?.addEventListener("change", renderConvs);
$$("[data-dm-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.dmTab = btn.dataset.dmTab || "all";
    paintDmTabs();
    renderConvs();
  });
});
$("#dmBack")?.addEventListener("click", closeThread);
$("#dmNewBtn")?.addEventListener("click", () => switchPane("people", true));
$("#dmEmptyNew")?.addEventListener("click", () => switchPane("people", true));
$("#dmAcceptBtn")?.addEventListener("click", () => respondConv(true));
$("#dmRejectBtn")?.addEventListener("click", () => respondConv(false));
$("#dmScrollBtn")?.addEventListener("click", jumpToLatest);
$("#dmReplyCancel")?.addEventListener("click", clearReply);
$("#dmInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendDm();
  }
});
$("#dmInput")?.addEventListener("input", (event) => {
  const area = event.target;
  area.style.height = "auto";
  area.style.height = `${Math.min(132, area.scrollHeight)}px`;
});
$("#dmInput")?.addEventListener("focus", () => {
  setTimeout(() => {
    $("#dmInput")?.scrollIntoView({ block: "nearest" });
    if (state.scrollBottom) jumpToLatest(true);
  }, 240);
});
$("#dmForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  sendDm();
});
$("#dmMuteBtn")?.addEventListener("click", () => toggleConvPref("muted"));
$("#dmArchiveBtn")?.addEventListener("click", () => toggleConvPref("archived"));
$("#dmStream")?.addEventListener("scroll", onThreadScroll);
window.visualViewport?.addEventListener("resize", syncMessagingViewport);
window.visualViewport?.addEventListener("scroll", syncMessagingViewport);
window.addEventListener("resize", syncMessagingViewport);

function syncMessagingViewport() {
  const app = $("#dmLayout");
  const vv = window.visualViewport;
  if (!app || !vv) return;
  if (!app.offsetParent || !app.getBoundingClientRect().width) return;
  const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  const top = Math.max(0, Math.round(app.getBoundingClientRect().top - vv.offsetTop));
  const docTop = Math.round(app.getBoundingClientRect().top + window.scrollY);
  app.style.setProperty("--msg-vvh", `${Math.round(vv.height)}px`);
  app.style.setProperty("--msg-top", `${top}px`);
  app.style.setProperty("--msg-avail", `${Math.max(320, Math.round(window.innerHeight - docTop - 16))}px`);
  app.classList.toggle("kb-open", keyboard > 90);
  if (keyboard > 90 && state.scrollBottom) {
    requestAnimationFrame(() => {
      const stream = $("#dmStream");
      if (stream) stream.scrollTop = stream.scrollHeight;
    });
  }
}

function paintDmTabs() {
  $$("[data-dm-tab]").forEach((btn) => btn.classList.toggle("active", btn.dataset.dmTab === state.dmTab));
}

function convById(id) {
  return state.convs.find((conv) => String(conv.id) === String(id)) || null;
}

function upsertConv(conv) {
  if (!conv?.id) return null;
  const index = state.convs.findIndex((item) => String(item.id) === String(conv.id));
  if (index >= 0) state.convs[index] = { ...state.convs[index], ...conv };
  else state.convs.unshift(conv);
  return convById(conv.id);
}

function updateRequestCount() {
  const count = state.convs.filter((conv) => conv.pendingIncoming).length;
  const chip = $("#dmRequestCount");
  if (chip) {
    chip.textContent = count > 0 ? String(count) : "";
    chip.hidden = count <= 0;
  }
  const unread = state.convs.filter((conv) => !conv.archived).reduce((sum, conv) => sum + (conv.unread || 0), 0);
  paintCount("countMessages", unread);
}

async function loadConversations(quiet = true) {
  if (!state.convs.length) {
    state.convsLoading = true;
    renderConvs();
  }
  try {
    const data = await api("/social/dm", { quiet });
    const list = Array.isArray(data.conversations) ? data.conversations : [];
    state.convs = list;
    state.convsLoading = false;
    const active = state.activeConv ? convById(state.activeConv.id) : null;
    if (active) {
      state.activeConv = active;
      paintConvHead();
      paintRequestBar();
    }
    renderConvs();
    updateRequestCount();
  } catch {
    state.convsLoading = false;
    renderConvs();
  }
}

async function openDmWith(user) {
  try {
    const data = await api("/social/dm", { method: "POST", body: { username: user.username } });
    const conv = upsertConv(data.conversation) || data.conversation;
    switchPane("messages");
    if (state.pane === "messages") await selectConv(conv);
  } catch (err) {
    if (err?.code === "private_profile") toast(errorText(err), "error");
  }
}

async function selectConv(conv) {
  if (!conv?.id) return;
  const token = ++state.threadToken;
  state.activeConv = convById(conv.id) || conv;
  state.messages = [];
  state.threadHasMore = false;
  state.threadOldestSeq = 0;
  state.newDividerSeq = 0;
  state.newCount = 0;
  state.threadLoading = true;
  state.scrollBottom = true;
  clearReply();
  $("#dmLayout")?.classList.add("has-thread");
  const head = $("#dmHead");
  if (head) head.hidden = false;
  const empty = $("#dmEmpty");
  if (empty) empty.hidden = true;
  paintConvHead();
  paintRequestBar();
  renderConvs();
  renderMessages();
  updateJump();
  try {
    const data = await api(`/social/dm/${enc(conv.id)}/messages?limit=50`, { quiet: true });
    if (token !== state.threadToken || String(state.activeConv?.id) !== String(conv.id)) return;
    if (data.conversation) {
      upsertConv(data.conversation);
      state.activeConv = convById(conv.id) || state.activeConv;
      paintConvHead();
      paintRequestBar();
    }
    state.threadHasMore = Boolean(data.hasMore);
    state.threadOldestSeq = Number(data.oldestSeq || 0);
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    state.threadLoading = false;
    renderMessages();
    jumpToLatest(true);
    markReadSoon();
  } catch (err) {
    if (token !== state.threadToken) return;
    state.threadLoading = false;
    renderMessages();
    toast(errorText(err), "error");
  }
}

function closeThread() {
  state.threadToken += 1;
  state.activeConv = null;
  state.messages = [];
  state.replyTo = null;
  state.threadLoading = false;
  $("#dmLayout")?.classList.remove("has-thread");
  const head = $("#dmHead");
  if (head) head.hidden = true;
  const form = $("#dmForm");
  if (form) form.hidden = true;
  const bar = $("#dmRequestBar");
  if (bar) bar.hidden = true;
  const stream = $("#dmStream");
  if (stream) stream.replaceChildren();
  const empty = $("#dmEmpty");
  if (empty) empty.hidden = false;
  renderConvs();
}

function paintConvHead() {
  const conv = state.activeConv;
  if (!conv) return;
  const box = $("#dmPeerAvatar");
  if (box) {
    const next = avatarEl(conv.peer, "person-avatar");
    next.id = "dmPeerAvatar";
    box.replaceWith(next);
  }
  const dot = $("#dmPeerDot");
  const online = isOnline(conv.peer);
  if (dot) dot.classList.toggle("on", online);
  const name = $("#dmPeerName");
  if (name) name.textContent = displayName(conv.peer);
  const status = $("#dmPeerStatus");
  if (status) {
    status.textContent = online
      ? t("social.online")
      : conv.peer?.lastSeenAt
        ? t("social.seenAgo", { when: ago(conv.peer.lastSeenAt) })
        : t("social.offline");
  }
  const user = $("#dmPeerUser");
  if (user) user.textContent = `@${conv.peer?.username || ""}`;
  const mute = $("#dmMuteBtn");
  if (mute) mute.textContent = conv.muted ? t("social.dmUnmute") : t("social.dmMute");
  const archive = $("#dmArchiveBtn");
  if (archive) archive.textContent = conv.archived ? t("social.dmUnarchive") : t("social.dmArchive");
}

function paintRequestBar() {
  const conv = state.activeConv;
  const bar = $("#dmRequestBar");
  const text = $("#dmRequestText");
  const actions = $("#dmRequestActions");
  const form = $("#dmForm");
  if (!conv || !bar || !text || !actions || !form) return;
  const pending = conv.status === "pending";
  const rejected = conv.status === "rejected";
  actions.hidden = !conv.pendingIncoming;
  if (conv.pendingIncoming) {
    text.textContent = t("social.dmRequestIncoming", { name: displayName(conv.peer) });
    bar.hidden = false;
  } else if (pending) {
    text.textContent = t("social.dmRequestWaiting");
    bar.hidden = false;
  } else if (rejected) {
    text.textContent = t("social.dmRequestRejected");
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }
  const canReply = Boolean(conv.canReply);
  form.hidden = !canReply;
  const hint = $("#dmComposeHint");
  if (hint) hint.textContent = canReply ? t("social.dmSendHint") : t("social.dmLocked");
  const input = $("#dmInput");
  if (input) input.placeholder = canReply ? t("social.dmPlaceholder") : t("social.dmLocked");
}

async function respondConv(accept) {
  const conv = state.activeConv;
  if (!conv?.pendingIncoming) return;
  const buttons = [$("#dmAcceptBtn"), $("#dmRejectBtn")];
  for (const button of buttons) if (button) button.disabled = true;
  try {
    const data = await api(`/social/dm/${enc(conv.id)}/respond`, {
      method: "POST",
      body: { accept }
    });
    upsertConv(data.conversation);
    state.activeConv = convById(conv.id) || state.activeConv;
    toast(accept ? t("social.dmRequestAcceptedToast") : t("social.dmRequestRejectedToast"), accept ? "success" : "info");
    paintConvHead();
    paintRequestBar();
    renderConvs();
    updateRequestCount();
    if (accept) {
      await Promise.allSettled([loadFriends(), loadPeople(true)]);
      $("#dmInput")?.focus();
      if (state.messages.length) markReadSoon();
    }
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    for (const button of buttons) if (button) button.disabled = false;
  }
}

function renderConvs() {
  const list = $("#convList");
  if (!list) return;
  const loading = $("#convLoading");
  if (loading) loading.hidden = !state.convsLoading;
  const query = String(state.dmQuery || "").trim().toLowerCase();
  const showArchived = Boolean($("#dmShowArchived")?.checked);
  let items = state.convs.filter((conv) => showArchived || !conv.archived);
  if (state.dmTab === "unread") items = items.filter((conv) => (conv.unread || 0) > 0 || conv.pendingIncoming);
  else if (state.dmTab === "requests") items = items.filter((conv) => conv.pendingIncoming);
  if (query) {
    items = items.filter((conv) => {
      const hay = `${conv.peer?.nick || ""} ${conv.peer?.username || ""} ${conv.lastMessage?.body || ""}`.toLowerCase();
      return hay.includes(query);
    });
  }
  list.replaceChildren(...items.map((conv) => convRow(conv)));
  const empty = $("#convEmpty");
  if (empty) empty.hidden = items.length > 0 || state.convsLoading;
  updateRequestCount();
}

function convRow(conv) {
  const li = el("li");
  const row = el("div", {
    class: [
      "conv-row msg-conv",
      state.activeConv?.id === conv.id ? "active" : "",
      conv.unread ? "unread" : "",
      conv.pendingIncoming ? "pending" : ""
    ].filter(Boolean).join(" "),
    role: "button",
    tabindex: "0",
    onClick: () => selectConv(conv)
  });
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectConv(conv);
    }
  });

  const avatarWrap = el("span", { class: "avatar-wrap" });
  avatarWrap.append(avatarEl(conv.peer));
  avatarWrap.append(el("span", { class: `presence-dot${isOnline(conv.peer) ? " on" : ""}`, "aria-hidden": "true" }));
  row.append(avatarWrap);

  const main = el("div", { class: "conv-main" });
  const title = el("strong");
  title.append(document.createTextNode(displayName(conv.peer)));
  if (conv.pendingIncoming) title.append(el("span", { class: "msg-badge", text: t("social.dmRequestBadge") }));
  if (conv.muted) title.append(el("span", { class: "msg-badge muted", text: t("social.dmMutedBadge") }));
  if (conv.archived) title.append(el("span", { class: "msg-badge muted", text: t("social.dmArchivedBadge") }));
  main.append(title);

  const preview = el("small", { class: "conv-preview" });
  const last = conv.lastMessage;
  if (conv.pendingIncoming) {
    preview.textContent = t("social.dmRequestFrom", { name: displayName(conv.peer) });
  } else {
    const mineLast = last && String(last.senderId) === String(state.me?.id);
    const text = last
      ? last.deleted
        ? t("social.dmDeleted")
        : String(last.body || "").trim() || t("social.dmAttachment")
      : "";
    if (mineLast && text) preview.append(el("span", { class: "conv-you", text: `${t("social.you")}:` }));
    preview.append(el("span", { class: "conv-preview-text", text }));
  }
  main.append(preview);

  if (conv.pendingIncoming) {
    const actions = el("div", { class: "conv-request-actions" });
    for (const [label, accept] of [[t("social.dmAccept"), true], [t("social.dmReject"), false]]) {
      actions.append(el("button", {
        type: "button",
        class: `btn ${accept ? "btn-primary" : "btn-ghost"} btn-sm`,
        text: label,
        onClick: (event) => {
          event.stopPropagation();
          respondConvFromRow(conv, accept);
        }
      }));
    }
    main.append(actions);
  }
  row.append(main);

  const side = el("div", { class: "conv-side" });
  side.append(el("span", {
    class: "conv-time",
    text: last ? shortStamp(last.createdAt) : shortStamp(conv.updatedAt)
  }));
  if ((conv.unread || 0) > 0) side.append(el("span", { class: "conv-unread", text: String(conv.unread) }));
  row.append(side);
  li.append(row);
  return li;
}

function shortStamp(ts) {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - Number(ts));
  if (diff < 24 * 3600 * 1000) return fmtTime(ts);
  if (diff < 7 * 24 * 3600 * 1000) {
    try {
      return new Date(Number(ts)).toLocaleDateString(getLang() === "fa" ? "fa-IR" : "en-US", { weekday: "short" });
    } catch {
      return "";
    }
  }
  return fmtDate(ts);
}

async function respondConvFromRow(conv, accept) {
  try {
    const data = await api(`/social/dm/${enc(conv.id)}/respond`, {
      method: "POST",
      body: { accept }
    });
    upsertConv(data.conversation);
    if (state.activeConv?.id === conv.id) {
      state.activeConv = convById(conv.id);
      paintConvHead();
      paintRequestBar();
    }
    toast(accept ? t("social.dmRequestAcceptedToast") : t("social.dmRequestRejectedToast"), accept ? "success" : "info");
    renderConvs();
    updateRequestCount();
    if (accept) {
      await Promise.allSettled([loadFriends(), loadPeople(true)]);
      if (state.activeConv?.id === conv.id && state.scrollBottom) markReadSoon();
    }
  } catch (err) {
    toast(errorText(err), "error");
  }
}

function renderMessages(keepScroll = false) {
  const stream = $("#dmStream");
  if (!stream) return;
  const top = stream.scrollTop;
  const frag = document.createDocumentFragment();
  if (state.threadLoading) frag.append(skeletons());
  else if (!state.messages.length) {
    frag.append(el("div", { class: "msg-thread-hint", text: t("social.dmNoMessages") }));
  } else {
    let lastDay = "";
    let dividerDone = false;
    for (const message of state.messages) {
      const day = dayKey(message.createdAt);
      if (day !== lastDay) {
        lastDay = day;
        frag.append(el("div", { class: "msg-day" }, [el("span", { text: dayLabel(message.createdAt) })]));
      }
      if (!dividerDone && state.newDividerSeq && Number(message.seq || 0) >= state.newDividerSeq) {
        dividerDone = true;
        frag.append(el("div", { class: "msg-divider", text: t("social.dmNewMessages") }));
      }
      frag.append(messageNode(message));
    }
    if (!dividerDone && state.newDividerSeq) {
      frag.append(el("div", { class: "msg-divider", text: t("social.dmNewMessages") }));
    }
  }
  stream.replaceChildren(frag);
  if (keepScroll) stream.scrollTop = top;
  else stream.scrollTop = stream.scrollHeight;
  state.scrollBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 90;
  updateJump();
}

function skeletons() {
  const box = el("div", { class: "msg-skeleton", "aria-hidden": "true" });
  for (const [side, width] of [["theirs", "62%"], ["mine", "48%"], ["theirs", "70%"], ["mine", "40%"]]) {
    const line = el("div", { class: `msg-skel ${side}` });
    line.style.width = width;
    box.append(line);
  }
  return box;
}

function dayKey(ts) {
  try {
    const d = new Date(Number(ts));
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  } catch {
    return "";
  }
}

function dayLabel(ts) {
  try {
    const d = new Date(Number(ts));
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((start - day) / 86400000);
    if (diff === 0) return t("social.dmToday");
    if (diff === 1) return t("social.dmYesterday");
  } catch {}
  return fmtDate(ts);
}

function messageNode(message) {
  const mine = String(message.senderId) === String(state.me?.id);
  const pending = Boolean(message.pending);
  const failed = Boolean(message.failed);
  const row = el("div", {
    class: `msg-row ${mine ? "mine" : "theirs"}`,
    "data-mid": String(message.id || "")
  });
  if (!mine) row.append(avatarEl(state.activeConv?.peer, "person-avatar msg-avatar"));

  const col = el("div", { class: "msg-col" });
  const bubble = el("article", {
    class: `dm-bubble msg-bubble${mine ? " mine" : ""}${pending ? " is-pending" : ""}${failed ? " is-failed" : ""}`
  });

  if (message.replyTo) bubble.append(quoteNode(message));

  const body = el("div", { class: `dm-body${message.deletedAt ? " dm-deleted" : ""}`, dir: "auto" });
  body.textContent = message.deletedAt ? t("social.dmDeleted") : message.body || "";
  bubble.append(body);

  if (message.attachment?.url) {
    bubble.append(el("a", {
      class: "attach-note",
      href: message.attachment.url,
      target: "_blank",
      rel: "noopener noreferrer",
      dir: "ltr",
      text: message.attachment.name || message.attachment.url
    }));
  }

  if (Array.isArray(message.reactions) && message.reactions.length) {
    const row2 = el("div", { class: "dm-reactions" });
    for (const reaction of message.reactions) {
      row2.append(el("button", {
        type: "button",
        class: `dm-reaction${reaction.mine ? " mine" : ""}`,
        text: `${reaction.emoji} ${reaction.count}`,
        onClick: () => toggleReaction(message, reaction)
      }));
    }
    bubble.append(row2);
  }

  const meta = el("div", { class: "dm-meta" });
  meta.append(el("span", { class: "msg-time", text: fmtTime(message.createdAt) }));
  if (message.editedAt) meta.append(el("span", { text: t("social.dmEdited") }));
  if (mine) {
    if (pending) {
      meta.append(el("span", { class: "msg-state pending", text: "●", title: t("social.dmPending") }));
    } else if (failed) {
      meta.append(el("button", {
        type: "button",
        class: "msg-retry",
        text: t("social.dmRetry"),
        onClick: () => retryMessage(message)
      }));
    } else {
      const read = message.seq !== null && message.seq !== undefined
        && Number(message.seq) <= Number(state.activeConv?.peerLastReadSeq || 0);
      meta.append(el("span", {
        class: `msg-state ${read ? "read" : "sent"}`,
        text: read ? "✓✓" : "✓",
        title: read ? t("social.dmRead") : t("social.dmSent")
      }));
    }
  }

  if (!message.deletedAt && !pending && !failed) {
    const actions = el("span", { class: "msg-actions" });
    if (!String(message.id).startsWith("local:")) {
      actions.append(el("button", {
        type: "button",
        class: "dm-react-toggle",
        text: "↩",
        title: t("social.dmReply"),
        onClick: () => startReply(message)
      }));
    }
    const reactBtn = el("button", {
      type: "button",
      class: "dm-react-toggle",
      text: "☺",
      title: t("social.react")
    });
    actions.append(reactBtn);
    if (mine) {
      actions.append(el("button", {
        type: "button",
        class: "dm-react-toggle",
        text: t("social.edit"),
        onClick: () => startMessageEdit(message, bubble)
      }));
      actions.append(el("button", {
        type: "button",
        class: "dm-react-toggle",
        text: t("social.delete"),
        onClick: () => deleteMessage(message)
      }));
    }
    meta.append(actions);
    const quick = el("div", { class: "dm-quick" });
    for (const emoji of REACTIONS) {
      quick.append(el("button", {
        type: "button",
        text: emoji,
        onClick: () => addReaction(message, emoji)
      }));
    }
    reactBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      quick.classList.toggle("open");
    });
    bubble.append(meta, quick);
  } else {
    bubble.append(meta);
  }

  col.append(bubble);
  row.append(col);
  return row;
}

function quoteNode(message) {
  const reply = message.replyTo;
  const peerName = String(reply.senderId) === String(state.me?.id)
    ? t("social.you")
    : displayName(state.activeConv?.peer);
  const quote = el("button", {
    type: "button",
    class: "msg-quote",
    onClick: () => scrollToMessage(message.replyToId)
  });
  quote.append(el("strong", { text: peerName }));
  quote.append(el("span", {
    text: reply.deleted ? t("social.dmDeleted") : reply.body || t("social.dmAttachment")
  }));
  return quote;
}

function startReply(message) {
  state.replyTo = {
    id: message.id,
    senderId: message.senderId,
    body: message.deletedAt ? "" : message.body || "",
    deleted: Boolean(message.deletedAt)
  };
  const preview = $("#dmReplyPreview");
  const text = $("#dmReplyText");
  const peerName = String(message.senderId) === String(state.me?.id) ? t("social.you") : displayName(state.activeConv?.peer);
  if (text) text.textContent = `${peerName}: ${state.replyTo.deleted ? t("social.dmDeleted") : state.replyTo.body}`;
  if (preview) preview.hidden = false;
  $("#dmInput")?.focus();
}

function clearReply() {
  state.replyTo = null;
  const preview = $("#dmReplyPreview");
  if (preview) preview.hidden = true;
  const text = $("#dmReplyText");
  if (text) text.textContent = "";
}

function scrollToMessage(id, attempt = 0) {
  const stream = $("#dmStream");
  if (!stream || !id) return;
  const target = [...stream.querySelectorAll(".msg-row")].find((node) => node.dataset.mid === String(id));
  if (target) {
    target.scrollIntoView({ block: "center" });
    target.classList.add("msg-hit");
    setTimeout(() => target.classList.remove("msg-hit"), 1200);
    return;
  }
  if (state.threadHasMore && attempt < 3) {
    loadOlder().finally(() => setTimeout(() => scrollToMessage(id, attempt + 1), 120));
  }
}

function updateJump() {
  const button = $("#dmScrollBtn");
  if (!button) return;
  const show = state.newCount > 0 || !state.scrollBottom;
  button.hidden = !show;
  const count = $("#dmScrollCount");
  if (count) count.textContent = state.newCount > 0 ? String(state.newCount) : "";
}

function onThreadScroll() {
  const stream = $("#dmStream");
  if (!stream) return;
  const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 90;
  const wasBottom = state.scrollBottom;
  state.scrollBottom = nearBottom;
  if (nearBottom && state.newDividerSeq) {
    state.newDividerSeq = 0;
    state.newCount = 0;
    renderMessages();
    return;
  }
  if (!wasBottom && nearBottom) markReadSoon();
  updateJump();
  if (stream.scrollTop < 48 && state.threadHasMore && !state.threadPaging) loadOlder();
}

function jumpToLatest(silent = false) {
  const stream = $("#dmStream");
  if (!stream) return;
  state.newDividerSeq = 0;
  state.newCount = 0;
  if (!silent) renderMessages();
  else stream.scrollTop = stream.scrollHeight;
  stream.scrollTop = stream.scrollHeight;
  state.scrollBottom = true;
  updateJump();
  if (!silent) markReadSoon();
}

async function loadOlder() {
  const conv = state.activeConv;
  if (!conv || state.threadPaging || !state.threadHasMore || !state.threadOldestSeq) return;
  const token = state.threadToken;
  const stream = $("#dmStream");
  const prevHeight = stream?.scrollHeight || 0;
  const prevTop = stream?.scrollTop || 0;
  state.threadPaging = true;
  stream?.classList.add("is-paging");
  try {
    const data = await api(`/social/dm/${enc(conv.id)}/messages?limit=50&before=${state.threadOldestSeq}`, { quiet: true });
    if (token !== state.threadToken || String(state.activeConv?.id) !== String(conv.id)) return;
    const known = new Set(state.messages.map((item) => item.id));
    const older = (data.messages || []).filter((item) => !known.has(item.id));
    state.messages = [...older, ...state.messages];
    state.threadHasMore = Boolean(data.hasMore);
    state.threadOldestSeq = Number(data.oldestSeq || state.threadOldestSeq);
    if (data.conversation) {
      upsertConv(data.conversation);
      state.activeConv = convById(conv.id) || state.activeConv;
      paintConvHead();
    }
    renderMessages(true);
    if (stream) stream.scrollTop = stream.scrollHeight - prevHeight + prevTop;
  } catch {} finally {
    state.threadPaging = false;
    stream?.classList.remove("is-paging");
  }
}

function markReadSoon() {
  clearTimeout(state.readTimer);
  state.readTimer = setTimeout(markReadNow, 700);
}

function markReadNow() {
  const conv = state.activeConv;
  if (!conv || document.visibilityState === "hidden") return;
  const last = state.messages.reduce((max, message) => Math.max(max, Number(message.seq || 0)), 0);
  if (!last) return;
  if (last <= Number(conv.myLastReadSeq || 0) && !conv.unread) return;
  conv.myLastReadSeq = last;
  conv.unread = 0;
  renderConvs();
  if (state.readSentSeq !== last) {
    state.readSentSeq = last;
    api(`/social/dm/${enc(conv.id)}/read`, { method: "POST", body: { seq: last }, quiet: true }).catch(() => {
      state.readSentSeq = 0;
    });
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.activeConv && state.scrollBottom) markReadSoon();
});
window.addEventListener("offline", () => {
  if (state.wsReady) state.wsDropped = true;
  disconnectWs();
});
window.addEventListener("online", () => {
  if (state.wsClosedByUs) return;
  state.wsRetry = 0;
  connectWs();
});

function newClientId() {
  try {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  } catch {}
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function sendDm() {
  const input = $("#dmInput");
  const conv = state.activeConv;
  if (!input || !conv) return;
  if (!conv.canReply) {
    toast(t("social.dmLocked"), "info");
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  const reply = state.replyTo;
  const clientId = newClientId();
  const message = {
    id: `local:${clientId}`,
    clientId,
    conversationId: conv.id,
    senderId: state.me?.id,
    body: text,
    attachment: null,
    replyToId: reply?.id || null,
    replyTo: reply
      ? { id: reply.id, senderId: reply.senderId, body: reply.body, deleted: Boolean(reply.deleted) }
      : null,
    reactions: [],
    createdAt: Date.now(),
    pending: true,
    failed: false,
    seq: null
  };
  state.messages.push(message);
  state.newDividerSeq = 0;
  state.newCount = 0;
  conv.lastMessage = {
    id: message.id,
    senderId: message.senderId,
    body: message.body,
    deleted: false,
    clientId,
    createdAt: message.createdAt
  };
  conv.updatedAt = message.createdAt;
  input.value = "";
  input.style.height = "auto";
  clearReply();
  renderMessages();
  jumpToLatest(true);
  renderConvs();
  await postDmMessage(message, conv);
}

async function postDmMessage(message, conv) {
  message.pending = true;
  message.failed = false;
  try {
    const data = await api(`/social/dm/${enc(conv.id)}/messages`, {
      method: "POST",
      body: { body: message.body, clientId: message.clientId, replyToId: message.replyToId },
      quiet: true
    });
    const saved = data.message;
    const index = state.messages.findIndex((item) =>
      item.id === message.id || (saved.clientId && item.clientId === saved.clientId)
    );
    if (index >= 0) state.messages[index] = saved;
    else if (!state.messages.some((item) => item.id === saved.id)) state.messages.push(saved);
    if (data.conversation) {
      upsertConv(data.conversation);
      if (state.activeConv?.id === conv.id) {
        state.activeConv = convById(conv.id) || state.activeConv;
        paintConvHead();
        paintRequestBar();
      }
    }
    if (conv.lastMessage?.id === message.id || (saved.clientId && conv.lastMessage?.clientId === saved.clientId)) {
      conv.lastMessage = {
        id: saved.id,
        seq: saved.seq,
        senderId: saved.senderId,
        body: saved.body,
        deleted: false,
        clientId: saved.clientId,
        createdAt: saved.createdAt
      };
      conv.updatedAt = saved.createdAt;
    }
    if (state.activeConv?.id === conv.id) renderMessages(true);
    renderConvs();
  } catch (err) {
    message.pending = false;
    message.failed = true;
    message.error = errorText(err);
    if (state.activeConv?.id === conv.id) renderMessages(true);
    toast(errorText(err), "error");
    if (err?.code === "request_pending" || err?.code === "request_rejected" || err?.code === "blocked") {
      loadConversations().catch(() => {});
    }
  }
}

async function retryMessage(message) {
  if (!message.failed || !state.activeConv) return;
  await postDmMessage(message, state.activeConv);
}

async function addReaction(message, emoji) {
  try {
    const data = await api(`/social/dm/messages/${enc(message.id)}/reactions`, {
      method: "POST",
      body: { emoji }
    });
    message.reactions = data.reactions || [];
    renderMessages(true);
  } catch {}
}

async function toggleReaction(message, reaction) {
  try {
    const path = `/social/dm/messages/${enc(message.id)}/reactions${reaction.mine ? `/${enc(reaction.emoji)}` : ""}`;
    const data = reaction.mine
      ? await api(path, { method: "DELETE" })
      : await api(path, { method: "POST", body: { emoji: reaction.emoji } });
    message.reactions = data.reactions || [];
    renderMessages(true);
  } catch {}
}

async function deleteMessage(message) {
  if (String(message.id).startsWith("local:")) return;
  const ok = await confirmDialog({ title: t("social.delete"), text: t("social.confirmDeleteMessage"), okLabel: t("social.delete") });
  if (!ok) return;
  try {
    const data = await api(`/social/dm/messages/${enc(message.id)}`, { method: "DELETE" });
    message.deletedAt = Date.now();
    message.body = "";
    message.reactions = [];
    const conv = convById(message.conversationId || data.conversationId);
    if (conv?.lastMessage?.id === message.id) {
      conv.lastMessage = { ...conv.lastMessage, body: "", deleted: true };
    }
    renderMessages(true);
    renderConvs();
  } catch {}
}

function startMessageEdit(message, bubble) {
  bubble.replaceChildren();
  const area = el("div", { class: "dm-edit-area" });
  const text = el("textarea", { maxlength: "4000" });
  text.value = message.body || "";
  const actions = el("div", { class: "dm-actions" });
  actions.append(el("button", {
    type: "button",
    class: "btn btn-primary btn-sm",
    text: t("social.save"),
    onClick: async () => {
      const value = text.value.trim();
      if (!value) return;
      try {
        const data = await api(`/social/dm/messages/${enc(message.id)}`, { method: "PATCH", body: { body: value } });
        Object.assign(message, data.message);
        renderMessages(true);
      } catch {}
    }
  }));
  actions.append(el("button", {
    type: "button",
    class: "btn btn-ghost btn-sm",
    text: t("social.cancel"),
    onClick: () => renderMessages(true)
  }));
  area.append(text, actions);
  bubble.append(area);
  text.focus();
}

async function toggleConvPref(kind) {
  const conv = state.activeConv;
  if (!conv) return;
  try {
    const path = kind === "muted" ? "mute" : "archive";
    const data = await api(`/social/dm/${enc(conv.id)}/${path}`, {
      method: "POST",
      body: { [kind]: !conv[kind] }
    });
    Object.assign(conv, data.conversation || {});
    paintConvHead();
    renderConvs();
  } catch {}
}

/* ----------------------------------------------------------- notifications */

$("#notifReadAll")?.addEventListener("click", async () => {
  try {
    await api("/social/notifications/read-all", { method: "POST", body: {} });
    toast(t("social.notifAllRead"), "success");
    await loadNotifications();
    refreshBadges();
  } catch {}
});
$("#notifPrefsForm")?.addEventListener("submit", saveNotifPrefs);
$("#notifLoadMore")?.addEventListener("click", () => loadNotifications(false, true));
$("#muteRoomAdd")?.addEventListener("click", addMutedRoom);
$("#muteRoomInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addMutedRoom();
  }
});
$("#notifPushBtn")?.addEventListener("click", async () => {
  const stateNode = $("#notifPushState");
  const result = await requestNotifPermission();
  if (stateNode) {
    stateNode.textContent = result === "granted"
      ? t("social.notifPushOn")
      : result === "unsupported"
        ? t("social.notifPushUnsupported")
        : t("social.notifPushBlocked");
  }
});

function paintPushState() {
  const btn = $("#notifPushBtn");
  const stateNode = $("#notifPushState");
  if (!btn || !stateNode) return;
  const permission = notifPermission();
  const supported = permission !== "unsupported";
  btn.hidden = permission === "granted" || !supported;
  stateNode.textContent = permission === "granted"
    ? t("social.notifPushOn")
    : permission === "denied"
      ? t("social.notifPushBlocked")
      : supported
        ? t("social.notifPushOff")
        : t("social.notifPushUnsupported");
}

async function loadNotifications(quiet = false, more = false) {
  const before = more ? state.notifBefore : "";
  const path = `/social/notifications?limit=40${before ? `&before=${enc(before)}` : ""}`;
  const data = await api(path, { quiet });
  const items = data.notifications || [];
  state.notifs = more ? state.notifs.concat(items) : items;
  state.notifUnread = Number(data.unread || 0);
  state.notifBefore = data.nextBefore || "";
  const moreBtn = $("#notifLoadMore");
  if (moreBtn) moreBtn.hidden = !state.notifBefore;
  renderNotifs();
  paintCount("countNotifs", state.notifUnread);
}

function renderNotifs() {
  const list = $("#notifList");
  if (!list) return;
  list.replaceChildren(...state.notifs.map((notif) => {
    const li = el("li", { class: `request-row${notif.read ? "" : " unread"}` });
    li.append(el("span", { class: "notif-unread", style: notif.read ? "background:var(--border-strong)" : "" }));
    const main = el("div", { class: "person-main" });
    main.append(el("strong", { text: notif.title || t(`social.kind.${notif.kind}`) }));
    if (notif.body) main.append(el("small", { text: notif.body, dir: "auto" }));
    const meta = el("small", { class: "notif-meta" });
    meta.append(el("span", { text: ago(notif.createdAt) }));
    meta.append(el("span", {
      class: `badge ${notif.delivered ? "ok" : "off"}`,
      text: notif.delivered ? t("social.notifDelivered") : t("social.notifInApp")
    }));
    main.append(meta);
    li.append(main);
    const actions = el("div", { class: "person-actions" });
    if (notif.link) {
      actions.append(smallBtn(t("social.libraryOpen"), "ghost", () => {
        location.href = notif.link;
      }));
    }
    if (!notif.read) actions.append(smallBtn(t("social.markRead"), "ghost", () => markNotifRead(notif)));
    li.append(actions);
    return li;
  }));
  emptyState("notifEmpty", state.notifs.length > 0);
}

async function markNotifRead(notif) {
  try {
    await api("/social/notifications/read", { method: "POST", body: { ids: [notif.id] } });
    notif.read = true;
    renderNotifs();
    refreshBadges();
  } catch {}
}

async function loadNotifPrefs() {
  try {
    const data = await api("/social/notification-prefs", { quiet: true });
    state.notifPrefs = data.prefs && typeof data.prefs === "object" ? data.prefs : {};
    $$("#notifKindGrid input").forEach((input) => {
      input.checked = state.notifPrefs[input.dataset.kind] !== false;
    });
    const from = $("#quietFrom");
    const to = $("#quietTo");
    if (from) from.value = minutesToTime(data.quietFrom);
    if (to) to.value = minutesToTime(data.quietTo);
    const quiet = $("#notifQuietActive");
    if (quiet) quiet.hidden = !data.quietActive;
    paintPushState();
    renderMutedRooms();
  } catch {}
}

function mutedRooms() {
  const rooms = state.notifPrefs.rooms;
  return rooms && typeof rooms === "object" ? rooms : {};
}

function renderMutedRooms() {
  const list = $("#muteRoomList");
  if (!list) return;
  const entries = Object.entries(mutedRooms()).filter(([, muted]) => muted === false);
  list.replaceChildren(...entries.map(([code]) => {
    const li = el("li", { class: "mute-row" });
    li.append(el("code", { text: code }));
    li.append(smallBtn(t("social.notifUnmute"), "ghost", () => {
      state.notifPrefs.rooms = { ...mutedRooms() };
      delete state.notifPrefs.rooms[code];
      renderMutedRooms();
    }));
    return li;
  }));
  if (!entries.length) list.append(el("li", { class: "hint", text: t("social.notifNoMutedRooms") }));
}

function addMutedRoom() {
  const input = $("#muteRoomInput");
  const code = (input?.value || "").trim().toUpperCase();
  if (!code) return;
  state.notifPrefs.rooms = { ...mutedRooms(), [code]: false };
  if (input) input.value = "";
  renderMutedRooms();
}

function minutesToTime(value) {
  if (value === null || value === undefined || value === "") return "";
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return "";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

async function saveNotifPrefs(event) {
  event.preventDefault();
  const msg = $("#notifPrefsMsg");
  const prefs = { ...state.notifPrefs };
  $$("#notifKindGrid input").forEach((input) => { prefs[input.dataset.kind] = input.checked; });
  prefs.rooms = { ...mutedRooms() };
  try {
    const data = await api("/social/notification-prefs", {
      method: "PUT",
      body: {
        prefs,
        quietFrom: $("#quietFrom")?.value || null,
        quietTo: $("#quietTo")?.value || null
      }
    });
    state.notifPrefs = data.prefs || prefs;
    if (msg) { msg.textContent = t("social.notifSaved"); msg.classList.add("ok"); setTimeout(() => { msg.textContent = ""; }, 2500); }
  } catch {}
}

function browserPush(title, body, link = "") {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (!document.hidden) return;
    const options = {
      body: String(body || ""),
      icon: "assets/icon.svg",
      badge: "assets/icon.svg",
      tag: "wt-social",
      lang: getLang(),
      data: { url: link || "./" }
    };
    if (navigator.serviceWorker?.ready) {
      navigator.serviceWorker.ready
        .then((reg) => reg.showNotification(String(title || "هم‌تماشا"), options))
        .catch(() => {});
    } else {
      new Notification(String(title || "هم‌تماشا"), options);
    }
  } catch {}
}

/* ----------------------------------------------------------------- history */

$("#historyClear")?.addEventListener("click", async () => {
  const ok = await confirmDialog({ title: t("social.historyClear"), text: t("social.historyClearConfirm"), okLabel: t("social.historyClear") });
  if (!ok) return;
  try {
    await api("/social/history", { method: "DELETE" });
    toast(t("social.historyCleared"), "success");
    await loadHistory();
  } catch {}
});

async function loadHistory() {
  const data = await api("/social/history", { quiet: true });
  state.history = data.history || [];
  renderHistory();
}

function renderHistory() {
  const list = $("#historyList");
  if (!list) return;
  list.replaceChildren(...state.history.map((item) => {
    const li = el("li", { class: "history-row" });
    const main = el("div", { class: "person-main" });
    main.append(el("strong", { text: item.title || item.mediaUrl || "—", dir: "auto" }));
    const host = (() => {
      try { return new URL(item.mediaUrl).hostname; } catch { return item.mediaUrl; }
    })();
    main.append(el("small", { text: host, dir: "ltr" }));
    const percent = item.duration > 0 ? Math.min(100, Math.round((item.position / item.duration) * 100)) : 0;
    const bar = el("div", { class: "bar-wrap", role: "progressbar", "aria-valuenow": String(percent), "aria-valuemin": "0", "aria-valuemax": "100" });
    bar.append(el("span", { class: "bar-fill", style: `width:${percent}%` }));
    main.append(bar);
    main.append(el("small", {
      text: item.duration > 0 ? `${t("social.historyProgress", { p: percent })} · ${ago(item.lastWatchedAt)}` : ago(item.lastWatchedAt)
    }));
    li.append(main);
    li.append(el("div", { class: "person-actions" }, [
      smallBtn(t("social.delete"), "ghost", () => deleteHistory(item))
    ]));
    return li;
  }));
  emptyState("historyEmpty", state.history.length > 0);
}

async function deleteHistory(item) {
  try {
    await api(`/social/history/${enc(item.id)}`, { method: "DELETE" });
    toast(t("social.historyDeleted"), "success");
    await loadHistory();
  } catch {}
}

/* ----------------------------------------------------------------- library */

$("#libraryForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const msg = $("#libraryMsg");
  const url = $("#libraryUrl")?.value.trim() || "";
  let valid = false;
  try {
    const parsed = new URL(url);
    valid = parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {}
  if (!valid) {
    if (msg) msg.textContent = t("social.urlInvalid");
    return;
  }
  try {
    await api("/social/library", {
      method: "POST",
      body: {
        kind: $("#libraryKind")?.value || "saved",
        title: $("#libraryTitle")?.value.trim() || "",
        url
      }
    });
    if (msg) msg.textContent = "";
    $("#libraryTitle").value = "";
    $("#libraryUrl").value = "";
    toast(t("social.libraryAdded"), "success");
    await loadLibrary();
  } catch {}
});
$("#libraryRefresh")?.addEventListener("click", () => loadLibrary());
$("#libraryFilter")?.addEventListener("change", () => loadLibrary());

async function loadLibrary() {
  const kind = $("#libraryFilter")?.value || "";
  const data = await api(`/social/library${kind ? `?kind=${enc(kind)}` : ""}`, { quiet: true });
  state.library = data.items || [];
  renderLibrary();
}

function renderLibrary() {
  const list = $("#libraryList");
  if (!list) return;
  list.replaceChildren(...state.library.map((item) => {
    const li = el("li", { class: "library-row" });
    li.append(el("span", { class: "badge kind", text: t(`social.kind.${item.kind}`) }));
    const main = el("div", { class: "person-main" });
    main.append(el("strong", { text: item.title || item.url, dir: "auto" }));
    const link = el("a", { class: "url", href: item.url, target: "_blank", rel: "noopener noreferrer", dir: "ltr", text: item.url });
    main.append(link);
    li.append(main);
    li.append(el("div", { class: "person-actions" }, [
      smallBtn(t("social.libraryOpen"), "secondary", () => window.open(item.url, "_blank", "noopener")),
      smallBtn(t("social.delete"), "ghost", () => deleteLibrary(item))
    ]));
    return li;
  }));
  emptyState("libraryEmpty", state.library.length > 0);
}

async function deleteLibrary(item) {
  try {
    await api(`/social/library/${enc(item.id)}`, { method: "DELETE" });
    toast(t("social.libraryDeleted"), "success");
    await loadLibrary();
  } catch {}
}

/* ----------------------------------------------------------------- invites */

$("#inviteForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const msg = $("#inviteMsg");
  const roomCode = ($("#inviteRoom")?.value || "").trim().toUpperCase();
  if (!roomCode) {
    if (msg) msg.textContent = t("social.inviteRoom");
    return;
  }
  try {
    const data = await api("/social/invites", {
      method: "POST",
      body: {
        roomCode,
        expiresInHours: Number($("#inviteHours")?.value || 24),
        maxUses: Number($("#inviteUses")?.value || 0)
      }
    });
    if (msg) msg.textContent = "";
    state.lastInviteCode = data.invite?.code || "";
    const box = $("#inviteCreated");
    const code = $("#inviteCreatedCode");
    if (code) code.textContent = state.lastInviteCode;
    if (box) box.hidden = !state.lastInviteCode;
    toast(t("social.inviteCreated"), "success");
    await loadInvites();
  } catch {}
});
$("#inviteCopyBtn")?.addEventListener("click", async () => {
  if (!state.lastInviteCode) return;
  await copyText(state.lastInviteCode);
  toast(t("social.copied"), "success");
});
$("#inviteAcceptForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const msg = $("#inviteAcceptMsg");
  const code = ($("#inviteAcceptCode")?.value || "").trim();
  if (!code) {
    if (msg) msg.textContent = t("social.inviteAcceptPh");
    return;
  }
  try {
    const data = await api("/social/invites/accept", { method: "POST", body: { code } });
    if (msg) msg.textContent = "";
    const roomCode = data.roomCode;
    toast(t("social.inviteJoined"), "success");
    if (roomCode) {
      setTimeout(() => {
        location.href = `room.html?room=${enc(roomCode)}`;
      }, 700);
    }
  } catch {}
});

async function loadInvites() {
  const data = await api("/social/invites", { quiet: true });
  state.invites = data.invites || [];
  renderInvites();
}

function renderInvites() {
  const list = $("#inviteList");
  if (!list) return;
  list.replaceChildren(...state.invites.map((invite) => {
    const li = el("li", { class: "request-row" });
    const main = el("div", { class: "person-main" });
    main.append(el("strong", { text: invite.roomCode ? `#${invite.roomCode}` : invite.serverId || invite.hint, dir: "ltr" }));
    const meta = el("div", { class: "invite-meta" });
    meta.append(el("span", { class: "badge", text: t(`social.inviteStatus.${invite.status}`) }));
    meta.append(el("span", { text: invite.maxUses > 0 ? t("social.inviteUsed", { used: invite.uses, max: invite.maxUses }) : t("social.inviteUnlimited") }));
    meta.append(el("span", { text: t("social.inviteExpires", { date: fmtDate(invite.expiresAt) }) }));
    main.append(meta);
    main.append(el("small", { text: invite.hint, dir: "ltr" }));
    li.append(main);
    if (invite.status === "active") {
      li.append(el("div", { class: "person-actions" }, [
        smallBtn(t("social.inviteRevoke"), "ghost", () => revokeInvite(invite))
      ]));
    }
    return li;
  }));
  emptyState("inviteEmpty", state.invites.length > 0);
}

async function revokeInvite(invite) {
  const ok = await confirmDialog({ title: t("social.inviteRevoke"), text: t("social.confirmRevoke"), okLabel: t("social.inviteRevoke") });
  if (!ok) return;
  try {
    await api(`/social/invites/${enc(invite.id)}`, { method: "DELETE" });
    toast(t("social.inviteRevoked"), "success");
    await loadInvites();
  } catch {}
}

/* ----------------------------------------------------------------- support */

const ATTACH_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"]);
const ATTACH_MAX = 400 * 1024;

async function readAttachment(input) {
  const file = input?.files?.[0];
  if (!file) return undefined;
  if (!ATTACH_TYPES.has(file.type)) {
    toast(t("social.attachType"), "warn");
    input.value = "";
    return null;
  }
  if (file.size > ATTACH_MAX) {
    toast(t("social.attachSize"), "warn");
    input.value = "";
    return null;
  }
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("read_failed"));
      reader.readAsDataURL(file);
    });
    if (!data) return null;
    input.value = "";
    return { name: file.name.slice(0, 80), type: file.type, size: file.size, data };
  } catch {
    input.value = "";
    return null;
  }
}

function attachNode(attachment) {
  const url = attachment?.url;
  if (!url) return null;
  const isImage = /^image\//.test(String(attachment.type || ""));
  const node = el("a", {
    class: `attach-note${isImage ? " attach-image" : ""}`,
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
    dir: "ltr"
  });
  if (isImage) {
    node.append(el("img", { src: url, alt: attachment.name || "attachment", loading: "lazy", decoding: "async" }));
  }
  node.append(el("span", { text: attachment.name || "attachment" }));
  return node;
}

$("#ticketForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const msg = $("#ticketMsg");
  const subject = ($("#ticketSubject")?.value || "").trim();
  if (subject.length < 3) {
    if (msg) msg.textContent = t("social.supportSubject");
    return;
  }
  const attachment = await readAttachment($("#ticketAttachment"));
  if (attachment === null) return;
  try {
    const data = await api("/social/support/tickets", {
      method: "POST",
      body: {
        subject,
        category: $("#ticketCategory")?.value || "general",
        priority: $("#ticketPriority")?.value || "normal",
        body: $("#ticketBody")?.value.trim() || "",
        attachment
      }
    });
    if (msg) msg.textContent = "";
    $("#ticketSubject").value = "";
    $("#ticketBody").value = "";
    toast(t("social.ticketCreated"), "success");
    await loadTickets();
    if (data.ticket?.id) openTicket(data.ticket.id);
  } catch {}
});
$("#ticketCloseDetail")?.addEventListener("click", () => {
  state.activeTicket = null;
  $("#ticketDetail").hidden = true;
});
$("#ticketReplyForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const ticket = state.activeTicket;
  const body = ($("#ticketReplyBody")?.value || "").trim();
  const attachment = await readAttachment($("#ticketReplyAttachment"));
  if (attachment === null) return;
  if (!ticket || (!body && !attachment)) return;
  try {
    await api(`/social/support/tickets/${enc(ticket.id)}/messages`, {
      method: "POST",
      body: { body, attachment }
    });
    $("#ticketReplyBody").value = "";
    toast(t("social.ticketReplySent"), "success");
    await openTicket(ticket.id);
    await loadTickets(true);
  } catch {}
});
$("#ticketStatusSave")?.addEventListener("click", async () => {
  const ticket = state.activeTicket;
  if (!ticket || !state.staff) return;
  try {
    const data = await api(`/social/support/tickets/${enc(ticket.id)}`, {
      method: "PATCH",
      body: {
        status: $("#ticketStatus")?.value,
        priority: $("#ticketStatusPriority")?.value,
        assignedTo: $("#ticketAssignee")?.value || "",
        resolution: $("#ticketResolution")?.value || ""
      }
    });
    toast(t("social.statusUpdated"), "success");
    state.activeTicket = data.ticket;
    renderTicketDetail();
    await loadTickets(true);
  } catch {}
});

async function loadTickets(silent = false) {
  const data = await api("/social/support/tickets?limit=40", { quiet: true });
  state.tickets = data.tickets || [];
  renderTickets();
  if (!silent) {
    $("#supportStaffBadge").hidden = !state.staff;
  }
}

function renderTickets() {
  const list = $("#ticketList");
  if (!list) return;
  list.replaceChildren(...state.tickets.map((ticket) => {
    const li = el("li", { class: "ticket-row", onClick: () => openTicket(ticket.id) });
    const main = el("div", { class: "person-main" });
    const title = el("strong", { text: ticket.subject, dir: "auto" });
    main.append(title);
    const badges = el("div", { class: "invite-meta" });
    badges.append(el("span", { class: `badge ${ticket.status === "open" ? "hot" : ticket.status === "resolved" ? "ok" : "off"}`, text: t(`social.status.${ticket.status}`) }));
    badges.append(el("span", { class: `badge ${ticket.priority === "urgent" || ticket.priority === "high" ? "warn" : ""}`, text: t(`social.priority.${ticket.priority}`) }));
    if (state.staff && ticket.user && String(ticket.user.id) !== String(state.me?.id)) {
      badges.append(el("span", { class: "badge", text: t("social.ticketFrom", { name: displayName(ticket.user) }) }));
    }
    if (ticket.assignee) {
      badges.append(el("span", { class: "badge", text: t("social.ticketAssigned", { name: displayName(ticket.assignee) }) }));
    }
    badges.append(el("span", { class: "hint", text: ago(ticket.updatedAt) }));
    main.append(badges);
    li.append(main);
    if (state.staff) li.append(el("span", { class: "badge", text: t("social.staffBadge") }));
    return li;
  }));
  emptyState("ticketEmpty", state.tickets.length > 0);
}

async function openTicket(id) {
  try {
    const data = await api(`/social/support/tickets/${enc(id)}`, { quiet: true });
    state.activeTicket = data.ticket;
    renderTicketDetail();
  } catch {}
}

function renderTicketDetail() {
  const ticket = state.activeTicket;
  const wrap = $("#ticketDetail");
  if (!ticket || !wrap) return;
  wrap.hidden = false;
  $("#ticketDetailTitle").textContent = ticket.subject;
  const meta = [`${t(`social.status.${ticket.status}`)} · ${t(`social.priority.${ticket.priority}`)} · ${ago(ticket.createdAt)}`];
  if (ticket.assignee) meta.push(t("social.ticketAssigned", { name: displayName(ticket.assignee) }));
  if (ticket.resolvedAt) meta.push(t("social.ticketResolvedAt", { when: ago(ticket.resolvedAt) }));
  $("#ticketDetailMeta").textContent = meta.join(" · ");
  const msgs = $("#ticketMsgs");
  msgs.replaceChildren(...(ticket.messages || []).map((message) => {
    const system = message.kind === "system";
    const mineStaff = !system && String(message.author?.id) !== String(ticket.userId);
    const node = el("div", { class: `ticket-msg${system ? " system" : mineStaff ? " staff" : ""}` });
    const head = el("div", { class: "dm-meta" });
    head.append(el("strong", { text: system ? t("social.ticketSystem") : displayName(message.author) }));
    if (mineStaff) head.append(el("span", { class: "badge", text: t("social.staffBadge") }));
    head.append(el("span", { text: fmtTime(message.createdAt) }));
    node.append(head);
    if (message.body) node.append(el("div", { text: message.body, dir: "auto" }));
    const attach = attachNode(message.attachment);
    if (attach) node.append(attach);
    return node;
  }));
  $("#ticketStaffRow").hidden = !state.staff;
  if (state.staff) {
    $("#ticketStatus").value = ticket.status;
    $("#ticketStatusPriority").value = ticket.priority;
    paintAgentOptions(ticket);
    const resolution = $("#ticketResolution");
    if (resolution) resolution.value = ticket.resolution || "";
  }
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ------------------------------------------------------------------- help */

async function loadHelp() {
  if (state.helpLoaded) return;
  state.helpLoaded = true;
  try {
    const res = await fetch("assets/data/help.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("help_unavailable");
    state.help = await res.json();
  } catch {
    state.help = null;
  }
}

function helpLocale() {
  const data = state.help;
  if (!data) return null;
  return data[getLang()] || data.fa || data.en || null;
}

function renderHelp() {
  const faq = $("#helpFaq");
  const results = $("#helpResults");
  const empty = $("#helpEmpty");
  if (!faq || !results) return;
  const data = helpLocale();
  if (!data) {
    faq.replaceChildren();
    results.replaceChildren();
    if (empty) {
      empty.hidden = false;
      empty.firstElementChild.textContent = t("social.helpOffline");
    }
    return;
  }
  const query = ($("#helpSearch")?.value || "").trim().toLowerCase();
  if (query) {
    const hits = (data.articles || []).filter((article) =>
      [article.title, article.body, ...(article.tags || [])].join(" ").toLowerCase().includes(query)
    );
    results.replaceChildren(...hits.map((article) => {
      const node = el("article", { class: "help-article" });
      node.append(el("h4", { text: article.title, dir: "auto" }));
      node.append(el("p", { text: article.body, dir: "auto" }));
      return node;
    }));
    faq.replaceChildren();
    faq.hidden = true;
    if (empty) empty.hidden = hits.length > 0;
    return;
  }
  results.replaceChildren();
  faq.hidden = false;
  faq.replaceChildren(...(data.faq || []).map((item) => {
    const details = el("details", { class: "help-faq-item" });
    details.append(el("summary", { text: item.q, dir: "auto" }));
    details.append(el("p", { text: item.a, dir: "auto" }));
    return details;
  }));
  if (empty) empty.hidden = true;
}

$("#helpSearch")?.addEventListener("input", renderHelp);

async function loadAgents() {
  if (state.agents.length) return;
  try {
    const data = await api("/social/support/agents", { quiet: true });
    state.agents = data.agents || [];
  } catch {
    state.agents = [];
  }
}

function paintAgentOptions(ticket = null) {
  const select = $("#ticketAssignee");
  if (!select) return;
  const current = ticket?.assignedTo || "";
  select.replaceChildren(el("option", { value: "", text: t("social.supportUnassigned") }));
  for (const agent of state.agents) {
    select.append(el("option", { value: agent.id, text: displayName(agent) }));
  }
  select.value = current;
  if (select.value !== current) select.value = "";
}

/* ------------------------------------------------------------------- polls */

$("#pollLoad")?.addEventListener("click", () => {
  const room = ($("#pollRoom")?.value || "").trim().toUpperCase();
  if (!room) {
    toast(t("social.pollsNeedRoom"), "warn");
    return;
  }
  state.pollsRoom = room;
  try { localStorage.setItem("wt.social.pollRoom", room); } catch {}
  loadPolls();
});
$("#pollRoom")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("#pollLoad")?.click();
  }
});
$("#pollForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const msg = $("#pollMsg");
  const room = (($("#pollRoom")?.value || "").trim().toUpperCase()) || state.pollsRoom;
  if (!room) {
    if (msg) msg.textContent = t("social.pollsNeedRoom");
    return;
  }
  const question = ($("#pollQuestion")?.value || "").trim();
  const options = ($("#pollOptions")?.value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const unique = new Set(options.map((line) => line.toLowerCase()));
  if (!question || options.length < 2 || options.length > 10 || unique.size !== options.length) {
    if (msg) msg.textContent = t("social.pollsOptionsInvalid");
    return;
  }
  try {
    await api("/social/polls", {
      method: "POST",
      body: {
        roomCode: room,
        question,
        options,
        multi: Boolean($("#pollMulti")?.checked),
        anonymous: Boolean($("#pollAnonymous")?.checked),
        closesInMinutes: Number($("#pollMinutes")?.value || 0)
      }
    });
    if (msg) msg.textContent = "";
    $("#pollQuestion").value = "";
    $("#pollOptions").value = "";
    state.pollsRoom = room;
    toast(t("social.pollsCreated"), "success");
    await loadPolls();
  } catch {}
});

async function loadPolls(quiet = false) {
  if (!state.pollsRoom) return;
  try {
    const data = await api(`/social/polls?room=${enc(state.pollsRoom)}`, { quiet });
    state.polls = data.polls || [];
  } catch {
    state.polls = [];
  }
  state.pollsLoaded = true;
  renderPolls();
}

function renderPolls() {
  const list = $("#pollList");
  if (!list) return;
  list.replaceChildren(...state.polls.map((poll) => pollCard(poll)));
  emptyState("pollEmpty", state.polls.length > 0 || !state.pollsLoaded);
}

function pollCard(poll) {
  const card = el("div", { class: `poll-card${poll.closed ? " poll-closed" : ""}` });
  const head = el("div", { class: "poll-head" });
  head.append(el("p", { class: "poll-q", text: poll.question, dir: "auto" }));
  const actions = el("div", { class: "poll-actions" });
  if (poll.closed) actions.append(el("span", { class: "badge off", text: t("social.pollsClosed") }));
  else if (poll.closesAt) actions.append(el("span", { class: "badge", text: fmtDate(poll.closesAt) }));
  head.append(actions);
  card.append(head);

  const total = Number(poll.totalVotes || 0);
  const selection = state.pollSelection.get(poll.id) || new Set();
  for (const option of poll.options || []) {
    const percent = total > 0 ? Math.round((option.votes / total) * 100) : 0;
    const chosen = poll.multi ? selection.has(option.id) : option.mine;
    const node = el("button", {
      type: "button",
      class: `poll-opt${chosen || option.mine ? " mine" : ""}`,
      disabled: poll.closed
    });
    const fill = el("span", { class: "poll-fill", style: `width:${percent}%` });
    node.append(fill);
    node.append(el("span", { class: "poll-label", text: option.label, dir: "auto" }));
    node.append(el("span", { class: "poll-count", text: `${option.votes} · ${percent}%` }));
    node.addEventListener("click", () => choosePollOption(poll, option));
    card.append(node);
  }

  if (poll.multi && !poll.closed) {
    const vote = el("button", {
      type: "button",
      class: "btn btn-primary btn-sm",
      text: t("social.pollsVote"),
      onClick: () => submitPollVote(poll)
    });
    card.append(vote);
  }

  const meta = el("div", { class: "poll-meta" });
  meta.append(el("span", { text: t("social.pollsVotes", { n: total }) }));
  const owner = String(poll.createdBy) === String(state.me?.id);
  if (!poll.closed && (owner || state.staff)) {
    meta.append(el("button", {
      type: "button",
      class: "link-btn",
      text: t("social.pollsClose"),
      onClick: () => closePoll(poll)
    }));
  }
  if (owner || state.staff) {
    meta.append(el("button", {
      type: "button",
      class: "link-btn",
      text: t("social.pollsDelete"),
      onClick: () => deletePoll(poll)
    }));
  }
  card.append(meta);
  return card;
}

async function choosePollOption(poll, option) {
  if (poll.closed) return;
  if (poll.multi) {
    const set = new Set(state.pollSelection.get(poll.id) || []);
    if (set.has(option.id)) set.delete(option.id);
    else set.add(option.id);
    state.pollSelection.set(poll.id, set);
    renderPolls();
    return;
  }
  try {
    const data = await api(`/social/polls/${enc(poll.id)}/vote`, {
      method: "POST",
      body: { optionIds: [option.id] }
    });
    replacePoll(data.poll);
    toast(t("social.pollsVoted"), "success");
    renderPolls();
  } catch {}
}

async function submitPollVote(poll) {
  const set = state.pollSelection.get(poll.id);
  if (!set || set.size === 0) return;
  try {
    const data = await api(`/social/polls/${enc(poll.id)}/vote`, {
      method: "POST",
      body: { optionIds: [...set] }
    });
    state.pollSelection.delete(poll.id);
    replacePoll(data.poll);
    toast(t("social.pollsVoted"), "success");
    renderPolls();
  } catch {}
}

function replacePoll(poll) {
  const index = state.polls.findIndex((item) => item.id === poll.id);
  if (index >= 0) state.polls[index] = poll;
  else state.polls.unshift(poll);
}

async function closePoll(poll) {
  try {
    const data = await api(`/social/polls/${enc(poll.id)}/close`, { method: "POST", body: {} });
    replacePoll(data.poll);
    toast(t("social.pollsClosedToast"), "success");
    renderPolls();
  } catch {}
}

async function deletePoll(poll) {
  const ok = await confirmDialog({ title: t("social.pollsDelete"), text: t("common.confirm"), okLabel: t("social.delete") });
  if (!ok) return;
  try {
    await api(`/social/polls/${enc(poll.id)}`, { method: "DELETE" });
    state.polls = state.polls.filter((item) => item.id !== poll.id);
    toast(t("social.pollsDeleted"), "success");
    renderPolls();
  } catch {}
}

/* ----------------------------------------------------------------- reports */

async function loadReports() {
  try {
    const mine = await api("/social/reports/mine", { quiet: true });
    state.myReports = mine.reports || [];
  } catch {
    state.myReports = [];
  }
  renderMyReports();
  const wrap = $("#staffReportsWrap");
  if (wrap) wrap.hidden = !state.staff;
  if (state.staff) await loadStaffReports();
}

async function loadStaffReports() {
  const status = $("#staffReportFilter")?.value || "";
  try {
    const data = await api(`/social/reports${status ? `?status=${enc(status)}` : ""}`, { quiet: true });
    state.staffReports = data.reports || [];
  } catch {
    state.staffReports = [];
  }
  renderStaffReports();
}

function renderMyReports() {
  const list = $("#myReports");
  if (!list) return;
  list.replaceChildren(...state.myReports.map((report) => {
    const li = el("li", { class: "request-row" });
    const main = el("div", { class: "person-main" });
    main.append(el("strong", { text: `${t("social.reportTarget")}: ${reasonLabel(report.category)}`, dir: "auto" }));
    main.append(el("small", { text: `${report.targetType} · ${report.targetId}`, dir: "ltr" }));
    if (report.details) main.append(el("div", { class: "report-body", text: report.details, dir: "auto" }));
    main.append(el("small", { text: ago(report.createdAt) }));
    li.append(main);
    li.append(el("span", { class: `badge ${report.status === "open" ? "hot" : report.status === "resolved" ? "ok" : "off"}`, text: t(`social.reportStatus.${report.status}`) }));
    return li;
  }));
  emptyState("reportsEmpty", state.myReports.length > 0);
}

function reasonLabel(category) {
  const key = `social.reason.${category}`;
  const value = t(key);
  return value === key ? category : value;
}

function renderStaffReports() {
  const list = $("#staffReports");
  if (!list) return;
  list.replaceChildren(...state.staffReports.map((report) => {
    const li = el("li", { class: "person-row report-item" });
    const main = el("div", { class: "person-main" });
    main.append(el("strong", { text: `${report.category} — ${report.targetType}`, dir: "ltr" }));
    main.append(el("small", { text: `@${report.reporter?.username || report.reporter?.id || "?"} · ${ago(report.createdAt)}` }));
    if (report.details) main.append(el("div", { class: "report-body", text: report.details, dir: "auto" }));
    const form = el("div", { class: "report-mod" });
    const status = el("select", {}, REPORT_STATUSES.map((key) => el("option", { value: key, text: t(`social.reportStatus.${key}`) })));
    status.value = report.status;
    const note = el("textarea", { rows: "1", maxlength: "2000", placeholder: t("social.reportNotePh") });
    form.append(field(t("social.reportStatus"), status), field(t("social.reportNote"), note), btn(t("social.reportApply"), "secondary", async () => {
      try {
        await api(`/social/reports/${enc(report.id)}`, {
          method: "PATCH",
          body: { status: status.value, note: note.value.trim() }
        });
        toast(t("social.reportUpdated"), "success");
        await loadStaffReports();
      } catch {}
    }));
    main.append(form);
    li.append(main);
    li.append(el("span", { class: "badge", text: t(`social.reportStatus.${report.status}`) }));
    return li;
  }));
}
$("#staffReportRefresh")?.addEventListener("click", () => loadStaffReports());
$("#staffReportFilter")?.addEventListener("change", () => loadStaffReports());

/* ------------------------------------------------------------------ search */

let searchTimer = 0;
const SEARCH_PAGE = 20;
const SEARCH_HISTORY_MAX = 8;

function searchHistoryKey() {
  return `wt.searchHist.v1:${state.me?.id || "anon"}`;
}

function readSearchHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(searchHistoryKey()) || "[]");
    return Array.isArray(raw) ? raw.filter((item) => typeof item === "string" && item.trim()).slice(0, SEARCH_HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function renderSearchHistory() {
  const list = $("#searchHistoryList");
  if (!list) return;
  list.replaceChildren(...readSearchHistory().map((value) => el("option", { value })));
}

function rememberSearch(query) {
  const clean = String(query || "").trim().slice(0, 60);
  if (clean.length < 2) return;
  const next = [clean, ...readSearchHistory().filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(0, SEARCH_HISTORY_MAX);
  try { localStorage.setItem(searchHistoryKey(), JSON.stringify(next)); } catch {}
  renderSearchHistory();
}

$("#globalSearch")?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(true), 350);
});
$("#globalSearch")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  clearTimeout(searchTimer);
  rememberSearch(event.target.value);
  runSearch(true);
});
$("#searchType")?.addEventListener("change", () => runSearch(true));
$("#searchSort")?.addEventListener("change", () => runSearch(true));
$("#searchMore")?.addEventListener("click", () => {
  if (state.searchLoading || !state.searchHasMore) return;
  state.searchPage += 1;
  runSearch(false);
});

async function runSearch(reset = true) {
  const query = ($("#globalSearch")?.value || "").trim();
  const type = $("#searchType")?.value || "all";
  const sort = $("#searchSort")?.value || "relevance";
  if (reset) state.searchPage = 1;
  if (query.length < 2) {
    state.searchData = null;
    state.searchHasMore = false;
    state.searchLoading = false;
    renderSearch();
    return;
  }
  const seq = ++state.searchSeq;
  state.searchLoading = true;
  renderSearch();
  try {
    const data = await api(`/social/search?q=${enc(query)}&type=${enc(type)}&sort=${enc(sort)}&page=${state.searchPage}&limit=${SEARCH_PAGE}`, { quiet: true });
    if (seq !== state.searchSeq) return;
    if (reset) {
      state.searchData = data;
    } else {
      const prev = state.searchData || {};
      const merged = { ...data };
      for (const key of ["users", "friends", "rooms", "messages"]) merged[key] = [...(prev[key] || []), ...(data[key] || [])];
      merged.results = [...(prev.results || []), ...(data.results || [])];
      state.searchData = merged;
    }
    state.searchHasMore = Boolean(data.hasMore);
  } catch {
    if (seq !== state.searchSeq) return;
    if (reset) {
      state.searchData = null;
      state.searchHasMore = false;
    }
  } finally {
    if (seq === state.searchSeq) {
      state.searchLoading = false;
      renderSearch();
    }
  }
}

function renderSearch() {
  const wrap = $("#searchResults");
  if (!wrap) return;
  const data = state.searchData;
  wrap.replaceChildren();
  const count = $("#searchCount");
  const more = $("#searchMore");
  if (!data) {
    emptyState("searchEmpty", true);
    if (count) count.hidden = true;
    if (more) more.hidden = true;
    return;
  }
  const groups = [
    ["users", t("social.searchUsers")],
    ["friends", t("social.searchFriends")],
    ["rooms", t("social.searchRooms")],
    ["messages", t("social.searchMessages")]
  ];
  let total = 0;
  for (const [key, label] of groups) {
    const items = data[key] || [];
    if (!items.length) continue;
    total += items.length;
    const group = el("div", { class: "search-group" });
    group.append(el("h3", { text: label }));
    for (const item of items) group.append(searchResult(item, key));
    wrap.append(group);
  }
  if (count) {
    count.hidden = false;
    count.textContent = state.searchLoading
      ? t("social.searchLoading")
      : t("social.searchCount", { n: fmtNumber(Number(data.total || total)) });
  }
  if (more) {
    more.hidden = !state.searchHasMore || state.searchLoading;
    more.disabled = state.searchLoading;
  }
  emptyState("searchEmpty", total > 0 || state.searchLoading);
}

function searchResult(item, kind) {
  const row = el("div", { class: "search-result" });
  if (kind === "users" || kind === "friends") {
    row.append(avatarEl(item, "person-avatar"));
    const main = el("div", { class: "person-main" });
    main.append(el("strong", { text: displayName(item) }));
    main.append(el("small", { text: `@${item.username}` }));
    row.append(main);
    row.append(el("div", { class: "person-actions" }, [
      smallBtn(t("social.message"), "secondary", () => openDmWith(item)),
      smallBtn(t("social.more"), "ghost", () => openUserMenu(item))
    ]));
    return row;
  }
  if (kind === "rooms") {
    const main = el("div", { class: "person-main" });
    main.append(el("strong", { text: item.name || `#${item.roomCode}` }));
    const meta = [`${item.roomCode} · ${t("social.roomMembers", { n: item.memberCount })}`];
    if (item.description) meta.push(item.description);
    main.append(el("small", { text: meta.join(" · "), dir: "auto" }));
    row.append(main);
    row.append(el("a", {
      class: "btn btn-secondary btn-sm",
      href: `room.html?room=${enc(item.roomCode)}`,
      text: t("join.cta"),
      onClick: () => rememberSearch(item.name || item.roomCode)
    }));
    return row;
  }
  const main = el("div", { class: "person-main" });
  main.append(el("strong", { text: item.content, dir: "auto" }));
  main.append(el("small", { text: `${item.username || ""} · @${item.roomCode} · ${ago(item.createdAt)}`, dir: "auto" }));
  row.append(main);
  row.append(el("div", { class: "person-actions" }, [
    el("a", {
      class: "btn btn-ghost btn-sm",
      href: `room.html?room=${enc(item.roomCode)}`,
      text: t("social.libraryOpen")
    }),
    smallBtn(t("social.report"), "ghost", () => openReport({ type: "message", id: item.id, label: item.username || item.roomCode }))
  ]));
  return row;
}

/* ------------------------------------------------------------------ badges */

async function refreshBadges() {
  try {
    const [requests, dm, notifs] = await Promise.all([
      api("/social/requests", { quiet: true }),
      api("/social/dm", { quiet: true }),
      api("/social/notifications?unread=1&limit=1", { quiet: true })
    ]);
    paintCount("countRequests", (requests.incoming || []).length);
    const unread = (dm.conversations || []).reduce((sum, conv) => sum + (conv.unread || 0), 0);
    paintCount("countMessages", unread);
    paintCount("countNotifs", Number(notifs.unread || 0));
  } catch {}
}

/* --------------------------------------------------------------- websocket */

function connectWs() {
  if (!apiGetToken() || state.wsClosedByUs) return;
  if (state.ws && state.ws.readyState <= 1) return;
  try {
    const socket = apiConnectSocket({
      onOpen() {
        state.wsReady = false;
        try {
          socket.send(JSON.stringify({ type: "identify", token: apiGetToken() }));
        } catch {}
        paintWs();
      },
      onMessage(data) {
        if (data?.type === "identified") {
          const dropped = state.wsDropped;
          state.wsReady = true;
          state.wsRetry = 0;
          state.wsDropped = false;
          paintWs();
          if (dropped) resyncMessaging();
          return;
        }
        if (data?.type === "social") handleSocialEvent(data);
      },
      onClose() {
        if (state.ws === socket) {
          if (state.wsReady) state.wsDropped = true;
          state.ws = null;
          state.wsReady = false;
          paintWs();
          if (!state.wsClosedByUs) scheduleWs();
        }
      },
      onError() {}
    });
    state.ws = socket;
  } catch {}
  paintWs();
}

function disconnectWs() {
  const socket = state.ws;
  state.ws = null;
  state.wsReady = false;
  try { socket?.close(); } catch {}
  paintWs();
}

function scheduleWs() {
  const delay = Math.min(30000, 2000 * Math.pow(1.7, state.wsRetry++));
  setTimeout(() => {
    if (!state.wsClosedByUs && !state.ws) connectWs();
  }, delay);
}

function paintWs() {
  const badge = $("#wsState");
  if (!badge) return;
  badge.hidden = $("#socialLayout")?.hidden ?? true;
  const dot = badge.querySelector(".online-dot");
  if (dot) dot.classList.toggle("on", state.wsReady);
  const label = $("#wsStateText");
  if (label) {
    label.dataset.i18n = state.wsReady ? "social.live" : "social.liveOff";
    label.textContent = t(label.dataset.i18n);
  }
}

function refreshFriendsSoon() {
  clearTimeout(state.friendsTimer);
  state.friendsTimer = setTimeout(() => {
    if (state.pane === "people") loadPeoplePane().catch(() => {});
    else loadFriends().catch(() => {});
    refreshBadges();
  }, 150);
}

async function refreshThread(conv = state.activeConv) {
  if (!conv?.id) return;
  const token = state.threadToken;
  try {
    const data = await api(`/social/dm/${enc(conv.id)}/messages?limit=50`, { quiet: true });
    if (token !== state.threadToken || String(state.activeConv?.id) !== String(conv.id)) return;
    if (data.conversation) {
      upsertConv(data.conversation);
      state.activeConv = convById(conv.id) || state.activeConv;
      paintConvHead();
      paintRequestBar();
    }
    const latest = Array.isArray(data.messages) ? data.messages : [];
    const oldest = Number(data.oldestSeq || 0);
    const known = new Set(latest.map((item) => item.id));
    const older = state.messages.filter((item) =>
      Number(item.seq || 0) > 0 && Number(item.seq) < oldest && !known.has(item.id)
    );
    const pending = state.messages.filter((item) =>
      (item.pending || item.failed) && !latest.some((saved) => saved.clientId && saved.clientId === item.clientId)
    );
    state.messages = [...older, ...latest, ...pending];
    state.threadHasMore = older.length ? true : Boolean(data.hasMore);
    if (!older.length) state.threadOldestSeq = oldest;
    state.threadLoading = false;
    renderMessages(true);
    if (state.scrollBottom) {
      const stream = $("#dmStream");
      if (stream) stream.scrollTop = stream.scrollHeight;
      markReadSoon();
    }
    renderConvs();
  } catch {}
}

async function resyncMessaging() {
  if (!apiGetToken()) return;
  await Promise.allSettled([loadConversations(), refreshBadges()]);
  if (state.pane === "messages" && state.activeConv) await refreshThread(state.activeConv);
  if (state.pane === "people") refreshFriendsSoon();
}

function mergeMessage(message) {
  const index = state.messages.findIndex((item) =>
    item.id === message.id || (message.clientId && item.clientId === message.clientId)
  );
  if (index >= 0) {
    state.messages[index] = {
      ...state.messages[index],
      ...message,
      pending: false,
      failed: false,
      error: undefined
    };
    return true;
  }
  state.messages.push(message);
  return false;
}

function handleSocialEvent(payload) {
  const event = payload.event;
  const data = payload.data;
  if (event === "dm_message_updated") {
    if (!data?.id) return;
    const conv = convById(data.conversationId);
    const message = state.messages.find((item) => item.id === data.id);
    if (message) {
      message.body = data.body;
      message.editedAt = data.editedAt;
    }
    for (const item of state.messages) {
      if (item.replyTo?.id === data.id) item.replyTo = { ...item.replyTo, body: data.body };
    }
    if (conv?.lastMessage?.id === data.id) {
      conv.lastMessage = { ...conv.lastMessage, body: data.body };
    }
    if (state.pane === "messages") {
      renderConvs();
      if (state.activeConv?.id === data.conversationId) renderMessages(true);
    }
    return;
  }
  if (event === "dm_message_deleted") {
    const id = data?.id;
    if (!id) return;
    const message = state.messages.find((item) => item.id === id);
    if (message) {
      message.deletedAt = message.deletedAt || Date.now();
      message.body = "";
      message.attachments = null;
    }
    for (const item of state.messages) {
      if (item.replyTo?.id === id) item.replyTo = { ...item.replyTo, body: "", deleted: true };
    }
    for (const conv of state.convs) {
      if (conv.lastMessage?.id === id) conv.lastMessage = { ...conv.lastMessage, body: "", deleted: true };
    }
    if (state.pane === "messages") {
      renderConvs();
      if (state.activeConv) renderMessages(true);
    }
    return;
  }
  if (event === "dm_reaction") {
    if (!data?.messageId) return;
    const message = state.messages.find((item) => item.id === data.messageId);
    if (!message) return;
    message.reactions = data.reactions || [];
    if (state.pane === "messages" && state.activeConv) renderMessages(true);
    return;
  }
  if (event === "dm_message") {
    const message = data;
    if (!message?.id) return;
    const conv = convById(message.conversationId);
    if (!conv) {
      loadConversations().catch(() => {});
      return;
    }
    if (data.conversation?.status) conv.status = data.conversation.status;
    const mine = String(message.senderId) === String(state.me?.id);
    const active = String(state.activeConv?.id) === String(conv.id);
    conv.lastMessage = {
      id: message.id,
      seq: message.seq,
      senderId: message.senderId,
      body: message.body,
      hasAttachment: Boolean(message.attachment?.url),
      deleted: Boolean(message.deletedAt),
      clientId: message.clientId || "",
      createdAt: message.createdAt
    };
    conv.updatedAt = message.createdAt;
    if (active) {
      const maxSeq = state.messages.reduce(
        (max, item) => Math.max(max, item.pending || item.failed ? 0 : Number(item.seq || 0)),
        0
      );
      if (!mine && maxSeq && Number(message.seq || 0) > maxSeq + 1) {
        refreshThread(conv).catch(() => {});
      } else {
        const seen = mergeMessage(message);
        state.messages.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
        if (!seen) {
          if (state.scrollBottom) {
            renderMessages();
            jumpToLatest(true);
            markReadSoon();
          } else {
            if (!state.newDividerSeq) state.newDividerSeq = Number(message.seq || 0);
            state.newCount += 1;
            renderMessages(true);
            updateJump();
          }
        } else {
          renderMessages(true);
        }
      }
      if (state.scrollBottom) {
        conv.unread = 0;
        markReadSoon();
      } else if (!mine) {
        conv.unread = (conv.unread || 0) + 1;
      }
    } else if (!mine) {
      conv.unread = (conv.unread || 0) + 1;
    }
    if (!mine && (!active || document.visibilityState === "hidden") && !conv.muted) {
      toast(`${displayName(conv.peer)}: ${String(message.body || "").slice(0, 70)}`, "info");
    }
    if (state.pane === "messages") {
      renderConvs();
      updateRequestCount();
    }
    refreshBadges();
    return;
  }
  if (event === "dm_request") {
    loadConversations().catch(() => {});
    refreshBadges();
    return;
  }
  if (event === "dm_request_update") {
    const conv = convById(data?.id);
    if (conv) {
      conv.status = data.status;
      conv.requestedBy = data.requestedBy || conv.requestedBy;
      conv.respondedAt = data.respondedAt || conv.respondedAt;
    }
    loadConversations().catch(() => {});
    if (state.activeConv && String(state.activeConv.id) === String(data?.id)) {
      if (data?.status === "accepted") refreshThread(state.activeConv).catch(() => {});
      else {
        paintRequestBar();
        paintConvHead();
      }
    }
    refreshBadges();
    return;
  }
  if (event === "dm_read") {
    const conv = convById(data?.conversationId);
    if (!conv) return;
    conv.peerLastReadSeq = Math.max(Number(conv.peerLastReadSeq || 0), Number(data.lastReadSeq || 0));
    conv.peerLastReadAt = data.lastReadAt || conv.peerLastReadAt;
    if (state.activeConv?.id === conv.id) renderMessages(true);
    return;
  }
  if (event === "friend_request") {
    toast(t("social.kind.friend_request"), "info");
    refreshFriendsSoon();
    return;
  }
  if (event === "friend_accept" || event === "friend_added") {
    toast(t("social.kind.friend_accept"), "success");
    refreshFriendsSoon();
    return;
  }
  if (event === "friend_removed" || event === "friend_request_update") {
    refreshFriendsSoon();
    return;
  }
  if (event === "poll_update") {
    applyPollUpdate(data);
    return;
  }
  if (event === "poll_removed") {
    if (data?.id) {
      state.polls = state.polls.filter((poll) => poll.id !== data.id);
      if (state.pane === "polls") renderPolls();
    }
    return;
  }
  if (event === "support_reply") {
    if (state.activeTicket && String(state.activeTicket.id) === String(data?.ticketId)) {
      openTicket(state.activeTicket.id).catch(() => {});
    }
    return;
  }
  if (event === "notification") {
    const notif = data && typeof data === "object" ? data : {};
    const dedicated = ["dm_message", "friend_request", "friend_accept"].includes(notif.kind);
    if (notif.title && !dedicated) toast(notif.title, "info");
    browserPush(notif.title, notif.body, notif.link);
    if (state.pane === "notifications") loadNotifications(true).catch(() => {});
    refreshBadges();
    if (notif.kind === "support_update" || notif.kind === "support_reply" || notif.kind === "support_new") {
      loadTickets(true).catch(() => {});
      if (state.activeTicket) openTicket(state.activeTicket.id).catch(() => {});
    }
  }
}

function applyPollUpdate(data) {
  if (!data?.id) return;
  const poll = state.polls.find((item) => item.id === data.id);
  if (!poll) {
    if (state.pollsLoaded && state.pollsRoom && data.roomCode === state.pollsRoom) {
      loadPolls(true).catch(() => {});
    }
    return;
  }
  poll.closed = Boolean(data.closed);
  if (data.closesAt) poll.closesAt = data.closesAt;
  poll.totalVotes = Number(data.totalVotes || 0);
  const counts = new Map((data.options || []).map((option) => [option.id, Number(option.votes || 0)]));
  for (const option of poll.options || []) {
    if (counts.has(option.id)) option.votes = counts.get(option.id);
  }
  if (state.pane === "polls") renderPolls();
}
