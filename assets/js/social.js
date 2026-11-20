import { initI18n, t, getLang, fmtNumber } from "./i18n.js";
import {
  $, $$, el, toast, initials, applyUIPrefs, registerServiceWorker,
  confirmDialog, copyText
} from "./core.js";
import { apiFetch, apiGetToken, apiConnectSocket } from "./api.js";
import { avatarSrc } from "./avatars.js";
import { loadSiteConfig, applySiteConfig, listenLiveConfig } from "./site-config.js";

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
  activeConv: null,
  messages: [],
  notifs: [],
  notifPrefs: {},
  notifUnread: 0,
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
  wsRetry: 0
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
  if (src) box.append(el("img", { src, alt: "", loading: "lazy" }));
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
  $$("#socialNav button").forEach((node) => node.classList.toggle("active", node.dataset.pane === pane));
  $$(".social-pane").forEach((node) => { node.hidden = node.dataset.pane !== pane; });
  document.title = `${t(`social.nav.${pane}`)} — هم‌تماشا`;
  if (push) {
    try { history.replaceState(null, "", `#${pane}`); } catch {}
  }
  loadPane(pane);
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
    else if (pane === "support") await loadTickets();
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

$("#dmSearch")?.addEventListener("input", renderConvs);
$("#dmShowArchived")?.addEventListener("change", renderConvs);
$("#dmBack")?.addEventListener("click", closeThread);
$("#dmInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendDm();
  }
});
$("#dmInput")?.addEventListener("input", (event) => {
  const area = event.target;
  area.style.height = "auto";
  area.style.height = `${Math.min(120, area.scrollHeight)}px`;
});
$("#dmForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  sendDm();
});
$("#dmMuteBtn")?.addEventListener("click", () => toggleConvPref("muted"));
$("#dmArchiveBtn")?.addEventListener("click", () => toggleConvPref("archived"));

async function loadConversations() {
  const data = await api("/social/dm", { quiet: true });
  state.convs = data.conversations || [];
  renderConvs();
  if (state.activeConv) {
    const fresh = state.convs.find((item) => item.id === state.activeConv.id);
    if (fresh) {
      state.activeConv = fresh;
      paintConvHead();
    }
  }
}

async function openDmWith(user) {
  try {
    const data = await api("/social/dm", { method: "POST", body: { username: user.username } });
    const conv = data.conversation;
    const existing = state.convs.find((item) => item.id === conv.id);
    if (!existing) state.convs.unshift(conv);
    switchPane("messages");
    await selectConv(existing || conv);
  } catch {}
}

async function selectConv(conv) {
  state.activeConv = conv;
  $("#dmLayout").classList.add("has-thread");
  $("#dmHead").hidden = false;
  $("#dmEmpty").hidden = true;
  $("#dmForm").hidden = false;
  paintConvHead();
  renderConvs();
  try {
    const data = await api(`/social/dm/${enc(conv.id)}/messages?limit=50`);
    state.messages = data.messages || [];
  } catch {
    state.messages = [];
  }
  renderMessages();
  if ((conv.unread || 0) > 0) {
    conv.unread = 0;
    renderConvs();
    paintCount("countMessages", state.convs.filter((item) => !item.archived).reduce((n, item) => n + (item.unread || 0), 0));
    api(`/social/dm/${enc(conv.id)}/read`, { method: "POST", body: {}, quiet: true }).catch(() => {});
  }
}

function closeThread() {
  state.activeConv = null;
  state.messages = [];
  $("#dmLayout").classList.remove("has-thread");
  $("#dmHead").hidden = true;
  $("#dmForm").hidden = true;
  $("#dmStream").replaceChildren();
  $("#dmEmpty").hidden = false;
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
  const name = $("#dmPeerName");
  if (name) name.textContent = displayName(conv.peer);
  const user = $("#dmPeerUser");
  if (user) user.textContent = `@${conv.peer?.username || ""}`;
  const mute = $("#dmMuteBtn");
  if (mute) mute.textContent = conv.muted ? t("social.dmUnmute") : t("social.dmMute");
  const archive = $("#dmArchiveBtn");
  if (archive) archive.textContent = conv.archived ? t("social.dmUnarchive") : t("social.dmArchive");
}

function renderConvs() {
  const list = $("#convList");
  if (!list) return;
  const query = ($("#dmSearch")?.value || "").trim().toLowerCase();
  const showArchived = Boolean($("#dmShowArchived")?.checked);
  const items = state.convs.filter((conv) => {
    if (!showArchived && conv.archived) return false;
    if (!query) return true;
    const hay = `${conv.peer?.nick || ""} ${conv.peer?.username || ""} ${conv.lastMessage?.body || ""}`.toLowerCase();
    return hay.includes(query);
  });
  list.replaceChildren(...items.map((conv) => convRow(conv)));
  emptyState("convEmpty", items.length > 0);
}

