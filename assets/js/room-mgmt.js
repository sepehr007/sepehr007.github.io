import { t } from "./i18n.js";
import { el, toast, confirmDialog, copyText } from "./core.js";
import { apiFetch, apiGetToken, apiConnectSocket } from "./api.js";

const ROLE_KEY = {
  host: "room.roleManager",
  moderator: "room.roleModerator",
  guest: "room.roleGuest",
  member: "room.roleMember"
};

const state = {
  code: "",
  nick: "",
  me: null,
  room: null,
  members: [],
  ws: null,
  wsClosed: false,
  retry: 0,
  touch: 0,
  onEvent: null,
  busy: false
};

export function getRoomMgmt() {
  return state;
}

function enc(value) {
  return encodeURIComponent(String(value || ""));
}

function errorText(err) {
  const code = String(err?.code || "");
  const key = `social.err.${code}`;
  const text = t(key);
  if (text !== key) return text;
  if (code === "room_full") return t("rooms.errFull");
  if (code === "private_room") return t("rooms.errPrivate");
  if (code === "wrong_password") return t("rooms.errPassword");
  if (err?.status === 403) return t("social.err.forbidden");
  if (err?.status === 429) return t("social.err.rate_limited");
  if (code === "network_error" || code === "timeout" || code === "not_configured") return t("social.gateServer");
  return t("social.failed");
}

function roleLabel(role) {
  return t(ROLE_KEY[role] || "room.roleGuest");
}

function memberName(member) {
  const name = String(member?.nick || member?.username || "—");
  return state.me && String(member?.userId) === String(state.me.id) ? `${name} ${t("room.you")}` : name;
}

/* -------------------------------------------------------------------- load */

async function loadRoom({ join = false } = {}) {
  try {
    const res = await apiFetch(`/rooms/${enc(state.code)}`, { timeoutMs: 10000 });
    if (!res?.room) return false;
    if (res.room.isActive === false) {
      state.room = null;
      state.wsClosed = true;
      document.getElementById("roomMgmtHost")?.replaceChildren();
      toast(t("room.closedToast"), "error", 6000);
      state.onEvent?.({ type: "room-event", event: "closed", code: state.code });
      return false;
    }
    state.room = res.room;
    if (join && !res.room.isMember) {
      let password = "";
      try { password = sessionStorage.getItem(`pwd:${state.code}`) || ""; } catch {}
      try {
        await apiFetch(`/rooms/${enc(state.code)}/join`, { method: "POST", body: { password }, timeoutMs: 12000 });
        const fresh = await apiFetch(`/rooms/${enc(state.code)}`, { timeoutMs: 10000 });
        if (fresh?.room) state.room = fresh.room;
      } catch {}
    }
    state.members = await loadMembers();
    return true;
  } catch (err) {
    if (err?.status === 401) toast(errorText(err), "error");
    return false;
  }
}

async function loadMembers() {
  try {
    const res = await apiFetch(`/rooms/${enc(state.code)}/members`, { timeoutMs: 10000 });
    return Array.isArray(res?.members) ? res.members : [];
  } catch {
    return state.members;
  }
}

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    await loadRoom();
    render();
  } finally {
    state.busy = false;
  }
}

/* --------------------------------------------------------------- realtime */

function connect() {
  if (!apiGetToken()) return;
  const ws = apiConnectSocket({
    onMessage: (data) => handleSocket(data),
    onClose: () => {
      state.ws = null;
      if (!state.wsClosed && !document.hidden) {
        state.retry = Math.min(30, (state.retry || 0) + 1);
        setTimeout(connect, state.retry * 2000);
      }
    }
  });
  if (!ws) return;
  state.ws = ws;
  ws.addEventListener("open", () => {
    state.retry = 0;
    try {
      ws.send(JSON.stringify({ type: "identify", token: apiGetToken() }));
      ws.send(JSON.stringify({ type: "join", room: state.code, name: state.nick || "guest" }));
    } catch {}
  });
}

function handleSocket(data) {
  if (!data || typeof data !== "object") return;
  if (data.type === "room-event") {
    if (data.event === "manager") {
      refresh();
      const name = data.manager?.nick || data.manager?.username || "";
      toast(t("room.managerChanged", { name }), "info", 6000);
      state.onEvent?.(data);
    } else if (data.event === "closed") {
      state.onEvent?.(data);
    } else if (["updated", "member-removed", "member-role", "joined", "left"].includes(data.event)) {
      refresh();
    }
    return;
  }
  if (data.type === "room") {
    if (data.event === "removed") {
      state.onEvent?.(data);
    } else if (data.event === "manager-promoted") {
      toast(t("room.youAreManager"), "success", 7000);
      refresh();
    } else if (data.event === "manager-transferred") {
      refresh();
    } else if (data.event === "guest-joined") {
      refresh();
    } else if (data.event === "role") {
      refresh();
    }
  }
}

