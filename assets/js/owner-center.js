import { el, store, toast } from "./core.js";
import { apiFetch } from "./api.js";
import {
  CONFIG_REGISTRY, NAV_GROUPS, PAGE_DEFS, pageDef, configMeta,
  CONFIG_CATEGORIES, DEFAULT_ROLES, PERMISSION_SCOPES, PERMISSIONS, FEATURE_DEFS
} from "./owner-registry.js";
import { readAudit, logAudit, auditCountSince, clearAudit, lastChangeFor } from "./owner-audit.js";
import { SITE_CONFIG_DEFAULTS } from "./site-config.js";
import { ACCENTS } from "./core.js";
import {
  readBilling, writeBilling, logBillingEvent, uid, slugify,
  normalizePlan, emptyPlan, migrateLegacyPlan, sortPlans, validatePlan,
  effectivePrice, BILLING_CYCLES, CURRENCIES, PLAN_STATUSES,
  PAYMENT_STATUSES, SUB_STATUSES, SUB_ACTIONS, normalizeCoupon, validateCoupon,
  createSubscription, applySubscriptionAction, subscriptionAlerts,
  recordPayment, updatePaymentStatus, computeMetrics, formatMoney, daysLeft
} from "./billing-model.js";
import {
  ENTITLEMENTS, ENTITLEMENT_GROUPS, FREE_ENTITLEMENTS, UNLIMITED,
  normalizeEntitlements, resolveEntitlements, summarizeEntitlements, formatLimit, subscriptionActive
} from "./entitlements.js";
import { PROVIDERS, PROVIDER_MODES, sanitizeProviderConfig, providerHealth, createCheckout } from "./payment-providers.js";
import { lineChart, barChart, donut } from "./charts.js";
import { planCard } from "./pricing.js";
import {
  FLAGS, FLAG_GROUPS, FLAG_BY_ID, SCOPE_TYPES, HEALTH_LABELS,
  readFeatureCenter, writeFeatureCenter, resolveFlags, flagHealth,
  dependentIds, missingDependencies, lastHistoryFor, pushHistory,
  snapshotFeatureState, buildFeatureExport, readFeatureImport,
  readUsage, usageSeries, usageTop, usageByDimension, usageAdoption,
  scheduleState, getPath, buildFlagContext
} from "./feature-flags.js";

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

/* ---------------- billing form helpers ---------------- */

function fieldRow(label, control, cls = "") {
  const wrap = el("label", { class: `ofield ${cls}`.trim() });
  wrap.append(el("span", { text: label }), control);
  return wrap;
}
function selectInput(options, value) {
  const sel = el("select");
  for (const opt of options) sel.append(el("option", { value: opt.value, text: opt.label }));
  sel.value = value;
  return sel;
}
function numberInput(value, attrs = {}) {
  const input = el("input", { type: "number", min: "0" });
  Object.assign(input, attrs);
  input.value = value == null ? "" : String(value);
  return input;
}
function dateInput(value) {
  const input = el("input", { type: "date" });
  if (value) {
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) input.value = new Date(ts).toISOString().slice(0, 10);
  }
  return input;
}
function dateFa(ts) {
  return ts ? new Date(ts).toLocaleDateString("fa-IR") : "—";
}
function cycleLabel(cycle) {
  return BILLING_CYCLES.find((c) => c.id === cycle)?.label || cycle;
}
function statusTag(status) {
  const kind = status === "published" || status === "active" ? "ok" : status === "draft" || status === "trialing" ? "" : "bad";
  return tag(PLAN_STATUSES[status] || SUB_STATUSES[status] || status, kind);
}