function convRow(conv) {
  const li = el("li");
  const node = el("button", {
    type: "button",
    class: `conv-row${state.activeConv?.id === conv.id ? " active" : ""}`,
    onClick: () => selectConv(conv)
  });
  node.append(avatarEl(conv.peer));
  const main = el("div", { class: "conv-main" });
  const title = el("strong");
  title.append(document.createTextNode(displayName(conv.peer)));
  if (conv.muted) title.append(el("span", { class: "badge off", text: t("social.dmMutedBadge") }));
  if (conv.archived && $("#dmShowArchived")?.checked) title.append(el("span", { class: "badge off", text: t("social.dmArchivedBadge") }));
  main.append(title);
  const preview = el("small");
  const last = conv.lastMessage;
  preview.textContent = last ? (last.deleted ? t("social.dmDeleted") : String(last.body || "").slice(0, 80)) : "";
  main.append(preview);
  node.append(main);
  const side = el("div", { class: "conv-side" });
  side.append(el("span", { class: "conv-time", text: last ? fmtTime(last.createdAt) : fmtTime(conv.updatedAt) }));
  if ((conv.unread || 0) > 0) side.append(el("span", { class: "conv-unread", text: String(conv.unread) }));
  node.append(side);
  li.append(node);
  return li;
}

function renderMessages(keepScroll = false) {
  const stream = $("#dmStream");
  if (!stream) return;
  const top = stream.scrollTop;
  stream.replaceChildren(...state.messages.map((message) => messageNode(message)));
  if (keepScroll) stream.scrollTop = top;
  else stream.scrollTop = stream.scrollHeight;
}

function messageNode(message) {
  const mine = String(message.senderId) === String(state.me?.id);
  const bubble = el("article", { class: `dm-bubble${mine ? " mine" : ""}` });
  const body = el("div", { class: `dm-body${message.deletedAt ? " dm-deleted" : ""}` });
  body.textContent = message.deletedAt ? t("social.dmDeleted") : message.body;
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

  const meta = el("div", { class: "dm-meta" });
  meta.append(el("span", { text: fmtTime(message.createdAt) }));
  if (message.editedAt) meta.append(el("span", { text: t("social.dmEdited") }));
  if (!message.deletedAt) {
    const reactBtn = el("button", {
      type: "button",
      class: "dm-react-toggle",
      title: t("social.react"),
      text: "☺"
    });
    meta.append(reactBtn);
    if (mine) {
      meta.append(el("button", {
        type: "button",
        class: "dm-react-toggle",
        text: t("social.edit"),
        onClick: () => startMessageEdit(message, bubble)
      }));
      meta.append(el("button", {
        type: "button",
        class: "dm-react-toggle",
        text: t("social.delete"),
        onClick: () => deleteMessage(message)
      }));
    }
    const quick = el("div", { class: "dm-quick" });
    for (const emoji of REACTIONS) {
      quick.append(el("button", {
        type: "button",
        text: emoji,
        onClick: () => addReaction(message, emoji)
      }));
    }
    reactBtn.addEventListener("click", () => quick.classList.toggle("open"));
    bubble.append(quick);
  }
  bubble.append(meta);

  if (Array.isArray(message.reactions) && message.reactions.length) {
    const row = el("div", { class: "dm-reactions" });
    for (const reaction of message.reactions) {
      row.append(el("button", {
        type: "button",
        class: `dm-reaction${reaction.mine ? " mine" : ""}`,
        text: `${reaction.emoji} ${reaction.count}`,
        onClick: () => toggleReaction(message, reaction)
      }));
    }
    bubble.append(row);
  }
  return bubble;
}