function startTouch() {
  clearInterval(state.touch);
  state.touch = setInterval(() => {
    if (document.hidden) return;
    apiFetch(`/rooms/${enc(state.code)}/touch`, { method: "POST", body: {}, timeoutMs: 8000 }).catch(() => {});
  }, 60000);
}

/* ------------------------------------------------------------------ render */

function field(labelKey, input, cls = "") {
  return el("label", { class: `mgmt-field ${cls}`.trim() }, [el("span", { text: t(labelKey) }), input]);
}

function textInput(value, attrs = {}) {
  const input = el("input", { type: "text", ...attrs });
  input.value = value ?? "";
  return input;
}

function render() {
  const host = document.getElementById("roomMgmtHost");
  if (!host || !state.room) return;
  const room = state.room;
  const canManage = Boolean(room.canManage);
  const canModerate = Boolean(room.canModerate);
  host.replaceChildren();

  const card = el("section", { class: "mgmt-card" });
  const head = el("div", { class: "mgmt-head" });
  head.append(el("strong", { text: t("room.mgmtTitle") }));
  const viewerRole = room.viewerRole || (canManage ? "host" : "");
  if (viewerRole || canManage) head.append(el("span", { class: "mgmt-role-badge", text: roleLabel(canManage ? "host" : viewerRole) }));
  card.append(head);
  card.append(el("p", { class: "hint mgmt-hint", text: t("room.mgmtP2PNote") }));

  const info = el("div", { class: "mgmt-meta" });
  info.append(el("span", { text: `${t("room.infoManager")}: ${room.manager?.nick || room.manager?.username || "—"}` }));
  info.append(el("span", { text: `${t("room.infoMembers")}: ${room.memberCount || state.members.length}` }));
  info.append(el("span", { text: room.visibility === "private" ? t("rooms.privateBadge") : room.visibility === "unlisted" ? t("rooms.visUnlisted") : t("rooms.visPublic") }));
  if (room.hasPassword) info.append(el("span", { text: t("rooms.passwordBadge") }));
  card.append(info);

  if (room.rules) {
    card.append(el("h3", { class: "mgmt-sub", text: t("room.rulesTitle") }));
    card.append(el("p", { class: "mgmt-rules", text: room.rules }));
  } else {
    card.append(el("p", { class: "hint", text: t("room.noRules") }));
  }

  /* members */
  if (state.members.length) {
    card.append(el("h3", { class: "mgmt-sub", text: t("room.memberList") }));
    const list = el("div", { class: "mgmt-members" });
    for (const member of state.members) {
      const row = el("div", { class: "mgmt-member" });
      const main = el("div", { class: "mgmt-member-main" });
      main.append(el("b", { text: memberName(member) }));
      main.append(el("small", { text: "@" + (member.username || "") }));
      row.append(main);

      const isHost = member.role === "host" || String(member.userId) === String(room.manager?.id);
      const isSelf = state.me && String(member.userId) === String(state.me.id);
      if (canManage && !isHost) {
        const select = el("select", { class: "mgmt-role-select", "aria-label": t("room.memberList") });
        for (const value of ["moderator", "member", "guest"]) {
          const option = el("option", { value, text: roleLabel(value) });
          if (member.role === value) option.selected = true;
          select.append(option);
        }
        if (!["moderator", "member", "guest"].includes(member.role)) select.value = "guest";
        select.addEventListener("change", () => setRole(member, select.value, select));
        row.append(select);
      } else {
        row.append(el("span", { class: "mgmt-role-badge", text: roleLabel(member.role) }));
      }

      const canKick = !isHost && !isSelf && (canManage || (canModerate && member.role !== "moderator"));
      if (canKick) {
        row.append(el("button", {
          type: "button",
          class: "btn btn-ghost btn-sm danger-text",
          text: t("room.memberRemove"),
          onClick: () => kick(member)
        }));
      }
      list.append(row);
    }
    card.append(list);
  }

  if (canManage) {
    card.append(buildEditor(room));
    card.append(buildInvite(room));
    if (state.members.some((m) => m.role !== "host" && String(m.userId) !== String(state.me?.id))) {
      card.append(buildTransfer());
    }
    card.append(buildClose());
  }

  host.append(card);
}