function entitlementEditor(initial = {}) {
  const state = { ...FREE_ENTITLEMENTS, ...(initial || {}) };
  const root = el("div", { class: "ent-grid" });
  for (const group of ENTITLEMENT_GROUPS) {
    const box = el("div", { class: "ent-group" });
    box.append(el("h4", { class: "ent-group-lbl", text: group.label }));
    for (const meta of ENTITLEMENTS.filter((e) => e.group === group.id)) {
      const row = el("div", { class: "ent-row" });
      row.append(el("span", { class: "ent-lbl", text: meta.label }));
      if (meta.type === "boolean") {
        const cb = el("input", { type: "checkbox" });
        cb.checked = !!state[meta.id];
        cb.addEventListener("change", () => { state[meta.id] = cb.checked; });
        row.append(cb);
      } else {
        const num = numberInput(state[meta.id] === UNLIMITED ? "" : state[meta.id]);
        num.classList.add("ent-num");
        const unl = el("label", { class: "ent-unl" });
        const cb = el("input", { type: "checkbox" });
        cb.checked = state[meta.id] === UNLIMITED;
        num.disabled = cb.checked;
        cb.addEventListener("change", () => {
          num.disabled = cb.checked;
          state[meta.id] = cb.checked ? UNLIMITED : Math.max(0, Number(num.value) || 0);
        });
        num.addEventListener("input", () => { if (!cb.checked) state[meta.id] = Math.max(0, Number(num.value) || 0); });
        unl.append(cb, el("span", { text: "نامحدود" }));
        row.append(num, unl);
      }
      if (meta.unit) row.append(el("span", { class: "ent-unit", text: meta.unit }));
      box.append(row);
    }
    root.append(box);
  }
  return { node: root, read: () => normalizeEntitlements(state) };
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

  /* ----- billing helpers ----- */
  const currencyNow = () => (ctx.getDraft()?.billing?.currency === "USD" ? "USD" : "IRT");
  const draftPlans = () => {
    const raw = ctx.getDraft()?.billing?.plans;
    return sortPlans((Array.isArray(raw) ? raw : []).map((p, i) => normalizePlan(p, i)));
  };
  const persistPlans = (list, action, target = "") => {
    const clean = list.map((p, i) => ({ ...normalizePlan(p, i), order: i }));
    ctx.setCfg("billing.plans", clean);
    logAudit({ kind: "plan", action, target });
  };
  const livePlan = (id) => draftPlans().find((p) => p.id === id) || null;
  const legacyPlans = () => {
    const raw = readData().plans;
    return Array.isArray(raw) ? raw : [];
  };

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

  /* ----- plan builder ----- */
  const planFilter = { status: "all" };
  renderers.plans = (section) => {
    section.replaceChildren();
    const plans = draftPlans();
    const cur = currencyNow();
    const head = card("سازندهٔ پلن", "همهٔ پلن‌ها داده‌ای‌اند: ساخت، ویرایش، کپی، آرشیو، ترتیب و قیمت‌گذاری کامل بدون تغییر کد. تغییرات در پیش‌نویس ذخیره و با انتشار روی سایت اعمال می‌شوند.");
    const bar = el("div", { class: "ow-toolbar pb-toolbar" });
    const add = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "پلن جدید" });
    add.addEventListener("click", () => openPlanEditor(null, section));
    const chips = el("div", { class: "ow-chips" });
    for (const [id, label] of [["all", "همه"], ["published", "منتشرشده"], ["draft", "پیش‌نویس"], ["disabled", "غیرفعال"], ["archived", "بایگانی"], ["deleted", "حذف‌شده"]]) {
      const chip = el("button", { class: `ow-chip${planFilter.status === id ? " active" : ""}`, type: "button", text: label });
      chip.addEventListener("click", () => { planFilter.status = id; renderers.plans(section); });
      chips.append(chip);
    }
    const legacy = legacyPlans();
    const importBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "واردکردن پلن‌های قدیمی" });
    importBtn.classList.toggle("hidden", !legacy.length || plans.length > 0);
    importBtn.addEventListener("click", () => {
      if (!legacy.length) return;
      const merged = [...plans];
      legacy.forEach((raw, i) => {
        const migrated = migrateLegacyPlan(raw, merged.length + i);
        if (!merged.some((p) => p.id === migrated.id || p.slug === migrated.slug)) merged.push(migrated);
      });
      persistPlans(merged, "واردکردن پلن‌های قدیمی", `${legacy.length} پلن`);
      toast("پلن‌های قدیمی منتقل شدند؛ دادهٔ قبلی هم دست‌نخورده ماند.", "success");
      renderers.plans(section);
    });
    bar.append(add, chips, importBtn);
    head.append(bar);

    const stats = el("div", { class: "stat-grid ow-mt" });
    const publishedCount = plans.filter((p) => p.status === "published" && p.visibility === "public").length;
    const promoCount = plans.filter((p) => {
      const cycle = ["monthly", "yearly", "lifetime"].find((c) => Number(p.prices[c]) > 0) || "custom";
      return p.status !== "deleted" && effectivePrice(p, cycle).discountPercent > 0;
    }).length;
    for (const [label, value] of [["کل پلن‌ها", plans.filter((p) => p.status !== "deleted").length], ["منتشرشده در سایت", publishedCount], ["تخفیف فعال", promoCount]]) {
      const stat = el("article", { class: "ostat" });
      stat.append(el("span", { class: "ostat-lbl", text: label }), el("strong", { text: String(value) }));
      stats.append(stat);
    }
    head.append(stats);
    section.append(head);

    const visible = plans.filter((p) => (planFilter.status === "all" ? p.status !== "deleted" : p.status === planFilter.status));
    const listCard = el("article", { class: "ocard" });
    listCard.append(el("h2", { text: "فهرست پلن‌ها" }));
    const { wrap: tbl, tbody } = table(["ترتیب", "پلن", "وضعیت", "قیمت", "دسترسی", "نمایش", "اقدام"], []);
    if (!visible.length) emptyRow(tbody, 7, plans.length ? "پلنی با این فیلتر نیست." : "هنوز پلنی ساخته نشده؛ با «پلن جدید» شروع کن.");

    const priceSummary = (plan) => {
      const bits = [];
      if (Number(plan.prices.monthly) > 0) bits.push(`${formatMoney(plan.prices.monthly, cur)} / ماه`);
      if (Number(plan.prices.yearly) > 0) bits.push(`${formatMoney(plan.prices.yearly, cur)} / سال`);
      if (Number(plan.prices.lifetime) > 0) bits.push(`${formatMoney(plan.prices.lifetime, cur)} مادام‌العمر`);
      if (Number(plan.prices.custom?.amount) > 0) bits.push(`${formatMoney(plan.prices.custom.amount, cur)} / ${plan.prices.custom.days || 30} روز`);
      if (!bits.length) return "رایگان";
      const cycle = Number(plan.prices.monthly) > 0 ? "monthly" : Number(plan.prices.yearly) > 0 ? "yearly" : Number(plan.prices.lifetime) > 0 ? "lifetime" : "custom";
      const eff = effectivePrice(plan, cycle);
      return eff.discountPercent ? `${bits[0]} · ٪${eff.discountPercent.toLocaleString("fa-IR")} تخفیف` : bits[0];
    };

    for (const plan of visible) {
      const tr = el("tr");
      tr.append(el("td", { text: String(plan.order + 1) }));
      const nameTd = el("td");
      nameTd.append(el("span", { class: "pb-name", text: `${plan.icon ? `${plan.icon} ` : ""}${plan.name}` }), el("small", { text: `/${plan.slug}` }));
      const flags = [plan.popular ? "پرفروش" : "", plan.recommended ? "پیشنهادی" : "", plan.badge].filter(Boolean);
      if (flags.length) nameTd.append(el("small", { class: "pb-flags", text: flags.join(" · ") }));
      tr.append(nameTd);
      const stTd = el("td");
      stTd.append(statusTag(plan.status));
      tr.append(stTd);
      tr.append(el("td", { text: priceSummary(plan) }));
      tr.append(el("td", { text: `${summarizeEntitlements({ ...FREE_ENTITLEMENTS, ...plan.entitlements }).length} مورد` }));
      tr.append(el("td", { text: plan.status === "published" && plan.visibility === "public" ? "عمومی" : "پنهان" }));
      const act = el("td");
      if (plan.status === "deleted") {
        act.append(miniBtn("بازگردانی", () => {
          persistPlans(draftPlans().map((p) => (p.id === plan.id ? { ...p, status: "draft" } : p)), "بازگردانی پلن حذف‌شده", plan.name);
          renderers.plans(section);
          toast("پلن به پیش‌نویس بازگشت.");
        }));
      } else {
        act.append(miniBtn("ویرایش", () => openPlanEditor(plan, section)));
        act.append(miniBtn("کپی", () => clonePlan(plan, section)));
        act.append(miniBtn(plan.status === "published" && plan.visibility === "public" ? "پنهان" : "انتشار", () => togglePublishPlan(plan, section)));
        act.append(miniBtn("↑", () => movePlan(plan, -1, section)));
        act.append(miniBtn("↓", () => movePlan(plan, 1, section)));
        act.append(miniBtn(plan.status === "archived" ? "بازگردانی" : "آرشیو", () => {
          persistPlans(draftPlans().map((p) => (p.id === plan.id ? { ...p, status: plan.status === "archived" ? "draft" : "archived" } : p)), plan.status === "archived" ? "خروج از بایگانی" : "بایگانی پلن", plan.name);
          renderers.plans(section);
        }));
        act.append(miniBtn("حذف ایمن", () => {
          const subsCount = readBilling().subscriptions.filter((s) => s.planId === plan.id && ["active", "trialing", "past_due", "grace"].includes(s.status)).length;
          const msg = subsCount
            ? `پلن «${plan.name}» حذف ایمن شود؟ ${subsCount} اشتراک فعال به آن ارجاع می‌دهد؛ اشتراک‌ها، پرداخت‌ها و فاکتورها دست‌نخورده می‌مانند.`
            : `پلن «${plan.name}» به وضعیت «حذف‌شده» منتقل شود؟ سابقه حفظ می‌شود و با بازگردانی قابل بازیابی است.`;
          if (!confirm(msg)) return;
          persistPlans(draftPlans().map((p) => (p.id === plan.id ? { ...p, status: "deleted" } : p)), "حذف ایمن پلن", plan.name);
          renderers.plans(section);
          toast("پلن حذف ایمن شد؛ سابقه و مالی حفظ شدند.");
        }, true));
      }
      tr.append(act);
      tbody.append(tr);
    }
    listCard.append(tbl);
    section.append(listCard);
    section.append(honesty("حذف پلن هیچ رکورد مالی را پاک نمی‌کند و اشتراک‌های موجود معتبر می‌مانند. پلن‌های منتشرشده و عمومی، صفحهٔ قیمت سایت را به‌صورت زنده می‌سازند."));
  };

  function openPlanEditor(plan, section) {
    const isNew = !plan;
    const base = plan ? normalizePlan(plan) : emptyPlan();
    const cur = currencyNow();
    const body = el("div", { class: "pb-form" });
    const block = (title, node) => {
      const box = el("div", { class: "pb-sec" });
      box.append(el("h4", { class: "pb-sec-lbl", text: title }), node);
      return box;
    };
    const grid = (children) => {
      const g = el("div", { class: "form-grid" });
      for (const child of children) if (child) g.append(child);
      return g;
    };

    const nameIn = el("input", { type: "text" });
    nameIn.value = base.name;
    const slugIn = el("input", { type: "text", dir: "ltr" });
    slugIn.value = base.slug;
    let slugTouched = !isNew;
    nameIn.addEventListener("input", () => { if (!slugTouched) slugIn.value = slugify(nameIn.value); });
    slugIn.addEventListener("input", () => { slugTouched = true; });
    const descIn = el("textarea", { rows: "2" });
    descIn.value = base.description;
    const iconIn = el("input", { type: "text" });
    iconIn.value = base.icon;
    const colorIn = el("input", { type: "color" });
    colorIn.value = /^#[0-9a-f]{6}$/i.test(base.color) ? base.color : "#3d6bff";
    const badgeIn = el("input", { type: "text" });
    badgeIn.value = base.badge;
    body.append(block("هویت پلن", grid([
      fieldRow("نام پلن", nameIn),
      fieldRow("شناسهٔ یکتا (slug)", slugIn),
      fieldRow("شناسه در آدرس‌ها؛ فقط انگلیسی، عدد و خط تیره.", descIn, "span2"),
      fieldRow("آیکون", iconIn),
      fieldRow("رنگ", colorIn),
      fieldRow("برچسب ویژه", badgeIn)
    ])));

    const monthly = numberInput(base.prices.monthly);
    const yearly = numberInput(base.prices.yearly);
    const lifetime = numberInput(base.prices.lifetime);
    const customLabel = el("input", { type: "text" });
    customLabel.value = base.prices.custom?.label || "";
    const customDays = numberInput(base.prices.custom?.days || 30, { min: "1" });
    const customAmount = numberInput(base.prices.custom?.amount);
    const setupFee = numberInput(base.setupFee);
    const trialDays = numberInput(base.trialDays);
    const graceDays = numberInput(base.graceDays);
    const originalPrice = numberInput(base.originalPrice);
    const discountPercent = numberInput(base.discountPercent, { max: "100" });
    const promoPrice = numberInput(base.promoPrice);
    const promoStart = dateInput(base.promoStart);
    const promoEnd = dateInput(base.promoEnd);
    body.append(block(`قیمت‌گذاری (${CURRENCIES[cur].fa})`, grid([
      fieldRow("ماهانه", monthly),
      fieldRow("سالانه", yearly),
      fieldRow("مادام‌العمر", lifetime),
      fieldRow("قیمت دورهٔ سفارشی", customAmount),
      fieldRow("برچسب دورهٔ سفارشی", customLabel),
      fieldRow("طول دورهٔ سفارشی (روز)", customDays, "span2"),
      fieldRow("هزینهٔ راه‌اندازی", setupFee),
      fieldRow("روزهای آزمایشی", trialDays),
      fieldRow("روزهای مهلت پرداخت", graceDays),
      fieldRow("قیمت پیش از تخفیف", originalPrice),
      fieldRow("درصد تخفیف", discountPercent),
      fieldRow("قیمت تخفیفی", promoPrice),
      fieldRow("شروع تخفیف", promoStart),
      fieldRow("پایان تخفیف", promoEnd)
    ])));

    const statusSel = selectInput(Object.entries(PLAN_STATUSES).filter(([id]) => id !== "deleted").map(([value, label]) => ({ value, label })), base.status === "deleted" ? "draft" : base.status);
    const visSel = selectInput([{ value: "public", label: "عمومی (نمایش در صفحهٔ قیمت)" }, { value: "hidden", label: "پنهان" }], base.visibility);
    const ctaIn = el("input", { type: "url", dir: "ltr" });
    ctaIn.value = base.ctaUrl;
    const popularCb = el("input", { type: "checkbox" });
    popularCb.checked = base.popular;
    const recCb = el("input", { type: "checkbox" });
    recCb.checked = base.recommended;
    const popWrap = el("label", { class: "switch-line" });
    popWrap.append(popularCb, el("span", { text: "پرفروش" }));
    const recWrap = el("label", { class: "switch-line" });
    recWrap.append(recCb, el("span", { text: "پیشنهادی" }));
    const toggles = el("div", { class: "toggle-grid" });
    toggles.append(popWrap, recWrap);
    body.append(block("نمایش و انتشار", grid([
      fieldRow("وضعیت", statusSel),
      fieldRow("نمایش عمومی", visSel),
      fieldRow("لینک خرید اختصاصی", ctaIn, "span2")
    ])));
    body.append(toggles);

    const editor = entitlementEditor({ ...FREE_ENTITLEMENTS, ...base.entitlements });
    body.append(block("دسترسی‌ها و سهمیه‌ها", editor.node));

    const errNode = el("p", { class: "pb-err" });
    body.append(errNode);

    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ذخیرهٔ پلن" });
    save.addEventListener("click", () => {
      const n = (input, max = 1e12) => Math.min(max, Math.max(0, Number(input.value) || 0));
      const next = normalizePlan({
        ...base,
        name: nameIn.value.trim(),
        slug: slugIn.value.trim() || slugify(nameIn.value),
        description: descIn.value.trim(),
        icon: iconIn.value.trim() || "✦",
        color: colorIn.value,
        badge: badgeIn.value.trim(),
        status: statusSel.value,
        visibility: visSel.value,
        ctaUrl: ctaIn.value.trim(),
        popular: popularCb.checked,
        recommended: recCb.checked,
        prices: {
          monthly: n(monthly),
          yearly: n(yearly),
          lifetime: n(lifetime),
          custom: { label: customLabel.value.trim(), days: Math.max(1, n(customDays)), amount: n(customAmount) }
        },
        trialDays: n(trialDays),
        graceDays: n(graceDays),
        setupFee: n(setupFee),
        originalPrice: n(originalPrice),
        discountPercent: n(discountPercent, 100),
        promoPrice: n(promoPrice),
        promoStart: promoStart.value,
        promoEnd: promoEnd.value,
        entitlements: editor.read(),
        updatedAt: Date.now()
      });
      const errors = [];
      if (next.promoStart && next.promoEnd && Date.parse(next.promoStart) > Date.parse(next.promoEnd)) errors.push("پایان تخفیف باید بعد از شروع آن باشد.");
      if (next.ctaUrl) {
        try { const u = new URL(next.ctaUrl); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { errors.push("لینک خرید باید با http یا https شروع شود."); }
      }
      const existing = draftPlans();
      const idx = existing.findIndex((p) => p.id === base.id);
      const list = idx >= 0 ? existing.map((p) => (p.id === base.id ? next : p)) : [...existing, next];
      const check = validatePlan(next, list.map((p, i) => normalizePlan(p, i)));
      errors.push(...check.errors);
      if (errors.length) {
        errNode.textContent = errors.join(" ");
        toast(errors[0], "error");
        return;
      }
      persistPlans(list, isNew ? "ساخت پلن" : "ویرایش پلن", next.name);
      closeModal();
      renderers.plans(section);
      toast(isNew ? "پلن ساخته شد." : "پلن ذخیره شد.", "success");
    });
    showModal(isNew ? "پلن جدید" : `ویرایش ${base.name}`, body, [save]);
  }
  function clonePlan(plan, section) {
    const copy = normalizePlan({
      ...plan,
      id: uid("plan"),
      name: `${plan.name} (کپی)`,
      slug: `${plan.slug}-copy-${Date.now().toString(36).slice(-4)}`,
      status: "draft",
      visibility: "hidden",
      popular: false,
      recommended: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }, draftPlans().length);
    persistPlans([...draftPlans(), copy], "کپی پلن", plan.name);
    renderers.plans(section);
    toast("پلن کپی شد؛ نسخهٔ جدید پیش‌نویس و پنهان است.", "success");
  }
  function togglePublishPlan(plan, section) {
    const publish = !(plan.status === "published" && plan.visibility === "public");
    persistPlans(draftPlans().map((p) => (p.id === plan.id ? { ...p, status: publish ? "published" : p.status, visibility: publish ? "public" : "hidden" } : p)), publish ? "انتشار پلن" : "پنهان‌سازی پلن", plan.name);
    renderers.plans(section);
    toast(publish ? "پلن منتشر شد؛ در صفحهٔ قیمت نمایش داده می‌شود." : "پلن از صفحهٔ قیمت پنهان شد.");
  }
  function movePlan(plan, dir, section) {
    const list = draftPlans();
    const index = list.findIndex((p) => p.id === plan.id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    persistPlans(list, "جابه‌جایی پلن", plan.name);
    renderers.plans(section);
  }

  /* ----- entitlement engine ----- */
  let entPlanId = "";
  renderers.entitlements = (section) => {
    section.replaceChildren();
    const plans = draftPlans().filter((p) => p.status !== "deleted");
    const wrap = card("دسترسی‌های پلن", "برای هر پلن قابلیت‌ها، سهمیه‌ها، نرخ‌ها و هم‌زمانی را تعریف کن. قابلیت خاموش‌شدهٔ سراسری همیشه بر پلن اولویت دارد.");
    if (!plans.length) {
      wrap.append(el("p", { class: "ohint", text: "اول یک پلن بساز تا دسترسی‌هایش را تعریف کنی." }));
      const go = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "سازندهٔ پلن" });
      go.addEventListener("click", () => ctx.showView("plans"));
      wrap.append(el("div", { class: "ov-actions ow-mt" }, [go]));
      section.append(wrap);
      return;
    }
    const plan = livePlan(entPlanId) || plans[0];
    entPlanId = plan.id;
    const bar = el("div", { class: "ow-toolbar" });
    bar.append(el("span", { class: "hint-s", text: "پلن:" }));
    const sel = selectInput(plans.map((p) => ({ value: p.id, label: `${p.name} — ${PLAN_STATUSES[p.status]}${p.visibility === "public" ? "" : " (پنهان)"}` })), plan.id);
    sel.addEventListener("change", () => { entPlanId = sel.value; renderers.entitlements(section); });
    bar.append(sel);
    wrap.append(bar);

    const editor = entitlementEditor({ ...FREE_ENTITLEMENTS, ...plan.entitlements });
    wrap.append(editor.node);
    const actions = el("div", { class: "ov-actions ow-mt" });
    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ذخیرهٔ دسترسی‌ها" });
    save.addEventListener("click", () => {
      const values = editor.read();
      persistPlans(draftPlans().map((p) => (p.id === plan.id ? { ...p, entitlements: values } : p)), "ویرایش دسترسی‌های پلن", plan.name);
      renderers.entitlements(section);
      toast("دسترسی‌های پلن ذخیره شد.", "success");
    });
    const reset = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "بازگشت به پیش‌فرض پایه" });
    reset.addEventListener("click", () => {
      if (!confirm(`دسترسی‌های پلن «${plan.name}» به مقادیر پایه برگردد؟`)) return;
      persistPlans(draftPlans().map((p) => (p.id === plan.id ? { ...p, entitlements: { ...FREE_ENTITLEMENTS } } : p)), "بازنشانی دسترسی‌های پلن", plan.name);
      renderers.entitlements(section);
    });
    actions.append(save, reset);
    wrap.append(actions);
    section.append(wrap);

    const resolved = resolveEntitlements({ plan, featureFlags: ctx.getDraft()?.features || {} });
    const resCard = card("نتیجهٔ اعمال مرکزی", "ترکیب پلن، پرچم‌های سراسری و بازنویسی‌ها. تصمیم نهایی یک‌جا گرفته می‌شود، نه در رابط کاربری.");
    const { wrap: tbl, tbody } = table(["دسترسی", "مقدار مؤثر", "وضعیت"], []);
    for (const meta of ENTITLEMENTS) {
      const value = resolved[meta.id];
      const active = meta.type === "boolean" ? Boolean(value) : value === UNLIMITED || Number(value) > 0;
      const blocked = meta.flag && ctx.getDraft()?.features?.[meta.flag] === false;
      const tr = el("tr");
      tr.append(el("td", { text: meta.label }));
      tr.append(el("td", { text: meta.type === "boolean" ? (active ? "فعال" : "غیرفعال") : formatLimit(value, meta.unit) }));
      const st = el("td");
      st.append(tag(blocked ? "قفل سراسری" : active ? "مجاز" : "بسته", blocked ? "bad" : active ? "ok" : ""));
      tr.append(st);
      tbody.append(tr);
    }
    resCard.append(tbl);
    section.append(resCard);
    section.append(honesty("این موتور تصمیم مستقل از DOM نوشته شده و همان تابع پس از اتصال بک‌اند برای هر حساب اجرا می‌شود؛ محدودیت فقط در رابط کاربری اعمال نمی‌شود."));
  };

  /* ----- subscriptions ----- */
  const readSubs = () => readBilling().subscriptions.slice();
  renderers.subscriptions = (section) => {
    section.replaceChildren();
    const subs = readSubs();
    const plans = draftPlans().filter((p) => p.status !== "deleted");
    const wrap = card("اشتراک‌ها", "چرخهٔ کامل عمر اشتراک با تاریخچهٔ تغییرناپذیر. هیچ رکورد مالی حذف نمی‌شود.");
    const bar = el("div", { class: "ow-toolbar" });
    const add = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "اشتراک جدید" });
    add.disabled = !plans.length;
    add.addEventListener("click", () => openSubCreate(section));
    const sweep = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "بررسی انقضا" });
    sweep.addEventListener("click", () => sweepExpired(section));
    bar.append(add, sweep);
    if (!plans.length) bar.append(el("span", { class: "hint-s", text: "برای ساخت اشتراک، اول یک پلن بساز." }));
    wrap.append(bar);
    const { wrap: tbl, tbody } = table(["کاربر", "پلن", "دوره", "وضعیت", "مبلغ", "پایان دوره", "اقدام"], []);
    if (!subs.length) emptyRow(tbody, 7, "هنوز اشتراکی ثبت نشده است.");
    for (const sub of subs) {
      const tr = el("tr");
      const userTd = el("td");
      userTd.append(el("span", { text: sub.userKey || "—" }), el("small", { text: sub.id }));
      tr.append(userTd);
      tr.append(el("td", { text: sub.planName || livePlan(sub.planId)?.name || "—" }));
      tr.append(el("td", { text: cycleLabel(sub.cycle) }));
      const stTd = el("td");
      stTd.append(tag(SUB_STATUSES[sub.status] || sub.status, ["active", "trialing"].includes(sub.status) ? "ok" : ["canceled", "expired"].includes(sub.status) ? "bad" : ""));
      const alerts = subscriptionAlerts(sub);
      if (alerts.length) stTd.append(el("small", { class: "pb-flags", text: alerts.join(" ") }));
      tr.append(stTd);
      tr.append(el("td", { text: formatMoney(sub.amount, currencyNow()) }));
      tr.append(el("td", { text: sub.cycle === "lifetime" ? "مادام‌العمر" : dateFa(sub.currentPeriodEnd) }));
      const act = el("td");
      act.append(miniBtn("اقدام‌ها", () => openSubActions(sub, section)));
      act.append(miniBtn("تاریخچه", () => showSubHistory(sub)));
      act.append(miniBtn("پرداخت", () => openSubPayment(sub, section)));
      tr.append(act);
      tbody.append(tr);
    }
    wrap.append(tbl);
    section.append(wrap);
    section.append(honesty("وضعیت‌ها فقط با اقدام صریح یا «بررسی انقضا» تغییر می‌کنند. فعال‌سازی خودکار پس از پرداخت به وب‌هوک سرور نیاز دارد."));
  };

  function openSubCreate(section) {
    const plans = draftPlans().filter((p) => p.status !== "deleted");
    if (!plans.length) return;
    const body = el("div", { class: "form-grid" });
    const userIn = el("input", { type: "text" });
    userIn.placeholder = "نام کاربری یا شناسهٔ حساب";
    const planSel = selectInput(plans.map((p) => ({ value: p.id, label: `${p.name} — ${PLAN_STATUSES[p.status]}` })), plans[0].id);
    const cycleSel = selectInput(BILLING_CYCLES.map((c) => ({ value: c.id, label: c.label })), "monthly");
    const noteIn = el("input", { type: "text" });
    body.append(fieldRow("کاربر", userIn), fieldRow("پلن", planSel), fieldRow("دوره", cycleSel), fieldRow("یادداشت", noteIn, "span2"));
    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ساخت اشتراک" });
    save.addEventListener("click", () => {
      const userKey = userIn.value.trim();
      if (!userKey) return toast("نام کاربر لازم است.", "error");
      const plan = plans.find((p) => p.id === planSel.value);
      const sub = createSubscription({ userKey, plan, cycle: cycleSel.value });
      if (noteIn.value.trim()) sub.history[0].note = noteIn.value.trim().slice(0, 120);
      writeBilling({ subscriptions: [sub, ...readSubs()] });
      logBillingEvent({ kind: "subscription", action: `ایجاد اشتراک ${plan.name}`, subId: sub.id, userKey });
      logAudit({ kind: "plan", action: "ایجاد اشتراک", target: userKey });
      closeModal();
      renderers.subscriptions(section);
      toast("اشتراک ساخته شد.", "success");
    });
    showModal("اشتراک جدید", body, [save]);
  }

  function openSubActions(sub, section) {
    const plans = draftPlans().filter((p) => p.status !== "deleted" && p.id !== sub.planId);
    const body = el("div");
    const info = el("p", { class: "ohint" });
    info.textContent = `${sub.userKey} · ${sub.planName} · ${SUB_STATUSES[sub.status] || sub.status} · پایان: ${sub.cycle === "lifetime" ? "مادام‌العمر" : dateFa(sub.currentPeriodEnd)}`;
    body.append(info);
    const form = el("div", { class: "form-grid ow-mt" });
    const noteIn = el("input", { type: "text" });
    const planSel = plans.length ? selectInput(plans.map((p) => ({ value: p.id, label: p.name })), plans[0].id) : null;
    const graceIn = numberInput(3, { min: "0" });
    form.append(fieldRow("یادداشت اقدام", noteIn, "span2"));
    if (planSel) form.append(fieldRow("پلن مقصد (ارتقا/تنزل)", planSel));
    form.append(fieldRow("روزهای مهلت", graceIn));
    body.append(form);
    const details = el("details", { class: "pb-details ow-mt" });
    details.append(el("summary", { text: "بازنویسی دسترسی‌ها (برای اقدام override)" }));
    const overrideEditor = entitlementEditor({ ...FREE_ENTITLEMENTS, ...(sub.overrides || {}) });
    details.append(overrideEditor.node);
    body.append(details);

    const grid = el("div", { class: "ov-actions ow-mt" });
    for (const [action, meta] of Object.entries(SUB_ACTIONS)) {
      if (!meta.from.includes(sub.status)) continue;
      const danger = action === "cancel" || action === "expire";
      const btn = el("button", { class: `btn ${danger ? "btn-ghost ow-danger" : "btn-secondary"} btn-sm`, type: "button", text: meta.label });
      btn.addEventListener("click", () => {
        if (danger && !confirm(`«${meta.label}» برای اشتراک ${sub.userKey} انجام شود؟ تاریخچه حفظ می‌شود.`)) return;
        const opts = { actor: "owner", note: noteIn.value.trim() };
        if (["upgrade", "downgrade"].includes(action)) {
          if (!planSel) return toast("پلن مقصدی وجود ندارد؛ اول پلن دیگری بساز.", "error");
          opts.plan = draftPlans().find((p) => p.id === planSel.value);
        }
        if (action === "start_grace") opts.graceDays = Number(graceIn.value) || 0;
        if (action === "override") opts.overrides = overrideEditor.read();
        const result = applySubscriptionAction(sub, action, opts);
        if (!result.ok) return toast(result.reason, "error");
        writeBilling({ subscriptions: readSubs().map((s) => (s.id === sub.id ? result.subscription : s)) });
        logBillingEvent({ kind: "subscription", action: `${meta.label} — ${sub.userKey}`, subId: sub.id, userKey: sub.userKey, from: sub.status, to: result.subscription.status });
        logAudit({ kind: "plan", action: `اشتراک: ${meta.label}`, target: sub.userKey });
        closeModal();
        renderers.subscriptions(section);
        toast(`${meta.label} انجام شد.`, "success");
      });
      grid.append(btn);
    }
    body.append(grid);
    if (!grid.children.length) body.append(el("p", { class: "ohint", text: "این وضعیت اجازهٔ اقدام دیگری نمی‌دهد." }));
    showModal(`اقدام‌های ${sub.userKey}`, body);
  }

  function showSubHistory(sub) {
    const fresh = readSubs().find((s) => s.id === sub.id) || sub;
    const body = el("div");
    const { wrap: tbl, tbody } = table(["زمان", "اقدام", "از", "به", "یادداشت"], []);
    for (const h of (fresh.history || []).slice().reverse()) {
      const tr = el("tr");
      tr.append(el("td", { text: new Date(h.at).toLocaleString("fa-IR") }));
      tr.append(el("td", { text: SUB_ACTIONS[h.action]?.label || h.action }));
      tr.append(el("td", { text: SUB_STATUSES[h.from] || h.from || "—" }));
      tr.append(el("td", { text: SUB_STATUSES[h.to] || h.to || "—" }));
      tr.append(el("td", { text: h.note || h.actor || "—" }));
      tbody.append(tr);
    }
    if (!fresh.history?.length) emptyRow(tbody, 5, "تاریخچه‌ای ثبت نشده است.");
    body.append(tbl);
    body.append(el("h4", { class: "ow-h3", text: "پرداخت‌های مرتبط" }));
    const pays = readBilling().payments.filter((p) => p.subscriptionId === fresh.id);
    const pt = table(["فاکتور", "مبلغ", "وضعیت", "تاریخ"], []);
    if (!pays.length) emptyRow(pt.tbody, 4, "پرداختی ثبت نشده است.");
    for (const p of pays) {
      const tr = el("tr");
      tr.append(el("td", { text: p.invoiceNo }));
      tr.append(el("td", { text: formatMoney(p.amount, p.currency || currencyNow()) }));
      const st = el("td");
      st.append(tag(PAYMENT_STATUSES[p.status] || p.status, p.status === "paid" ? "ok" : p.status === "failed" ? "bad" : ""));
      tr.append(st);
      tr.append(el("td", { text: new Date(p.paidAt || p.createdAt).toLocaleDateString("fa-IR") }));
      pt.tbody.append(tr);
    }
    body.append(pt.wrap);
    showModal(`تاریخچهٔ ${fresh.userKey}`, body);
  }

  function openSubPayment(sub, section) {
    const body = el("div", { class: "form-grid" });
    const amountIn = numberInput(sub.amount || 0);
    const statusSel = selectInput(Object.entries(PAYMENT_STATUSES).map(([value, label]) => ({ value, label })), "paid");
    const providerIds = Object.keys(readBilling().providers);
    const providerSel = selectInput([{ value: "manual", label: "دستی (مالک)" }, ...providerIds.map((id) => ({ value: id, label: PROVIDERS.find((p) => p.id === id)?.label || id }))], "manual");
    const noteIn = el("input", { type: "text" });
    body.append(fieldRow("مبلغ", amountIn), fieldRow("وضعیت", statusSel), fieldRow("درگاه", providerSel), fieldRow("یادداشت", noteIn, "span2"));
    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ثبت پرداخت" });
    save.addEventListener("click", () => {
      const payment = recordPayment({ subscription: sub, amount: Number(amountIn.value) || 0, currency: currencyNow(), provider: providerSel.value, status: statusSel.value, note: noteIn.value.trim() });
      logAudit({ kind: "plan", action: `ثبت پرداخت ${payment.invoiceNo}`, target: sub.userKey });
      closeModal();
      renderers.subscriptions(section);
      toast(`فاکتور ${payment.invoiceNo} ثبت شد.`, "success");
    });
    showModal("ثبت پرداخت", body, [save]);
  }

  function sweepExpired(section) {
    const now = Date.now();
    let changed = 0;
    const list = readSubs().map((sub) => {
      const overduePeriod = Number(sub.currentPeriodEnd) && now > Number(sub.currentPeriodEnd) && ["active", "trialing"].includes(sub.status);
      const overdueGrace = sub.status === "grace" && Number(sub.graceEndsAt) && now > Number(sub.graceEndsAt);
      if (!overduePeriod && !overdueGrace) return sub;
      const result = applySubscriptionAction(sub, "expire", { actor: "owner", note: "بررسی خودکار انقضا" });
      if (!result.ok) return sub;
      changed += 1;
      logBillingEvent({ kind: "subscription", action: `انقضای خودکار — ${sub.userKey}`, subId: sub.id, userKey: sub.userKey });
      return result.subscription;
    });
    if (changed) writeBilling({ subscriptions: list });
    logAudit({ kind: "plan", action: "بررسی انقضای اشتراک‌ها", target: `${changed} مورد` });
    renderers.subscriptions(section);
    toast(changed ? `${changed} اشتراک منقضی شد.` : "اشتراک منقضی‌ای نبود.");
  }

  /* ----- coupons ----- */
  renderers.coupons = (section) => {
    section.replaceChildren();
    const bill = readBilling();
    const coupons = bill.coupons.map((c) => normalizeCoupon(c)).sort((a, b) => b.createdAt - a.createdAt);
    const plans = draftPlans();
    const head = card("کدهای تخفیف", "کمپین درصدی و مبلغی با سقف استفاده، محدودیت پلن و بازهٔ زمانی. شمارش استفاده هنگام اتصال پرداخت سروری افزایش می‌یابد.");
    const bar = el("div", { class: "ow-toolbar" });
    const add = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "کد جدید" });
    add.addEventListener("click", () => openCouponEditor(null, section));
    bar.append(add);
    head.append(bar);
    section.append(head);

    const listCard = el("article", { class: "ocard" });
    listCard.append(el("h2", { text: "فهرست کدها" }));
    const { wrap: tbl, tbody } = table(["کد", "نوع", "مقدار", "استفاده", "بازه", "پلن‌ها", "وضعیت", "اقدام"], []);
    if (!coupons.length) emptyRow(tbody, 8, "کدی ساخته نشده است.");
    for (const c of coupons) {
      const tr = el("tr");
      tr.append(el("td", { text: c.code }));
      tr.append(el("td", { text: c.type === "percent" ? "درصدی" : "مبلغی" }));
      tr.append(el("td", { text: c.type === "percent" ? `٪${c.value.toLocaleString("fa-IR")}` : formatMoney(c.value, currencyNow()) }));
      tr.append(el("td", { text: c.maxUses ? `${c.usedCount} / ${c.maxUses}` : `${c.usedCount} / نامحدود` }));
      tr.append(el("td", { text: `${c.startsAt ? dateFa(Date.parse(c.startsAt)) : "—"} تا ${c.expiresAt ? dateFa(Date.parse(c.expiresAt)) : "—"}` }));
      tr.append(el("td", { text: c.planIds.length ? c.planIds.map((id) => plans.find((p) => p.id === id)?.name || id).join("، ") : "همه" }));
      const st = el("td");
      st.append(tag(c.status === "active" ? "فعال" : "غیرفعال", c.status === "active" ? "ok" : "bad"));
      tr.append(st);
      const act = el("td");
      act.append(miniBtn("ویرایش", () => openCouponEditor(c, section)));
      act.append(miniBtn(c.status === "active" ? "غیرفعال" : "فعال", () => {
        writeBilling({ coupons: bill.coupons.map((x) => (normalizeCoupon(x).id === c.id ? { ...normalizeCoupon(x), status: c.status === "active" ? "disabled" : "active" } : x)) });
        logBillingEvent({ kind: "coupon", action: `${c.status === "active" ? "غیرفعال‌سازی" : "فعال‌سازی"} کد ${c.code}` });
        logAudit({ kind: "plan", action: c.status === "active" ? "غیرفعال‌سازی کد تخفیف" : "فعال‌سازی کد تخفیف", target: c.code });
        renderers.coupons(section);
      }));
      tr.append(act);
      tbody.append(tr);
    }
    listCard.append(tbl);
    section.append(listCard);

    const testCard = card("آزمایش کد", "اعتبارسنجی همان منطقی است که پرداخت استفاده می‌کند؛ بدون ثبت استفاده.");
    const testGrid = el("div", { class: "form-grid" });
    const codeSel = selectInput(coupons.length ? coupons.map((c) => ({ value: c.code, label: c.code })) : [{ value: "", label: "کدی نیست" }], coupons.length ? coupons[0].code : "");
    const amountIn = numberInput(0);
    const planSel = selectInput([{ value: "", label: "همهٔ پلن‌ها" }, ...plans.map((p) => ({ value: p.id, label: p.name }))], "");
    testGrid.append(fieldRow("کد", codeSel), fieldRow("مبلغ سفارش", amountIn), fieldRow("پلن", planSel));
    testCard.append(testGrid);
    const out = el("p", { class: "ohint ow-mt" });
    const run = el("button", { class: "btn btn-secondary btn-sm ow-mt", type: "button", text: "بررسی" });
    run.addEventListener("click", () => {
      const c = coupons.find((x) => x.code === codeSel.value);
      const res = validateCoupon(c, { planId: planSel.value, amount: Number(amountIn.value) || 0 });
      out.textContent = res.ok
        ? `معتبر است؛ تخفیف ${formatMoney(res.discount, currencyNow())} و مبلغ نهایی ${formatMoney(res.final, currencyNow())}.`
        : res.reason;
    });
    testCard.append(run, out);
    section.append(testCard);
  };

  function openCouponEditor(coupon, section) {
    const isNew = !coupon;
    const base = normalizeCoupon(coupon || {});
    const plans = draftPlans().filter((p) => p.status !== "deleted");
    const body = el("div", { class: "form-grid" });
    const codeIn = el("input", { type: "text", dir: "ltr" });
    codeIn.value = base.code;
    const typeSel = selectInput([{ value: "percent", label: "درصدی" }, { value: "fixed", label: "مبلغ ثابت" }], base.type);
    const valueIn = numberInput(base.value);
    const minIn = numberInput(base.minAmount);
    const maxIn = numberInput(base.maxUses);
    const perUserIn = numberInput(base.perUserLimit);
    const startIn = dateInput(base.startsAt);
    const endIn = dateInput(base.expiresAt);
    const affiliateIn = el("input", { type: "text" });
    affiliateIn.value = base.affiliate || "";
    const statusSel = selectInput([{ value: "active", label: "فعال" }, { value: "disabled", label: "غیرفعال" }], base.status);
    const planBox = el("div", { class: "pb-planpick span2" });
    const checks = plans.map((p) => {
      const l = el("label", { class: "ow-chip" });
      const cb = el("input", { type: "checkbox" });
      cb.checked = base.planIds.includes(p.id);
      cb.value = p.id;
      l.append(cb, el("span", { text: p.name }));
      planBox.append(l);
      return cb;
    });
    if (!plans.length) planBox.append(el("span", { class: "hint-s", text: "پلنی برای محدودسازی نیست؛ کد روی همه معتبر است." }));
    body.append(
      fieldRow("کد", codeIn), fieldRow("نوع تخفیف", typeSel), fieldRow("مقدار", valueIn),
      fieldRow("حداقل مبلغ سفارش", minIn), fieldRow("سقف استفاده", maxIn), fieldRow("سقف هر کاربر", perUserIn),
      fieldRow("شروع", startIn), fieldRow("پایان", endIn), fieldRow("کد معرف (اختیاری)", affiliateIn), fieldRow("وضعیت", statusSel),
      fieldRow("محدود به پلن‌ها (خالی = همه)", planBox, "span2")
    );
    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ذخیرهٔ کد" });
    save.addEventListener("click", () => {
      const code = codeIn.value.trim().toUpperCase();
      if (!code) return toast("کد تخفیف لازم است.", "error");
      if (typeSel.value === "percent" && Number(valueIn.value) > 100) return toast("درصد تخفیف حداکثر ۱۰۰ است.", "error");
      const next = normalizeCoupon({
        ...base,
        code,
        type: typeSel.value,
        value: Math.max(0, Number(valueIn.value) || 0),
        minAmount: Math.max(0, Number(minIn.value) || 0),
        maxUses: Math.max(0, Number(maxIn.value) || 0),
        perUserLimit: Math.max(0, Number(perUserIn.value) || 0),
        startsAt: startIn.value,
        expiresAt: endIn.value,
        affiliate: affiliateIn.value.trim(),
        status: statusSel.value,
        planIds: checks.filter((cb) => cb.checked).map((cb) => cb.value)
      });
      const bill = readBilling();
      if (bill.coupons.some((x) => normalizeCoupon(x).id !== next.id && normalizeCoupon(x).code === next.code)) return toast("این کد قبلاً ثبت شده است.", "error");
      const exists = bill.coupons.some((x) => normalizeCoupon(x).id === next.id);
      writeBilling({ coupons: exists ? bill.coupons.map((x) => (normalizeCoupon(x).id === next.id ? next : x)) : [next, ...bill.coupons] });
      logBillingEvent({ kind: "coupon", action: isNew ? `ساخت کد ${next.code}` : `ویرایش کد ${next.code}` });
      logAudit({ kind: "plan", action: isNew ? "ساخت کد تخفیف" : "ویرایش کد تخفیف", target: next.code });
      closeModal();
      renderers.coupons(section);
      toast("کد تخفیف ذخیره شد.", "success");
    });
    showModal(isNew ? "کد تخفیف جدید" : `ویرایش ${base.code}`, body, [save]);
  }

  /* ----- financial dashboard ----- */
  renderers.finance = (section) => {
    section.replaceChildren();
    const cur = currencyNow();
    const billing = readBilling();
    const m = computeMetrics({ plans: draftPlans(), billing });
    const head = card("داشبورد مالی", "شاخص‌ها از اشتراک‌ها و پرداخت‌های ثبت‌شده در همین کنسول محاسبه می‌شوند؛ پس از اتصال بک‌اند همان فرمول روی دادهٔ سروری اجرا می‌شود.");
    const kpis = el("div", { class: "fin-grid" });
    const kpi = (label, value, hint) => {
      const a = el("article", { class: "fin-kpi" });
      a.append(el("span", { class: "fin-lbl", text: label }), el("strong", { text: value }));
      if (hint) a.append(el("small", { text: hint }));
      return a;
    };
    kpis.append(
      kpi("درآمد ماهانهٔ تکرارشونده (MRR)", formatMoney(m.mrr, cur)),
      kpi("درآمد سالانهٔ تکرارشونده (ARR)", formatMoney(m.arr, cur)),
      kpi("اشتراک فعال", String(m.active), `${m.totalSubs} کل اشتراک`),
      kpi("اشتراک جدید (۳۰ روز)", String(m.newSubs)),
      kpi("لغو (۳۰ روز)", String(m.canceled30), `نرخ ریزش ٪${m.churnRate.toLocaleString("fa-IR")}`),
      kpi("پرداخت ناموفق (۳۰ روز)", String(m.failed30)),
      kpi("درآمد ثبت‌شده", formatMoney(m.revenueTotal, cur), `${m.totalPayments} پرداخت`),
      kpi("پیش‌بینی ماه بعد", formatMoney(m.forecast, cur))
    );
    head.append(kpis);
    section.append(head);

    const charts = el("div", { class: "fin-charts" });
    const rev = el("article", { class: "ocard" });
    rev.append(el("h2", { text: "روند درآمد ۶ ماه" }));
    rev.append(lineChart({ labels: m.revenueSeries.map((r) => r.label), values: m.revenueSeries.map((r) => r.value), color: "#3d6bff" }));
    charts.append(rev);
    const dist = el("article", { class: "ocard" });
    dist.append(el("h2", { text: "توزیع اشتراک بین پلن‌ها" }));
    dist.append(donut({ items: m.distribution }));
    charts.append(dist);
    section.append(charts);

    const flow = el("article", { class: "ocard" });
    flow.append(el("h2", { text: "ارتقا و تنزل (۳۰ روز)" }));
    flow.append(barChart({ labels: ["ارتقا", "تنزل"], values: [m.upgrades, m.downgrades], color: "#f5b23e" }));
    section.append(flow);

    const recent = el("article", { class: "ocard" });
    recent.append(el("h2", { text: "آخرین پرداخت‌ها" }));
    const { wrap: tbl, tbody } = table(["فاکتور", "کاربر", "پلن", "مبلغ", "وضعیت", "تاریخ"], []);
    const pays = billing.payments.slice(0, 6);
    if (!pays.length) emptyRow(tbody, 6, "پرداختی ثبت نشده؛ از صفحهٔ پرداخت‌ها یا اشتراک‌ها ثبت کن.");
    for (const p of pays) {
      const tr = el("tr");
      tr.append(el("td", { text: p.invoiceNo }));
      tr.append(el("td", { text: p.userKey || "—" }));
      tr.append(el("td", { text: p.planName || "—" }));
      tr.append(el("td", { text: formatMoney(p.amount, p.currency || cur) }));
      const st = el("td");
      st.append(tag(PAYMENT_STATUSES[p.status] || p.status, p.status === "paid" ? "ok" : p.status === "failed" ? "bad" : ""));
      tr.append(st);
      tr.append(el("td", { text: new Date(p.paidAt || p.createdAt).toLocaleDateString("fa-IR") }));
      tbody.append(tr);
    }
    recent.append(tbl);
    const go = el("button", { class: "btn btn-ghost btn-sm ow-mt", type: "button", text: "مدیریت پرداخت‌ها" });
    go.addEventListener("click", () => ctx.showView("payments"));
    recent.append(go);
    section.append(recent);
    section.append(honesty("MRR از قیمت مؤثر پلن‌ها (با تخفیف فعال) و دورهٔ هر اشتراک محاسبه می‌شود؛ بدون اشتراک واقعی، اعداد صفر می‌مانند."));
  };

  /* ----- pricing / premium / payments ----- */
  renderers.pricing = (section) => {
    section.replaceChildren();
    const draft = ctx.getDraft();
    const cur = currencyNow();
    const wrap = card("قیمت‌گذاری", "ارز نمایش و نمای زندهٔ صفحهٔ قیمت. با وجود پلن عمومی منتشرشده، کارت‌های سایت از داده ساخته می‌شوند؛ در غیر این صورت کارت‌های ثابت قبلی حفظ می‌شوند.");
    const currencySel = selectInput(Object.values(CURRENCIES).map((c) => ({ value: c.id, label: `${c.label} (${c.id})` })), cur);
    currencySel.dataset.cfg = "billing.currency";
    const grid = el("div", { class: "form-grid" });
    grid.append(fieldRow("ارز نمایش قیمت", currencySel));
    wrap.append(grid);
    const pub = draftPlans().filter((p) => p.status === "published" && p.visibility === "public");
    const info = el("p", { class: "ohint ow-mt" });
    info.textContent = pub.length
      ? `${pub.length} پلن عمومی منتشرشده روی صفحهٔ قیمت سایت نمایش داده می‌شود.`
      : "پلن عمومی منتشرشده‌ای نیست؛ کارت‌های ثابت قبلی سایت نمایش داده می‌شوند.";
    wrap.append(info);
    if (pub.length) {
      wrap.append(el("h3", { class: "ow-h3", text: "پیش‌نمایش زنده" }));
      const preview = el("div", { class: "pricing-grid pb-pricing-preview" });
      for (const plan of pub) preview.append(planCard(plan, { currency: cur }));
      wrap.append(preview);
      const actions = el("div", { class: "ov-actions ow-mt" });
      const openPlans = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "سازندهٔ پلن" });
      openPlans.addEventListener("click", () => ctx.showView("plans"));
      const previewBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "پیش‌نمایش سایت" });
      previewBtn.addEventListener("click", () => ctx.previewSite());
      actions.append(openPlans, previewBtn);
      wrap.append(actions);
    }
    section.append(wrap);

    const legacy = card("پلن پریمیوم ساده", "اگر پلن منتشرشده‌ای وجود نداشته باشد، این دکمه و لینک پرداخت روی کارت پریمیوم ثابت سایت استفاده می‌شود.");
    const toggle = el("div", { class: "toggle-grid" });
    toggle.append(cfgSwitch("نمایش دکمهٔ خرید", "plans.premiumEnabled", !!draft?.plans?.premiumEnabled));
    legacy.append(toggle);
    const f = el("div", { class: "form-grid ow-mt" });
    f.append(cfgField("قیمت (فارسی)", "plans.premiumPriceFa"));
    f.append(cfgField("Price (English)", "plans.premiumPriceEn"));
    f.append(cfgField("لینک پرداخت", "plans.premiumUrl", "url", { attrs: { dir: "ltr" } }));
    legacy.append(f);
    const link = el("p", { class: "ohint ow-mt" });
    link.textContent = draft?.plans?.premiumUrl ? `لینک فعلی: ${draft.plans.premiumUrl}` : "لینک پرداخت خالی است؛ دکمهٔ خرید غیرفعال می‌ماند.";
    legacy.append(link);
    section.append(legacy);
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
    const bill = readBilling();
    const cur = currencyNow();
    section.append(card("پرداخت‌ها", "چند درگاه قابل تنظیم است. کلیدهای محرمانه هرگز در مرورگر ذخیره یا نمایش داده نمی‌شوند و فقط در سرور تنظیم می‌شوند."));

    const providersCard = el("article", { class: "ocard" });
    providersCard.append(el("h2", { text: "درگاه‌های پرداخت" }));
    const provGrid = el("div", { class: "prov-grid" });
    for (const meta of PROVIDERS) {
      const saved = sanitizeProviderConfig(bill.providers[meta.id] || { id: meta.id }) || { id: meta.id, mode: "disabled", callbackUrl: "", fields: {} };
      const box = el("article", { class: "prov-card" });
      box.append(el("h3", { text: meta.label }), el("p", { class: "hint-s", text: meta.note }));
      const modeSel = selectInput(Object.entries(PROVIDER_MODES).map(([value, label]) => ({ value, label })), saved.mode);
      box.append(fieldRow("حالت", modeSel));
      const fieldInputs = {};
      for (const f of meta.publicFields) {
        const inp = el("input", { type: "text", dir: "ltr", placeholder: f.placeholder || "" });
        inp.value = saved.fields[f.key] || "";
        fieldInputs[f.key] = inp;
        box.append(fieldRow(f.label, inp));
      }
      const cbIn = el("input", { type: "url", dir: "ltr", placeholder: "https://…/api/billing/callback" });
      cbIn.value = saved.callbackUrl || "";
      box.append(fieldRow("Callback URL", cbIn));
      const secrets = el("ul", { class: "prov-secrets" });
      for (const s of meta.secretFields) secrets.append(el("li", { text: `${s.env} — فقط در سرور` }));
      box.append(secrets);
      const readProvider = () => sanitizeProviderConfig({
        id: meta.id,
        mode: modeSel.value,
        callbackUrl: cbIn.value.trim(),
        fields: Object.fromEntries(Object.entries(fieldInputs).map(([k, input]) => [k, input.value])),
        secretsRef: true,
        updatedAt: Date.now()
      });
      const health = el("div", { class: "prov-health" });
      for (const c of providerHealth(readProvider()).checks) health.append(el("span", { class: c.ok ? "ok" : "warn", text: `${c.ok ? "✓" : "•"} ${c.text}` }));
      box.append(health);
      const actions = el("div", { class: "ov-actions ow-mt" });
      const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ذخیرهٔ تنظیمات" });
      save.addEventListener("click", () => {
        const cfg = readProvider();
        writeBilling({ providers: { ...readBilling().providers, [meta.id]: cfg } });
        logBillingEvent({ kind: "provider", action: `ذخیرهٔ تنظیمات ${meta.label}`, providerId: meta.id });
        logAudit({ kind: "plan", action: `تنظیم درگاه ${meta.label}`, target: cfg.mode });
        renderers.payments(section);
        toast("تنظیمات عمومی درگاه ذخیره شد؛ بدون کلید محرمانه.", "success");
      });
      const test = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "تست اتصال" });
      test.addEventListener("click", () => {
        try {
          createCheckout(meta.id, readProvider(), { planId: "", amount: 0 });
          toast("تراکنش آزمایشی ساخته شد.", "success");
        } catch (err) {
          const honest = err.code === "backend_required";
          toast(honest ? `${meta.label}: ساخت تراکنش نیازمند سرور است؛ تنظیمات عمومی معتبر است.` : err.message, honest ? "info" : "error");
        }
      });
      actions.append(save, test);
      box.append(actions);
      provGrid.append(box);
    }
    providersCard.append(provGrid);
    section.append(providersCard);

    const hosted = card("لینک پرداخت میزبانی‌شده", "ساده‌ترین مسیر فروش بدون بک‌اند؛ روی کارت پریمیوم ثابت سایت استفاده می‌شود.");
    const { wrap: tbl, tbody } = table(["روش", "وضعیت", "اقدام"], []);
    const tr = el("tr");
    tr.append(el("td", { text: "لینک پرداخت" }));
    const st = el("td");
    st.append(tag(ctx.getDraft()?.plans?.premiumUrl ? "تنظیم‌شده" : "تنظیم نشده", ctx.getDraft()?.plans?.premiumUrl ? "ok" : "bad"));
    tr.append(st);
    const act = el("td");
    act.append(miniBtn("تنظیم لینک", () => ctx.showView("pricing")));
    tr.append(act);
    tbody.append(tr);
    hosted.append(tbl);
    section.append(hosted);

    const paysCard = el("article", { class: "ocard" });
    paysCard.append(el("h2", { text: "تراکنش‌ها" }));
    const payBar = el("div", { class: "ow-toolbar" });
    const manual = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "پرداخت دستی" });
    manual.addEventListener("click", () => openManualPayment(section));
    payBar.append(manual);
    paysCard.append(payBar);
    const pt = table(["فاکتور", "کاربر", "پلن", "مبلغ", "درگاه", "وضعیت", "تاریخ", "اقدام"], []);
    const payments = bill.payments.slice(0, 40);
    if (!payments.length) emptyRow(pt.tbody, 8, "تراکنشی ثبت نشده است.");
    for (const p of payments) {
      const row = el("tr");
      row.append(el("td", { text: p.invoiceNo }), el("td", { text: p.userKey || "—" }), el("td", { text: p.planName || "—" }), el("td", { text: formatMoney(p.amount, p.currency || cur) }), el("td", { text: p.provider }));
      const stTd = el("td");
      stTd.append(tag(PAYMENT_STATUSES[p.status] || p.status, p.status === "paid" ? "ok" : p.status === "failed" ? "bad" : ""));
      row.append(stTd);
      row.append(el("td", { text: new Date(p.paidAt || p.createdAt).toLocaleDateString("fa-IR") }));
      const pAct = el("td");
      for (const status of ["paid", "failed", "refunded", "void"]) {
        if (status === p.status) continue;
        pAct.append(miniBtn(PAYMENT_STATUSES[status], () => {
          updatePaymentStatus(p.id, status);
          logAudit({ kind: "plan", action: `وضعیت ${p.invoiceNo}: ${PAYMENT_STATUSES[status]}`, target: p.invoiceNo });
          renderers.payments(section);
        }, status === "refunded" || status === "void"));
      }
      row.append(pAct);
      pt.tbody.append(row);
    }
    paysCard.append(pt.wrap);
    section.append(paysCard);
    section.append(honesty("کلید محرمانه، وب‌هوک و ایجاد تراکنش فقط در سرور انجام می‌شود. تا اتصال بک‌اند، این صفحه پیکربندی عمومی را ذخیره می‌کند و هیچ تراکنش ساختگی نمی‌سازد."));
  };

  function openManualPayment(section) {
    const body = el("div", { class: "form-grid" });
    const amountIn = numberInput(0);
    const statusSel = selectInput(Object.entries(PAYMENT_STATUSES).map(([value, label]) => ({ value, label })), "paid");
    const userIn = el("input", { type: "text" });
    const noteIn = el("input", { type: "text" });
    body.append(fieldRow("مبلغ", amountIn), fieldRow("وضعیت", statusSel), fieldRow("کاربر (اختیاری)", userIn), fieldRow("یادداشت", noteIn, "span2"));
    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ثبت" });
    save.addEventListener("click", () => {
      const amount = Number(amountIn.value) || 0;
      if (amount <= 0) return toast("مبلغ باید بزرگ‌تر از صفر باشد.", "error");
      const userKey = userIn.value.trim();
      const payment = recordPayment({ subscription: userKey ? { userKey } : null, amount, currency: currencyNow(), provider: "manual", status: statusSel.value, note: noteIn.value.trim() });
      logAudit({ kind: "plan", action: `ثبت پرداخت ${payment.invoiceNo}`, target: userKey || "مهمان" });
      closeModal();
      renderers.payments(section);
      toast(`فاکتور ${payment.invoiceNo} ثبت شد.`, "success");
    });
    showModal("پرداخت دستی", body, [save]);
  }

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
    preview.style.background = `linear-gradient(135deg,${current.accent || "#3d6bff"},${current.accent2 || "#f5b23e"})`;
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
    let token = "";
    try { token = sessionStorage.getItem("wt.ownerJwt") || ""; } catch {}
    let base = "";
    try { base = ctx.getApiBase(); } catch {}

    const locked = !token;
    const warn = card("اتصال ایمیل و پیامک", "از همین صفحه SMTP و درگاه پیامک را وصل کن؛ فرم‌ها همیشه اینجا هستند.");
    const p = el("p", { class: "ohint" });
    if (locked) {
      p.textContent = base
        ? `آدرس سرور: ${base} — هنوز نشست سروری مالک پیدا نشد. یک بار از کنسول خارج شو و دوباره با رمز مالک وارد شو؛ آن‌وقت دکمه‌های ذخیره و ارسال آزمایشی فعال می‌شوند.`
        : "آدرس سرور تنظیم نشده؛ سایت به بک‌اند وصل نیست. تا وقتی سرور پوشهٔ server بالا بیاید، این فرم‌ها فقط نمایشی‌اند و ارسال واقعی ایمیل یا پیامک انجام نمی‌شود.";
    } else {
      p.textContent = "اتصال فعلی و وضعیت ارسال پایین همین صفحه دیده می‌شود؛ رمزها همیشه فقط روی سرور می‌مانند.";
    }
    warn.append(p);
    section.append(warn);

    const field = (label, input, span2 = false) => {
      const lab = el("label", { class: `ofield${span2 ? " span2" : ""}` });
      lab.append(el("span", { text: label }), input);
      return lab;
    };
    const textInput = (type, attrs = {}) => el("input", { type, dir: type === "checkbox" ? null : "ltr", autocomplete: "off", ...attrs });
    const checkField = (label, input) => {
      const lab = el("label", { class: "ofield" });
      lab.append(el("span", { text: label }), el("label", {}, [input, " فعال"]));
      return lab;
    };
    const statusText = (node, text, ok) => {
      node.textContent = text;
      node.classList.toggle("ok", Boolean(ok));
    };

    /* ----- mail ----- */
    const mailCard = card("اتصال ایمیل (SMTP)", "کد تأیید ایمیل و لینک تعیین رمز از همین اتصال ارسال می‌شوند. اگر خالی بماند، نسخهٔ بدون سرور فقط فایل outbox می‌سازد.");
    const mEnabled = el("input", { type: "checkbox" });
    const mHost = textInput("text", { placeholder: "smtp.gmail.com" });
    const mPort = textInput("number", { min: "1", max: "65535", placeholder: "587" });
    const mSecure = el("input", { type: "checkbox" });
    const mUser = textInput("text", { placeholder: "you@gmail.com" });
    const mPass = textInput("password", { placeholder: "رمز SMTP" });
    const mFrom = textInput("text", { placeholder: "هم‌تماشا <no-reply@example.com>" });
    const mailGrid = el("div", { class: "form-grid" });
    mailGrid.append(
      checkField("وضعیت", mEnabled),
      field("رمزنگاری SSL/TLS", mSecure),
      field("هاست", mHost),
      field("پورت", mPort),
      field("نام کاربری", mUser),
      field("رمز عبور", mPass),
      field("فرستنده", mFrom, true)
    );
    const mailActions = el("div", { class: "ov-actions" });
    const mailSave = el("button", { type: "button", class: "btn btn-primary btn-sm", text: "ذخیره اتصال ایمیل" });
    const mailClear = el("button", { type: "button", class: "btn btn-secondary btn-sm", text: "پاک کردن رمز SMTP" });
    mailActions.append(mailSave, mailClear);
    const mailStatus = el("p", { class: "ohint" });
    const mailTestRow = el("div", { class: "form-grid ow-mt" });
    const mTestTo = textInput("email", { placeholder: "you@example.com" });
    const mTestBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", text: "ارسال ایمیل آزمایشی" });
    mailTestRow.append(field("ایمیل آزمایشی", mTestTo), field(" ", mTestBtn));
    mailCard.append(mailGrid, mailActions, mailStatus, mailTestRow);

    /* ----- sms ----- */
    const smsCard = card("اتصال پیامک", "برای بازیابی رمز با پیامک، یک درگاه یا دستگاه SMS وصل کن. بدون اتصال، پیامک فقط در فایل outbox ذخیره می‌شود.");
    const sEnabled = el("input", { type: "checkbox" });
    const sProvider = el("select");
    for (const [value, text] of [["", "— انتخاب کن —"], ["kavenegar", "کاوه‌نگار"], ["twilio", "Twilio"], ["webhook", "وب‌هوک اختصاصی"]]) {
      sProvider.append(el("option", { value, text }));
    }
    const sApiKey = textInput("password", { placeholder: "API key" });
    const sSender = textInput("text", { placeholder: "شماره یا عنوان فرستنده" });
    const sSid = textInput("text", { placeholder: "ACxxxxxxxx" });
    const sToken = textInput("password", { placeholder: "auth token" });
    const sTwFrom = textInput("text", { placeholder: "+1…" });
    const sUrl = textInput("text", { placeholder: "https://example.com/sms" });
    const sWebKey = textInput("password", { placeholder: "کلید اختیاری" });

    const kavBox = el("div", { class: "form-grid ow-mt" });
    kavBox.append(field("کلید API کاوه‌نگار", sApiKey), field("شماره فرستنده", sSender));
    const twiBox = el("div", { class: "form-grid ow-mt" });
    twiBox.append(field("Account SID", sSid), field("Auth token", sToken), field("شماره فرستنده", sTwFrom));
    const webBox = el("div", { class: "form-grid ow-mt" });
    webBox.append(field("آدرس وب‌هوک", sUrl), field("کلید اختیاری", sWebKey));
    kavBox.hidden = true;
    twiBox.hidden = true;
    webBox.hidden = true;

    const smsGrid = el("div", { class: "form-grid" });
    smsGrid.append(checkField("وضعیت", sEnabled), field("درگاه", sProvider));
    const smsActions = el("div", { class: "ov-actions" });
    const smsSave = el("button", { type: "button", class: "btn btn-primary btn-sm", text: "ذخیره اتصال پیامک" });
    const smsClear = el("button", { type: "button", class: "btn btn-secondary btn-sm", text: "پاک کردن کلیدها" });
    smsActions.append(smsSave, smsClear);
    const smsStatus = el("p", { class: "ohint" });
    const smsTestRow = el("div", { class: "form-grid ow-mt" });
    const sTestTo = textInput("tel", { placeholder: "09121234567", inputmode: "tel" });
    const sTestBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", text: "ارسال پیامک آزمایشی" });
    smsTestRow.append(field("شماره آزمایشی", sTestTo), field(" ", sTestBtn));
    smsCard.append(smsGrid, kavBox, twiBox, webBox, smsActions, smsStatus, smsTestRow);

    const paintProvider = () => {
      kavBox.hidden = sProvider.value !== "kavenegar";
      twiBox.hidden = sProvider.value !== "twilio";
      webBox.hidden = sProvider.value !== "webhook";
    };
    sProvider.addEventListener("change", paintProvider);

    let latest = null;
    const paint = (conn, eff) => {
      latest = conn || null;
      const m = conn?.mail;
      if (m) {
        mEnabled.checked = Boolean(m.enabled);
        mHost.value = m.host || "";
        mPort.value = m.port || 587;
        mSecure.checked = Boolean(m.secure);
        mUser.value = m.user || "";
        mFrom.value = m.from || "";
        mPass.value = "";
        mPass.placeholder = m.passSet ? "رمز ذخیره شده — برای تغییر بنویس" : "رمز SMTP";
      }
      const s = conn?.sms;
      if (s) {
        sEnabled.checked = Boolean(s.enabled);
        sProvider.value = s.provider || "";
        sSender.value = s.sender || "";
        sSid.value = s.twilioSid || "";
        sTwFrom.value = s.twilioFrom || "";
        sUrl.value = s.webhookUrl || "";
        sApiKey.value = "";
        sToken.value = "";
        sWebKey.value = "";
        sApiKey.placeholder = s.apiKeySet ? "کلید ذخیره شده — برای تغییر بنویس" : "API key";
        sToken.placeholder = s.twilioTokenSet ? "توکن ذخیره شده — برای تغییر بنویس" : "auth token";
      }
      paintProvider();
      const mm = eff?.mail || {};
      statusText(mailStatus, mm.mode === "smtp"
        ? `وضعیت: SMTP فعال${mm.host ? ` (${mm.host})` : ""}${mm.error ? ` — آخرین خطا: ${mm.error}` : ""}`
        : "وضعیت: outbox — ایمیل فقط در فایل سرور ذخیره می‌شود و به کاربر نمی‌رسد.", mm.mode === "smtp");
      const ss = eff?.sms || {};
      statusText(smsStatus, ss.mode && ss.mode !== "outbox"
        ? `وضعیت: ${ss.mode}${ss.sender ? ` — فرستنده ${ss.sender}` : ""}${ss.error ? ` — آخرین خطا: ${ss.error}` : ""}`
        : "وضعیت: outbox — پیامک فقط در فایل سرور ذخیره می‌شود و به گوشی نمی‌رسد.", ss.mode && ss.mode !== "outbox");
    };

    const lockedMessage = "برای ذخیره، کنسول باید با حساب مالک به سرور وصل باشد.";
    const requireSession = () => {
      if (!locked) return;
      throw Object.assign(new Error(lockedMessage), { payload: { message: lockedMessage } });
    };
    const put = (body) => {
      requireSession();
      return apiFetch("/auth/owner/connections", { token, auth: false, method: "PUT", body, timeoutMs: 12000 });
    };
    const sendTest = (body) => {
      requireSession();
      return apiFetch("/auth/owner/connections/test", { token, auth: false, method: "POST", body, timeoutMs: 25000 });
    };

    mailSave.addEventListener("click", async () => {
      mailSave.disabled = true;
      try {
        const res = await put({
          mail: {
            enabled: mEnabled.checked,
            host: mHost.value.trim(),
            port: Number(mPort.value) || 587,
            secure: mSecure.checked,
            user: mUser.value.trim(),
            pass: mPass.value,
            from: mFrom.value.trim()
          }
        });
        paint(res.connections, res.effective);
        toast("اتصال ایمیل ذخیره شد.", "success");
      } catch (err) {
        toast(err?.payload?.message || "ذخیره نشد؛ ارتباط با سرور را بررسی کن.", "error");
      } finally {
        mailSave.disabled = false;
      }
    });

    mailClear.addEventListener("click", async () => {
      mailClear.disabled = true;
      try {
        const res = await put({ mail: { clear: ["pass"] } });
        paint(res.connections, res.effective);
        toast("رمز SMTP پاک شد.", "success");
      } catch {
        toast("پاک کردن انجام نشد.", "error");
      } finally {
        mailClear.disabled = false;
      }
    });

    mTestBtn.addEventListener("click", async () => {
      const to = mTestTo.value.trim();
      mTestBtn.disabled = true;
      try {
        const res = await sendTest({ kind: "mail", to });
        if (res.ok) toast(`ایمیل آزمایشی ارسال شد (${res.mode || "smtp"}).`, "success");
        else toast(`ارسال نشد: ${res.error || "خطای نامشخص"}`, "error");
      } catch (err) {
        toast(err?.payload?.message || "ارسال آزمایشی ناموفق بود.", "error");
      } finally {
        mTestBtn.disabled = false;
      }
    });

    smsSave.addEventListener("click", async () => {
      smsSave.disabled = true;
      try {
        const res = await put({
          sms: {
            enabled: sEnabled.checked,
            provider: sProvider.value,
            apiKey: sApiKey.value,
            sender: sSender.value.trim(),
            webhookUrl: sUrl.value.trim(),
            twilioSid: sSid.value.trim(),
            twilioToken: sToken.value,
            twilioFrom: sTwFrom.value.trim()
          }
        });
        paint(res.connections, res.effective);
        toast("اتصال پیامک ذخیره شد.", "success");
      } catch (err) {
        toast(err?.payload?.message || "ذخیره نشد؛ تنظیمات درگاه را بررسی کن.", "error");
      } finally {
        smsSave.disabled = false;
      }
    });

    smsClear.addEventListener("click", async () => {
      smsClear.disabled = true;
      try {
        const res = await put({ sms: { clear: ["apiKey", "twilioToken"] } });
        paint(res.connections, res.effective);
        toast("کلیدهای پیامک پاک شد.", "success");
      } catch {
        toast("پاک کردن انجام نشد.", "error");
      } finally {
        smsClear.disabled = false;
      }
    });

    sTestBtn.addEventListener("click", async () => {
      const to = sTestTo.value.trim();
      sTestBtn.disabled = true;
      try {
        const res = await sendTest({ kind: "sms", to });
        if (res.ok) toast(`پیامک آزمایشی ارسال شد (${res.mode || "درگاه"}).`, "success");
        else toast(`ارسال نشد: ${res.error || "خطای نامشخص"}`, "error");
      } catch (err) {
        toast(err?.payload?.message || "ارسال آزمایشی ناموفق بود.", "error");
      } finally {
        sTestBtn.disabled = false;
      }
    });

    section.append(mailCard, smsCard);
    section.append(honesty("کلیدهای SMTP و پیامک فقط روی سرور ذخیره می‌شوند و هرگز به مرورگر برنمی‌گردند. این فرم فقط با نشست سروری مالک کار می‌کند؛ اگر Pages استاتیک است، باید API جداگانه بالا باشد."));

    if (locked) {
      for (const btn of [mailSave, mailClear, mTestBtn, smsSave, smsClear, sTestBtn]) btn.disabled = true;
      const note = "وضعیت: نامشخص — برای خواندن وضعیت اتصال، کنسول باید با حساب مالک به سرور وصل باشد.";
      statusText(mailStatus, note, false);
      statusText(smsStatus, note, false);
      return;
    }

    (async () => {
      try {
        const res = await apiFetch("/auth/owner/connections", { token, auth: false, timeoutMs: 12000 });
        paint(res.connections, res.effective);
      } catch (err) {
        const note = err?.status === 401 || err?.status === 403
          ? "نشست سروری مالک منقضی شده؛ از کنسول خارج و دوباره وارد شو."
          : "ارتباط با سرور برقرار نشد.";
        statusText(mailStatus, note, false);
        statusText(smsStatus, note, false);
      }
    })();
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

  /* ----- feature center / config center (enterprise mode) ----- */
  const FC_CONTEXT = () => buildFlagContext({ user: { username: "owner", role: "owner" } });
  const fcStates = () => {
    const center = readFeatureCenter();
    return { center, states: resolveFlags(ctx.getDraft(), center.scopes, FC_CONTEXT()) };
  };
  const fcLabel = (id) => FLAG_BY_ID.get(id)?.label || id;
  const fcCounts = (states) => {
    const counts = { healthy: 0, partial: 0, disabled: 0, emergency: 0, scheduled: 0, dependency: 0, misconfigured: 0, future: 0, error: 0 };
    for (const flag of FLAGS) counts[flagHealth(flag, states[flag.id]).id] += 1;
    return counts;
  };
  const fcHistoryWrite = (entry) => {
    const center = readFeatureCenter();
    pushHistory(center, entry);
    writeFeatureCenter(center);
  };
  const fcAudit = (flag, action, before, after, extra = {}) => {
    logAudit({
      kind: "feature",
      action,
      target: flag.id,
      before,
      after,
      scope: extra.scope || "global",
      reason: extra.reason || "",
      source: extra.source || "owner",
      rollback: extra.rollback ?? before
    });
    fcHistoryWrite({ id: flag.id, action, scope: extra.scope || "global", before, after, reason: extra.reason || "", source: extra.source || "owner" });
  };
  const fcSetGlobal = (flag, value, extra = {}) => {
    const before = getPath(ctx.getDraft(), flag.path);
    ctx.setCfg(flag.path, value);
    fcAudit(flag, value ? "روشن‌کردن قابلیت" : "خاموش‌کردن قابلیت", before, value, extra);
  };
  const fcEnableChain = (id, seen = new Set()) => {
    const flag = FLAG_BY_ID.get(id);
    if (!flag || seen.has(id)) return true;
    seen.add(id);
    const { states } = fcStates();
    const state = states[id];
    if (state?.enabled) return true;
    if (state?.reason && state.reason !== "global") return false;
    for (const dep of flag.deps || []) if (!fcEnableChain(dep, seen)) return false;
    const before = getPath(ctx.getDraft(), flag.path);
    ctx.setCfg(flag.path, true);
    fcAudit(flag, "روشن‌کردن از زنجیرهٔ وابستگی", before, true);
    return true;
  };
  const fcRuleOf = (flag) => ctx.getDraft()?.featureRules?.[flag.path] || {};
  const fcSaveRule = (flag, rule, action) => {
    const before = JSON.stringify(fcRuleOf(flag));
    ctx.setFeatureRule(flag.path, rule);
    fcAudit(flag, action, before, JSON.stringify(rule), { source: "owner", reason: "زمان‌بندی/اضطرار" });
  };
  const fcModalLabel = (flag) => `${flag.label} · ${flag.id}`;
  const fcDepPrompt = (flag, missing, done) => {
    const body = el("div", { class: "fc-modal-body" });
    body.append(el("p", { class: "ohint", text: "برای روشن‌بودن این قابلیت، وابستگی‌های زیر باید فعال باشند. وضعیت هر وابستگی نشان داده شده است." }));
    for (const dep of missing) {
      const { states } = fcStates();
      const st = states[dep];
      const row = el("div", { class: "fc-dep-row" });
      row.append(el("b", { text: fcLabel(dep) }), tag(HEALTH_LABELS[flagHealth(FLAG_BY_ID.get(dep), st).id] || "—", st?.enabled ? "ok" : "bad"));
      body.append(row);
    }
    const cancel = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "انصراف", onclick: closeModal });
    const proceed = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "روشن‌کردن وابستگی‌ها و این قابلیت" });
    proceed.addEventListener("click", () => {
      let ok = true;
      for (const dep of missing) if (!fcEnableChain(dep)) ok = false;
      if (ok) {
        fcEnableChain(flag.id);
        if (fcStates().states[flag.id]?.enabled) { closeModal(); toast("قابلیت و وابستگی‌هایش روشن شدند.", "success"); }
        else { toast("وابستگی‌های مسدود (اضطراری/دامنه/زمان‌بندی) مانع روشن‌شدن هستند.", "error"); closeModal(); }
      } else {
        toast("برخی وابستگی‌ها مسدودند و از اینجا روشن نمی‌شوند.", "error");
      }
      done?.();
    });
    showModal(`وابستگی‌های «${flag.label}»`, body, [cancel, proceed]);
  };

  const FC_STATUS_OPTIONS = [
    ["all", "همه"], ["healthy", "سالم"], ["disabled", "خاموش"], ["emergency", "اضطراری"],
    ["scheduled", "زمان‌بندی"], ["dependency", "وابستگی"], ["partial", "محدود"], ["future", "آینده"]
  ];

  function fcFlagCard(flag, states, center, refresh) {
    const state = states[flag.id];
    const health = flagHealth(flag, state);
    const rule = fcRuleOf(flag);
    const history = lastHistoryFor(center, flag.id);
    const notes = center.notes?.[flag.id] || "";
    const isFav = center.favorites.includes(flag.id);
    const isPinned = center.pinned.includes(flag.id);
    const cardEl = el("article", { class: `ocard fc-flag${state?.enabled ? "" : " is-off"}${rule?.emergency ? " is-emergency" : ""}`, "data-flag": flag.id });
    const head = el("div", { class: "fc-flag-head" });
    head.append(el("b", { text: flag.label }), el("code", { text: flag.id }));
    head.append(tag(health.label, health.id === "healthy" ? "ok" : health.id === "partial" ? "" : "bad"));
    if (flag.future) head.append(tag("در انتظار پیاده‌سازی", ""));
    if (isPinned) head.append(tag("سنجاق", "ok"));
    const star = miniBtn(isFav ? "★" : "☆", () => {
      const c = readFeatureCenter();
      const list = new Set(c.favorites);
      if (list.has(flag.id)) list.delete(flag.id); else list.add(flag.id);
      c.favorites = [...list];
      writeFeatureCenter(c);
      refresh();
    });
    star.classList.add("fc-star");
    const pin = miniBtn(isPinned ? "برداشتن سنجاق" : "سنجاق", () => {
      const c = readFeatureCenter();
      const list = new Set(c.pinned);
      if (list.has(flag.id)) list.delete(flag.id); else list.add(flag.id);
      c.pinned = [...list];
      writeFeatureCenter(c);
      refresh();
    });
    head.append(star, pin);
    cardEl.append(head);
    cardEl.append(el("p", { class: "fc-desc", text: flag.desc }));

    const meta = el("div", { class: "fc-meta" });
    meta.append(el("span", { text: `مسیر: ${flag.path}` }));
    if (flag.deps?.length) meta.append(el("span", { text: `وابستگی: ${flag.deps.map(fcLabel).join("، ")}` }));
    if (notes) meta.append(el("span", { text: `یادداشت: ${notes}` }));
    if (history) meta.append(el("span", { text: `آخرین تغییر: ${new Date(history.at).toLocaleString("fa-IR")} · ${history.action}${history.scope !== "global" ? ` · ${history.scope}` : ""}` }));
    if (rule?.enableAt) meta.append(el("span", { text: `روشن‌سازی: ${new Date(rule.enableAt).toLocaleString("fa-IR")}` }));
    if (rule?.disableAt) meta.append(el("span", { text: `خاموشی: ${new Date(rule.disableAt).toLocaleString("fa-IR")}` }));
    if (rule?.emergency) meta.append(el("span", { class: "fc-meta-danger", text: "خاموشی اضطراری فعال است" }));
    if (state?.denials?.length) meta.append(el("span", { text: `منع دامنه: ${state.denials.join("، ")}` }));
    if (state?.failedDeps?.length) meta.append(el("span", { class: "fc-meta-danger", text: `وابستگی خاموش: ${state.failedDeps.map(fcLabel).join("، ")}` }));
    cardEl.append(meta);

    const controls = el("div", { class: "fc-controls" });
    const switchLine = el("label", { class: "switch-line" });
    const sw = el("input", { type: "checkbox" });
    sw.checked = getPath(ctx.getDraft(), flag.path) !== false;
    sw.disabled = !!flag.future;
    switchLine.append(sw, el("span", { text: flag.future ? "پیاده‌سازی نشده" : "فعال در پیکربندی سراسری" }));
    sw.addEventListener("change", () => {
      if (flag.future) return;
      if (sw.checked) {
        const missing = missingDependencies(flag.id, fcStates().states);
        if (missing.length) { sw.checked = false; fcDepPrompt(flag, missing, refresh); return; }
        fcSetGlobal(flag, true);
      } else {
        const dependents = dependentIds(flag.id).filter((id) => fcStates().states[id]?.enabled && !FLAG_BY_ID.get(id)?.future);
        if (dependents.length && !confirm(`با خاموش‌کردن «${flag.label}» این قابلیت‌ها هم خاموش می‌شوند:\n${dependents.map(fcLabel).join("، ")}\nادامه می‌دهی؟`)) {
          sw.checked = true;
          return;
        }
        fcSetGlobal(flag, false, { reason: dependents.length ? "خاموشی وابسته‌ها" : "" });
      }
      refresh();
      refreshDashboard();
      refreshAnalytics();
    });
    controls.append(switchLine);

    if (!flag.future) {
      controls.append(miniBtn(rule?.emergency ? "پایان خاموشی اضطراری" : "خاموشی اضطراری", () => {
        const cur = fcRuleOf(flag);
        const next = { ...cur, emergency: !cur.emergency };
        fcSaveRule(flag, next, next.emergency ? "خاموشی اضطراری" : "پایان خاموشی اضطراری");
        refresh(); refreshDashboard(); refreshAnalytics();
      }, !rule?.emergency));
      controls.append(miniBtn("زمان‌بندی", () => fcScheduleModal(flag, refresh)));
    }
    controls.append(miniBtn("دامنه‌ها", () => fcScopeModal(flag, refresh)));
    controls.append(miniBtn("یادداشت", () => fcNotesModal(flag, refresh)));
    controls.append(miniBtn("تاریخچه", () => fcHistoryModal(flag, refresh)));
    if (history && typeof history.before === "boolean") {
      controls.append(miniBtn("بازگردانی", () => {
        if (!confirm(`مقدار قبلی «${flag.label}» بازگردانده شود؟`)) return;
        fcSetGlobal(flag, history.before, { reason: "بازگردانی از تاریخچه", scope: "rollback" });
        refresh(); refreshDashboard(); refreshAnalytics();
      }));
    }
    cardEl.append(controls);
    return cardEl;
  }

  function fcScheduleModal(flag, refresh) {
    const rule = fcRuleOf(flag);
    const toLocal = (ts) => {
      if (!ts) return "";
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const enableIn = el("input", { type: "datetime-local" });
    const disableIn = el("input", { type: "datetime-local" });
    enableIn.value = toLocal(rule.enableAt);
    disableIn.value = toLocal(rule.disableAt);
    const body = el("div", { class: "fc-modal-body" });
    body.append(fieldRow("زمان روشن‌سازی", enableIn), fieldRow("زمان خاموش‌سازی", disableIn));
    body.append(el("p", { class: "ohint", text: "اگر بازهٔ روشن‌سازی یا خاموش‌سازی آینده باشد، وضعیت قابلیت به‌صورت خودکار زمان‌بندی می‌شود. زمان‌ها روی همین مرورگر بلافاصله اعمال می‌شوند و برای همهٔ بازدیدکنندگان پس از انتشار." }));
    const cancel = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "انصراف", onclick: closeModal });
    const clear = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "پاک‌کردن زمان‌بندی" });
    clear.addEventListener("click", () => {
      const { enableAt, disableAt, ...rest } = rule;
      fcSaveRule(flag, rest, "پاک‌کردن زمان‌بندی");
      closeModal(); refresh(); refreshDashboard(); refreshAnalytics();
    });
    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ذخیرهٔ زمان‌بندی" });
    save.addEventListener("click", () => {
      const enableAt = enableIn.value ? Date.parse(enableIn.value) : 0;
      const disableAt = disableIn.value ? Date.parse(disableIn.value) : 0;
      if ((enableAt && !Number.isFinite(enableAt)) || (disableAt && !Number.isFinite(disableAt))) return toast("زمان معتبر نیست.", "error");
      if (enableAt && disableAt && enableAt >= disableAt) return toast("زمان روشن‌سازی باید قبل از خاموش‌سازی باشد.", "error");
      fcSaveRule(flag, { ...rule, enableAt, disableAt }, "تنظیم زمان‌بندی");
      closeModal(); refresh(); refreshDashboard(); refreshAnalytics();
      toast("زمان‌بندی ذخیره شد.", "success");
    });
    showModal(`زمان‌بندی ${fcModalLabel(flag)}`, body, [cancel, clear, save]);
  }

  function fcScopeModal(flag, refresh) {
    const body = el("div", { class: "fc-modal-body" });
    const list = el("div", { class: "fc-scope-list" });
    const typeSel = selectInput(SCOPE_TYPES.map((t) => ({ value: t.id, label: t.label })), "role");
    const keyIn = el("input", { class: "ow-input", placeholder: "مثلاً member یا نام کاربری", dir: "ltr" });
    const addBtn = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "افزودن منع" });
    const hint = el("p", { class: "ohint", text: "دامنه‌ها فقط می‌توانند قابلیت را خاموش کنند (منع). سخت‌گیرانه‌ترین وضعیت برنده است و خاموشی اضطراری بر همه مقدم است. این منع‌ها روی همان مرورگر بلافاصله و برای سرور پس از اتصال API اعمال می‌شوند." });

    const renderRows = () => {
      list.replaceChildren();
      const c = readFeatureCenter();
      let found = false;
      for (const type of SCOPE_TYPES) {
        for (const [key, flags] of Object.entries(c.scopes[type.id] || {})) {
          if (flags?.[flag.id] !== "off") continue;
          found = true;
          const row = el("div", { class: "fc-scope-row" });
          row.append(el("span", { text: `${type.label}: ${key}` }), tag("منع", "bad"));
          row.append(miniBtn("حذف", () => {
            const center = readFeatureCenter();
            delete center.scopes[type.id][key][flag.id];
            if (!Object.keys(center.scopes[type.id][key]).length) delete center.scopes[type.id][key];
            if (!Object.keys(center.scopes[type.id] || {}).length) delete center.scopes[type.id];
            writeFeatureCenter(center);
            logAudit({ kind: "feature", action: "حذف منع دامنه", target: flag.id, scope: `${type.id}:${key}`, source: "owner", before: "off", after: null });
            fcHistoryWrite({ id: flag.id, action: "حذف منع دامنه", scope: `${type.id}:${key}`, before: "off", after: null, reason: "", source: "owner" });
            renderRows(); refresh(); refreshDashboard();
          }, true));
          list.append(row);
        }
      }
      if (!found) list.append(el("p", { class: "log-empty", text: "هیچ منع دامنه‌ای برای این قابلیت ثبت نشده." }));
    };

    addBtn.addEventListener("click", () => {
      const type = typeSel.value;
      const key = keyIn.value.trim();
      if (!key) return toast("کلید دامنه را وارد کن.", "error");
      const center = readFeatureCenter();
      center.scopes[type] = center.scopes[type] || {};
      center.scopes[type][key] = center.scopes[type][key] || {};
      center.scopes[type][key][flag.id] = "off";
      writeFeatureCenter(center);
      logAudit({ kind: "feature", action: "افزودن منع دامنه", target: flag.id, scope: `${type}:${key}`, source: "owner", before: null, after: "off" });
      fcHistoryWrite({ id: flag.id, action: "افزودن منع دامنه", scope: `${type}:${key}`, before: null, after: "off", reason: "scope", source: "owner" });
      keyIn.value = "";
      renderRows(); refresh(); refreshDashboard();
      toast("منع دامنه ذخیره شد.", "success");
    });

    body.append(hint, list);
    const addBar = el("div", { class: "ow-toolbar" });
    addBar.append(typeSel, keyIn, addBtn);
    body.append(addBar);
    renderRows();
    showModal(`دامنه‌های ${fcModalLabel(flag)}`, body, [el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "بستن", onclick: closeModal })]);
  }

  function fcNotesModal(flag, refresh) {
    const ta = el("textarea", { rows: "3", maxlength: "240" });
    ta.value = readFeatureCenter().notes?.[flag.id] || "";
    const body = el("div", { class: "fc-modal-body" });
    body.append(fieldRow("یادداشت مالک", ta));
    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ذخیره" });
    save.addEventListener("click", () => {
      const center = readFeatureCenter();
      center.notes = center.notes || {};
      center.notes[flag.id] = ta.value.trim();
      writeFeatureCenter(center);
      logAudit({ kind: "feature", action: "ویرایش یادداشت قابلیت", target: flag.id, detail: ta.value.trim(), source: "owner" });
      closeModal(); refresh();
    });
    showModal(`یادداشت ${fcModalLabel(flag)}`, body, [
      el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "انصراف", onclick: closeModal }), save
    ]);
  }

  function fcHistoryModal(flag, refresh) {
    const list = el("div", { class: "fc-history-list" });
    const items = readFeatureCenter().history.filter((h) => h.id === flag.id).slice(0, 40);
    if (!items.length) list.append(el("p", { class: "log-empty", text: "تاریخچه‌ای برای این قابلیت ثبت نشده." }));
    for (const h of items) {
      const row = el("div", { class: "fc-history-row" });
      row.append(el("time", { text: new Date(h.at).toLocaleString("fa-IR") }));
      row.append(el("b", { text: h.action }));
      row.append(el("span", { text: `${h.scope} · ${h.source}` }));
      row.append(el("span", { text: `${h.before ?? "—"} ← ${h.after ?? "—"}` }));
      if (h.reason) row.append(el("small", { text: h.reason }));
      if (typeof h.before === "boolean") {
        row.append(miniBtn("بازگردانی", () => {
          const cur = getPath(ctx.getDraft(), flag.path);
          ctx.setCfg(flag.path, h.before);
          logAudit({ kind: "feature", action: "بازگردانی از تاریخچه", target: flag.id, before: cur, after: h.before, scope: "rollback", reason: h.reason || "", source: "owner", rollback: cur });
          fcHistoryWrite({ id: flag.id, action: "بازگردانی از تاریخچه", scope: "rollback", before: cur, after: h.before, reason: h.reason || "", source: "owner" });
          closeModal(); refresh(); refreshDashboard(); refreshAnalytics();
          toast("مقدار قبلی بازگردانده شد.", "success");
        }));
      }
      list.append(row);
    }
    showModal(`تاریخچهٔ ${fcModalLabel(flag)}`, list, [el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "بستن", onclick: closeModal })]);
  }

  function fcDownloadExport() {
    const data = buildFeatureExport(ctx.getDraft(), readFeatureCenter());
    const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: `features-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logAudit({ kind: "backup", action: "خروجی پیکربندی قابلیت‌ها", source: "owner" });
  }

  function fcImportFile(file, refresh) {
    if (!file) return;
    file.text().then((text) => {
      const payload = readFeatureImport(JSON.parse(text));
      ctx.applyFeatureSnapshot(payload);
      const center = readFeatureCenter();
      center.scopes = payload.scopes;
      center.favorites = payload.favorites;
      center.pinned = payload.pinned;
      center.notes = payload.notes;
      writeFeatureCenter(center);
      logAudit({ kind: "backup", action: "بازیابی پیکربندی قابلیت‌ها", target: file.name || "", source: "owner" });
      toast("پیکربندی قابلیت‌ها بازیابی شد.", "success");
      refresh(); refreshDashboard(); refreshAnalytics();
    }).catch(() => toast("فایل قابلیت معتبر نیست.", "error"));
  }

  function fcSnapshotsCard(refresh) {
    const center = readFeatureCenter();
    const cardEl = card("نقاط بازیابی", "وضعیت کامل قابلیت‌ها، قواعد، دامنه‌ها و یادداشت‌ها در همین مرورگر ذخیره می‌شود. حداکثر ۲۰ نقطه.");
    const bar = el("div", { class: "ow-toolbar" });
    const label = el("input", { class: "ow-input", placeholder: "برچسب نقطهٔ بازیابی (اختیاری)" });
    const make = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ثبت نقطهٔ بازیابی" });
    make.addEventListener("click", () => {
      const c = readFeatureCenter();
      const snap = snapshotFeatureState(ctx.getDraft(), c, label.value.trim() || `نقطهٔ ${new Date().toLocaleString("fa-IR")}`);
      c.snapshots = [snap, ...(c.snapshots || [])].slice(0, 20);
      writeFeatureCenter(c);
      logAudit({ kind: "backup", action: "ثبت نقطهٔ بازیابی قابلیت‌ها", target: snap.label, source: "owner" });
      refresh(); toast("نقطهٔ بازیابی ثبت شد.", "success");
    });
    bar.append(label, make);
    cardEl.append(bar);
    const list = el("div", { class: "fc-snap-list" });
    if (!center.snapshots?.length) list.append(el("p", { class: "log-empty", text: "هنوز نقطهٔ بازیابی ثبت نشده." }));
    for (const snap of center.snapshots || []) {
      const row = el("div", { class: "fc-snap-row" });
      row.append(el("b", { text: snap.label }), el("time", { text: new Date(snap.at).toLocaleString("fa-IR") }));
      row.append(miniBtn("بازگردانی", () => {
        if (!confirm(`بازگردانی «${snap.label}»؟ قابلیت‌های فعلی با این نقطه جایگزین می‌شوند.`)) return;
        const payload = readFeatureImport(snap.data);
        ctx.applyFeatureSnapshot(payload);
        const c = readFeatureCenter();
        c.scopes = payload.scopes;
        c.favorites = payload.favorites;
        c.pinned = payload.pinned;
        c.notes = payload.notes;
        writeFeatureCenter(c);
        logAudit({ kind: "backup", action: "بازگردانی از نقطهٔ بازیابی", target: snap.label, source: "owner" });
        refresh(); refreshDashboard(); refreshAnalytics();
        toast("نقطهٔ بازیابی اعمال شد.", "success");
      }));
      row.append(miniBtn("حذف", () => {
        const c = readFeatureCenter();
        c.snapshots = c.snapshots.filter((s) => s.id !== snap.id);
        writeFeatureCenter(c);
        refresh();
      }, true));
      list.append(row);
    }
    cardEl.append(list);
    return cardEl;
  }

  function fcAnalyticsCard() {
    const usage = readUsage();
    const series = usageSeries(usage, 14);
    const top = usageTop(usage, 8);
    const adopt = usageAdoption(usage, 14);
    const cardEl = card("تحلیل استفاده از قابلیت‌ها", "استفاده‌ها روی همین مرورگر ثبت می‌شوند و با هر رویداد به‌روز می‌شوند. تفکیک پلن/نقش/اتاق از زمینهٔ اجرای صفحه خوانده می‌شود.");
    const stats = el("div", { class: "stat-grid" });
    const mk = (label, value) => {
      const a = el("article", { class: "ostat" });
      a.append(el("span", { class: "ostat-lbl", text: label }), el("strong", { text: String(value) }));
      return a;
    };
    stats.append(mk("کل استفاده (۹۰ روز)", Object.values(usage.total || {}).reduce((s, n) => s + Number(n || 0), 0)), mk("قابلیت‌های استفاده‌شده", adopt.active), mk("روزهای با فعالیت", series.filter((d) => d.value > 0).length));
    cardEl.append(stats);
    const charts = el("div", { class: "fc-charts" });
    const trend = el("div", { class: "fc-chart" });
    trend.append(el("h3", { class: "ow-h3", text: "روند ۱۴ روز اخیر" }), lineChart({ labels: series.map((d) => d.label), values: series.map((d) => d.value), color: "#3d6bff" }));
    const topBox = el("div", { class: "fc-chart" });
    topBox.append(el("h3", { class: "ow-h3", text: "پرقصدمصرف‌ترین قابلیت‌ها" }));
    if (top.length) topBox.append(barChart({ labels: top.map((t) => t.label.slice(0, 10)), values: top.map((t) => t.count), color: "#f5b23e" }));
    else topBox.append(el("p", { class: "log-empty", text: "استفاده‌ای ثبت نشده است." }));
    charts.append(trend, topBox);
    cardEl.append(charts);
    const dims = el("div", { class: "fc-dims" });
    for (const [dim, label] of [["plan", "پلن"], ["role", "نقش"], ["room", "اتاق"]]) {
      const rows = usageByDimension(usage, dim, 5);
      const box = el("div", { class: "fc-dim" });
      box.append(el("h4", { text: label }));
      if (!rows.length) box.append(el("p", { class: "hint", text: "داده‌ای نیست." }));
      for (const r of rows) box.append(el("div", { class: "fc-dim-row" }, el("span", { text: r.label }), el("b", { text: String(r.count) })));
      dims.append(box);
    }
    cardEl.append(dims);
    const disabledRecent = readFeatureCenter().history.filter((h) => /خاموش/.test(h.action)).slice(0, 5);
    const recent = el("div", { class: "fc-recent-off" });
    if (disabledRecent.length) {
      recent.append(el("h3", { class: "ow-h3", text: "اخیراً خاموش‌شده‌ها" }));
      for (const h of disabledRecent) {
        const row = el("div", { class: "fc-history-row" });
        row.append(el("time", { text: new Date(h.at).toLocaleString("fa-IR") }), el("b", { text: fcLabel(h.id) }), el("span", { text: h.action }));
        recent.append(row);
      }
      cardEl.append(recent);
    }
    return cardEl;
  }

  const FC_PAGE_LINKS = {
    branding: "branding", theme: "theme", seo: "seo", site: "branding", notifications: "notifications",
    maintenance: "maintenance", accounts: "features", rooms: "rooms", chat: "chat", voice: "voice",
    video: "video", screenShare: "screenShare", profile: "limits", billing: "pricing"
  };
  const BUSINESS_GATES = {
    plans: ["business.subscriptions", "پلن‌ها"],
    entitlements: ["business.subscriptions", "دسترسی‌های پلن"],
    subscriptions: ["business.subscriptions", "اشتراک‌ها"],
    coupons: ["business.coupons", "کدهای تخفیف"],
    finance: ["business.analytics", "داشبورد مالی"],
    pricing: ["business.subscriptions", "قیمت‌گذاری"],
    premium: ["business.premiumPlans", "قابلیت‌های پریمیوم"],
    payments: ["business.payments", "پرداخت‌ها"],
    website: ["business.websiteBuilder", "سازندهٔ سایت"],
    pages: ["business.websiteBuilder", "صفحه‌ساز"],
    automation: ["business.automation", "خودکارسازی"]
  };

  function applyBusinessGate(pageId, section) {
    const gate = BUSINESS_GATES[pageId];
    if (!gate) return;
    const draft = ctx.getDraft();
    const rule = draft?.featureRules?.[FLAG_BY_ID.get(gate[0])?.path] || null;
    const sched = scheduleState(rule);
    const on = getPath(draft, FLAG_BY_ID.get(gate[0])?.path) !== false && !rule?.emergency && sched !== "off" && sched !== "waiting" && sched !== "invalid";
    if (on) return;
    const notice = el("article", { class: "ocard fc-gate" });
    notice.append(el("b", { text: `${gate[1]} در سایت عمومی خاموش است` }));
    notice.append(el("p", { class: "ohint", text: "این صفحه برای مدیریت مالک باز است، اما قابلیت مربوط به آن برای کاربران اعمال نمی‌شود. برای روشن‌کردن، از مرکز قابلیت‌ها استفاده کن." }));
    notice.append(miniBtn("رفتن به مرکز قابلیت‌ها", () => ctx.showView("features")));
    section.prepend(notice);
  }

  renderers.features = (section) => {
    section.replaceChildren();
    const paint = () => {
      const { center, states } = fcStates();
      const ui = center.ui || {};
      const q = String(ui.q || "").toLowerCase();
      section.replaceChildren();
      const root = el("div", { class: "fc-root", "data-fc-root": "1" });

      const summaryCard = card("مرکز قابلیت‌ها", "همهٔ کنترل‌ها واقعی‌اند: تغییر سراسری، خاموشی اضطراری، زمان‌بندی، دامنهٔ نقش/کاربر/پلن/اتاق، وابستگی‌ها، تاریخچه و بازگردانی. اعمال در همین مرورگر فوری است و برای همهٔ بازدیدکنندگان پس از انتشار.");
      const counts = fcCounts(states);
      const grid = el("div", { class: "stat-grid" });
      for (const [id, label] of [["healthy", "سالم"], ["partial", "محدود"], ["disabled", "خاموش"], ["emergency", "اضطراری"], ["scheduled", "زمان‌بندی"], ["dependency", "وابستگی"], ["future", "آینده"]]) {
        const a = el("article", { class: "ostat" });
        a.append(el("span", { class: "ostat-lbl", text: label }), el("strong", { text: String(counts[id] || 0) }), el("small", { text: `${FLAGS.length} قابلیت` }));
        grid.append(a);
      }
      summaryCard.append(grid);

      const toolbar = el("div", { class: "ow-toolbar" });
      const search = el("input", { type: "search", class: "ow-input", placeholder: "جستجوی قابلیت، شناسه یا توضیح…" });
      search.value = ui.q || "";
      search.addEventListener("input", () => {
        const c = readFeatureCenter();
        c.ui = { ...c.ui, q: search.value };
        writeFeatureCenter(c);
        paint();
        const again = section.querySelector(".fc-root .ow-toolbar input[type=search]");
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
      toolbar.append(search);
      summaryCard.append(toolbar);

      const groupChips = el("div", { class: "ow-chips" });
      const mkChip = (id, label) => {
        const chip = el("button", { type: "button", class: `ow-chip${(ui.group || "all") === id ? " active" : ""}`, text: label });
        chip.addEventListener("click", () => {
          const c = readFeatureCenter();
          c.ui = { ...c.ui, group: id };
          writeFeatureCenter(c);
          paint();
        });
        return chip;
      };
      groupChips.append(mkChip("all", "همهٔ گروه‌ها"));
      for (const g of FLAG_GROUPS) groupChips.append(mkChip(g.id, g.label));
      summaryCard.append(groupChips);

      const statusChips = el("div", { class: "ow-chips" });
      for (const [id, label] of FC_STATUS_OPTIONS) {
        const chip = el("button", { type: "button", class: `ow-chip${(ui.status || "all") === id ? " active" : ""}`, text: label });
        chip.addEventListener("click", () => {
          const c = readFeatureCenter();
          c.ui = { ...c.ui, status: id };
          writeFeatureCenter(c);
          paint();
        });
        statusChips.append(chip);
      }
      const favChip = el("button", { type: "button", class: `ow-chip${ui.favOnly ? " active" : ""}`, text: "فقط علاقه‌مندی‌ها" });
      favChip.addEventListener("click", () => {
        const c = readFeatureCenter();
        c.ui = { ...c.ui, favOnly: !c.ui.favOnly };
        writeFeatureCenter(c);
        paint();
      });
      statusChips.append(favChip);
      summaryCard.append(statusChips);

      const filtered = FLAGS.filter((flag) => {
        if (ui.group && ui.group !== "all" && flag.group !== ui.group) return false;
        if (ui.favOnly && !center.favorites.includes(flag.id)) return false;
        if (ui.status && ui.status !== "all" && flagHealth(flag, states[flag.id]).id !== ui.status) return false;
        if (q && !`${flag.label} ${flag.id} ${flag.desc} ${flag.path}`.toLowerCase().includes(q)) return false;
        return true;
      }).sort((a, b) => (center.pinned.includes(b.id) ? 1 : 0) - (center.pinned.includes(a.id) ? 1 : 0));

      const bulk = el("div", { class: "ow-toolbar fc-bulk" });
      const bulkDo = (label, value, danger) => {
        const b = el("button", { class: `btn btn-ghost btn-sm${danger ? " ow-danger" : ""}`, type: "button", text: label });
        b.addEventListener("click", () => {
          if (!filtered.length) return toast("قابلیتی با این فیلتر نیست.", "error");
          if (!confirm(`${filtered.length} قابلیت انتخاب‌شده ${value ? "روشن" : "خاموش"} شوند؟`)) return;
          for (const flag of filtered) {
            if (flag.future) continue;
            if (value) {
              const missing = missingDependencies(flag.id, fcStates().states).filter((d) => !FLAG_BY_ID.get(d)?.future);
              for (const dep of missing) fcEnableChain(dep);
            }
            if (getPath(ctx.getDraft(), flag.path) !== value) fcSetGlobal(flag, value, { scope: "bulk", reason: "اقدام گروهی" });
          }
          paint(); refreshDashboard(); refreshAnalytics();
          toast("اقدام گروهی اعمال شد.", "success");
        });
        return b;
      };
      bulk.append(bulkDo("روشن‌کردن فیلترشده", true), bulkDo("خاموش‌کردن فیلترشده", false));
      const emergencyAll = el("button", { class: "btn btn-ghost btn-sm ow-danger", type: "button", text: "خاموشی اضطراری فیلترشده" });
      emergencyAll.addEventListener("click", () => {
        if (!filtered.length) return toast("قابلیتی با این فیلتر نیست.", "error");
        if (!confirm(`خاموشی اضطراری روی ${filtered.length} قابلیت اعمال شود؟ این کنترل بر همهٔ تنظیمات دیگر مقدم است.`)) return;
        for (const flag of filtered) {
          if (flag.future) continue;
          const cur = fcRuleOf(flag);
          if (!cur.emergency) fcSaveRule(flag, { ...cur, emergency: true }, "خاموشی اضطراری گروهی");
        }
        paint(); refreshDashboard(); refreshAnalytics();
        toast("خاموشی اضطراری گروهی اعمال شد.", "success");
      });
      const clearRules = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "پاک‌کردن قواعد فیلترشده" });
      clearRules.addEventListener("click", () => {
        if (!filtered.length) return toast("قابلیتی با این فیلتر نیست.", "error");
        if (!confirm("همهٔ زمان‌بندی‌ها و خاموشی‌های اضطراری انتخاب‌شده پاک شوند؟")) return;
        for (const flag of filtered) {
          if (Object.keys(fcRuleOf(flag)).length) fcSaveRule(flag, null, "پاک‌کردن قواعد");
        }
        paint(); refreshDashboard(); refreshAnalytics();
        toast("قواعد فیلترشده پاک شدند.", "success");
      });
      bulk.append(emergencyAll, clearRules);

      const exportBtn = miniBtn("خروجی JSON", () => fcDownloadExport());
      const importBtn = miniBtn("ورود JSON", () => fileIn.click());
      const fileIn = el("input", { type: "file", accept: "application/json", class: "hidden" });
      fileIn.addEventListener("change", () => { fcImportFile(fileIn.files?.[0], paint); fileIn.value = ""; });
      bulk.append(exportBtn, importBtn, fileIn);
      summaryCard.append(bulk);
      root.append(summaryCard);

      const recentCard = card("آخرین تغییرات قابلیت‌ها", "تاریخچهٔ داخلی مرکز قابلیت‌ها با دامنه، دلیل و منبع.");
      const recentList = el("div", { class: "fc-history-list" });
      const recent = (center.history || []).slice(0, 6);
      if (!recent.length) recentList.append(el("p", { class: "log-empty", text: "هنوز تغییری ثبت نشده." }));
      for (const h of recent) {
        const row = el("div", { class: "fc-history-row" });
        row.append(el("time", { text: new Date(h.at).toLocaleString("fa-IR") }), el("b", { text: fcLabel(h.id) }), el("span", { text: h.action }), el("span", { text: h.scope }));
        recentList.append(row);
      }
      recentCard.append(recentList);
      root.append(recentCard);

      for (const group of FLAG_GROUPS) {
        const items = filtered.filter((f) => f.group === group.id);
        if (!items.length) continue;
        const groupCard = card(`${group.icon} ${group.label}`, `${items.length} قابلیت در این گروه`);
        const list = el("div", { class: "fc-list" });
        for (const flag of items) list.append(fcFlagCard(flag, states, center, paint));
        groupCard.append(list);
        root.append(groupCard);
      }
      if (!filtered.length) root.append(card("نتیجه‌ای نیست", "فیلترها را تغییر بده یا جستجو را پاک کن."));

      root.append(fcSnapshotsCard(paint));
      root.append(fcAnalyticsCard());
      section.append(root);
    };
    paint();
  };

  const CC_CATEGORY_ORDER = ["branding", "theme", "site", "seo", "notifications", "maintenance", "accounts", "rooms", "chat", "voice", "video", "screenShare", "profile", "billing"];

  function ccField(item, refresh) {
    const draft = ctx.getDraft();
    const value = getPath(draft, item.id);
    const center = readFeatureCenter();
    const isFav = center.configFavorites.includes(item.id);
    const isPinned = center.configPinned.includes(item.id);
    const row = el("div", { class: `cc-field${isPinned ? " is-pinned" : ""}` });
    const head = el("div", { class: "cc-field-head" });
    head.append(el("b", { text: item.name }), el("code", { text: item.id }));
    if (isPinned) head.append(tag("سنجاق", "ok"));
    const star = miniBtn(isFav ? "★" : "☆", () => {
      const c = readFeatureCenter();
      const list = new Set(c.configFavorites);
      if (list.has(item.id)) list.delete(item.id); else list.add(item.id);
      c.configFavorites = [...list];
      writeFeatureCenter(c);
      refresh();
    });
    star.classList.add("fc-star");
    const pin = miniBtn(isPinned ? "برداشتن سنجاق" : "سنجاق", () => {
      const c = readFeatureCenter();
      const list = new Set(c.configPinned);
      if (list.has(item.id)) list.delete(item.id); else list.add(item.id);
      c.configPinned = [...list];
      writeFeatureCenter(c);
      refresh();
    });
    head.append(star, pin);
    row.append(head);

    const control = el("div", { class: "cc-control" });
    if (item.type === "boolean") {
      const line = el("label", { class: "switch-line" });
      const cb = el("input", { type: "checkbox" });
      cb.checked = value !== false;
      cb.dataset.cfg = item.id;
      line.append(cb, el("span", { text: cb.checked ? "روشن" : "خاموش" }));
      cb.addEventListener("change", () => { line.querySelector("span").textContent = cb.checked ? "روشن" : "خاموش"; });
      control.append(line);
    } else if (item.type === "enum") {
      const sel = selectInput((item.validation.enum || []).map((v) => ({ value: v, label: v })), String(value ?? ""));
      sel.dataset.cfg = item.id;
      control.append(sel);
    } else if (item.type === "number") {
      const input = numberInput(value, { min: item.validation.min, max: item.validation.max, step: item.validation.step || 1 });
      input.dataset.cfg = item.id;
      control.append(input);
    } else if (item.type === "color") {
      const input = el("input", { type: "color" });
      input.value = String(value || "#3d6bff");
      input.dataset.cfg = item.id;
      control.append(input);
    } else {
      const input = el("input", { type: item.type === "url" ? "url" : "text", maxlength: item.validation.maxLength || "" });
      input.value = String(value ?? "");
      input.dataset.cfg = item.id;
      if (item.type === "url") input.dir = "ltr";
      control.append(input);
    }
    row.append(control);
    if (item.description) row.append(el("p", { class: "ohint", text: item.description }));
    const last = lastChangeFor(item.id);
    if (last) row.append(el("span", { class: "cc-last", text: `آخرین تغییر: ${new Date(last.at).toLocaleString("fa-IR")} · ${last.before ?? "—"} ← ${last.after ?? "—"}` }));
    if (item.defaultValue !== null && item.defaultValue !== undefined && String(item.defaultValue) !== String(value)) {
      row.append(miniBtn("بازگردانی به پیش‌فرض", () => {
        ctx.setCfg(item.id, item.defaultValue);
        logAudit({ kind: "config", action: "بازگردانی تنظیم به پیش‌فرض", target: item.id, before: value, after: item.defaultValue, source: "configcenter" });
        refresh(); refreshDashboard();
      }));
    }
    return row;
  }

  renderers.configcenter = (section) => {
    section.replaceChildren();
    const paint = () => {
      const center = readFeatureCenter();
      const ui = center.ui || {};
      const q = String(ui.cq || "").toLowerCase();
      const category = ui.cat || "all";
      section.replaceChildren();
      const root = el("div", { class: "cc-root", "data-cc-root": "1" });
      const top = card("مرکز پیکربندی سیستم", "همهٔ تنظیمات ثبت‌شده در یک صفحه: جستجو، فیلتر دسته، سنجاق و علاقه‌مندی، ویرایش گروهی بولین‌ها، و پیوند به صفحهٔ مرتبط. تغییرات در پیش‌نویس و اجرای زندهٔ همین مرورگر ذخیره می‌شوند.");
      const stats = el("div", { class: "stat-grid" });
      const onCount = CONFIG_REGISTRY.filter((i) => i.type === "boolean" && getPath(ctx.getDraft(), i.id) !== false).length;
      const boolCount = CONFIG_REGISTRY.filter((i) => i.type === "boolean").length;
      const a1 = el("article", { class: "ostat" });
      a1.append(el("span", { class: "ostat-lbl", text: "تنظیمات ثبت‌شده" }), el("strong", { text: String(CONFIG_REGISTRY.length) }));
      const a2 = el("article", { class: "ostat" });
      a2.append(el("span", { class: "ostat-lbl", text: "کلیدهای بولین روشن" }), el("strong", { text: `${onCount}/${boolCount}` }));
      const a3 = el("article", { class: "ostat" });
      a3.append(el("span", { class: "ostat-lbl", text: "دسته‌ها" }), el("strong", { text: String(CC_CATEGORY_ORDER.length) }));
      stats.append(a1, a2, a3);
      top.append(stats);

      const toolbar = el("div", { class: "ow-toolbar" });
      const search = el("input", { type: "search", class: "ow-input", placeholder: "جستجو در نام، مسیر یا توضیح تنظیم…" });
      search.value = ui.cq || "";
      search.addEventListener("input", () => {
        const c = readFeatureCenter();
        c.ui = { ...c.ui, cq: search.value };
        writeFeatureCenter(c);
        paint();
        const again = section.querySelector(".cc-root .ow-toolbar input[type=search]");
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
      const favOnly = el("button", { type: "button", class: `ow-chip${ui.cfav ? " active" : ""}`, text: "فقط علاقه‌مندی‌ها" });
      favOnly.addEventListener("click", () => {
        const c = readFeatureCenter();
        c.ui = { ...c.ui, cfav: !c.ui.cfav };
        writeFeatureCenter(c);
        paint();
      });
      toolbar.append(search, favOnly);
      top.append(toolbar);

      const chips = el("div", { class: "ow-chips" });
      const mk = (id, label) => {
        const chip = el("button", { type: "button", class: `ow-chip${category === id ? " active" : ""}`, text: label });
        chip.addEventListener("click", () => {
          const c = readFeatureCenter();
          c.ui = { ...c.ui, cat: id };
          writeFeatureCenter(c);
          paint();
        });
        return chip;
      };
      chips.append(mk("all", "همه"));
      for (const cat of CC_CATEGORY_ORDER) if (CONFIG_REGISTRY.some((i) => i.category === cat)) chips.append(mk(cat, CONFIG_CATEGORIES[cat] || cat));
      top.append(chips);
      root.append(top);

      const list = CONFIG_REGISTRY.filter((item) => {
        if (category !== "all" && item.category !== category) return false;
        if (ui.cfav && !center.configFavorites.includes(item.id)) return false;
        if (q && !`${item.name} ${item.id} ${item.description} ${item.category}`.toLowerCase().includes(q)) return false;
        return true;
      });
      const pinned = list.filter((i) => center.configPinned.includes(i.id));
      const rest = list.filter((i) => !center.configPinned.includes(i.id));

      if (pinned.length) {
        const pc = card("سنجاق‌شده‌ها", "دسترسی سریع به تنظیمات پرکاربرد.");
        const plist = el("div", { class: "cc-list" });
        for (const item of pinned) plist.append(ccField(item, paint));
        pc.append(plist);
        root.append(pc);
      }

      const activeCats = CC_CATEGORY_ORDER.filter((cat) => rest.some((i) => i.category === cat));
      for (const cat of activeCats) {
        const items = rest.filter((i) => i.category === cat);
        const catCard = card(CONFIG_CATEGORIES[cat] || cat, `${items.length} تنظیم`);
        const boolItems = items.filter((i) => i.type === "boolean");
        if (boolItems.length) {
          const bulk = el("div", { class: "ow-toolbar" });
          const setAll = (value) => {
            if (!confirm(`${boolItems.length} کلید بولین این دسته ${value ? "روشن" : "خاموش"} شوند؟`)) return;
            for (const item of boolItems) ctx.setCfg(item.id, value);
            logAudit({ kind: "config", action: value ? "روشن‌کردن گروهی تنظیمات" : "خاموش‌کردن گروهی تنظیمات", target: cat, source: "configcenter" });
            paint(); refreshDashboard();
            toast("اقدام گروهی اعمال شد.", "success");
          };
          bulk.append(miniBtn("روشن‌کردن بولین‌ها", () => setAll(true)), miniBtn("خاموش‌کردن بولین‌ها", () => setAll(false), true));
          const link = FC_PAGE_LINKS[cat];
          if (link) bulk.append(miniBtn("صفحهٔ مرتبط", () => ctx.showView(link)));
          catCard.append(bulk);
        }
        const itemList = el("div", { class: "cc-list" });
        for (const item of items) itemList.append(ccField(item, paint));
        catCard.append(itemList);
        root.append(catCard);
      }
      if (!list.length) root.append(card("نتیجه‌ای نیست", "فیلترها را تغییر بده یا جستجو را پاک کن."));
      section.append(root);
    };
    paint();
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
    if (!view || view.querySelector("[data-ow-ext]") || view.querySelector("[data-fc-root]")) return;
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
    applyBusinessGate(def.id, section);
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
    document.getElementById("qaFinance")?.addEventListener("click", () => ctx.showView("finance"));
  }

  function refreshAll() {
    refreshDashboard();
    refreshAnalytics();
  }

  function registerPage(def, renderer) {
    if (!def || !def.id || !def.view) return;
    if (def.group && !NAV_GROUPS.some((g) => g.id === def.group)) {
      NAV_GROUPS.push({ id: def.group, label: def.groupLabel || def.group });
    }
    if (!PAGE_DEFS.some((p) => p.id === def.id)) {
      PAGE_DEFS.push({ kind: "dynamic", keywords: "", ...def });
    }
    if (typeof renderer === "function") renderers[def.id] = renderer;
    buildNav();
  }

  function init() {
    buildNav();
    initChrome();
    initSearch();
    initNotifications();
    ensureExtras();
    refreshAll();
  }

  return { init, renderPage, refreshDashboard, refreshAnalytics, refreshAll, ensureExtras, showModal, closeModal, registerPage };
}
