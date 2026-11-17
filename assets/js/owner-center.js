import { el, store, toast } from "./core.js";
import {
  CONFIG_REGISTRY, NAV_GROUPS, PAGE_DEFS, pageDef, configMeta,
  DEFAULT_ROLES, PERMISSION_SCOPES, PERMISSIONS, FEATURE_DEFS
} from "./owner-registry.js";
import { readAudit, logAudit, auditCountSince, clearAudit } from "./owner-audit.js";
import { SITE_CONFIG_DEFAULTS } from "./site-config.js";
import { ACCENTS } from "./core.js";

const DATA_KEY = "wt.ownerData";
const UI_KEY = "wt.ownerUi";
const AUDIT_LABELS = {
  config: "تغییر تنظیمات",
  security: "امنیت",
  user: "کاربر",
  feature: "قابلیت",
  role: "نقش",
  permission: "دسترسی",
  plan: "اشتراک",
  publish: "انتشار",
  backup: "پشتیبان",
  system: "سیستم",
  action: "اقدام"
};

/* ---------------- shared state helpers ---------------- */

export function getUi() {
  const ui = store.get(UI_KEY, null);
  return ui && typeof ui === "object" ? { view: "dashboard", collapsed: false, notifSeen: 0, ...ui } : { view: "dashboard", collapsed: false, notifSeen: 0 };
}
export function setUi(patch) {
  store.set(UI_KEY, { ...getUi(), ...patch });
}

function readData() {
  const raw = store.get(DATA_KEY, null);
  return raw && typeof raw === "object" ? raw : {};
}
function writeData(patch) {
  store.set(DATA_KEY, { ...readData(), ...patch });
}

export function readRoles() {
  const custom = readData().roles;
  return Array.isArray(custom) && custom.length ? custom : [...DEFAULT_ROLES];
}
export function readPlans() {
  const plans = readData().plans;
  return Array.isArray(plans) ? plans : defaultPlans();
}
function defaultPlans() {
  const p = SITE_CONFIG_DEFAULTS.plans;
  return [{
    id: "premium",
    name: "پریمیوم",
    priceFa: p.premiumPriceFa,
    priceEn: p.premiumPriceEn,
    interval: "ماهانه",
    visibility: p.premiumEnabled ? "public" : "hidden",
    rooms: 2,
    members: 24,
    storageMb: 2048,
    benefits: ["همهٔ قابلیت‌های فعلی", "پشتیبانی اولویت‌دار"],
    archived: false,
    createdAt: Date.now()
  }];
}

const PERMISSION_DEFAULTS = {
  super_owner: Object.fromEntries(PERMISSIONS.map((p) => [p.id, "allow"])),
  administrator: Object.fromEntries(PERMISSIONS.map((p) => [p.id, p.id === "manageSystem" ? "inherit" : "allow"])),
  moderator: Object.fromEntries(PERMISSIONS.map((p) => [p.id, ["view", "moderate", "ban", "manageContent"].includes(p.id) ? "allow" : "inherit"])),
  room_owner: Object.fromEntries(PERMISSIONS.map((p) => [p.id, ["view", "create", "edit", "manageRooms"].includes(p.id) ? "allow" : "inherit"])),
  member: Object.fromEntries(PERMISSIONS.map((p) => [p.id, p.id === "view" ? "allow" : "inherit"])),
  guest: Object.fromEntries(PERMISSIONS.map((p) => [p.id, p.id === "view" ? "allow" : "deny"]))
};

export function effectivePermission(scope, roleId, permId) {
  const stored = readData().permissions?.[scope]?.[roleId]?.[permId];
  if (stored) return stored;
  return scope === "role" || scope === "global" ? (PERMISSION_DEFAULTS[roleId]?.[permId] || "inherit") : "inherit";
}

/* ---------------- DOM helpers ---------------- */

function card(title, hint) {
  const node = el("article", { class: "ocard" });
  if (title) node.append(el("h2", { text: title }));
  if (hint) node.append(el("p", { class: "ohint", text: hint }));
  return node;
}
function honesty(text, title = "مرز صادقانه") {
  const node = el("article", { class: "ocard honesty" });
  node.append(el("h2", { text: title }), el("p", { text }));
  return node;
}
function tag(text, kind = "") {
  return el("span", { class: `tag ${kind}`.trim(), text });
}
function emptyRow(tbody, cols, text) {
  const tr = el("tr");
  tr.append(el("td", { class: "empty", colspan: String(cols), text }));
  tbody.append(tr);
}
function table(head, rows) {
  const wrap = el("div", { class: "table-wrap" });
  const t = el("table", { class: "otable" });
  const thead = el("thead");
  const htr = el("tr");
  for (const h of head) htr.append(el("th", { text: h }));
  thead.append(htr);
  const tbody = el("tbody");
  t.append(thead, tbody);
  wrap.append(t);
  return { wrap, tbody };
}
function miniBtn(text, onClick, danger = false) {
  return el("button", { class: `mini-btn${danger ? " danger" : ""}`, type: "button", text, onclick: onClick });
}
function cfgSwitch(label, path, checked, text) {
  const wrap = el("label", { class: "switch-line" });
  const input = el("input", { type: "checkbox" });
  input.checked = checked;
  input.dataset.cfg = path;
  wrap.append(input, el("span", { text: text || label }));
  return wrap;
}
function cfgField(label, path, type = "text", extra = {}) {
  const wrap = el("label", { class: "ofield" });
  wrap.append(el("span", { text: label }));
  const input = el("input", { type });
  input.dataset.cfg = path;
  Object.assign(input, extra.attrs || {});
  wrap.append(input);
  return wrap;
}
function foundationList(items) {
  const list = el("ul", { class: "ofnd-list" });
  for (const item of items) list.append(el("li", { text: item }));
  return list;
}

/* ---------------- modal ---------------- */

let modalEl = null;
function showModal(title, bodyNodes, actions = []) {
  closeModal();
  modalEl = el("div", { class: "ow-modal-back" });
  const box = el("div", { class: "ow-modal", role: "dialog", "aria-modal": "true" });
  const head = el("div", { class: "ow-modal-head" });
  head.append(el("h3", { text: title }));
  const close = el("button", { class: "mini-btn", type: "button", text: "بستن", onclick: closeModal });
  head.append(close);
  const body = el("div", { class: "ow-modal-body" });
  for (const node of [].concat(bodyNodes)) if (node) body.append(node);
  const foot = el("div", { class: "ow-modal-foot" });
  for (const a of actions) foot.append(a);
  box.append(head, body, foot);
  modalEl.append(box);
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) closeModal(); });
  document.body.append(modalEl);
  return box;
}
function closeModal() {
  modalEl?.remove();
  modalEl = null;
}

/* ---------------- center factory ---------------- */