function buildEditor(room) {
  const box = el("div", { class: "mgmt-block" });
  box.append(el("h3", { class: "mgmt-sub", text: t("room.editSection") }));

  const grid = el("div", { class: "mgmt-grid" });
  const name = textInput(room.name, { maxlength: "80" });
  const capacity = el("input", { type: "number", min: "2", max: "48", dir: "ltr" });
  capacity.value = String(room.capacity || 6);
  const visibility = el("select", {});
  for (const value of ["public", "unlisted", "private"]) {
    const label = value === "public" ? t("rooms.visPublic") : value === "unlisted" ? t("rooms.visUnlisted") : t("rooms.visPrivate");
    visibility.append(el("option", { value, text: label }));
  }
  visibility.value = room.visibility || "public";
  const color = el("input", { type: "color", value: room.color || "#6c5cff" });
  grid.append(field("room.editName", name));
  grid.append(field("room.editCapacity", capacity));
  grid.append(field("room.editVisibility", visibility));
  grid.append(field("room.editColor", color));

  const desc = el("textarea", { rows: "2", maxlength: "600" });
  desc.value = room.description || "";
  const rules = el("textarea", { rows: "3", maxlength: "2000" });
  rules.value = room.rules || "";
  grid.append(field("room.editDesc", desc, "wide"));
  grid.append(field("room.editRules", rules, "wide"));

  const pwd = el("input", { type: "password", maxlength: "64", dir: "ltr", placeholder: t("rooms.passwordPh") });
  const removePwd = el("input", { type: "checkbox" });
  if (!room.hasPassword) removePwd.disabled = true;
  const pwdRow = el("label", { class: "mgmt-check" }, [
    removePwd,
    el("span", { text: t("room.removePassword") })
  ]);
  grid.append(field("rooms.password", pwd, "wide"));
  grid.append(pwdRow);

  const save = el("button", { type: "button", class: "btn btn-primary btn-sm", text: t("room.save") });
  save.addEventListener("click", async () => {
    const patch = {
      name: name.value.trim(),
      description: desc.value.trim(),
      rules: rules.value.trim(),
      color: color.value,
      visibility: visibility.value,
      capacity: Number(capacity.value) || 6
    };
    if (removePwd.checked) patch.password = "";
    else if (pwd.value) patch.password = pwd.value;
    save.disabled = true;
    try {
      const res = await apiFetch(`/rooms/${enc(state.code)}`, { method: "PATCH", body: patch, timeoutMs: 12000 });
      if (res?.room) state.room = res.room;
      toast(t("room.saved"), "success");
      refresh();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      save.disabled = false;
    }
  });

  box.append(grid, save);
  return box;
}

function buildInvite(room) {
  const box = el("div", { class: "mgmt-block" });
  box.append(el("h3", { class: "mgmt-sub", text: t("rooms.inviteTitle") }));
  box.append(el("p", { class: "hint", text: t("room.inviteLinkHint") }));

  const row = el("div", { class: "mgmt-inline" });
  const hours = el("input", { type: "number", min: "1", max: "720", value: "24", dir: "ltr", "aria-label": t("social.inviteHours") });
  const uses = el("input", { type: "number", min: "0", max: "1000", value: "1", dir: "ltr", "aria-label": t("social.inviteUses") });
  const create = el("button", { type: "button", class: "btn btn-secondary btn-sm", text: t("rooms.inviteCreate") });
  row.append(field("social.inviteHours", hours), field("social.inviteUses", uses), create);

  const linkWrap = el("div", { class: "mgmt-link hidden" });
  const linkInput = el("input", { type: "text", readonly: "", dir: "ltr" });
  const copy = el("button", { type: "button", class: "btn btn-secondary btn-sm", text: t("social.copy") });
  linkWrap.append(linkInput, copy);

  create.addEventListener("click", async () => {
    create.disabled = true;
    try {
      const res = await apiFetch(`/rooms/${enc(state.code)}/invites`, {
        method: "POST",
        body: { expiresInHours: Number(hours.value) || 24, maxUses: Number(uses.value) || 0 },
        timeoutMs: 12000
      });
      const invite = res?.invite;
      if (!invite?.code) throw new Error("no invite");
      const link = new URL(`rooms.html?room=${enc(state.code)}&invite=${enc(invite.code)}`, document.baseURI).href;
      linkInput.value = link;
      linkWrap.classList.remove("hidden");
      try {
        await copyText(link);
        toast(t("rooms.inviteCopied"), "success");
      } catch {}
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      create.disabled = false;
    }
  });
  copy.addEventListener("click", async () => {
    try {
      await copyText(linkInput.value);
      toast(t("rooms.inviteCopied"), "success");
    } catch {}
  });

  box.append(row, linkWrap);
  return box;
}