async function sendDm() {
  const input = $("#dmInput");
  const conv = state.activeConv;
  if (!input || !conv) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  try {
    const data = await api(`/social/dm/${enc(conv.id)}/messages`, { method: "POST", body: { body: text } });
    if (!state.messages.some((item) => item.id === data.message.id)) state.messages.push(data.message);
    conv.lastMessage = {
      id: data.message.id,
      senderId: data.message.senderId,
      body: data.message.body,
      deleted: false,
      createdAt: data.message.createdAt
    };
    conv.updatedAt = data.message.createdAt;
    renderMessages();
    renderConvs();
  } catch {
    input.value = text;
  }
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
  const ok = await confirmDialog({ title: t("social.delete"), text: t("social.confirmDeleteMessage"), okLabel: t("social.delete") });
  if (!ok) return;
  try {
    await api(`/social/dm/messages/${enc(message.id)}`, { method: "DELETE" });
    message.deletedAt = Date.now();
    if (state.activeConv?.lastMessage?.id === message.id) {
      state.activeConv.lastMessage = { ...state.activeConv.lastMessage, body: "", deleted: true };
      renderConvs();
    }
    renderMessages(true);
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

async function loadNotifications(quiet = false) {
  const data = await api("/social/notifications?limit=40", { quiet });
  state.notifs = data.notifications || [];
  state.notifUnread = Number(data.unread || 0);
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
    main.append(el("strong", { text: notif.title || notif.kind }));
    if (notif.body) main.append(el("small", { text: notif.body, dir: "auto" }));
    main.append(el("small", { text: ago(notif.createdAt) }));
    li.append(main);
    if (!notif.read) {
      li.append(el("div", { class: "person-actions" }, [
        smallBtn(t("social.markRead"), "ghost", () => markNotifRead(notif))
      ]));
    }
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
  } catch {}
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

$("#ticketForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const msg = $("#ticketMsg");
  const subject = ($("#ticketSubject")?.value || "").trim();
  if (subject.length < 3) {
    if (msg) msg.textContent = t("social.supportSubject");
    return;
  }
  try {
    const data = await api("/social/support/tickets", {
      method: "POST",
      body: {
        subject,
        category: $("#ticketCategory")?.value || "general",
        priority: $("#ticketPriority")?.value || "normal",
        body: $("#ticketBody")?.value.trim() || ""
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
  if (!ticket || !body) return;
  try {
    await api(`/social/support/tickets/${enc(ticket.id)}/messages`, { method: "POST", body: { body } });
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
      body: { status: $("#ticketStatus")?.value, priority: $("#ticketStatusPriority")?.value }
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
  $("#ticketDetailMeta").textContent = `${t(`social.status.${ticket.status}`)} · ${t(`social.priority.${ticket.priority}`)} · ${ago(ticket.createdAt)}`;
  const msgs = $("#ticketMsgs");
  msgs.replaceChildren(...(ticket.messages || []).map((message) => {
    const mineStaff = String(message.author?.id) !== String(ticket.userId);
    const node = el("div", { class: `ticket-msg${mineStaff ? " staff" : ""}` });
    const meta = el("div", { class: "dm-meta" });
    meta.append(el("strong", { text: displayName(message.author) }));
    if (mineStaff) meta.append(el("span", { class: "badge", text: t("social.staffBadge") }));
    meta.append(el("span", { text: fmtTime(message.createdAt) }));
    node.append(meta);
    node.append(el("div", { text: message.body, dir: "auto" }));
    return node;
  }));
  $("#ticketStaffRow").hidden = !state.staff;
  if (state.staff) {
    $("#ticketStatus").value = ticket.status;
    $("#ticketStatusPriority").value = ticket.priority;
  }
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
          state.wsReady = true;
          state.wsRetry = 0;
          paintWs();
          return;
        }
        if (data?.type === "social") handleSocialEvent(data);
      },
      onClose() {
        if (state.ws === socket) {
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

function handleSocialEvent(payload) {
  const event = payload.event;
  const data = payload.data;
  if (event === "dm_message_updated") {
    if (!data?.id) return;
    const conv = state.convs.find((item) => item.id === data.conversationId);
    const message = state.messages.find((item) => item.id === data.id);
    if (message) {
      message.body = data.body;
      message.editedAt = data.editedAt;
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
    if (!message?.conversationId) return;
    const conv = state.convs.find((item) => item.id === message.conversationId);
    if (conv) {
      conv.lastMessage = {
        id: message.id,
        senderId: message.senderId,
        body: message.body,
        deleted: Boolean(message.deletedAt),
        createdAt: message.createdAt
      };
      conv.updatedAt = message.createdAt;
      const mine = String(message.senderId) === String(state.me?.id);
      if (state.activeConv?.id === conv.id) {
        if (!state.messages.some((item) => item.id === message.id)) {
          state.messages.push(message);
          if (state.pane === "messages") renderMessages();
          api(`/social/dm/${enc(conv.id)}/read`, { method: "POST", body: {}, quiet: true }).catch(() => {});
        }
        conv.unread = 0;
      } else if (!mine) {
        conv.unread = (conv.unread || 0) + 1;
      }
      if (!mine && !conv.muted) {
        toast(`${displayName(conv.peer)}: ${String(message.body || "").slice(0, 70)}`, "info");
      }
      if (state.pane === "messages") renderConvs();
    } else {
      loadConversations().catch(() => {});
    }
    refreshBadges();
    return;
  }
  if (event === "friend_request") {
    toast(t("social.kind.friend_request"), "info");
    loadPeoplePane().catch(() => {});
    refreshBadges();
    return;
  }
  if (event === "friend_accept") {
    toast(t("social.kind.friend_accept"), "success");
    loadPeoplePane().catch(() => {});
    refreshBadges();
    return;
  }
  if (event === "poll_update") {
    if (state.pollsLoaded && data?.roomCode && data.roomCode === state.pollsRoom) {
      loadPolls(true).catch(() => {});
    }
    return;
  }
  if (event === "notification") {
    if (state.pane === "notifications") loadNotifications(true).catch(() => {});
    else refreshBadges();
  }
}