export function createCenter(ctx) {
  const renderers = {};
  const freshExt = new Set();
  const repaintExtras = () => freshExt.forEach((fn) => fn());

  /* ----- navigation ----- */
  function buildNav() {
    const nav = document.getElementById("osNav");
    if (!nav) return;
    nav.replaceChildren();
    for (const group of NAV_GROUPS) {
      const items = PAGE_DEFS.filter((p) => p.group === group.id);
      if (!items.length) continue;
      const g = el("div", { class: "os-group" });
      g.append(el("span", { class: "os-group-lbl", text: group.label }));
      for (const item of items) {
        const btn = el("button", { type: "button", "data-nav": item.view, "data-page": item.id });
        btn.append(el("span", { class: "ni", text: item.icon }), el("span", { class: "os-lbl", text: item.label }));
        g.append(btn);
      }
      nav.append(g);
    }
  }

  /* ----- dashboard ----- */
  function refreshDashboard() {
    const users = ctx.readUsers();
    const bans = ctx.readBans();
    const audit = readAudit();
    const draft = ctx.getDraft();
    const set = (id, value) => {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    };
    set("dashUsers", String(Object.keys(users).length));
    set("dashBans", String(bans.length));
    set("dashEvents", String(audit.length));
    const featuresOn = FEATURE_DEFS.filter((f) => draft?.features?.[f.key] !== false).length;
    set("dashFeatures", `${featuresOn}/${FEATURE_DEFS.length}`);
    set("dashChanges", ctx.isDirty() ? "تغییر ذخیره‌نشده منتشرشده" : "هم‌سان با نسخهٔ منتشرشده");

    const feed = document.getElementById("dashActivity");
    if (feed) {
      feed.replaceChildren();
      const merged = [
        ...audit.slice(0, 8).map((a) => ({ at: a.at, kind: a.kind, text: `${AUDIT_LABELS[a.kind] || a.kind} — ${a.action || a.target || ""}` })),
        ...ctx.readModLog().slice(0, 5).map((m) => ({ at: m.at, kind: "moderation", text: `${m.kind} ${m.detail || ""}` }))
      ].sort((a, b) => b.at - a.at).slice(0, 7);
      if (!merged.length) feed.append(el("div", { class: "log-empty", text: "هنوز رویدادی ثبت نشده است." }));
      for (const item of merged) {
        const row = el("div", { class: "log-item" });
        row.append(el("time", { text: new Date(item.at).toLocaleString("fa-IR") }), el("span", { text: item.text }));
        feed.append(row);
      }
    }
  }

  /* ----- users ----- */
  const userState = { q: "", status: "all", sort: "newest", selected: new Set() };
  renderers.users = (section) => {
    section.replaceChildren();
    const getUsers = () => Object.entries(ctx.readUsers()).map(([u, rec]) => ({ u, ...rec }));
    const bans = () => ctx.readBans();
    const wrap = card("کاربران این مرورگر", "حساب‌هایی که روی این دستگاه ساخته شده‌اند. حساب‌های سروری پس از اتصال API اینجا فهرست می‌شوند.");
    const bar = el("div", { class: "ow-toolbar" });
    const q = el("input", { type: "search", class: "ow-input", placeholder: "جستجوی نام، نام کاربری یا ایمیل…" });
    q.value = userState.q;
    q.addEventListener("input", () => { userState.q = q.value; paint(); });
    const status = el("select", { class: "ow-input" });
    status.append(el("option", { value: "all", text: "همه" }), el("option", { value: "active", text: "فعال" }), el("option", { value: "banned", text: "مسدود" }));
    status.value = userState.status;
    status.addEventListener("change", () => { userState.status = status.value; paint(); });
    const sort = el("select", { class: "ow-input" });
    sort.append(el("option", { value: "newest", text: "جدیدترین" }), el("option", { value: "name", text: "نام" }), el("option", { value: "username", text: "نام کاربری" }));
    sort.value = userState.sort;
    sort.addEventListener("change", () => { userState.sort = sort.value; paint(); });
    const bulkBan = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "مسدودسازی گروهی" });
    const bulkUnban = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "رفع مسدودی گروهی" });
    const bulkDel = el("button", { class: "btn btn-ghost btn-sm ow-danger", type: "button", text: "حذف گروهی" });
    bar.append(q, status, sort, bulkBan, bulkUnban, bulkDel);
    const { wrap: tbl, tbody } = table(["", "نام", "نام کاربری", "ایمیل", "نقش", "وضعیت", "تاریخ عضویت", "اقدام"], []);
    wrap.append(bar, tbl);
    const banner = el("p", { class: "ohint" });
    banner.textContent = "اقدام‌های این صفحه واقعی‌اند اما فقط روی همین مرورگر اثر دارند. نقش‌ها از صفحهٔ نقش‌ها مدیریت می‌شوند و اجرای سراسری پس از اتصال بک‌اند فعال می‌شود.";
    wrap.append(banner);
    section.append(wrap);

    function list() {
      let items = getUsers();
      const qq = userState.q.trim().toLowerCase();
      if (qq) items = items.filter((r) => `${r.nick || ""} ${r.u || ""} ${r.email || ""}`.toLowerCase().includes(qq));
      if (userState.status !== "all") {
        items = items.filter((r) => (userState.status === "banned") === bans().includes(String(r.u).toLowerCase()));
      }
      if (userState.sort === "name") items.sort((a, b) => String(a.nick || "").localeCompare(String(b.nick || ""), "fa"));
      else if (userState.sort === "username") items.sort((a, b) => String(a.u || "").localeCompare(String(b.u || ""), "en"));
      else items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return items;
    }

    function paint() {
      tbody.replaceChildren();
      const items = list();
      if (!items.length) { emptyRow(tbody, 8, getUsers().length ? "کاربری با این فیلتر پیدا نشد." : "حسابی روی این مرورگر ساخته نشده."); return; }
      for (const rec of items) {
        const banned = bans().includes(String(rec.u).toLowerCase());
        const tr = el("tr");
        const check = el("input", { type: "checkbox" });
        check.checked = userState.selected.has(rec.u);
        check.addEventListener("change", () => {
          if (check.checked) userState.selected.add(rec.u); else userState.selected.delete(rec.u);
        });
        const tdCheck = el("td");
        tdCheck.append(check);
        tr.append(tdCheck);
        tr.append(el("td", { text: rec.nick || "?" }));
        const uTd = el("td");
        uTd.append(el("span", { text: `@${rec.u || "?"}` }), el("small", { text: `ID: ${String(rec.uid || rec.u || "").slice(0, 14)}` }));
        tr.append(uTd);
        tr.append(el("td", { text: rec.email || "—" }));
        tr.append(el("td", { text: "Member" }));
        const st = el("td");
        st.append(tag(banned ? "مسدود محلی" : "فعال", banned ? "bad" : "ok"));
        tr.append(st);
        tr.append(el("td", { text: rec.createdAt ? new Date(rec.createdAt).toLocaleDateString("fa-IR") : "—" }));
        const act = el("td");
        act.append(miniBtn("مشاهده", () => viewUser(rec, banned)));
        act.append(miniBtn(banned ? "رفع مسدودی" : "مسدود", () => { ctx.toggleBan(rec.u, banned); paint(); }));
        act.append(miniBtn("حذف", () => { ctx.deleteLocalUser(rec.u); paint(); }, true));
        tr.append(act);
        tbody.append(tr);
      }
    }

    function selectedUsers() {
      return [...userState.selected].filter((u) => getUsers().some((r) => r.u === u));
    }

    bulkBan.addEventListener("click", () => {
      const sel = selectedUsers();
      if (!sel.length) return toast("اول کاربر انتخاب کن.", "error");
      const bansNow = ctx.readBans();
      sel.forEach((u) => { if (!bansNow.includes(String(u).toLowerCase())) ctx.toggleBan(u, false); });
      userState.selected.clear();
      paint(); refreshDashboard();
    });
    bulkUnban.addEventListener("click", () => {
      const sel = selectedUsers();
      if (!sel.length) return toast("اول کاربر انتخاب کن.", "error");
      const bansNow = ctx.readBans();
      sel.forEach((u) => { if (bansNow.includes(String(u).toLowerCase())) ctx.toggleBan(u, true); });
      userState.selected.clear();
      paint(); refreshDashboard();
    });
    bulkDel.addEventListener("click", () => {
      const sel = selectedUsers();
      if (!sel.length) return toast("اول کاربر انتخاب کن.", "error");
      if (!confirm(`${sel.length} حساب انتخاب‌شده از این مرورگر حذف شوند؟`)) return;
      sel.forEach((u) => ctx.deleteLocalUser(u, { silent: true }));
      logAudit({ kind: "user", action: "حذف گروهی حساب", target: sel.join(", ") });
      userState.selected.clear();
      paint(); refreshDashboard();
    });

    function viewUser(rec, banned) {
      const body = el("div", { class: "ow-kv" });
      const rows = [
        ["شناسه", String(rec.uid || rec.u || "—")],
        ["نام نمایشی", rec.nick || "—"],
        ["نام کاربری", `@${rec.u}`],
        ["ایمیل", rec.email || "—"],
        ["نقش", "Member (محلی)"],
        ["وضعیت", banned ? "مسدود محلی" : "فعال"],
        ["عضویت", rec.createdAt ? new Date(rec.createdAt).toLocaleString("fa-IR") : "—"],
        ["آواتار", rec.avatar ? "انتخاب‌شده" : "پیش‌فرض"]
      ];
      for (const [k, v] of rows) {
        const row = el("div");
        row.append(el("span", { text: k }), el("b", { text: v }));
        body.append(row);
      }
      body.append(el("p", { class: "ohint", text: "تغییر نقش، بازنشانی رمز و مدیریت اشتراک برای حساب‌های محلی در دسترس نیست؛ این اقدام‌ها به بک‌اند متصل می‌شوند." }));
      showModal("جزئیات کاربر", body);
    }

    paint();
  };

  /* ----- roles ----- */
  renderers.roles = (section) => {
    section.replaceChildren();
    const wrap = card("نقش‌ها", "نقش‌های پایه ثابت‌اند و نقش‌های سفارشی در همین مرورگر ذخیره می‌شوند. اجرای واقعی نقش‌ها روی رفتار سایت پس از اتصال بک‌اند فعال می‌شود.");
    const { wrap: tbl, tbody } = table(["نقش", "شناسه", "سطح", "نوع", "اقدام"], []);
    const roles = readRoles();
    for (const role of roles) {
      const tr = el("tr");
      tr.append(el("td", { text: role.name }));
      const idTd = el("td");
      idTd.append(el("code", { text: role.id }));
      tr.append(idTd);
      tr.append(el("td", { text: String(role.level) }));
      tr.append(el("td", { text: role.builtin ? "پایه" : "سفارشی" }));
      const act = el("td");
      if (!role.builtin) {
        act.append(miniBtn("تغییر نام", () => renameRole(role)));
        act.append(miniBtn("حذف", () => deleteRole(role), true));
      } else act.append(el("span", { class: "hint-s", text: "قابل حذف نیست" }));
      tr.append(act);
      tbody.append(tr);
    }
    const addRow = el("div", { class: "ow-toolbar" });
    const nameIn = el("input", { class: "ow-input", placeholder: "نام نقش جدید (مثل Editor)" });
    const levelIn = el("input", { class: "ow-input", type: "number", min: "1", max: "99", placeholder: "سطح ۱ تا ۹۹" });
    const addBtn = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "افزودن نقش" });
    addBtn.addEventListener("click", () => {
      const name = nameIn.value.trim();
      const level = Number(levelIn.value);
      if (!name) return toast("نام نقش را بنویس.", "error");
      if (!Number.isFinite(level) || level < 1 || level > 99) return toast("سطح باید بین ۱ تا ۹۹ باشد.", "error");
      const list = readRoles().slice();
      if (list.some((r) => r.name.toLowerCase() === name.toLowerCase())) return toast("نقشی با این نام هست.", "error");
      list.push({ id: `custom_${Date.now().toString(36)}`, name, level: Math.round(level), builtin: false, createdAt: Date.now() });
      writeData({ roles: list });
      logAudit({ kind: "role", action: "ساخت نقش", target: name });
      renderers.roles(section);
      toast("نقش سفارشی ذخیره شد.", "success");
    });
    addRow.append(nameIn, levelIn, addBtn);
    wrap.append(tbl, addRow);
    section.append(wrap);
    section.append(honesty("نقش‌های سفارشی در فایل دادهٔ محلی کنسول ذخیره می‌شوند و هنوز روی رفتار سایت اثر اجرایی ندارند. ماتریس اجرای نقش‌ها در فاز اتصال بک‌اند فعال می‌شود."));
    function renameRole(role) {
      const name = prompt("نام جدید نقش:", role.name);
      if (!name || !name.trim()) return;
      const list = readRoles().map((r) => (r.id === role.id ? { ...r, name: name.trim() } : r));
      writeData({ roles: list });
      logAudit({ kind: "role", action: "تغییر نام نقش", target: role.id, detail: name.trim() });
      renderers.roles(section);
    }
    function deleteRole(role) {
      if (!confirm(`نقش «${role.name}» حذف شود؟`)) return;
      writeData({ roles: readRoles().filter((r) => r.id !== role.id) });
      logAudit({ kind: "role", action: "حذف نقش", target: role.id });
      renderers.roles(section);
      toast("نقش حذف شد.");
    }
  };

  /* ----- permissions ----- */
  const permState = { scope: "role" };
  renderers.permissions = (section) => {
    section.replaceChildren();
    const wrap = card("ماتریس دسترسی", "برای هر نقش و هر مجوز یکی از سه حالت «اجازه»، «منع» یا «ارث‌بری» را انتخاب کن. تغییرات فوراً در همین مرورگر ذخیره می‌شوند.");
    const chips = el("div", { class: "ow-chips" });
    for (const scope of PERMISSION_SCOPES) {
      const chip = el("button", { type: "button", class: `ow-chip${permState.scope === scope.id ? " active" : ""}`, text: scope.label });
      chip.addEventListener("click", () => { permState.scope = scope.id; renderers.permissions(section); });
      chips.append(chip);
    }
    wrap.append(chips);
    if (permState.scope !== "role" && permState.scope !== "global") {
      wrap.append(el("p", { class: "ohint", text: "این دامنه به دادهٔ سروری نیاز دارد. ماتریس نقش‌ها اکنون قابل ویرایش است؛ دامنه‌های کاربر/اتاق/پلن پس از اتصال API فعال می‌شوند." }));
      section.append(wrap);
      section.append(honesty("پایهٔ دامنه‌های کاربر، اتاق و پلن ساخته شده است اما چون فهرست سروری وجود ندارد، هیچ جدول ساختگی نمایش داده نمی‌شود."));
      return;
    }
    const roles = readRoles();
    const { wrap: tblWrap, tbody } = table(["مجوز", ...roles.map((r) => r.name)], []);
    const headRow = tblWrap.querySelector("thead tr");
    headRow.lastChild?.classList.add("ow-sticky-col");
    for (const perm of PERMISSIONS) {
      const tr = el("tr");
      const th = el("td");
      th.append(el("b", { text: perm.label }));
      tr.append(th);
      for (const role of roles) {
        const td = el("td");
        const sel = el("select", { class: "ow-perm-select" });
        for (const st of ["allow", "deny", "inherit"]) {
          const labels = { allow: "اجازه", deny: "منع", inherit: "ارث‌بری" };
          sel.append(el("option", { value: st, text: labels[st] }));
        }
        sel.value = effectivePermission(permState.scope, role.id, perm.id);
        sel.addEventListener("change", () => {
          const data = readData();
          const permissions = { ...(data.permissions || {}) };
          permissions[permState.scope] = { ...(permissions[permState.scope] || {}) };
          permissions[permState.scope][role.id] = { ...(permissions[permState.scope][role.id] || {}) };
          const before = effectivePermission(permState.scope, role.id, perm.id);
          permissions[permState.scope][role.id][perm.id] = sel.value;
          writeData({ permissions });
          logAudit({ kind: "permission", action: "تغییر دسترسی", target: `${permState.scope}/${role.id}/${perm.id}`, before, after: sel.value });
        });
        td.append(sel);
        tr.append(td);
      }
      tbody.append(tr);
    }
    wrap.append(tblWrap);
    const reset = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "بازگشت به پیش‌فرض‌ها" });
    reset.addEventListener("click", () => {
      if (!confirm("همهٔ بازنویسی‌های دسترسی پاک شود؟")) return;
      const data = readData();
      delete data.permissions;
      writeData({ permissions: {} });
      logAudit({ kind: "permission", action: "بازنشانی ماتریس دسترسی" });
      renderers.permissions(section);
    });
    wrap.append(el("div", { class: "ov-actions" }, [reset]));
    section.append(wrap);
    section.append(honesty("این ماتریس هنوز اجرایی نیست؛ رابط و ذخیره‌سازی آماده است تا در فاز بک‌اند به بررسی واقعی دسترسی متصل شود."));
  };

  /* ----- feature pages ----- */
  function featurePage(title, hint, switchIds, extraNodes = []) {
    return (section) => {
      section.replaceChildren();
      const wrap = card(title, hint);
      const grid = el("div", { class: "toggle-grid" });
      for (const id of switchIds) {
        const meta = configMeta(id);
        if (!meta) continue;
        grid.append(cfgSwitch(meta.name, id, ctx.getDraft()?.[id.split(".")[0]]?.[id.split(".")[1]] !== false, meta.name));
      }
      wrap.append(grid);
      for (const node of extraNodes) wrap.append(node);
      section.append(wrap);
      ctx.renderInputs();
      section.append(honesty("تغییرات این صفحه در پیش‌نویس ذخیره می‌شوند. برای اعمال روی سایت، از صفحهٔ انتشار خروجی بگیر یا پیش‌نمایش را ببین."));
    };
  }
  renderers.chat = featurePage("چت", "چت متنی و محدودیت نرخ پیام در اتاق.", ["features.chat"], [
    (() => {
      const g = el("div", { class: "form-grid ow-mt" });
      g.append(cfgField("پیام مجاز در بازه", "limits.chatPerWindow", "number", { attrs: { min: 2, max: 30 } }));
      g.append(cfgField("طول بازه (میلی‌ثانیه)", "limits.chatWindowMs", "number", { attrs: { min: 1000, max: 30000, step: 500 } }));
      return g;
    })()
  ]);
  renderers.voice = featurePage("صدای زنده", "میکروفن و بلندگوی WebRTC در اتاق.", ["features.voice"]);
  renderers.video = featurePage("ویدیو", "فایل محلی، صف پخش و زیرنویس.", ["features.localFile", "features.queue", "features.subtitles"]);
  renderers.screenShare = featurePage("اشتراک صفحه و واکنش‌ها", "ارسال تصویر صفحه و ایموجی‌های زنده.", ["features.screenShare", "features.liveReactions"]);
  renderers.player = (section) => {
    section.replaceChildren();
    const wrap = card("پخش‌کننده", "پخش WebRTC با hls.js برای پخش زنده و همگام‌سازی میزبان‌محور.");
    const { wrap: tbl, tbody } = table(["تنظیم", "مقدار", "وضعیت"], []);
    const rows = [
      ["نرخ پخش", "1x / 1.25x / 1.5x / 2x / 0.75x", "داخل اتاق قابل تغییر"],
      ["همگام‌سازی", "بازتنظیم هر ۲.۵ ثانیه، آستانهٔ ۱.۱ ثانیه", "خودکار"],
      ["پشتیبانی HLS", window.Hls ? "hls.js بارگذاری شد" : "فقط پخش بومی", "خودکار"],
      ["فول‌اسکرین", "دسکتاپ + fallback iOS", "فعال"],
      ["تصویر در تصویر", "experimental", "دستگاه‌محور"]
    ];
    for (const r of rows) {
      const tr = el("tr");
      r.forEach((c) => tr.append(el("td", { text: c })));
      tbody.append(tr);
    }
    wrap.append(tbl);
    section.append(wrap);
    section.append(honesty("تنظیمات عددی پخش‌کننده (مثل آستانهٔ همگام‌سازی) هنوز قابل ویرایش نیست؛ این صفحه وضعیت واقعی موتور پخش را نشان می‌دهد و برای آیندهٔ تنظیمات نمایشی آماده است."));
  };

  /* ----- rooms ----- */
  renderers.rooms = (section) => {
    section.replaceChildren();
    const wrap = card("اتاق‌ها", "اتاق‌ها فعلاً P2P روی مرورگر میزبان اجرا می‌شوند و سرور اتاق ندارند؛ بنابراین فهرست زنده از کنسول در دسترس نیست.");
    const g = el("div", { class: "form-grid" });
    g.append(cfgField("ظرفیت پیش‌فرض اتاق", "limits.defaultCapacity", "number", { attrs: { min: 2, max: 24 } }));
    g.append(cfgField("بیشترین ظرفیت مجاز", "limits.maxCapacity", "number", { attrs: { min: 2, max: 24 } }));
    wrap.append(g);
    const { wrap: tbl, tbody } = table(["اتاق", "میزبان", "اعضا", "وضعیت", "اقدام"], []);
    emptyRow(tbody, 5, "اتاق‌های سروری هنوز فعال نشده‌اند.");
    wrap.append(el("div", { class: "ow-mt" }), tbl);
    wrap.append(el("p", { class: "ohint ow-mt", text: "اقدام‌های بستن، قفل، انتقال مالکیت و حذف عضو پس از فعال‌شدن API اتاق‌ها در همین جدول فعال می‌شوند." }));
    section.append(wrap);
    ctx.renderInputs();
  };

  /* ----- plans ----- */
  const planState = { editing: null };
  renderers.plans = (section) => {
    section.replaceChildren();
    const top = card("پلن‌های اشتراک", "پلن‌ها به‌صورت داده‌ای ذخیره می‌شوند (بدون کد سخت‌شده). اتصال به پرداخت و اعمال خودکار محدودیت‌ها در فاز بعد فعال می‌شود.");
    const addBtn = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "پلن جدید" });
    addBtn.addEventListener("click", () => openPlanEditor(null, section));
    top.append(el("div", { class: "ov-actions" }, [addBtn]));
    section.append(top);

    const plans = readPlans();
    if (!plans.length) section.append(card("پلن‌ای وجود ندارد", "اولین پلن را بساز."));
    plans.forEach((plan, index) => {
      const c = el("article", { class: `ocard plan-card${plan.archived ? " archived" : ""}` });
      const head = el("div", { class: "plan-head" });
      head.append(el("h2", { text: plan.name }));
      head.append(tag(plan.archived ? "بایگانی" : plan.visibility === "public" ? "عمومی" : "پنهان", plan.archived ? "bad" : "ok"));
      c.append(head);
      const kv = el("ul", { class: "okv" });
      const rows = [
        ["قیمت", `${plan.priceFa || "—"}${plan.priceEn ? ` / ${plan.priceEn}` : ""}`],
        ["دوره", plan.interval || "—"],
        ["اتاق", String(plan.rooms ?? "—")],
        ["اعضا", String(plan.members ?? "—")],
        ["فضای ذخیره", plan.storageMb ? `${plan.storageMb} MB` : "نامحدود"],
        ["مزایا", (plan.benefits || []).join("، ") || "—"]
      ];
      for (const [k, v] of rows) {
        const li = el("li");
        li.append(el("span", { text: k }), el("b", { text: v }));
        kv.append(li);
      }
      c.append(kv);
      const actions = el("div", { class: "ov-actions" });
      actions.append(
        miniBtn("ویرایش", () => openPlanEditor(plan, section)),
        miniBtn("تکثیر", () => duplicatePlan(plan, section)),
        miniBtn(plan.archived ? "خروج از بایگانی" : "بایگانی", () => toggleArchive(plan, section)),
        miniBtn("بالا", () => movePlan(index, -1, section)),
        miniBtn("پایین", () => movePlan(index, 1, section)),
        miniBtn("حذف", () => deletePlan(plan, section), true)
      );
      c.append(actions);
      section.append(c);
    });
    section.append(honesty("پلن‌ها در دادهٔ محلی کنسول ذخیره می‌شوند و هنوز روی سایت اعمال نمی‌شوند. پلن پریمیومِ واقعیِ سایت در صفحهٔ قیمت‌گذاری از تنظیمات منتشرشده می‌آید."));
  };

  function openPlanEditor(plan, section) {
    const isNew = !plan;
    const base = plan || { id: `plan_${Date.now().toString(36)}`, name: "", priceFa: "", priceEn: "", interval: "ماهانه", visibility: "hidden", rooms: 2, members: 10, storageMb: 1024, benefits: [], archived: false, createdAt: Date.now() };
    const form = el("div", { class: "form-grid" });
    const fields = [
      ["نام پلن", "name", "text"],
      ["قیمت (فارسی)", "priceFa", "text"],
      ["Price (English)", "priceEn", "text"],
      ["دوره", "interval", "text"],
      ["سقف اتاق", "rooms", "number"],
      ["سقف اعضا", "members", "number"],
      ["فضای ذخیره (MB)", "storageMb", "number"]
    ];
    const inputs = {};
    for (const [label, key, type] of fields) {
      const f = el("label", { class: "ofield" });
      f.append(el("span", { text: label }));
      const inp = el("input", { type });
      inp.value = base[key] ?? "";
      inputs[key] = inp;
      f.append(inp);
      form.append(f);
    }
    const visField = el("label", { class: "ofield" });
    visField.append(el("span", { text: "نمایش" }));
    const vis = el("select");
    vis.append(el("option", { value: "public", text: "عمومی" }), el("option", { value: "hidden", text: "پنهان" }));
    vis.value = base.visibility;
    visField.append(vis);
    form.append(visField);
    const benefitsField = el("label", { class: "ofield span2" });
    benefitsField.append(el("span", { text: "مزایا (هر خط یک مزیت)" }));
    const benefits = el("textarea", { rows: "4" });
    benefits.value = (base.benefits || []).join("\n");
    benefitsField.append(benefits);
    form.append(benefitsField);
    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ذخیره" });
    save.addEventListener("click", () => {
      const name = inputs.name.value.trim();
      if (!name) return toast("نام پلن لازم است.", "error");
      const next = {
        ...base,
        name,
        priceFa: inputs.priceFa.value.trim(),
        priceEn: inputs.priceEn.value.trim(),
        interval: inputs.interval.value.trim(),
        rooms: Math.max(0, Number(inputs.rooms.value) || 0),
        members: Math.max(0, Number(inputs.members.value) || 0),
        storageMb: Math.max(0, Number(inputs.storageMb.value) || 0),
        visibility: vis.value,
        benefits: benefits.value.split("\n").map((x) => x.trim()).filter(Boolean)
      };
      const list = readPlans().slice();
      const idx = list.findIndex((p) => p.id === next.id);
      if (idx >= 0) list[idx] = next; else list.push(next);
      writeData({ plans: list });
      logAudit({ kind: "plan", action: isNew ? "ساخت پلن" : "ویرایش پلن", target: name });
      closeModal();
      renderers.plans(section);
      toast("پلن ذخیره شد.", "success");
    });
    showModal(isNew ? "پلن جدید" : `ویرایش ${base.name}`, form, [save]);
  }
  function duplicatePlan(plan, section) {
    const copy = { ...plan, id: `plan_${Date.now().toString(36)}`, name: `${plan.name} (کپی)`, createdAt: Date.now() };
    writeData({ plans: [...readPlans(), copy] });
    logAudit({ kind: "plan", action: "تکثیر پلن", target: plan.name });
    renderers.plans(section);
  }
  function toggleArchive(plan, section) {
    writeData({ plans: readPlans().map((p) => (p.id === plan.id ? { ...p, archived: !p.archived } : p)) });
    logAudit({ kind: "plan", action: plan.archived ? "خروج از بایگانی" : "بایگانی پلن", target: plan.name });
    renderers.plans(section);
  }
  function movePlan(index, dir, section) {
    const list = readPlans().slice();
    const target = index + dir;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    writeData({ plans: list });
    renderers.plans(section);
  }
  function deletePlan(plan, section) {
    if (!confirm(`پلن «${plan.name}» برای همیشه حذف شود؟`)) return;
    writeData({ plans: readPlans().filter((p) => p.id !== plan.id) });
    logAudit({ kind: "plan", action: "حذف پلن", target: plan.name });
    renderers.plans(section);
    toast("پلن حذف شد.");
  }

  /* ----- pricing / premium / payments ----- */
  renderers.pricing = (section) => {
    section.replaceChildren();
    const wrap = card("قیمت‌گذاری", "پلن پریمیوم واقعی سایت از تنظیمات منتشرشده خوانده می‌شود. پلن‌های اضافی از صفحهٔ پلن‌های اشتراک مدیریت می‌شوند.");
    const grid = el("div", { class: "toggle-grid" });
    grid.append(cfgSwitch("نمایش دکمهٔ خرید", "plans.premiumEnabled", !!ctx.getDraft()?.plans?.premiumEnabled));
    wrap.append(grid);
    const f = el("div", { class: "form-grid ow-mt" });
    f.append(cfgField("قیمت (فارسی)", "plans.premiumPriceFa"));
    f.append(cfgField("Price (English)", "plans.premiumPriceEn"));
    f.append(cfgField("لینک پرداخت", "plans.premiumUrl", "url", { attrs: { dir: "ltr" } }));
    wrap.append(f);
    const link = el("p", { class: "ohint ow-mt" });
    link.textContent = ctx.getDraft()?.plans?.premiumUrl ? `لینک فعلی: ${ctx.getDraft().plans.premiumUrl}` : "لینک پرداخت خالی است؛ دکمهٔ خرید غیرفعال می‌ماند.";
    wrap.append(link);
    section.append(wrap);
    ctx.renderInputs();
  };
  renderers.premium = (section) => {
    section.replaceChildren();
    const benefits = readData().premiumBenefits || [];
    const wrap = card("مزایای پریمیوم", "فهرست مزایا برای نمایش در بخش قیمت‌گذاری. این داده ذخیره می‌شود اما اتصال به محدودیت واقعی حساب هنوز برقرار نیست.");
    const list = el("ul", { class: "ofnd-list" });
    if (!benefits.length) list.append(el("li", { text: "مزیتی ثبت نشده." }));
    benefits.forEach((b, i) => {
      const li = el("li");
      li.append(el("span", { text: b }), miniBtn("حذف", () => {
        const next = benefits.filter((_, idx) => idx !== i);
        writeData({ premiumBenefits: next });
        logAudit({ kind: "plan", action: "حذف مزیت", target: b });
        renderers.premium(section);
      }, true));
      list.append(li);
    });
    const row = el("div", { class: "ow-toolbar" });
    const input = el("input", { class: "ow-input", placeholder: "مزیت جدید (مثل اتاق هم‌زمان بیشتر)" });
    const add = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "افزودن" });
    add.addEventListener("click", () => {
      const v = input.value.trim();
      if (!v) return;
      writeData({ premiumBenefits: [...benefits, v] });
      logAudit({ kind: "plan", action: "افزودن مزیت", target: v });
      renderers.premium(section);
    });
    row.append(input, add);
    wrap.append(list, row);
    section.append(wrap);
  };
  renderers.payments = (section) => {
    section.replaceChildren();
    const wrap = card("پرداخت‌ها", "پایهٔ اتصال درگاه پرداخت. فعال‌سازی واقعی اشتراک نیازمند بک‌اند و وب‌هوک درگاه است.");
    const { wrap: tbl, tbody } = table(["درگاه", "وضعیت", "اقدام"], []);
    const tr = el("tr");
    tr.append(el("td", { text: "لینک پرداخت میزبانی‌شده" }));
    const st = el("td");
    st.append(tag(ctx.getDraft()?.plans?.premiumUrl ? "تنظیم‌شده" : "تنظیم نشده", ctx.getDraft()?.plans?.premiumUrl ? "ok" : "bad"));
    tr.append(st);
    const act = el("td");
    act.append(miniBtn("تنظیم لینک", () => ctx.showView("pricing")));
    tr.append(act);
    tbody.append(tr);
    emptyRow(tbody, 3, "درگاه خودکار و وب‌هوک: نیازمند بک‌اند.");
    wrap.append(tbl);
    section.append(wrap);
    section.append(honesty("هیچ تراکنش ساختگی ثبت نمی‌شود. تا اتصال درگاه، فقط لینک پرداخت واقعی قابل تنظیم است."));
  };

  /* ----- theme studio ----- */
  renderers.theme = (section) => {
    section.replaceChildren();
    const wrap = card("استودیوی تم", "تم پیش‌فرض و رنگ‌های سراسری. بازدیدکنندگانی که ظاهر شخصی دارند، انتخاب خودشان را می‌بینند.");
    const themeField = el("div", { class: "form-grid" });
    const themeSel = el("label", { class: "ofield" });
    themeSel.append(el("span", { text: "تم پیش‌فرض" }));
    const sel = el("select");
    sel.dataset.cfg = "site.defaultTheme";
    sel.append(el("option", { value: "dark", text: "تیره" }), el("option", { value: "light", text: "روشن" }));
    themeSel.append(sel);
    themeField.append(themeSel);
    const support = cfgField("لینک پشتیبانی", "site.supportUrl", "url", { attrs: { dir: "ltr" } });
    themeField.append(support);
    wrap.append(themeField);
    const presets = el("div", { class: "ow-presets" });
    const current = ctx.getDraft()?.site || {};
    for (const acc of ACCENTS) {
      const b = el("button", { type: "button", class: `ow-preset${current.accent === acc.a && current.accent2 === acc.b ? " active" : ""}`, title: `${acc.a} / ${acc.b}` });
      b.style.background = `linear-gradient(135deg,${acc.a},${acc.b})`;
      b.addEventListener("click", () => {
        ctx.setCfg("site.accent", acc.a);
        ctx.setCfg("site.accent2", acc.b);
        logAudit({ kind: "config", action: "اعمال پیش‌تنظیم رنگ", target: "site.accent", after: `${acc.a}/${acc.b}` });
        renderers.theme(section);
        toast("پیش‌تنظیم رنگ اعمال شد.", "success");
      });
      presets.append(b);
    }
    wrap.append(el("h3", { class: "ow-h3", text: "پیش‌تنظیم‌های رنگ" }), presets);
    const custom = el("div", { class: "form-grid ow-mt" });
    const accentWrap = el("label", { class: "ofield" });
    accentWrap.append(el("span", { text: "رنگ اصلی" }));
    const colorRow = el("span", { class: "color-field" });
    const c1 = el("input", { type: "color" });
    const t1 = el("input", { type: "text", class: "mono", dir: "ltr", maxlength: "7" });
    c1.dataset.cfg = "site.accent"; t1.dataset.cfg = "site.accent";
    colorRow.append(c1, t1);
    accentWrap.append(colorRow);
    const accent2Wrap = el("label", { class: "ofield" });
    accent2Wrap.append(el("span", { text: "رنگ دوم" }));
    const colorRow2 = el("span", { class: "color-field" });
    const c2 = el("input", { type: "color" });
    const t2 = el("input", { type: "text", class: "mono", dir: "ltr", maxlength: "7" });
    c2.dataset.cfg = "site.accent2"; t2.dataset.cfg = "site.accent2";
    colorRow2.append(c2, t2);
    accent2Wrap.append(colorRow2);
    custom.append(accentWrap, accent2Wrap);
    wrap.append(custom);
    const preview = el("div", { class: "ow-theme-preview" });
    preview.style.background = `linear-gradient(135deg,${current.accent || "#7c5cff"},${current.accent2 || "#22d3ee"})`;
    preview.append(el("span", { text: "پیش‌نمایش گرادیان سایت" }));
    wrap.append(preview);
    section.append(wrap);
    ctx.renderInputs();
    section.append(honesty("فونت، شعاع گوشه‌ها و افکت‌ها هنوز متغیر CSS عمومی ندارند؛ این صفحه فقط گزینه‌هایی را نشان می‌دهد که واقعاً روی سایت اعمال می‌شوند."));
  };

  /* ----- seo ----- */
  renderers.seo = (section) => {
    section.replaceChildren();
    const wrap = card("سئو", "عنوان و توضیحات متای صفحهٔ اصلی. مقدار خالی یعنی استفاده از نام و شعار سایت.");
    const g = el("div", { class: "form-grid" });
    g.append(cfgField("عنوان متا (فارسی)", "site.metaTitleFa"));
    g.append(cfgField("Meta title (English)", "site.metaTitleEn", "text", { attrs: { dir: "ltr" } }));
    g.append(cfgField("توضیحات متا (فارسی)", "site.metaDescFa"));
    g.append(cfgField("Meta description (English)", "site.metaDescEn", "text", { attrs: { dir: "ltr" } }));
    wrap.append(g);
    const preview = el("div", { class: "ow-seo-preview" });
    preview.append(
      el("b", { text: ctx.getDraft()?.site?.metaTitleFa || `${ctx.getDraft()?.site?.nameFa || ""} — Watch Together` }),
      el("span", { text: ctx.getDraft()?.site?.metaDescFa || ctx.getDraft()?.site?.taglineFa || "" }),
      el("code", { text: location.origin })
    );
    wrap.append(el("h3", { class: "ow-h3", text: "پیش‌نمایش نتیجه" }), preview);
    section.append(wrap);
    ctx.renderInputs();
    const paint = () => {
      const s = ctx.getDraft()?.site || {};
      const title = wrap.querySelector('[data-cfg="site.metaTitleFa"]')?.value?.trim() || s.metaTitleFa || `${s.nameFa || ""} — Watch Together`;
      const desc = wrap.querySelector('[data-cfg="site.metaDescFa"]')?.value?.trim() || s.metaDescFa || s.taglineFa || "";
      preview.querySelector("b").textContent = title;
      preview.querySelector("span").textContent = desc;
    };
    ["site.metaTitleFa", "site.metaDescFa"].forEach((path) => {
      const input = wrap.querySelector(`[data-cfg="${path}"]`);
      if (!input) return;
      input.addEventListener("input", paint);
    });
    section.append(honesty("این فیلدها بعد از ذخیره در پیش‌نویس، هنگام پیش‌نمایش و نسخهٔ منتشرشدهٔ سایت روی تگ‌های عنوان و توضیحات اعمال می‌شوند."));
  };

  /* ----- notifications ----- */
  renderers.notifications = (section) => {
    section.replaceChildren();
    const wrap = card("نوار اطلاعیه", "هر متن و نوعی که اینجا انتخاب شود روی همهٔ صفحات سایت نمایش داده می‌شود.");
    const grid = el("div", { class: "toggle-grid" });
    grid.append(cfgSwitch("نمایش نوار اطلاعیه", "announcement.enabled", !!ctx.getDraft()?.announcement?.enabled));
    wrap.append(grid);
    const f = el("div", { class: "form-grid ow-mt" });
    const typeField = el("label", { class: "ofield" });
    typeField.append(el("span", { text: "نوع" }));
    const sel = el("select");
    sel.dataset.cfg = "announcement.type";
    sel.append(el("option", { value: "info", text: "اطلاع‌رسانی" }), el("option", { value: "warn", text: "هشدار" }), el("option", { value: "critical", text: "مهم" }));
    typeField.append(sel);
    f.append(typeField);
    f.append(cfgField("متن فارسی", "announcement.textFa"));
    f.append(cfgField("English text", "announcement.textEn", "text", { attrs: { dir: "ltr" } }));
    wrap.append(f);
    section.append(wrap);
    ctx.renderInputs();
    section.append(honesty("اعلان پاپ‌آپ و اعلان مستقیم به کاربران هنوز پیاده‌سازی نشده است؛ فقط نوار سراسری واقعی است."));
  };

  /* ----- audit ----- */
  const auditState = { q: "", kind: "all" };
  renderers.audit = (section) => {
    section.replaceChildren();
    const wrap = card("گزارش رویدادها", "هر تغییر تنظیمات، اقدام کاربری، امنیتی و قابلیت با زمان و مقدار قبل/بعد ثبت می‌شود (حداکثر ۵۰۰ رویداد).");
    const bar = el("div", { class: "ow-toolbar" });
    const q = el("input", { class: "ow-input", type: "search", placeholder: "جستجو در رویدادها…" });
    q.value = auditState.q;
    q.addEventListener("input", () => { auditState.q = q.value; paint(); });
    const kind = el("select", { class: "ow-input" });
    kind.append(el("option", { value: "all", text: "همهٔ انواع" }));
    for (const [k, label] of Object.entries(AUDIT_LABELS)) kind.append(el("option", { value: k, text: label }));
    kind.value = auditState.kind;
    kind.addEventListener("change", () => { auditState.kind = kind.value; paint(); });
    const clear = el("button", { class: "btn btn-ghost btn-sm ow-danger", type: "button", text: "پاک کردن گزارش" });
    clear.addEventListener("click", () => {
      if (!confirm("کل گزارش رویدادها پاک شود؟")) return;
      clearAudit();
      paint();
      refreshDashboard();
      toast("گزارش پاک شد.");
    });
    bar.append(q, kind, clear);
    const list = el("div", { class: "log-list ow-log" });
    wrap.append(bar, list);
    section.append(wrap);
    function paint() {
      list.replaceChildren();
      const qq = auditState.q.trim().toLowerCase();
      const items = readAudit().filter((item) => {
        if (auditState.kind !== "all" && item.kind !== auditState.kind) return false;
        if (!qq) return true;
        return `${item.action} ${item.target} ${item.detail}`.toLowerCase().includes(qq);
      });
      if (!items.length) { list.append(el("div", { class: "log-empty", text: "رویدادی با این فیلتر نیست." })); return; }
      for (const item of items.slice(0, 200)) {
        const row = el("div", { class: "log-item audit-item" });
        row.append(el("time", { text: new Date(item.at).toLocaleString("fa-IR") }));
        const body = el("span");
        body.append(el("b", { text: AUDIT_LABELS[item.kind] || item.kind }));
        const parts = [item.action, item.target].filter(Boolean).join(" — ");
        body.append(document.createTextNode(parts || item.detail || ""));
        if (item.before != null || item.after != null) {
          const diff = el("em", { class: "audit-diff" });
          diff.textContent = `${String(item.before ?? "—")} ← ${String(item.after ?? "—")}`;
          body.append(diff);
        }
        row.append(body);
        list.append(row);
      }
    }
    paint();
  };

  /* ----- backups ----- */
  renderers.backups = (section) => {
    section.replaceChildren();
    const wrap = card("پشتیبان‌گیری", "دریافت و بازگردانی دادهٔ کنسول. فایل پشتیبان شامل تنظیمات، نقش‌ها، پلن‌ها و گزارش رویدادها است (بدون رمز حساب‌ها).");
    const acts = el("div", { class: "ov-actions" });
    const expCfg = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "دانلود تنظیمات سایت" });
    expCfg.addEventListener("click", () => { ctx.downloadJson(); logAudit({ kind: "backup", action: "دانلود تنظیمات" }); });
    const expAll = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "دانلود پشتیبان کامل کنسول" });
    expAll.addEventListener("click", exportBundle);
    const impAll = el("label", { class: "btn btn-ghost btn-sm file-label", text: "بازگردانی پشتیبان کنسول" });
    const file = el("input", { type: "file", accept: "application/json,.json" });
    file.hidden = true;
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;
      if (!confirm("دادهٔ فعلی کنسول (نقش‌ها، پلن‌ها، گزارش) با فایل پشتیبان جایگزین شود؟")) return;
      try {
        const raw = JSON.parse(await f.text());
        if (!raw || raw.type !== "wt-owner-backup") throw new Error("bad");
        writeData({ roles: raw.data?.roles, plans: raw.data?.plans, permissions: raw.data?.permissions, premiumBenefits: raw.data?.premiumBenefits });
        if (Array.isArray(raw.audit)) store.set("wt.ownerAudit", raw.audit);
        logAudit({ kind: "backup", action: "بازگردانی پشتیبان" });
        toast("پشتیبان بازگردانی شد.", "success");
        renderers.backups(section);
      } catch { toast("فایل پشتیبان معتبر نیست.", "error"); }
    });
    impAll.append(file);
    acts.append(expCfg, expAll, impAll);
    wrap.append(acts);
    const { wrap: tbl, tbody } = table(["داده", "وضعیت"], []);
    const data = readData();
    const rows = [
      ["تنظیمات سایت (پیش‌نویس)", ctx.isDirty() ? "تغییر ذخیره‌نشده دارد" : "هم‌سان"],
      ["نقش‌ها", data.roles ? `${data.roles.length} نقش` : "پیش‌فرض"],
      ["پلن‌ها", `${readPlans().length} پلن`],
      ["گزارش رویدادها", `${readAudit().length} رویداد`],
      ["مسدودهای محلی", `${ctx.readBans().length} مورد`]
    ];
    for (const [k, v] of rows) {
      const tr = el("tr");
      tr.append(el("td", { text: k }), el("td", { text: v }));
      tbody.append(tr);
    }
    wrap.append(el("div", { class: "ow-mt" }), tbl);
    section.append(wrap);
    section.append(honesty("پشتیبان در همین مرورگر ذخیره می‌شود و شامل هش رمز حساب‌های محلی نیست. برای پشتیبان سراسری به بک‌اند نیاز است."));
  };
  function exportBundle() {
    const bundle = { type: "wt-owner-backup", version: 1, at: new Date().toISOString(), data: readData(), audit: readAudit() };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: `wt-owner-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logAudit({ kind: "backup", action: "دانلود پشتیبان کامل" });
  }

  /* ----- storage / integrations ----- */
  renderers.storage = (section) => {
    section.replaceChildren();
    const wrap = card("فضای ذخیره", "وضعیت ذخیره‌سازی محلی مرورگر. آپلود ابری و سهمیهٔ سروری هنوز فعال نیست.");
    const { wrap: tbl, tbody } = table(["کلید", "حجم تقریبی"], []);
    const keys = Object.keys(localStorage).sort();
    for (const key of keys) {
      const size = (localStorage.getItem(key) || "").length;
      const tr = el("tr");
      tr.append(el("td", {}, [el("code", { text: key })]), el("td", { text: `${(size / 1024).toFixed(1)} KB` }));
      tbody.append(tr);
    }
    if (!keys.length) emptyRow(tbody, 2, "داده‌ای ذخیره نشده.");
    wrap.append(tbl);
    section.append(wrap);
    section.append(honesty("سهمیهٔ فایل، آپلود ابری و مدیریت فایل کاربران نیازمند بک‌اند و فضای ذخیره‌سازی است."));
  };
  renderers.integrations = (section) => {
    section.replaceChildren();
    const wrap = card("یکپارچه‌سازی", "وضعیت اتصال‌های فعلی و پایهٔ اتصال سرویس‌های آینده.");
    const { wrap: tbl, tbody } = table(["سرویس", "وضعیت", "توضیح"], []);
    let base = "";
    try { base = ctx.getApiBase(); } catch {}
    const rows = [
      ["API بک‌اند", base ? "تنظیم‌شده" : "تنظیم نشده", base || "assets/data/runtime-config.json"],
      ["Signaling (ntfy)", "فعال", "همگام‌سازی اتاق‌ها P2P"],
      ["GitHub Pages", "فعال", "میزبانی استاتیک"],
      ["درگاه پرداخت", "غیرفعال", "پس از اتصال بک‌اند"],
      ["ایمیل/اعلان", "غیرفعال", "نیازمند سرویس بیرونی"]
    ];
    for (const r of rows) {
      const tr = el("tr");
      r.forEach((c, i) => {
        if (i === 1) {
          const td = el("td");
          td.append(tag(c, /فعال|تنظیم‌شده/.test(c) ? "ok" : "bad"));
          tr.append(td);
        } else tr.append(el("td", { text: c }));
      });
      tbody.append(tr);
    }
    wrap.append(tbl);
    section.append(wrap);
  };

  /* ----- foundation pages ----- */
  function foundation(title, hint, planned, extra = null) {
    return (section) => {
      section.replaceChildren();
      const wrap = card(title, hint);
      if (extra) wrap.append(extra);
      wrap.append(el("h3", { class: "ow-h3", text: "قابلیت‌های برنامه‌ریزی‌شده" }), foundationList(planned));
      section.append(wrap);
      section.append(honesty("این بخش پایهٔ معماری است و هیچ داده یا کلید ساختگی نمایش نمی‌دهد. اتصال واقعی در فاز بعد روی همین ساختار سوار می‌شود."));
    };
  }
  renderers.communities = foundation("انجمن‌ها", "ساخت انجمن، نقش‌های داخلی و اتاق‌های اختصاصی.", [
    "ساخت انجمن با نام و قوانین", "اتاق‌های وابسته به انجمن", "نقش‌های داخلی و دعوت‌نامه", "فهرست اعضا و گزارش فعالیت"
  ]);
  renderers.website = foundation("سازندهٔ سایت", "پایهٔ مدیریت صفحات ثابت، ناوبری و فوتر بدون کد.", [
    "مدیریت منو و لینک‌های سربرگ/فوتر", "افزودن صفحات ثابت (درباره ما، قوانین)", "لوگو و فاوآیکون سفارشی", "انتشار تغییرات بدون کامیت دستی"
  ], (() => {
    const p = el("p", { class: "ohint" });
    p.textContent = "برای اقلامی که همین حالا واقعی هستند از صفحات برندینگ، سئو و اعلام‌ها استفاده کن.";
    const acts = el("div", { class: "ov-actions" });
    const b1 = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "برندینگ" });
    b1.addEventListener("click", () => ctx.showView("branding"));
    const b2 = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "سئو" });
    b2.addEventListener("click", () => ctx.showView("seo"));
    acts.append(b1, b2);
    return el("div", {}, [p, acts]);
  })());
  renderers.pages = foundation("صفحه‌ساز", "ساخت صفحات و بلوک‌ها بدون کد.", [
    "بلوک متن، تصویر و ویدیو", "بخش‌های قابل جابه‌جایی", "پیش‌نمایش زنده", "انتشار صفحه با آدرس اختصاصی"
  ]);
  renderers.automation = foundation("خودکارسازی", "قواعد خودکار بر اساس رویداد.", [
    "قاعده: پس از X پیام، اخطار به میزبان", "مسدودسازی خودکار هنگام اسپم", "یادآوری اشتراک در حال پایان", "وب‌هوک برای رویدادهای سایت"
  ]);
  renderers.maintenance = (section) => {
    section.replaceChildren();
    const wrap = card("حالت تعمیرات", "با روشن‌بودن این گزینه، تمام صفحات سایت لایهٔ تعمیرات نشان می‌دهند و فقط مالک آزاد است.");
    const grid = el("div", { class: "toggle-grid" });
    grid.append(cfgSwitch("قفل سراسری سایت", "maintenance.enabled", !!ctx.getDraft()?.maintenance?.enabled));
    wrap.append(grid);
    const g = el("div", { class: "form-grid ow-mt" });
    const fa = el("label", { class: "ofield span2" });
    fa.append(el("span", { text: "پیام فارسی" }));
    const ta = el("textarea", { rows: "2" });
    ta.dataset.cfg = "maintenance.messageFa";
    fa.append(ta);
    const en = el("label", { class: "ofield span2" });
    en.append(el("span", { text: "English message" }));
    const ta2 = el("textarea", { rows: "2", dir: "ltr" });
    ta2.dataset.cfg = "maintenance.messageEn";
    en.append(ta2);
    g.append(fa, en);
    wrap.append(g);
    section.append(wrap);
    ctx.renderInputs();
  };

  /* ----- analytics extra / feature center extra ----- */
  function enhanceAnalytics() {
    const view = document.querySelector('[data-view="analytics"]');
    if (!view || view.querySelector("[data-ow-local]")) return;
    const cardEl = el("article", { class: "ocard", "data-ow-local": "1" });
    cardEl.append(el("h2", { text: "شاخص‌های واقعی این مرورگر" }));
    const grid = el("div", { class: "stat-grid" });
    const mk = (label, id) => {
      const a = el("article", { class: "ostat" });
      a.append(el("span", { class: "ostat-lbl", text: label }), el("strong", { id, text: "—" }), el("small", { text: "دادهٔ محلی" }));
      return a;
    };
    grid.append(mk("کاربران محلی", "anUsers"), mk("مسدودهای محلی", "anBans"), mk("رویدادهای کنسول", "anEvents"), mk("قابلیت‌های فعال", "anFeat"));
    cardEl.append(grid);
    view.append(cardEl);
    refreshAnalytics();
  }
  function refreshAnalytics() {
    const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
    set("anUsers", String(Object.keys(ctx.readUsers()).length));
    set("anBans", String(ctx.readBans().length));
    set("anEvents", String(readAudit().length));
    set("anFeat", `${FEATURE_DEFS.filter((f) => ctx.getDraft()?.features?.[f.key] !== false).length}/${FEATURE_DEFS.length}`);
  }

  function enhanceFeatureCenter() {
    const view = document.querySelector('[data-view="features"]');
    if (!view || view.querySelector("[data-ow-ext]")) return;
    const ext = el("article", { class: "ocard", "data-ow-ext": "1" });
    ext.append(el("h2", { text: "کنترل پیشرفته" }));
    ext.append(el("p", { class: "ohint", text: "دامنهٔ نقش، کاربر، اتاق و پلن پس از اتصال بک‌اند در همین جدول فعال می‌شود. دکمه‌های زیر همین حالا واقعی‌اند." }));

    const grid = el("div", { class: "toggle-grid" });
    for (const f of FEATURE_DEFS) {
      const row = el("div", { class: "ow-feature" });
      row.append(el("b", { text: f.label }), el("span", { class: "hint-s", text: `وابستگی: ${f.dependency}` }));
      grid.append(row);
    }
    ext.append(grid);

    const scopeTable = table(["دامنه", "وضعیت"], []);
    for (const [label, note] of [["نقش‌ها", "نیازمند بک‌اند"], ["کاربران", "نیازمند بک‌اند"], ["اتاق‌ها", "فقط سراسری فعال است"], ["پلن‌ها", "پایه در صفحهٔ پلن‌ها"]]) {
      const tr = el("tr");
      const st = el("td");
      st.append(tag(note, note.includes("فعال") || note.includes("پایه") ? "ok" : "bad"));
      tr.append(el("td", { text: label }), st);
      scopeTable.tbody.append(tr);
    }
    ext.append(el("h3", { class: "ow-h3", text: "دامنهٔ اعمال" }), scopeTable.wrap);

    const actions = el("div", { class: "ov-actions ow-mt" });
    const emergency = el("button", { class: "btn btn-ghost btn-sm ow-danger", type: "button", text: "خاموشی اضطراری همهٔ قابلیت‌ها" });
    emergency.addEventListener("click", () => {
      if (!confirm("همهٔ ۷ قابلیت اتاق خاموش شوند؟ این تغییر در پیش‌نویس ذخیره می‌شود.")) return;
      for (const f of FEATURE_DEFS) ctx.setCfg(f.id, false);
      logAudit({ kind: "feature", action: "خاموشی اضطراری همهٔ قابلیت‌ها" });
      ctx.renderInputs();
      refreshAnalytics();
      refreshDashboard();
      repaintExtras();
      toast("همهٔ قابلیت‌ها خاموش شدند؛ با انتشار اعمال می‌شود.", "success");
    });
    const restore = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "بازگرداندن همه" });
    restore.addEventListener("click", () => {
      for (const f of FEATURE_DEFS) ctx.setCfg(f.id, true);
      logAudit({ kind: "feature", action: "روشن‌کردن همهٔ قابلیت‌ها" });
      ctx.renderInputs();
      refreshAnalytics();
      refreshDashboard();
      repaintExtras();
      toast("همهٔ قابلیت‌ها روشن شدند.", "success");
    });
    const maint = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "صفحهٔ تعمیرات" });
    maint.addEventListener("click", () => ctx.showView("maintenance"));
    actions.append(emergency, restore, maint);
    ext.append(actions);

    const history = el("div", { class: "log-list ow-log ow-mt" });
    const paintHistory = () => {
      history.replaceChildren();
      const items = readAudit().filter((a) => (a.kind === "config" && a.target.startsWith("features.")) || a.kind === "feature").slice(0, 8);
      if (!items.length) history.append(el("div", { class: "log-empty", text: "تغییری در قابلیت‌ها ثبت نشده." }));
      for (const item of items) {
        const row = el("div", { class: "log-item" });
        row.append(el("time", { text: new Date(item.at).toLocaleString("fa-IR") }), el("span", { text: `${item.action || ""} ${item.target || ""} ${item.before != null ? `${item.before} ← ${item.after}` : ""}` }));
        history.append(row);
      }
    };
    paintHistory();
    ext.append(el("h3", { class: "ow-h3", text: "آخرین تغییرات قابلیت‌ها" }), history);
    view.append(ext);
    freshExt.add(paintHistory);
  }

  /* ----- dynamic sections / routing ----- */
  function ensureSection(view) {
    let node = document.querySelector(`[data-view="${CSS.escape(view)}"]`);
    if (node) return node;
    const host = document.getElementById("dynViews");
    if (!host) return null;
    node = el("section", { class: "oview", "data-view": view });
    host.append(node);
    return node;
  }

  function renderPage(name) {
    const def = pageDef(name);
    if (!def) return;
    if (def.kind !== "dynamic") {
      refreshDashboard();
      refreshAnalytics();
      ensureExtras();
      return;
    }
    const section = ensureSection(def.view);
    if (!section) return;
    const renderer = renderers[def.id];
    if (renderer) renderer(section);
    else section.replaceChildren(card(def.title, "این صفحه آماده است."));
    ensureExtras();
  }

  function ensureExtras() {
    enhanceAnalytics();
    enhanceFeatureCenter();
    refreshAnalytics();
  }

  /* ----- search ----- */
  function initSearch() {
    const input = document.getElementById("owSearch");
    const results = document.getElementById("owSearchResults");
    if (!input || !results) return;
    let index = null;
    const buildIndex = () => {
      const pages = PAGE_DEFS.map((p) => ({ type: "page", id: p.id, label: p.label, sub: p.title, view: p.view, text: `${p.label} ${p.title} ${p.keywords}`.toLowerCase() }));
      const cfg = CONFIG_REGISTRY.map((c) => ({ type: "config", id: c.id, label: c.name, sub: c.id, text: `${c.name} ${c.id} ${c.category}`.toLowerCase() }));
      const users = Object.keys(ctx.readUsers()).map((u) => ({ type: "user", id: u, label: `@${u}`, sub: "کاربر محلی", text: `${u} ${ctx.readUsers()[u]?.nick || ""}`.toLowerCase() }));
      return [...pages, ...cfg, ...users];
    };
    const close = () => { results.classList.add("hidden"); results.replaceChildren(); };
    input.addEventListener("focus", () => { index = buildIndex(); });
    input.addEventListener("input", () => {
      index = index || buildIndex();
      const q = input.value.trim().toLowerCase();
      results.replaceChildren();
      if (!q) { close(); return; }
      const hits = index.filter((item) => item.text.includes(q)).slice(0, 12);
      if (!hits.length) {
        results.append(el("div", { class: "ow-search-empty", text: "نتیجه‌ای پیدا نشد." }));
      } else {
        for (const hit of hits) {
          const b = el("button", { type: "button", class: "ow-search-item" });
          b.append(el("b", { text: hit.label }), el("span", { text: hit.sub }));
          b.addEventListener("click", () => {
            input.value = "";
            close();
            if (hit.type === "page") ctx.showView(hit.view);
            else if (hit.type === "user") { ctx.showView("users"); const q2 = document.getElementById("owQuickUser"); if (q2) q2.textContent = `@${hit.id}`; }
            else {
              const meta = configMeta(hit.id);
              const targetPage = { branding: "branding", theme: "theme", seo: "seo", notifications: "notifications", maintenance: "maintenance", accounts: "access", rooms: "rooms", chat: "chat", voice: "voice", video: "video", screenShare: "screenShare", profile: "limits", site: "branding", billing: "pricing" }[meta?.category] || "branding";
              ctx.showView(targetPage);
              const field = document.querySelector(`[data-cfg="${CSS.escape(hit.id)}"]`);
              if (field) {
                field.scrollIntoView({ behavior: "smooth", block: "center" });
                field.focus({ preventScroll: true });
                field.classList.add("ow-flash");
                setTimeout(() => field.classList.remove("ow-flash"), 1600);
              }
            }
          });
          results.append(b);
        }
      }
      results.classList.remove("hidden");
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") { input.value = ""; close(); input.blur(); } });
    document.addEventListener("click", (e) => {
      if (!results.contains(e.target) && e.target !== input) close();
    });
  }

  /* ----- notifications ----- */
  function initNotifications() {
    const btn = document.getElementById("owNotifBtn");
    const panel = document.getElementById("owNotifPanel");
    const badge = document.getElementById("owNotifBadge");
    if (!btn || !panel) return;
    const seen = Number(getUi().notifSeen || 0);
    const unread = auditCountSince(seen);
    if (badge) {
      badge.textContent = unread > 9 ? "9+" : String(unread);
      badge.classList.toggle("hidden", unread === 0);
    }
    btn.addEventListener("click", () => {
      panel.classList.toggle("hidden");
      if (panel.classList.contains("hidden")) return;
      panel.replaceChildren();
      const items = readAudit().slice(0, 8);
      if (!items.length) panel.append(el("div", { class: "ow-notif-empty", text: "اعلانی نیست." }));
      for (const item of items) {
        const b = el("button", { type: "button", class: "ow-notif-item" });
        b.append(el("b", { text: AUDIT_LABELS[item.kind] || item.kind }), el("span", { text: item.action || item.target || "" }), el("time", { text: new Date(item.at).toLocaleString("fa-IR") }));
        b.addEventListener("click", () => { panel.classList.add("hidden"); ctx.showView("audit"); });
        panel.append(b);
      }
      const mark = el("button", { type: "button", class: "btn btn-ghost btn-sm", text: "همه خوانده شد" });
      mark.addEventListener("click", () => {
        setUi({ notifSeen: Date.now() });
        if (badge) badge.classList.add("hidden");
        panel.classList.add("hidden");
      });
      panel.append(mark);
    });
    document.addEventListener("click", (e) => {
      if (!panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) panel.classList.add("hidden");
    });
  }

  /* ----- misc chrome ----- */
  function initChrome() {
    const app = document.getElementById("ownerApp");
    const collapseBtn = document.getElementById("owCollapse");
    const ui = getUi();
    if (ui.collapsed && app) app.classList.add("side-mini");
    collapseBtn?.addEventListener("click", () => {
      const next = !app.classList.contains("side-mini");
      app.classList.toggle("side-mini", next);
      setUi({ collapsed: next });
    });

    const backdrop = document.getElementById("owBackdrop");
    const side = document.getElementById("ownerSide");
    document.getElementById("menuBtn")?.addEventListener("click", () => {
      const open = side.classList.toggle("open");
      backdrop?.classList.toggle("hidden", !open);
    });
    backdrop?.addEventListener("click", () => {
      side.classList.remove("open");
      backdrop.classList.add("hidden");
    });
    document.addEventListener("click", (e) => {
      if (window.matchMedia("(max-width: 900px)").matches && side.classList.contains("open")) {
        if (!side.contains(e.target) && !document.getElementById("menuBtn")?.contains(e.target) && e.target !== backdrop) {
          side.classList.remove("open");
          backdrop?.classList.add("hidden");
        }
      }
    });

    document.getElementById("qaPreview")?.addEventListener("click", () => ctx.previewSite());
    document.getElementById("qaBackup")?.addEventListener("click", () => { ctx.downloadJson(); logAudit({ kind: "backup", action: "دانلود تنظیمات از داشبورد" }); });
    document.getElementById("qaLock")?.addEventListener("click", () => ctx.lockConsole());
    document.getElementById("qaFeature")?.addEventListener("click", () => ctx.showView("features"));
  }

  function refreshAll() {
    refreshDashboard();
    refreshAnalytics();
  }

  function init() {
    buildNav();
    initChrome();
    initSearch();
    initNotifications();
    ensureExtras();
    refreshAll();
  }

  return { init, renderPage, refreshDashboard, refreshAnalytics, refreshAll, ensureExtras, showModal, closeModal };
}