function buildTransfer() {
  const box = el("div", { class: "mgmt-block" });
  box.append(el("h3", { class: "mgmt-sub", text: t("room.transferTitle") }));
  box.append(el("p", { class: "hint", text: t("room.transferHint") }));

  const select = el("select", {});
  for (const member of state.members) {
    if (member.role === "host" || String(member.userId) === String(state.me?.id)) continue;
    select.append(el("option", { value: member.userId, text: member.nick || member.username }));
  }
  const pwd = el("input", { type: "password", maxlength: "64", dir: "ltr", placeholder: t("room.transferPassword") });
  const button = el("button", { type: "button", class: "btn btn-secondary btn-sm", text: t("room.transferCta") });
  const row = el("div", { class: "mgmt-inline" });
  row.append(field("room.transferTo", select), field("room.transferPassword", pwd), button);

  button.addEventListener("click", async () => {
    const target = state.members.find((m) => String(m.userId) === String(select.value));
    const name = target?.nick || target?.username || "";
    if (!name) return;
    const ok = await confirmDialog({
      title: t("room.transferTitle"),
      text: t("room.transferConfirm", { name }),
      okLabel: t("room.transferCta")
    });
    if (!ok) return;
    button.disabled = true;
    try {
      await apiFetch(`/rooms/${enc(state.code)}/transfer`, {
        method: "POST",
        body: { userId: select.value, password: pwd.value },
        timeoutMs: 15000
      });
      toast(t("room.transferDone", { name }), "success", 6000);
      toast(t("room.transferP2PNote"), "info", 8000);
      await refresh();
      state.onEvent?.({ type: "room-event", event: "manager", manager: target });
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      button.disabled = false;
    }
  });

  box.append(row);
  return box;
}

function buildClose() {
  const box = el("div", { class: "mgmt-block" });
  box.append(el("h3", { class: "mgmt-sub", text: t("room.closeTitle") }));
  box.append(el("p", { class: "hint", text: t("room.closeHint") }));
  const pwd = el("input", { type: "password", maxlength: "64", dir: "ltr", placeholder: t("room.closePassword") });
  const button = el("button", { type: "button", class: "btn btn-ghost danger-text btn-sm", text: t("room.closeCta") });
  const row = el("div", { class: "mgmt-inline single" });
  row.append(field("room.closePassword", pwd), button);

  button.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: t("room.closeTitle"),
      text: t("room.closeConfirm"),
      okLabel: t("room.closeCta")
    });
    if (!ok) return;
    button.disabled = true;
    try {
      await apiFetch(`/rooms/${enc(state.code)}`, { method: "DELETE", body: { password: pwd.value }, timeoutMs: 15000 });
      toast(t("room.closedToast"), "success");
      state.onEvent?.({ type: "room-event", event: "closed", code: state.code });
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      button.disabled = false;
    }
  });

  box.append(row);
  return box;
}

async function setRole(member, role, select) {
  select.disabled = true;
  try {
    await apiFetch(`/rooms/${enc(state.code)}/members/${enc(member.userId)}/role`, {
      method: "POST",
      body: { role },
      timeoutMs: 12000
    });
    toast(t("room.saved"), "success");
    await refresh();
  } catch (err) {
    toast(errorText(err), "error");
    select.value = member.role;
    select.disabled = false;
  }
}

async function kick(member) {
  const name = member.nick || member.username || "";
  const ok = await confirmDialog({
    title: t("room.memberRemove"),
    text: t("room.kickConfirm", { name }),
    okLabel: t("room.memberRemove")
  });
  if (!ok) return;
  try {
    await apiFetch(`/rooms/${enc(state.code)}/members/${enc(member.userId)}/kick`, {
      method: "POST",
      body: {},
      timeoutMs: 12000
    });
    toast(t("room.kickedToast", { name }), "success");
    await refresh();
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/* -------------------------------------------------------------------- boot */

export async function initRoomMgmt({ code, nick, onEvent } = {}) {
  if (!code || !apiGetToken()) return null;
  state.code = String(code).toUpperCase();
  state.nick = String(nick || "");
  state.onEvent = onEvent || null;
  try {
    const me = await apiFetch("/auth/me", { timeoutMs: 8000 });
    state.me = me?.user || null;
  } catch {
    return null;
  }
  if (!state.me) return null;
  const ok = await loadRoom({ join: true });
  if (!ok) return null;
  render();
  startTouch();
  connect();
  document.addEventListener("langchange", () => render());
  window.addEventListener("wt:room-pwd", () => { loadRoom({ join: true }).then(() => render()); });
  window.addEventListener("pagehide", () => {
    state.wsClosed = true;
    clearInterval(state.touch);
    try { state.ws?.close(); } catch {}
  });
  return state.room;
}
