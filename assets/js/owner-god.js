import { el, toast } from "./core.js";
import { apiFetch, ApiError, apiUrl } from "./api.js";
import { barChart } from "./charts.js";
import { renderBlocks } from "./page-blocks.js";
import { uploadFile, absoluteFileUrl, uploadProgressRow } from "./uploader.js";

const OWNER_JWT_KEY = "wt.ownerJwt";
const GOD_GROUP = "god";

const SCOPES = [
  { id: "global", label: "سراسری" },
  { id: "plan", label: "پلن" },
  { id: "role", label: "نقش" },
  { id: "server", label: "سرور" },
  { id: "room", label: "اتاق" },
  { id: "user", label: "کاربر" }
];
const SCOPE_LABELS = Object.fromEntries(SCOPES.map((s) => [s.id, s.label]));
const SCOPE_FIELD = { user: "userId", role: "role", server: "server", room: "room", plan: "plan" };
const FLAG_GROUPS = { system: "زیرساخت", comm: "ارتباطات", watch: "تماشا", voice: "صدا و تصویر", account: "حساب", business: "کسب‌وکار" };
const LAYER_LABELS = {
  security: "قفل امنیتی",
  global: "سراسری",
  plan: "پلن",
  role: "نقش",
  server: "سرور",
  room: "اتاق",
  user: "کاربر",
  dependency: "وابستگی",
  default: "پیش‌فرض"
};
const SOURCE_LABELS = {
  default: "پیش‌فرض",
  global: "سراسری",
  dependency: "وابستگی",
  rule: "قاعده",
  env: "اضطراری",
  emergency: "اضطرار سراسری",
  security: "قفل امنیتی",
  plan: "پلن",
  role: "نقش",
  server: "سرور",
  room: "اتاق",
  room_settings: "تنظیمات اتاق",
  user: "کاربر"
};
const ROLE_LABELS = { super_owner: "مالک ارشد", owner: "مالک", administrator: "مدیر", moderator: "ناظر", room_owner: "مالک اتاق", member: "عضو", user: "کاربر", guest: "مهمان" };
const STATUS_LABELS = { active: "فعال", suspended: "تعلیق", banned: "مسدود", pending: "در انتظار" };

function ownerToken() {
  try { return sessionStorage.getItem(OWNER_JWT_KEY) || ""; } catch { return ""; }
}

async function api(path, options = {}) {
  const token = ownerToken();
  if (!token) {
    throw new ApiError("برای دیدن داده‌های زنده، اول با رمز مالک وارد کنسول شو.", { status: 401, code: "owner_token_missing" });
  }
  return apiFetch(path, { token, timeoutMs: 15000, ...options });
}

function card(title, hint) {
  const node = el("article", { class: "ocard" });
  if (title) node.append(el("h2", { text: title }));
  if (hint) node.append(el("p", { class: "ohint", text: hint }));
  return node;
}

function statCard(label, value, hint) {
  const node = el("article", { class: "ostat" });
  node.append(el("span", { class: "ostat-lbl", text: label }), el("strong", { text: String(value) }));
  if (hint) node.append(el("small", { text: hint }));
  return node;
}

function tag(text, kind = "ok") {
  return el("span", { class: `tag ${kind}`, text });
}

function fmtDate(ms) {
  const n = Number(ms);
  if (!n) return "—";
  try { return new Date(n).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }); } catch { return "—"; }
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtMoney(amount, currency = "IRT") {
  const n = Number(amount) || 0;
  const text = n.toLocaleString("fa-IR");
  return currency === "USD" ? `$${text}` : `${text} تومان`;
}

function fmtSpan(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d) return `${d.toLocaleString("fa-IR")} روز و ${h.toLocaleString("fa-IR")} ساعت`;
  if (h) return `${h.toLocaleString("fa-IR")} ساعت و ${m.toLocaleString("fa-IR")} دقیقه`;
  return `${m.toLocaleString("fa-IR")} دقیقه`;
}

async function downloadCsv(path) {
  const res = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${ownerToken()}` }, cache: "no-store" });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch {}
    throw new ApiError(data?.message || "خروجی ساخته نشد.", { status: res.status, code: data?.error || `http_${res.status}` });
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || "export.csv";
  const link = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

const BLOCK_LABELS = {
  heading: "عنوان",
  text: "متن",
  image: "تصویر",
  button: "دکمه",
  link: "لینک",
  banner: "بنر",
  form: "فرم",
  nav: "ناوبری",
  spacer: "فضای خالی"
};
const VISIBILITY_LABELS = { public: "عمومی", unlisted: "بدون فهرست", members: "فقط اعضا" };
const PAGE_STATUS_LABELS = { draft: "پیش‌نویس", published: "منتشرشده", archived: "آرشیو" };
const OP_LABELS = {
  eq: "برابر باشد",
  neq: "برابر نباشد",
  contains: "شامل باشد",
  starts_with: "با … شروع شود",
  ends_with: "با … تمام شود",
  gt: "بزرگ‌تر از",
  gte: "بزرگ‌تر یا مساوی",
  lt: "کوچک‌تر از",
  lte: "کوچک‌تر یا مساوی",
  exists: "خالی نباشد"
};
const RUN_STATUS_LABELS = { ok: "موفق", failed: "ناموفق", running: "در حال اجرا" };
const ACTION_STATUS_LABELS = { ok: "انجام شد", skipped: "رد شد", failed: "خطا" };
const NOTICE_KIND_LABELS = {
  announcement: "اطلاعیه",
  payment: "پرداخت",
  support_update: "به‌روزرسانی پشتیبانی",
  security: "امنیت",
  system: "سیستم"
};
const PARAM_LABELS = { title: "عنوان", body: "متن", kind: "نوع اعلان", link: "لینک", role: "نقش", subject: "موضوع", text: "متن ایمیل" };

function newBlock(type) {
  const layout = { width: "narrow", tone: "none", align: "start" };
  switch (type) {
    case "heading":
      return { type, layout, text: "عنوان تازه", level: 2 };
    case "text":
      return { type, layout, text: "متن تازه…" };
    case "image":
      return { type, layout, src: "", alt: "", caption: "" };
    case "button":
      return { type, layout, label: "دکمهٔ تازه", href: "/", style: "primary" };
    case "link":
      return { type, layout, label: "لینک تازه", href: "/" };
    case "banner":
      return { type, layout, tone: "primary", title: "بنر تازه", text: "", image: "", ctaLabel: "", ctaHref: "" };
    case "form":
      return { type, layout, title: "فرم تماس", text: "", fields: ["name", "email", "message"], submitLabel: "ارسال", successText: "پیام شما ثبت شد." };
    case "nav":
      return { type, layout, items: [{ label: "خانه", href: "/" }] };
    case "spacer":
      return { type, layout, size: "md" };
    default:
      return { type: "text", layout, text: "" };
  }
}

function draftFromPage(page) {
  return {
    id: page?.id || "",
    slug: page?.slug || "",
    title: page?.title || "",
    description: page?.description || "",
    locale: page?.locale || "fa",
    visibility: page?.visibility || "public",
    showInNav: page ? Boolean(page.showInNav) : true,
    navOrder: page?.navOrder || 0,
    scheduledAt: page?.scheduledAt || null,
    status: page?.status || "draft",
    version: page?.version || 1,
    submissionCount: page?.submissionCount || 0,
    blocks: JSON.parse(JSON.stringify(page?.blocks || []))
  };
}

function toDateTimeInput(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDateTimeInput(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function mkBtn(label, onClick, cls = "mini-btn") {
  const node = el("button", { class: cls, type: "button", text: label });
  node.addEventListener("click", onClick);
  return node;
}

function field(labelText, control, cls = "") {
  const wrap = el("label", { class: `ofield ${cls}`.trim() }, [el("span", { text: labelText })]);
  wrap.append(control);
  return wrap;
}

function textInput(props = {}) {
  return el("input", { type: "text", ...props });
}

function optionsSelect(entries, value) {
  const select = el("select");
  for (const [id, label] of entries) select.append(el("option", { value: id, text: label }));
  if (value !== undefined) select.value = value;
  return select;
}

function confirmThen(center, { title, text, label = "تایید و اجرا", danger = false }, run) {
  const ok = el("button", { class: danger ? "mini-btn danger" : "btn btn-primary btn-sm", type: "button", text: label });
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    try {
      await run();
      center.closeModal();
    } catch (err) {
      toast(err.message || "انجام نشد.", "error");
      ok.disabled = false;
    }
  });
  center.showModal(title, [el("p", { class: "ohint", text })], [mkBtn("انصراف", () => center.closeModal()), ok]);
}

function formGrid(...nodes) {
  const grid = el("div", { class: "form-grid" });
  for (const node of nodes) if (node) grid.append(node);
  return grid;
}

function table(headers, rows) {
  const wrap = el("div", { class: "table-wrap" });
  const tbl = el("table", { class: "otable" });
  const head = el("tr");
  for (const h of headers) head.append(el("th", { text: h }));
  tbl.append(el("thead", {}, [head]));
  const body = el("tbody");
  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", { class: "empty", colspan: String(headers.length), text: "چیزی ثبت نشده." });
    tr.append(td);
    body.append(tr);
  } else {
    for (const row of rows) {
      const tr = el("tr");
      for (const cell of row) {
        const td = el("td");
        if (cell instanceof Node) td.append(cell);
        else td.textContent = cell == null ? "—" : String(cell);
        tr.append(td);
      }
      body.append(tr);
    }
  }
  tbl.append(body);
  wrap.append(tbl);
  return wrap;
}

function loading(text = "در حال گرفتن داده از سرور…") {
  return card("لطفاً صبر کن", text);
}

function failure(section, err, retry) {
  const node = card("دسترسی به سرور برقرار نشد", "");
  node.append(el("p", { class: "ohint", text: err?.message || "خطای نامشخص" }));
  if (err?.code === "owner_token_missing" || err?.status === 401) {
    node.append(el("p", { class: "ohint", text: "نشست سروری مالک لازم است. کنسول را قفل کن و دوباره با رمز مالک وارد شو تا توکن تازه ساخته شود." }));
  }
  const retryBtn = el("button", { class: "mini-btn", type: "button", text: "تلاش دوباره" });
  retryBtn.addEventListener("click", () => retry?.());
  node.append(retryBtn);
  section.replaceChildren(node);
}

function openPage(center, view) {
  document.querySelector(`[data-nav="${view}"]`)?.click();
}

function serviceState(services = {}) {
  const rows = [];
  const push = (label, entry) => {
    const state = entry?.mode || entry?.status || (entry?.ready ? "ready" : "unknown");
    rows.push([label, String(state)]);
  };
  push("فروشگاه داده", services.store);
  push("ایمیل", services.mail);
  push("پیامک", services.sms);
  push("Redis", services.redis);
  return rows;
}

/* ---------------- overview ---------------- */

function renderPlatform(section, center) {
  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const data = await api("/admin/overview");
      const view = el("div", { class: "og-page" });
      const head = el("div", { class: "ow-toolbar" });
      const refresh = el("button", { class: "mini-btn", type: "button", text: "تازه‌سازی" });
      refresh.addEventListener("click", reload);
      head.append(refresh, el("span", { class: "hint-s", text: "همهٔ اعداد از پایگاه دادهٔ واقعی خوانده می‌شوند." }));

      const grid = el("div", { class: "stat-grid" });
      const c = data.counts || {};
      grid.append(
        statCard("کاربران", c.users ?? 0, `${c.activeUsers ?? 0} فعال`),
        statCard("اتاق‌های زنده", c.lobbiesActive ?? 0, `${c.rooms ?? 0} اتاق ثبت‌شده`),
        statCard("پیام‌ها", c.messages ?? 0, `${c.messages24h ?? 0} در ۲۴ ساعت`),
        statCard("گزارش‌های باز", c.reportsOpen ?? 0, "رسیدگی نشده"),
        statCard("اشتراک فعال", c.subscriptionsActive ?? 0, `${c.ordersPending ?? 0} سفارش در انتظار`),
        statCard("درآمد پرداخت‌شده", fmtMoney(c.revenuePaid, "IRT"), "جمع پرداخت‌های موفق"),
        statCard("مدیران", c.admins ?? 0, `${c.moderators ?? 0} ناظر`),
        statCard("قابلیت‌های خاموش", data.featureHealth?.off ?? 0, `از ${data.featureHealth?.total ?? 0} قابلیت`)
      );

      const services = card("سلامت سرویس‌ها", "وضعیت اتصال ایمیل، پیامک، Redis و پایگاه داده.");
      const list = el("ul", { class: "okv" });
      for (const [label, value] of serviceState(data.services)) {
        const li = el("li");
        li.append(el("span", { text: label }), el("b", { class: value === "sqlite" || value === "ready" || value === "outbox" || value === "memory" ? "on" : "off", text: value }));
        list.append(li);
      }
      const db = data.database || {};
      const dbLi = el("li");
      dbLi.append(el("span", { text: "پایگاه داده" }), el("b", { class: db.ready ? "on" : "off", text: db.ready ? "آماده" : "در دسترس نیست" }));
      list.append(dbLi);
      services.append(list);

      const featureCard = card("کنترل قابلیت‌ها", "هر قابلیت را می‌توان سراسری یا برای کاربر، نقش، اتاق، سرور و پلن خاموش کرد.");
      const featureBtn = el("button", { class: "mini-btn", type: "button", text: "باز کردن مرکز کنترل" });
      featureBtn.addEventListener("click", () => openPage(center, "governance"));
      featureCard.append(el("p", { class: "ohint", text: `${data.featureHealth?.total ?? 0} قابلیت ثبت شده؛ ${data.featureHealth?.off ?? 0} مورد خاموش است.` }), featureBtn);

      const usersCard = card("آخرین حساب‌ها", "تازه‌ترین کاربران ثبت‌شده در سرور.");
      usersCard.append(table(
        ["کاربر", "نقش", "وضعیت", "عضویت"],
        (data.recentUsers || []).map((u) => [
          el("span", {}, [el("b", { text: `@${u.username}` }), el("small", { text: u.email || "" })]),
          ROLE_LABELS[u.role] || u.role,
          STATUS_LABELS[u.status] || u.status || "—",
          fmtDate(u.createdAt)
        ])
      ));

      const auditCard = card("آخرین رویدادهای مدیریتی", "هر تغییر حساس در گزارش رویدادها ثبت می‌شود.");
      auditCard.append(table(
        ["زمان", "اقدام", "هدف"],
        (data.recentAudit || []).map((a) => [fmtDate(a.createdAt || a.at), a.action || "", a.targetId || a.target || ""])
      ));

      const pair = el("div", { class: "ov-grid" }, [services, featureCard]);
      view.append(head, grid, pair, usersCard, auditCard);
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, reload);
    }
  };
  reload();
}

/* ---------------- accounts ---------------- */

const accountsState = { q: "", role: "", status: "", before: 0, users: [], more: true, selected: new Set() };

function renderAccounts(section, center) {
  section.replaceChildren();
  let bodyEl = null;
  const paint = () => {
    section.replaceChildren();
    const view = el("div", { class: "og-page" });
    const bar = el("div", { class: "ow-toolbar" });
    const q = el("input", { class: "ow-input", type: "search", placeholder: "جستجوی نام، ایمیل یا موبایل…" });
    q.value = accountsState.q;
    const role = el("select", { class: "ow-input" });
    role.append(el("option", { value: "", text: "همهٔ نقش‌ها" }));
    for (const [id, label] of Object.entries(ROLE_LABELS)) role.append(el("option", { value: id, text: label }));
    role.value = accountsState.role;
    const status = el("select", { class: "ow-input" });
    status.append(el("option", { value: "", text: "همهٔ وضعیت‌ها" }));
    for (const [id, label] of Object.entries(STATUS_LABELS)) status.append(el("option", { value: id, text: label }));
    status.value = accountsState.status;
    const apply = el("button", { class: "mini-btn", type: "button", text: "اعمال فیلتر" });
    apply.addEventListener("click", () => {
      accountsState.q = q.value.trim();
      accountsState.role = role.value;
      accountsState.status = status.value;
      accountsState.before = 0;
      accountsState.users = [];
      accountsState.more = true;
      accountsState.selected.clear();
      load();
    });
    bar.append(q, role, status, apply);

    const bulkBar = el("div", { class: "ow-toolbar" });
    const bulkAction = optionsSelect([["role", "تغییر نقش"], ["status", "تغییر وضعیت"]], "role");
    const bulkValue = el("select", { class: "ow-input" });
    const syncBulk = () => {
      bulkValue.replaceChildren();
      for (const [id, label] of Object.entries(bulkAction.value === "role" ? ROLE_LABELS : STATUS_LABELS)) {
        bulkValue.append(el("option", { value: id, text: label }));
      }
    };
    syncBulk();
    bulkAction.addEventListener("change", syncBulk);
    const bulkApply = mkBtn("اجرای گروهی", () => {
      const ids = [...accountsState.selected];
      if (!ids.length) return toast("اول دست‌کم یک حساب را انتخاب کن.", "error");
      confirmThen(center, {
        title: "اجرای گروهی",
        text: `${ids.length} حساب تغییر می‌کنند؛ این اقدام در گزارش رویدادها ثبت می‌شود.`,
        danger: true
      }, async () => {
        const res = await api("/admin/users/bulk", {
          method: "POST",
          body: { ids, action: bulkAction.value, [bulkAction.value]: bulkValue.value, confirm: true }
        });
        toast(`${res.updated.length} حساب به‌روز شد${res.skipped.length ? `، ${res.skipped.length} مورد رد شد` : ""}.`);
        accountsState.selected.clear();
        load();
      });
    });
    bulkBar.append(el("span", { class: "hint-s", text: "انتخاب گروهی:" }), bulkAction, bulkValue, bulkApply);

    const body = el("div");
    bodyEl = body;
    const moreWrap = el("div", { class: "ow-toolbar" });
    const more = el("button", { class: "mini-btn", type: "button", text: "نمایش بیشتر" });
    more.addEventListener("click", loadMore);
    moreWrap.append(more);

    view.append(
      card("حساب‌های سرور", "نقش و وضعیت را مستقیم عوض کن؛ تغییرها فوری روی دسترسی همان لحظه اثر می‌گذارند."),
      bar,
      bulkBar,
      body,
      moreWrap
    );
    section.replaceChildren(view);
    paintTable();
  };

  const paintTable = () => {
    if (!bodyEl) return;
    bodyEl.replaceChildren(table(
      ["", "کاربر", "نقش", "وضعیت", "آخرین ورود", "عضویت"],
      accountsState.users.map((u) => {
        const pick = el("input", { type: "checkbox" });
        pick.checked = accountsState.selected.has(u.id);
        pick.addEventListener("change", () => {
          if (pick.checked) accountsState.selected.add(u.id);
          else accountsState.selected.delete(u.id);
        });
        const roleSel = el("select", { class: "ow-perm-select" });
        for (const [id, label] of Object.entries(ROLE_LABELS)) roleSel.append(el("option", { value: id, text: label }));
        roleSel.value = u.role;
        roleSel.addEventListener("change", () => patchUser(u, { role: roleSel.value }, roleSel));
        const statusSel = el("select", { class: "ow-perm-select" });
        for (const [id, label] of Object.entries(STATUS_LABELS)) statusSel.append(el("option", { value: id, text: label }));
        statusSel.value = u.status || "active";
        statusSel.addEventListener("change", () => patchUser(u, { status: statusSel.value }, statusSel));
        return [
          pick,
          el("span", {}, [el("b", { text: `@${u.username}` }), el("small", { text: u.email || "" })]),
          roleSel,
          statusSel,
          fmtDate(u.lastLoginAt),
          fmtDate(u.createdAt)
        ];
      })
    ));
  };

  const patchUser = async (user, patch, control) => {
    control.disabled = true;
    try {
      const res = await api(`/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: patch });
      Object.assign(user, res.user || patch);
      toast("حساب به‌روز شد.");
    } catch (err) {
      toast(err.message || "تغییر انجام نشد.", "error");
    } finally {
      control.disabled = false;
    }
  };

  const load = async () => {
    try {
      const qs = new URLSearchParams();
      if (accountsState.q) qs.set("q", accountsState.q);
      if (accountsState.role) qs.set("role", accountsState.role);
      if (accountsState.status) qs.set("status", accountsState.status);
      if (accountsState.before) qs.set("before", String(accountsState.before));
      const data = await api(`/admin/users?${qs.toString()}`);
      accountsState.users = data.users || [];
      accountsState.before = data.nextBefore || 0;
      accountsState.more = Boolean(data.nextBefore);
      paint();
      const moreBtn = section.querySelector(".og-page > div:last-child button");
      if (moreBtn) moreBtn.disabled = !accountsState.more;
    } catch (err) {
      failure(section, err, load);
    }
  };

  const loadMore = async () => {
    try {
      const qs = new URLSearchParams({ before: String(accountsState.before) });
      if (accountsState.q) qs.set("q", accountsState.q);
      if (accountsState.role) qs.set("role", accountsState.role);
      if (accountsState.status) qs.set("status", accountsState.status);
      const data = await api(`/admin/users?${qs.toString()}`);
      accountsState.users = accountsState.users.concat(data.users || []);
      accountsState.before = data.nextBefore || 0;
      accountsState.more = Boolean(data.nextBefore);
      paintTable();
      const moreBtn = section.querySelector(".og-page > div:last-child button");
      if (moreBtn) moreBtn.disabled = !accountsState.more;
    } catch (err) {
      toast(err.message || "بارگذاری بیشتر نشد.", "error");
    }
  };

  section.replaceChildren(loading());
  accountsState.before = 0;
  accountsState.users = [];
  load();
}

/* ---------------- rooms / messages / reports ---------------- */

function renderServerRooms(section, center) {
  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const data = await api("/admin/rooms");
      const view = el("div", { class: "og-page" });
      const bar = el("div", { class: "ow-toolbar" });
      const refresh = el("button", { class: "mini-btn", type: "button", text: "تازه‌سازی" });
      refresh.addEventListener("click", reload);
      bar.append(refresh);
      view.append(card("اتاق‌های سرور", "پلتفرم فعلی مفهوم «سرور/کانال» جدا ندارد؛ اتاق‌ها و لابی‌ها همان نقش را دارند."), bar);
      view.append(table(
        ["کد", "نام", "مالک", "ظرفیت", "نوع", "وضعیت", "پیام‌ها", "ساخت"],
        (data.lobbies || []).map((l) => [
          el("b", { text: l.code }),
          l.name || "—",
          l.owner || l.ownerUsername || "—",
          String(l.capacity ?? "—"),
          l.privacy === "password" ? "خصوصی" : "عمومی",
          l.active ? "فعال" : "بسته",
          String(l.messageCount ?? 0),
          fmtDate(l.createdAt)
        ])
      ));
      view.append(el("h3", { class: "ow-h3", text: "اتاق‌های پیام‌رسانی" }));
      view.append(table(
        ["کد اتاق", "نام", "اعضا", "فعال", "آخرین فعالیت", "اقدام"],
        (data.rooms || []).map((r) => {
          const act = mkBtn(r.is_active ? "بستن اتاق" : "بازکردن اتاق", () => {
            const action = r.is_active ? "close" : "reopen";
            confirmThen(center, {
              title: action === "close" ? "بستن اتاق" : "بازکردن اتاق",
              text: `${action === "close" ? "اتاق" : "اتاق"} «${r.name || r.room_code}» ${action === "close" ? "برای کاربران بسته می‌شود." : "دوباره باز می‌شود."}`,
              danger: action === "close"
            }, async () => {
              await api(`/admin/rooms/${encodeURIComponent(r.id)}`, { method: "PATCH", body: { action, confirm: true } });
              toast(action === "close" ? "اتاق بسته شد." : "اتاق باز شد.");
              reload();
            });
          }, r.is_active ? "mini-btn danger" : "mini-btn");
          return [r.room_code || r.roomCode, r.name, String(r.member_count ?? 0), r.is_active ? "بله" : "خیر", fmtDate(r.last_activity_at), act];
        })
      ));
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, reload);
    }
  };
  reload();
}

const messagesState = { q: "", room: "", before: 0, items: [] };

function renderServerMessages(section) {
  section.replaceChildren();
  const paint = () => {
    const view = el("div", { class: "og-page" });
    const bar = el("div", { class: "ow-toolbar" });
    const room = el("input", { class: "ow-input", type: "search", placeholder: "کد اتاق (اختیاری)" });
    room.value = messagesState.room;
    const q = el("input", { class: "ow-input", type: "search", placeholder: "جستجو در متن پیام…" });
    q.value = messagesState.q;
    const apply = el("button", { class: "mini-btn", type: "button", text: "اعمال" });
    apply.addEventListener("click", () => {
      messagesState.room = room.value.trim().toUpperCase();
      messagesState.q = q.value.trim();
      messagesState.before = 0;
      messagesState.items = [];
      load();
    });
    bar.append(room, q, apply);
    const list = el("div");
    const more = el("button", { class: "mini-btn", type: "button", text: "بیشتر" });
    more.addEventListener("click", loadMore);
    view.append(card("پیام‌های سرور", "آخرین پیام‌های ذخیره‌شده با امکان فیلتر اتاق و متن."), bar, list, el("div", { class: "ow-toolbar" }, [more]));
    section.replaceChildren(view);
    paintTable();
  };
  const paintTable = () => {
    const host = section.querySelector(".og-page > div:nth-of-type(2)");
    if (!host) return;
    host.replaceChildren(table(
      ["زمان", "اتاق", "کاربر", "نوع", "متن"],
      messagesState.items.map((m) => [fmtDate(m.createdAt), m.room || "—", m.username || "—", m.type || "text", String(m.content || "").slice(0, 140)])
    ));
  };
  const load = async () => {
    try {
      const qs = new URLSearchParams();
      if (messagesState.room) qs.set("room", messagesState.room);
      if (messagesState.q) qs.set("q", messagesState.q);
      const data = await api(`/admin/messages?${qs.toString()}`);
      messagesState.items = data.messages || [];
      messagesState.before = data.nextBefore || 0;
      paint();
    } catch (err) {
      failure(section, err, load);
    }
  };
  const loadMore = async () => {
    if (!messagesState.before) return;
    try {
      const qs = new URLSearchParams({ before: String(messagesState.before) });
      if (messagesState.room) qs.set("room", messagesState.room);
      if (messagesState.q) qs.set("q", messagesState.q);
      const data = await api(`/admin/messages?${qs.toString()}`);
      messagesState.items = messagesState.items.concat(data.messages || []);
      messagesState.before = data.nextBefore || 0;
      paintTable();
    } catch (err) {
      toast(err.message || "بیشتر بارگذاری نشد.", "error");
    }
  };
  section.replaceChildren(loading());
  messagesState.before = 0;
  messagesState.items = [];
  load();
}

function renderServerReports(section, center) {
  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const [data, social] = await Promise.all([
        api("/admin/reports"),
        api("/admin/reports/social?limit=25").catch(() => ({ reports: [] }))
      ]);
      const view = el("div", { class: "og-page" });
      const bar = el("div", { class: "ow-toolbar" });
      const refresh = el("button", { class: "mini-btn", type: "button", text: "تازه‌سازی" });
      refresh.addEventListener("click", reload);
      bar.append(refresh);
      view.append(card("گزارش‌های کاربران", "پیام‌های گزارش‌شده به‌همراه وضعیت رسیدگی."), bar);
      view.append(table(
        ["وضعیت", "دلیل", "پیام", "گزارش‌دهنده", "اتاق", "زمان", "اقدام"],
        (data.reports || []).map((r) => {
          const act = r.status === "open"
            ? mkBtn("بررسی شد", async () => {
                try {
                  await api(`/admin/reports/message/${encodeURIComponent(r.id)}`, { method: "PATCH", body: { status: "reviewed" } });
                  toast("گزارش بررسی شد.");
                  reload();
                } catch (err) { toast(err.message || "ثبت نشد.", "error"); }
              })
            : el("span", { class: "hint-s", text: "—" });
          return [
            r.status === "open" ? tag("باز", "warn") : tag(r.status === "reviewed" ? "بررسی‌شده" : "رد‌شده"),
            r.reason || "—",
            String(r.message || "").slice(0, 120),
            r.reporter || "—",
            r.room || "—",
            fmtDate(r.createdAt),
            act
          ];
        })
      ));
      view.append(el("h3", { class: "ow-h3", text: "گزارش‌های اجتماعی" }));
      view.append(table(
        ["وضعیت", "نوع", "هدف", "دسته", "گزارش‌دهنده", "زمان", "اقدام"],
        (social.reports || []).map((r) => {
          const resolve = (status) => async () => {
            try {
              await api(`/admin/reports/social/${encodeURIComponent(r.id)}`, { method: "PATCH", body: { status } });
              toast("گزارش به‌روز شد.");
              reload();
            } catch (err) { toast(err.message || "ثبت نشد.", "error"); }
          };
          const actions = el("div", { class: "og-actions" }, [
            mkBtn("رسیدگی", resolve("reviewing")),
            mkBtn("حل شد", resolve("resolved")),
            mkBtn("رد", resolve("dismissed"), "mini-btn danger")
          ]);
          return [
            tag(r.status === "open" ? "باز" : r.status === "reviewing" ? "در بررسی" : r.status === "resolved" ? "حل شد" : "رد شد", r.status === "open" ? "warn" : "ok"),
            r.targetType || "—",
            String(r.targetId || "").slice(0, 18),
            r.category || "—",
            r.reporter || "—",
            fmtDate(r.createdAt),
            actions
          ];
        })
      ));
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, reload);
    }
  };
  reload();
}

/* ---------------- finance & analytics ---------------- */

function renderServerFinance(section) {
  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const data = await api("/admin/finance");
      const t = data.totals || {};
      const view = el("div", { class: "og-page" });
      const grid = el("div", { class: "stat-grid" });
      grid.append(
        statCard("درآمد موفق", fmtMoney(t.paidAmount, "IRT"), `${t.paidOrders ?? 0} پرداخت`),
        statCard("سفارش در انتظار", t.pendingOrders ?? 0, "نیازمند بررسی"),
        statCard("اشتراک فعال", t.activeSubscriptions ?? 0, "در حال استفاده"),
        statCard("پلن‌ها", (data.plans || []).length, "پلن ثبت‌شده")
      );
      const bar = el("div", { class: "ow-toolbar" });
      const refresh = el("button", { class: "mini-btn", type: "button", text: "تازه‌سازی" });
      refresh.addEventListener("click", reload);
      bar.append(refresh);
      view.append(grid, bar);
      view.append(el("h3", { class: "ow-h3", text: "پلن‌های اشتراک" }), table(
        ["پلن", "چرخه", "قیمت", "مدت", "وضعیت"],
        (data.plans || []).map((p) => [p.name, p.cycle || "—", fmtMoney(p.price, p.currency), `${p.days ?? "—"} روز`, p.active ? "فعال" : "غیرفعال"])
      ));
      view.append(el("h3", { class: "ow-h3", text: "سفارش‌ها" }), table(
        ["کاربر", "پلن", "مبلغ", "وضعیت", "زمان", "پرداخت"],
        (data.orders || []).map((o) => [o.username || "—", o.planId || "—", fmtMoney(o.amount, o.currency), o.status, fmtDate(o.createdAt), fmtDate(o.paidAt)])
      ));
      view.append(el("h3", { class: "ow-h3", text: "اشتراک‌ها" }), table(
        ["کاربر", "پلن", "وضعیت", "شروع", "انقضا"],
        (data.subscriptions || []).map((s) => [s.username || "—", s.plan || s.planId || "—", s.status, fmtDate(s.startedAt), fmtDate(s.expiresAt)])
      ));
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, reload);
    }
  };
  reload();
}

function renderServerAnalytics(section) {
  const state = { days: 30, from: "", to: "" };
  const reasonText = {
    no_watch_history: "تاریخچهٔ تماشا هنوز ثبت نشده است.",
    no_page_events_collected: "رویداد بازدید صفحه هنوز از مرورگرها جمع نشده است.",
    request_latency_not_instrumented: "زمان پاسخ درخواست‌ها اندازه‌گیری نمی‌شود.",
    storage_unavailable: "شمارش فایل‌ها در دسترس نیست."
  };
  const missing = (reason) => reasonText[reason] || "این داده در دسترس نیست.";

  const rangeQuery = () => {
    const qs = new URLSearchParams();
    if (state.from && state.to) {
      qs.set("from", String(new Date(`${state.from}T00:00:00`).getTime()));
      qs.set("to", String(new Date(`${state.to}T23:59:59.999`).getTime()));
    } else {
      qs.set("days", String(state.days));
    }
    return qs;
  };

  const reload = async () => {
    section.replaceChildren(loading("در حال محاسبهٔ گزارش از پایگاه داده…"));
    try {
      const qs = rangeQuery();
      const data = await api(`/admin/analytics/report?${qs.toString()}`);
      const s = data.summary || {};
      const avail = data.availability || {};
      const series = data.series || { labels: [] };
      const view = el("div", { class: "og-page" });

      const controls = card("بازهٔ گزارش", "همهٔ اعداد از پایگاه دادهٔ سرور در همین بازه خوانده می‌شوند.");
      const bar = el("div", { class: "ow-toolbar" });
      for (const days of [7, 30, 90]) {
        const active = !state.from && state.days === days;
        const btn = el("button", { class: active ? "ow-chip active" : "ow-chip", type: "button", text: `${days.toLocaleString("fa-IR")} روز` });
        btn.addEventListener("click", () => {
          state.days = days;
          state.from = "";
          state.to = "";
          reload();
        });
        bar.append(btn);
      }
      const fromInput = el("input", { type: "date", class: "ow-input", "aria-label": "از تاریخ" });
      fromInput.value = state.from;
      const toInput = el("input", { type: "date", class: "ow-input", "aria-label": "تا تاریخ" });
      toInput.value = state.to;
      const apply = mkBtn("اعمال بازه", () => {
        if (!fromInput.value || !toInput.value) return toast("هر دو تاریخ را انتخاب کن.", "error");
        if (fromInput.value > toInput.value) return toast("تاریخ شروع باید قبل از پایان باشد.", "error");
        state.from = fromInput.value;
        state.to = toInput.value;
        reload();
      }, "mini-btn");
      const reset = mkBtn("بازگشت به ۳۰ روز", () => {
        state.days = 30;
        state.from = "";
        state.to = "";
        reload();
      }, "mini-btn");
      bar.append(fromInput, toInput, apply, reset);
      const stamp = el("p", { class: "ohint", text: `از ${new Date(data.range.from).toLocaleDateString("fa-IR")} تا ${new Date(data.range.to).toLocaleDateString("fa-IR")} · ${Number(data.range.days).toLocaleString("fa-IR")} روز · ساخته‌شده ${fmtDate(data.generatedAt)}` });
      controls.append(bar, stamp);
      view.append(controls);

      const grid1 = el("div", { class: "stat-grid" });
      grid1.append(
        statCard("ثبت‌نام", Number(s.registrations || 0).toLocaleString("fa-IR"), `${Number(data.registrationsSharePct || 0).toLocaleString("fa-IR")}٪ از کل کاربران`),
        statCard("کاربران فعال", Number(s.activeUsers || 0).toLocaleString("fa-IR"), "بر اساس نشست‌های دارای فعالیت"),
        statCard("کل کاربران", Number(s.totalUsers || 0).toLocaleString("fa-IR"), "بدون حساب‌های حذف‌شده"),
        statCard("پیام‌ها", Number(s.messages || 0).toLocaleString("fa-IR"), "پیام‌های ذخیره‌شده در بازه")
      );
      const grid2 = el("div", { class: "stat-grid" });
      grid2.append(
        statCard("اتاق‌های ساخته‌شده", Number(s.roomsCreated || 0).toLocaleString("fa-IR"), `${Number(s.activeRooms || 0).toLocaleString("fa-IR")} اتاق فعال`),
        statCard("ورود به اتاق", Number(s.joinings || 0).toLocaleString("fa-IR"), "عضویت‌های تازه در بازه"),
        avail.watchTime
          ? statCard("زمان تماشا", fmtSpan(s.watchTime?.seconds), `${Number(s.watchTime?.sessions || 0).toLocaleString("fa-IR")} نشست تماشا`)
          : statCard("زمان تماشا", "در دسترس نیست", missing(s.watchTime?.reason)),
        avail.pageViews
          ? statCard("بازدید صفحه", Number(s.pageViews?.count || 0).toLocaleString("fa-IR"), "رویدادهای ثبت‌شدهٔ مرورگر")
          : statCard("بازدید صفحه", "در دسترس نیست", missing(s.pageViews?.reason))
      );
      const grid3 = el("div", { class: "stat-grid" });
      grid3.append(
        statCard("درآمد", fmtMoney(s.revenue?.amount, s.revenue?.currency), `${Number(s.revenue?.payments || 0).toLocaleString("fa-IR")} پرداخت موفق`),
        statCard("بازگشت وجه", fmtMoney(s.refunds?.amount), `${Number(s.refunds?.payments || 0).toLocaleString("fa-IR")} مورد`),
        statCard("اشتراک فعال", Number(s.subscriptions?.active || 0).toLocaleString("fa-IR"), `${Number(s.subscriptions?.trials || 0).toLocaleString("fa-IR")} آزمایشی · ${Number(s.subscriptions?.pendingOrders || 0).toLocaleString("fa-IR")} سفارش در انتظار`),
        statCard("اشتراک در بازه", `${Number(s.subscriptions?.activated || 0).toLocaleString("fa-IR")} فعال‌سازی`, `${Number(s.subscriptions?.expired || 0).toLocaleString("fa-IR")} انقضا`)
      );
      const grid4 = el("div", { class: "stat-grid" });
      grid4.append(
        statCard("تیکت‌های باز", Number(s.support?.open || 0).toLocaleString("fa-IR"), `${Number(s.support?.created || 0).toLocaleString("fa-IR")} تیکت تازه در بازه`),
        statCard("تیکت‌های حل‌شده", Number(s.support?.resolved || 0).toLocaleString("fa-IR"), s.support?.avgResolutionHours == null ? "میانگین پاسخ در دسترس نیست" : `میانگین ${Number(s.support.avgResolutionHours).toLocaleString("fa-IR")} ساعت`),
        statCard("گزارش تخلف", Number(s.moderation?.reports || 0).toLocaleString("fa-IR"), `${Number(s.moderation?.open || 0).toLocaleString("fa-IR")} باز · ${Number(s.moderation?.closed || 0).toLocaleString("fa-IR")} بسته‌شده`),
        statCard("خطاهای ثبت‌شده", Number(s.errors?.total || 0).toLocaleString("fa-IR"), `${Number(s.errors?.failedPayments || 0).toLocaleString("fa-IR")} پرداخت · ${Number(s.errors?.failedAutomationRuns || 0).toLocaleString("fa-IR")} گردش‌کار`)
      );
      view.append(grid1, grid2, grid3, grid4);

      const labels = (series.labels || []).map((label) => String(label).slice(5));
      const chartCard = (title, hint, values, color) => {
        const node = card(title, hint);
        const box = el("div", { class: "og-chart" });
        box.append(barChart({ labels, values: values || [], color }));
        node.append(box);
        return node;
      };
      view.append(chartCard("ثبت‌نام روزانه", "تعداد حساب‌های ساخته‌شده در هر روز.", series.registrations, "#3d6bff"));
      view.append(chartCard("پیام‌های روزانه", "پیام‌های ذخیره‌شده در گفتگوها.", series.messages, "#f5b23e"));
      view.append(chartCard("درآمد روزانه", "جمع پرداخت‌های موفق (تومان).", series.revenue, "#34d399"));
      if (avail.pageViews) {
        view.append(chartCard("بازدید صفحهٔ روزانه", "رویدادهای واقعی جمع‌آوری‌شده از مرورگرها.", series.pageViews, "#a78bfa"));
      }

      if ((data.topPaths || []).length) {
        view.append(el("h3", { class: "ow-h3", text: "پربازدیدترین مسیرها" }), table(
          ["مسیر", "بازدید"],
          data.topPaths.map((item) => [el("code", { dir: "ltr", text: item.path }), Number(item.count).toLocaleString("fa-IR")])
        ));
      }

      const sys = s.system || {};
      const sysCard = card("سیستم و ذخیره‌سازی", "وضعیت لحظهٔ سرور و مصرف فضای فایل‌ها.");
      sysCard.append(table(["شاخص", "مقدار"], [
        ["بالا بودن سرور", fmtSpan(sys.uptimeSeconds)],
        ["نسخهٔ Node", sys.node || "—"],
        ["حافظهٔ مصرفی (RSS)", fmtBytes(sys.rssBytes)],
        ["هیپ مصرف‌شده", fmtBytes(sys.heapUsedBytes)],
        ["حجم فایل پایگاه داده", sys.dbSizeBytes == null ? "در دسترس نیست" : fmtBytes(sys.dbSizeBytes)],
        ["فضای فایل‌های آپلودی", s.storage?.available === false ? "در دسترس نیست" : fmtBytes(s.storage?.usedBytes)],
        ["زمان پاسخ درخواست‌ها", avail.latency ? "دارد" : "اندازه‌گیری نمی‌شود"]
      ]));
      view.append(sysCard);
      if (s.errors?.note) view.append(el("p", { class: "ohint", text: s.errors.note }));

      const exportCard = card("خروجی CSV", "خروجی شامل ردیف‌های همان بازهٔ انتخاب‌شده است.");
      const exportBar = el("div", { class: "ow-toolbar" });
      for (const [dataset, label] of [["registrations", "ثبت‌نام‌ها"], ["revenue", "پرداخت‌ها"], ["tickets", "تیکت‌ها"], ["reports", "گزارش‌های تخلف"]]) {
        exportBar.append(mkBtn(`دریافت ${label}`, async () => {
          try {
            await downloadCsv(`/admin/analytics/export?dataset=${dataset}&${qs.toString()}`);
            toast("خروجی آماده شد.");
          } catch (err) {
            toast(err.message || "خروجی ساخته نشد.", "error");
          }
        }));
      }
      exportCard.append(exportBar);
      view.append(exportCard);
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, reload);
    }
  };
  reload();
}

/* ---------------- feature governance ---------------- */

const govState = { scopeType: "global", scopeId: "", q: "" };

function renderGovernance(section, center) {
  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const qs = new URLSearchParams({ all: "1" });
      const field = SCOPE_FIELD[govState.scopeType];
      if (field && govState.scopeId) {
        qs.set(field, govState.scopeType === "room" ? govState.scopeId.toUpperCase() : govState.scopeId);
      }
      const data = await api(`/admin/features?${qs.toString()}`);
      let history = [];
      try {
        const h = await api("/admin/features/history?limit=30");
        history = h.entries || [];
      } catch {}
      const status = new Map((data.status || []).map((s) => [s.key, s]));
      const overrideKey = (key) => (data.overrides || []).find((o) => o.feature_key === key && o.scope_type === govState.scopeType && (govState.scopeType === "global" || o.scope_id === (govState.scopeType === "room" ? govState.scopeId.toUpperCase() : govState.scopeId)));
      const pending = data.schedules || [];

      const view = el("div", { class: "og-page" });
      const bar = el("div", { class: "ow-toolbar" });
      const scopeSel = el("select", { class: "ow-input" });
      for (const s of SCOPES) scopeSel.append(el("option", { value: s.id, text: s.label }));
      scopeSel.value = govState.scopeType;
      const scopeInput = el("input", { class: "ow-input", type: "search", placeholder: "شناسهٔ کاربر / نقش / سرور / اتاق / پلن" });
      scopeInput.value = govState.scopeId;
      scopeInput.classList.toggle("hidden", govState.scopeType === "global");
      if (govState.scopeType === "role") scopeInput.placeholder = "member، moderator، administrator …";
      if (govState.scopeType === "room") scopeInput.placeholder = "کد اتاق، مثل ABC123";
      if (govState.scopeType === "plan") scopeInput.placeholder = "شناسهٔ پلن، مثل premium";
      const q = el("input", { class: "ow-input", type: "search", placeholder: "جستجوی قابلیت…" });
      q.value = govState.q;
      const apply = el("button", { class: "mini-btn", type: "button", text: "اعمال" });
      apply.addEventListener("click", () => {
        govState.scopeType = scopeSel.value;
        govState.scopeId = scopeInput.value.trim();
        govState.q = q.value.trim();
        reload();
      });
      scopeSel.addEventListener("change", () => {
        govState.scopeType = scopeSel.value;
        scopeInput.classList.toggle("hidden", scopeSel.value === "global");
      });
      bar.append(scopeSel, scopeInput, q, apply);

      const scopeHint = govState.scopeType === "global"
        ? "دامنهٔ سراسری: خاموش‌کردن اینجا روی همهٔ کاربران اثر می‌گذارد."
        : `دامنهٔ ${SCOPE_LABELS[govState.scopeType]}: بازنویسی فقط برای این شناسه اعمال می‌شود.`;
      const scopeReady = govState.scopeType === "global" || Boolean(govState.scopeId);

      const summary = card("کنترل کامل قابلیت‌ها", "برای هر قابلیت: روشن/خاموش، دامنه، وابستگی‌ها، وضعیت واقعی، زمان‌بندی و تاریخچه. دسترسی سرور هم همان لحظه بسته می‌شود.");
      summary.append(el("p", { class: "hint-s", text: scopeHint }));
      const hierarchy = data.hierarchy;
      if (hierarchy?.layers?.length) {
        summary.append(el("p", { class: "hint-s", text: `ترتیب اختیار: ${hierarchy.layers.map((l) => l.label).join(" ← ")}. هر لایه فقط می‌تواند محدودتر کند؛ لایهٔ پایین‌تر هیچ‌وقت محدودیت بالاتر را باز نمی‌کند.` }));
      }
      if (govState.scopeType !== "global" && !govState.scopeId) {
        summary.append(el("p", { class: "ohint", text: "شناسهٔ دامنه را وارد کن تا وضعیت مؤثر همان دامنه را ببینی." }));
      }

      const counts = (data.status || []).reduce((acc, s) => { acc[s.enabled ? "on" : "off"] += 1; return acc; }, { on: 0, off: 0 });
      const chips = el("div", { class: "ow-chips" });
      chips.append(tag(`${counts.on} روشن`, "ok"), tag(`${counts.off} خاموش`, counts.off ? "warn" : "ok"));

      const term = govState.q.toLowerCase();
      const groups = el("div", { class: "og-groups" });
      const ordered = ["system", "comm", "watch", "voice", "account", "business"];
      for (const groupKey of ordered) {
        const items = (data.catalog || []).filter((item) => item.group === groupKey && (!term || `${item.label} ${item.desc} ${item.id} ${item.key}`.toLowerCase().includes(term)));
        if (!items.length) continue;
        const block = el("div", { class: "og-group" });
        block.append(el("h3", { class: "ow-h3", text: FLAG_GROUPS[groupKey] || groupKey }));
        const grid = el("div", { class: "og-feature-grid" });
        for (const item of items) {
          const state = status.get(item.key) || { enabled: true, source: "default", reason: "" };
          const override = overrideKey(item.key);
          const rowEl = el("article", { class: "og-feature" });
          const top = el("div", { class: "og-feature-top" });
          const toggleLabel = el("label", { class: "switch-line og-switch" });
          const toggle = el("input", { type: "checkbox" });
          toggle.checked = state.enabled !== false;
          toggle.disabled = !scopeReady || state.locked === true;
          toggle.addEventListener("change", async () => {
            toggle.disabled = true;
            try {
              await api(`/admin/features/${encodeURIComponent(item.key)}`, {
                method: "PUT",
                body: {
                  enabled: toggle.checked,
                  scopeType: govState.scopeType,
                  scopeId: govState.scopeType === "room" ? govState.scopeId.toUpperCase() : govState.scopeId,
                  note: "تغییر از پنل مالک"
                }
              });
              toast(toggle.checked ? "قابلیت روشن شد." : "قابلیت خاموش شد.");
              reload();
            } catch (err) {
              toggle.checked = !toggle.checked;
              toast(err.message || "تغییر انجام نشد.", "error");
            } finally {
              toggle.disabled = false;
            }
          });
          const names = el("span", {}, [el("b", { text: item.label }), el("small", { class: "hint-s", text: item.desc })]);
          toggleLabel.append(toggle, names);
          top.append(toggleLabel, state.enabled !== false ? tag("روشن", "ok") : tag("خاموش", "off"));
          const meta = el("div", { class: "og-meta" });
          const sourceText = SOURCE_LABELS[state.layer] || SOURCE_LABELS[state.source] || state.source || "پیش‌فرض";
          meta.append(el("span", { class: "hint-s", text: `منبع: ${sourceText}` }));
          if (state.reason) meta.append(el("span", { class: "hint-s", text: state.reason }));
          if (Array.isArray(state.layers) && state.layers.length) {
            const merged = [];
            for (const layer of state.layers) {
              const seen = merged.find((entry) => entry.layer === layer.layer);
              if (!seen) merged.push({ layer: layer.layer, enabled: layer.enabled });
              else if (!layer.enabled) seen.enabled = false;
            }
            const chain = merged
              .map((entry) => `${LAYER_LABELS[entry.layer] || entry.layer}: ${entry.enabled ? "باز" : "بسته"}`)
              .join(" · ");
            meta.append(el("span", { class: "hint-s og-chain", text: chain }));
          }
          if (item.deps?.length) meta.append(el("span", { class: "hint-s", text: `وابسته به: ${item.deps.map((d) => (status.get(d)?.label || d)).join("، ")}` }));
          if (override) meta.append(tag("بازنویسی فعال", "warn"));
          rowEl.append(top, meta);

          const actions = el("div", { class: "og-actions" });
          const schedBtn = el("button", { class: "mini-btn", type: "button", text: "زمان‌بندی" });
          schedBtn.disabled = !scopeReady || state.locked === true;
          schedBtn.addEventListener("click", () => openScheduleModal(item, state));
          actions.append(schedBtn);
          if (override) {
            const clearBtn = el("button", { class: "mini-btn danger", type: "button", text: "حذف بازنویسی" });
            clearBtn.addEventListener("click", async () => {
              try {
                await api(`/admin/features/${encodeURIComponent(item.key)}?scopeType=${encodeURIComponent(govState.scopeType)}&scopeId=${encodeURIComponent(govState.scopeType === "room" ? govState.scopeId.toUpperCase() : govState.scopeId)}`, { method: "DELETE" });
                toast("بازنویسی حذف شد.");
                reload();
              } catch (err) {
                toast(err.message || "حذف نشد.", "error");
              }
            });
            actions.append(clearBtn);
          }
          rowEl.append(actions);
          grid.append(rowEl);
        }
        block.append(grid);
        groups.append(block);
      }

      const scheduleCard = card("زمان‌بندی‌های در انتظار", "تغییرها در زمان مشخصشده خودکار اعمال می‌شوند.");
      scheduleCard.append(table(
        ["قابلیت", "دامنه", "زمان", "نتیجه", "اقدام"],
        pending.map((s) => {
          const cancel = el("button", { class: "mini-btn danger", type: "button", text: "لغو" });
          cancel.addEventListener("click", async () => {
            try {
              await api(`/admin/features/schedule/${encodeURIComponent(s.id)}`, { method: "DELETE" });
              toast("زمان‌بندی لغو شد.");
              reload();
            } catch (err) {
              toast(err.message || "لغو نشد.", "error");
            }
          });
          return [s.feature_key, `${SCOPE_LABELS[s.scope_type] || s.scope_type}${s.scope_id ? ` − ${s.scope_id}` : ""}`, fmtDate(s.effective_at), s.enabled ? "روشن" : "خاموش", cancel];
        })
      ));

      const historyCard = card("تاریخچهٔ تغییرها", "هر روشن/خاموش‌شدن با منبع و زمان ذخیره می‌شود.");
      historyCard.append(table(
        ["زمان", "قابلیت", "دامنه", "نتیجه", "منبع", "یادداشت"],
        history.map((h) => [fmtDate(h.created_at), h.feature_key, `${SCOPE_LABELS[h.scope_type] || h.scope_type}${h.scope_id ? ` − ${h.scope_id}` : ""}`, h.enabled ? "روشن" : "خاموش", h.source, h.note || ""])
      ));

      view.append(summary, bar, chips, groups, scheduleCard, historyCard);
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, reload);
    }
  };

  const openScheduleModal = (item, state) => {
    const box = el("div");
    const form = el("div", { class: "form-grid" });
    const when = el("label", { class: "ofield" }, [el("span", { text: "زمان اجرا" })]);
    const whenInput = el("input", { type: "datetime-local" });
    const future = new Date(Date.now() + 10 * 60000);
    const pad = (n) => String(n).padStart(2, "0");
    whenInput.value = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    when.append(whenInput);
    const mode = el("label", { class: "ofield" }, [el("span", { text: "نتیجه" })]);
    const modeSel = el("select");
    modeSel.append(el("option", { value: "off", text: "خاموش شود" }), el("option", { value: "on", text: "روشن شود" }));
    modeSel.value = state.enabled === false ? "on" : "off";
    mode.append(modeSel);
    const note = el("label", { class: "ofield span2" }, [el("span", { text: "یادداشت" })]);
    const noteInput = el("input", { type: "text", placeholder: "مثلاً: خاموشی شبانه" });
    note.append(noteInput);
    form.append(when, mode, note);
    box.append(el("p", { class: "ohint", text: `قابلیت «${item.label}» در دامنهٔ ${SCOPE_LABELS[govState.scopeType]}` }), form);
    const submit = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ثبت زمان‌بندی" });
    submit.addEventListener("click", async () => {
      const at = new Date(whenInput.value).getTime();
      if (!Number.isFinite(at) || at < Date.now() + 5000) {
        toast("زمان باید دست‌کم چند ثانیه بعد باشد.", "error");
        return;
      }
      submit.disabled = true;
      try {
        await api("/admin/features/schedule", {
          method: "POST",
          body: {
            key: item.key,
            scopeType: govState.scopeType,
            scopeId: govState.scopeType === "room" ? govState.scopeId.toUpperCase() : govState.scopeId,
            enabled: modeSel.value === "on",
            effectiveAt: at,
            note: noteInput.value.trim()
          }
        });
        toast("زمان‌بندی ثبت شد.");
        center.closeModal();
        reload();
      } catch (err) {
        toast(err.message || "ثبت نشد.", "error");
      } finally {
        submit.disabled = false;
      }
    });
    center.showModal("زمان‌بندی تغییر", [box], [submit]);
  };

  reload();
}

/* ---------------- platform settings ---------------- */

function renderSiteSettings(section) {
  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const data = await api("/admin/settings");
      const values = { ...(data.values || {}) };
      const dirty = new Map();
      const view = el("div", { class: "og-page" });
      const bar = el("div", { class: "ow-toolbar" });
      const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ذخیره تغییرها" });
      const counter = el("span", { class: "hint-s", text: "تغییری ثبت نشده." });
      save.disabled = true;
      save.addEventListener("click", async () => {
        if (!dirty.size) return;
        save.disabled = true;
        try {
          await api("/admin/settings", { method: "PUT", body: { values: Object.fromEntries(dirty) } });
          toast("تنظیمات ذخیره شد.");
          reload();
        } catch (err) {
          toast(err.message || "ذخیره نشد.", "error");
          save.disabled = false;
        }
      });
      bar.append(save, counter);

      const cats = data.categories || {};
      const byCat = new Map();
      for (const item of data.registry || []) {
        if (!byCat.has(item.category)) byCat.set(item.category, []);
        byCat.get(item.category).push(item);
      }
      view.append(card("تنظیمات سایت", "هر مقدار همین‌جا ذخیره می‌شود و سایت عمومی و API بدون انتشار دستی آن را می‌خوانند."), bar);
      for (const [cat, items] of byCat) {
        const block = card(cats[cat] || cat, "");
        const grid = el("div", { class: "form-grid" });
        for (const item of items) {
          const current = Object.prototype.hasOwnProperty.call(values, item.id) ? values[item.id] : "";
          const field = el("label", { class: "ofield" });
          field.append(el("span", { text: item.label }), el("small", { text: item.id }));
          let input;
          if (item.type === "boolean") {
            input = el("select");
            input.append(el("option", { value: "true", text: "روشن" }), el("option", { value: "false", text: "خاموش" }));
            input.value = current === false || current === "false" ? "false" : "true";
            input.addEventListener("change", () => { dirty.set(item.id, input.value === "true"); mark(); });
          } else if (item.type === "enum") {
            input = el("select");
            for (const value of item.values || []) input.append(el("option", { value, text: value }));
            input.value = String(current || (item.values || [""])[0] || "");
            input.addEventListener("change", () => { dirty.set(item.id, input.value); mark(); });
          } else if (item.type === "number") {
            input = el("input", { type: "number", min: String(item.min ?? 0), max: String(item.max ?? 1000), step: "1" });
            input.value = String(current ?? "");
            input.addEventListener("input", () => { dirty.set(item.id, Number(input.value)); mark(); });
          } else if (item.type === "color") {
            input = el("input", { type: "color" });
            input.value = /^#[0-9a-f]{6}$/i.test(String(current)) ? current : "#3d6bff";
            input.addEventListener("input", () => { dirty.set(item.id, input.value); mark(); });
          } else {
            input = el("input", { type: item.type === "url" ? "url" : "text" });
            input.value = String(current ?? "");
            if (item.maxLength) input.setAttribute("maxlength", String(item.maxLength));
            input.addEventListener("input", () => { dirty.set(item.id, input.value); mark(); });
          }
          field.append(input);
          grid.append(field);
        }
        block.append(grid);
        view.append(block);
      }
      view.prepend(bar);
      section.replaceChildren(view);
      const mark = () => {
        save.disabled = dirty.size === 0;
        counter.textContent = dirty.size ? `${dirty.size} تغییر ذخیره‌نشده` : "تغییری ثبت نشده.";
      };
      mark();
    } catch (err) {
      failure(section, err, reload);
    }
  };
  reload();
}

/* ---------------- storage, backups, audit ---------------- */

function renderVault(section) {
  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const data = await api("/admin/storage");
      const view = el("div", { class: "og-page" });
      const bar = el("div", { class: "ow-toolbar" });
      const backupBtn = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "پشتیبان‌گیری اکنون" });
      const verifyBtn = el("button", { class: "mini-btn", type: "button", text: "بررسی سلامت" });
      const exportBtn = el("button", { class: "mini-btn", type: "button", text: "خروجی JSONL" });
      const pruneBtn = el("button", { class: "mini-btn danger", type: "button", text: "پاک‌سازی داده‌های قدیمی" });
      bar.append(backupBtn, verifyBtn, exportBtn, pruneBtn);

      backupBtn.addEventListener("click", async () => {
        backupBtn.disabled = true;
        try {
          const res = await api("/admin/database/backup", { method: "POST", body: {} });
          toast(`پشتیبان ساخته شد: ${res.backup?.fileName || ""}`);
          reload();
        } catch (err) {
          toast(err.message || "پشتیبان‌گیری نشد.", "error");
        } finally {
          backupBtn.disabled = false;
        }
      });
      verifyBtn.addEventListener("click", async () => {
        try {
          const res = await api("/admin/database/verify", { method: "POST", body: {} });
          toast(res.ok ? "سلامت پایگاه داده تأیید شد." : "بررسی سلامت هشدار داد.", res.ok ? "info" : "error");
        } catch (err) {
          toast(err.message || "بررسی انجام نشد.", "error");
        }
      });
      exportBtn.addEventListener("click", async () => {
        try {
          const res = await api("/admin/database/export", { method: "POST", body: {} });
          toast(`خروجی ساخته شد: ${res.export?.name || ""} (${res.export?.rows ?? 0} ردیف)`);
        } catch (err) {
          toast(err.message || "خروجی ساخته نشد.", "error");
        }
      });
      pruneBtn.addEventListener("click", async () => {
        if (!confirm("داده‌های قدیمی طبق سیاست نگهداری پاک شوند؟ این کار برگشت‌پذیر نیست.")) return;
        try {
          const res = await api("/admin/database/prune", { method: "POST", body: {} });
          const total = Object.values(res.deleted || {}).reduce((a, b) => a + Number(b || 0), 0);
          toast(`${total} ردیف قدیمی پاک شد.`);
        } catch (err) {
          toast(err.message || "پاک‌سازی انجام نشد.", "error");
        }
      });

      const db = data.database || {};
      const grid = el("div", { class: "stat-grid" });
      grid.append(
        statCard("موتور داده", db.mode || "sqlite", db.ready ? "آماده" : "در دسترس نیست"),
        statCard("نسخهٔ اسکیما", db.schemaVersion ?? "—", "مهاجرت‌های اعمال‌شده"),
        statCard("پشتیبان‌ها", (data.backups || []).length, "آخرین نسخه‌ها"),
        statCard("رسانه‌ها", (data.media || []).length, "رکورد رسانه")
      );

      const tablesCard = card("جدول‌ها و حجم ردیف‌ها", "شمارش واقعی از پایگاه دادهٔ فعال.");
      tablesCard.append(table(
        ["جدول", "ردیف‌ها"],
        Object.entries(data.tables || {}).map(([name, count]) => [name, String(count)])
      ));

      const backupsCard = card("پشتیبان‌ها", "فایل‌ها در پوشهٔ پشتیبان سرور ذخیره می‌شوند.");
      backupsCard.append(table(
        ["فایل", "حجم", "یکپارچگی", "ساخت", "بررسی"],
        (data.backups || []).map((b) => {
          const verifyOne = el("button", { class: "mini-btn", type: "button", text: "بررسی" });
          verifyOne.addEventListener("click", async () => {
            try {
              const res = await api("/admin/database/verify", { method: "POST", body: { file: b.fileName } });
              toast(res.ok ? `سالم است: ${b.fileName}` : `مشکل دارد: ${b.fileName}`, res.ok ? "info" : "error");
            } catch (err) {
              toast(err.message || "بررسی نشد.", "error");
            }
          });
          return [b.fileName, fmtBytes(b.sizeBytes), b.integrity || "—", fmtDate(b.createdAt), verifyOne];
        })
      ));

      view.append(bar, grid, tablesCard, backupsCard);
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, reload);
    }
  };
  reload();
}

function renderFiles(section, center) {
  const state = { kind: "", files: [], nextBefore: null, kinds: [] };

  const reload = async () => {
    section.replaceChildren(loading("در حال خواندن فایل‌ها…"));
    try {
      const qs = new URLSearchParams({ limit: "30" });
      if (state.kind) qs.set("kind", state.kind);
      const [usage, list, mine] = await Promise.all([
        api("/admin/storage/usage"),
        api(`/admin/storage/files?${qs.toString()}`),
        api("/uploads/usage").catch(() => null)
      ]);
      state.files = list.files || [];
      state.nextBefore = list.nextBefore;
      state.kinds = mine?.kinds || [];

      const view = el("div", { class: "og-page" });
      const grid = el("div", { class: "stat-grid" });
      grid.append(
        statCard("فایل‌های فعال", Number(usage.totalFiles || 0).toLocaleString("fa-IR"), `${(usage.byKind || []).length.toLocaleString("fa-IR")} نوع`),
        statCard("حجم ذخیره‌شده", fmtBytes(usage.totalBytes), "فایل‌های حذف‌نشده"),
        statCard("حجم روی دیسک", fmtBytes(usage.diskBytes), "شامل فایل‌های در انتظار پاک‌سازی"),
        statCard("در انتظار پاک‌سازی", fmtBytes(usage.deleted?.bytes), `${Number(usage.deleted?.files || 0).toLocaleString("fa-IR")} فایل حذف‌شده`)
      );

      const quotaCard = card("سهمیه‌ها", "سهمیهٔ هر کاربر و سهمیهٔ سراسری از تنظیمات سرور خوانده می‌شود.");
      const quota = usage.quota || {};
      const quotaRow = (label, used, limit) => {
        const pct = limit ? Math.min(100, Math.round((Number(used) / Number(limit)) * 100)) : 0;
        const bar = el("span", { class: "quota-bar" });
        const fill = el("span", { class: "quota-fill" });
        fill.style.width = `${pct}%`;
        if (pct > 90) fill.classList.add("hot");
        bar.append(fill);
        return el("div", { class: "quota-row" }, [
          el("div", { class: "quota-top" }, [el("span", { text: label }), el("small", { text: `${fmtBytes(used)} از ${fmtBytes(limit)} · ${pct.toLocaleString("fa-IR")}٪` })]),
          bar
        ]);
      };
      quotaCard.append(quotaRow("فضای سراسری سرور", usage.totalBytes, quota.global));
      if (mine) quotaCard.append(quotaRow("سهمیهٔ حساب مالک", mine.usedBytes, mine.quotaBytes));
      if ((usage.byKind || []).length) {
        quotaCard.append(el("h3", { class: "ow-h3", text: "مصرف به تفکیک نوع" }));
        quotaCard.append(table(
          ["نوع", "فایل", "حجم"],
          usage.byKind.map((item) => [item.label || item.kind, Number(item.files).toLocaleString("fa-IR"), fmtBytes(item.bytes)])
        ));
      }

      const fileRows = (file) => {
        const thumb = file.visibility === "public" && /^image\//.test(file.mime)
          ? el("a", { href: absoluteFileUrl(file.url), target: "_blank", rel: "noopener", title: "مشاهده" }, [el("img", { class: "file-thumb", src: absoluteFileUrl(file.url), alt: "", loading: "lazy" })])
          : el("a", { class: "mini-btn", href: absoluteFileUrl(file.url), target: "_blank", rel: "noopener", text: "بازکردن" });
        return [
          thumb,
          file.owner || "—",
          file.label || file.kind,
          fmtBytes(file.sizeBytes),
          file.visibility === "public" ? tag("عمومی") : tag("خصوصی", "neutral"),
          el("span", { dir: "ltr", text: file.purpose || "—" }),
          fmtDate(file.createdAt),
          mkBtn("حذف", () => {
            if (!confirm(`فایل «${file.purpose || file.id}» برای همیشه حذف شود؟`)) return;
            api(`/uploads/${encodeURIComponent(file.id)}`, { method: "DELETE" })
              .then(() => {
                toast("فایل حذف شد.");
                reload();
              })
              .catch((err) => toast(err.message || "حذف نشد.", "error"));
          }, "mini-btn danger")
        ];
      };
      const tableBox = el("div");
      const paintFiles = () => {
        tableBox.replaceChildren(table(["پیش‌نمایش", "مالک", "نوع", "حجم", "دسترسی", "نام", "زمان", "اقدام"], state.files.map(fileRows)));
      };
      paintFiles();

      const bar = el("div", { class: "ow-toolbar" });
      const kindSelect = optionsSelect([["", "همهٔ نوع‌ها"], ...state.kinds.map((kind) => [kind.key, kind.label])], state.kind);
      kindSelect.addEventListener("change", () => {
        state.kind = kindSelect.value;
        state.files = [];
        state.nextBefore = null;
        reload();
      });
      bar.append(kindSelect, mkBtn("تازه‌سازی", reload), mkBtn("پاک‌سازی فایل‌های رهاشده", () => openCleanup(), "mini-btn danger"));
      if (state.nextBefore) {
        bar.append(mkBtn("بیشتر", async () => {
          try {
            const more = await api(`/admin/storage/files?limit=30${state.kind ? `&kind=${encodeURIComponent(state.kind)}` : ""}&before=${state.nextBefore}`);
            state.files = state.files.concat(more.files || []);
            state.nextBefore = more.nextBefore;
            paintFiles();
            if (!more.nextBefore) toast("همهٔ فایل‌ها نمایش داده شد.");
          } catch (err) {
            toast(err.message || "ادامهٔ فهرست خوانده نشد.", "error");
          }
        }));
      }

      const filesCard = card("فایل‌های بارگذاری‌شده", "همهٔ فایل‌ها با بررسی نوع واقعی (magic bytes)، سهمیه و دسترسی ذخیره می‌شوند. فایل خصوصی فقط برای صاحب و کارکنان باز می‌شود.");
      filesCard.append(bar, tableBox);
      view.append(grid, quotaCard, filesCard);
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, reload);
    }
  };

  const openCleanup = () => {
    const days = el("input", { type: "number", min: "0", max: "3650", dir: "ltr" });
    days.value = "7";
    const runBtn = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "پاک‌سازی کن" });
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      try {
        const res = await api("/admin/storage/cleanup", { method: "POST", body: { confirm: true, olderThanDays: Number(days.value) || 0 } });
        center.closeModal();
        toast(`${Number(res.removed || 0).toLocaleString("fa-IR")} فایل پاک شد.`);
        reload();
      } catch (err) {
        toast(err.message || "پاک‌سازی انجام نشد.", "error");
        runBtn.disabled = false;
      }
    });
    center.showModal("پاک‌سازی فایل‌های حذف‌شده", [
      el("p", { class: "ohint", text: "فایل‌های حذف‌شدهٔ قدیمی‌تر از این تعداد روز، به‌همراه فایل‌های یتیم (بدون رکورد در پایگاه داده) پاک می‌شوند." }),
      field("قدیمی‌تر از (روز)", days)
    ], [mkBtn("انصراف", () => center.closeModal()), runBtn]);
  };

  reload();
}

function renderServerAudit(section) {
  let before = 0;
  const items = [];
  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const data = await api("/admin/audit?limit=50");
      items.length = 0;
      items.push(...(data.entries || []));
      before = data.nextBefore || 0;
      paint();
    } catch (err) {
      failure(section, err, reload);
    }
  };
  const paint = () => {
    const view = el("div", { class: "og-page" });
    const bar = el("div", { class: "ow-toolbar" });
    const refresh = el("button", { class: "mini-btn", type: "button", text: "تازه‌سازی" });
    refresh.addEventListener("click", reload);
    const more = el("button", { class: "mini-btn", type: "button", text: "بیشتر" });
    more.addEventListener("click", async () => {
      if (!before) return;
      try {
        const data = await api(`/admin/audit?limit=50&before=${before}`);
        items.push(...(data.entries || []));
        before = data.nextBefore || 0;
        paint();
      } catch (err) {
        toast(err.message || "بارگذاری نشد.", "error");
      }
    });
    bar.append(refresh, more);
    view.append(card("رویدادهای سرور", "هر اقدام مدیریتی، ورود، تغییر قابلیت و پشتیبان‌گیری با زمان و هدف ثبت می‌شود."), bar);
    view.append(table(
      ["زمان", "اقدام", "هدف", "جزئیات"],
      items.map((e) => [fmtDate(e.createdAt || e.at), e.action || "", `${e.targetType || ""} ${e.targetId || ""}`.trim(), e.meta ? JSON.stringify(e.meta).slice(0, 160) : ""])
    ));
    section.replaceChildren(view);
  };
  reload();
}

/* ---------------- roles & restrictions ---------------- */

const PERM_GROUP_FA = {
  rooms: "اتاق‌ها",
  chat: "گفتگو",
  billing: "مالی",
  users: "کاربران",
  site: "سایت",
  features: "قابلیت‌ها",
  content: "محتوا",
  audit: "رویدادها",
  backups: "پشتیبان",
  general: "عمومی"
};

function renderRoles(section, center) {
  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const [data, restrictions] = await Promise.all([
        api("/admin/roles"),
        api("/admin/restrictions").catch((err) => ({ error: err }))
      ]);
      const view = el("div", { class: "og-page" });
      view.append(card("نقش‌ها و مجوزها", "هر نقش مجموعه‌ای از مجوزها دارد؛ ذخیرهٔ تغییر با تایید انجام و در رویدادها ثبت می‌شود."));

      const groups = new Map();
      for (const perm of data.permissions || []) {
        const key = perm.group || "general";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(perm);
      }

      for (const role of data.roles || []) {
        const box = card(role.name, role.description || "");
        const head = el("div", { class: "ow-toolbar" });
        head.append(tag(`${role.users} کاربر`), role.locked ? tag("قفل‌شده", "warn") : tag(role.system ? "سیستمی" : "سفارشی", "ok"));
        box.append(head);
        const grid = el("div", { class: "og-perm-grid" });
        const checks = new Map();
        for (const [group, perms] of groups) {
          const groupBox = el("div", { class: "og-perm-group" });
          groupBox.append(el("b", { class: "ow-h3", text: PERM_GROUP_FA[group] || group }));
          for (const perm of perms) {
            const row = el("label", { class: "ow-chip" });
            const cb = el("input", { type: "checkbox" });
            cb.checked = (role.permissions || []).includes(perm.id);
            cb.disabled = Boolean(role.locked);
            checks.set(perm.id, cb);
            row.append(cb, el("span", { text: perm.id }));
            groupBox.append(row);
          }
          grid.append(groupBox);
        }
        box.append(grid);
        if (!role.locked) {
          box.append(mkBtn("ذخیرهٔ مجوزها", () => {
            const wanted = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
            confirmThen(center, {
              title: `مجوزهای ${role.name}`,
              text: `مجموعهٔ جدید شامل ${wanted.length} مجوز است؛ دسترسی همهٔ کاربران این نقش فوراً تغییر می‌کند.`,
              danger: true
            }, async () => {
              await api(`/admin/roles/${encodeURIComponent(role.id)}/permissions`, {
                method: "PUT",
                body: { permissions: wanted, confirm: true }
              });
              toast("مجوزها ذخیره شد.");
              reload();
            });
          }));
        }
        view.append(box);
      }

      const rest = card("محدودیت‌ها و مسدودی‌ها", "رفع مسدودی بین کاربران و فعال‌کردن دوبارهٔ حساب‌های تعلیق‌شده.");
      if (restrictions?.error) {
        rest.append(el("p", { class: "ohint", text: restrictions.error.message || "برای دیدن این بخش به مجوز مدیریت کاربران نیاز است." }));
      } else {
        rest.append(table(
          ["کاربر محدود", "وضعیت", "آخرین تغییر", "اقدام"],
          (restrictions.restricted || []).map((u) => [
            `@${u.username}`,
            STATUS_LABELS[u.status] || u.status,
            fmtDate(u.updatedAt),
            mkBtn("فعال‌سازی دوباره", () => {
              confirmThen(center, { title: "فعال‌سازی حساب", text: `حساب @${u.username} دوباره فعال شود؟` }, async () => {
                await api(`/admin/users/${encodeURIComponent(u.id)}`, { method: "PATCH", body: { status: "active" } });
                toast("حساب فعال شد.");
                reload();
              });
            })
          ])
        ));
        rest.append(el("h3", { class: "ow-h3", text: "مسدودی بین کاربران" }), table(
          ["مسدودکننده", "مسدودشده", "زمان", "اقدام"],
          (restrictions.blocks || []).map((b) => [
            `@${b.username || "—"}`,
            `@${b.blockedName || "—"}`,
            fmtDate(b.createdAt),
            mkBtn("رفع مسدودی", () => {
              confirmThen(center, {
                title: "رفع مسدودی",
                text: `@${b.username} دوباره می‌تواند برای @${b.blockedName} پیام بفرستد.`,
                danger: true
              }, async () => {
                await api(`/admin/restrictions/blocks/${encodeURIComponent(b.id)}`, { method: "DELETE", body: { confirm: true } });
                toast("مسدودی برداشته شد.");
                reload();
              });
            }, "mini-btn danger")
          ])
        ));
      }
      view.append(rest);
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, reload);
    }
  };
  reload();
}

/* ---------------- billing admin ---------------- */

const CYCLE_FA = { monthly: "ماهانه", yearly: "سالانه", lifetime: "مادام‌العمر" };
const SUB_STATUS_FA = { active: "فعال", pending: "در انتظار", expired: "منقضی", cancelled: "لغو‌شده" };
const PAY_STATUS_FA = { pending: "در انتظار", paid: "پرداخت‌شده", failed: "ناموفق", refunded: "بازگشت‌خورده", cancelled: "لغو" };

function renderBillingAdmin(section, center) {
  const state = { plans: [], coupons: [], payments: [], subs: [], overview: null };

  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const [overview, plans, coupons, payments, subs] = await Promise.all([
        api("/admin/billing/overview"),
        api("/admin/billing/plans"),
        api("/admin/billing/coupons"),
        api("/admin/billing/payments?limit=25"),
        api("/admin/billing/subscriptions?limit=25")
      ]);
      state.overview = overview;
      state.plans = plans.plans || [];
      state.coupons = coupons.coupons || [];
      state.payments = payments.payments || [];
      state.subs = subs.subscriptions || [];
      paint();
    } catch (err) {
      failure(section, err, reload);
    }
  };

  const openPlanModal = (plan) => {
    const id = textInput({ placeholder: "pro-yearly", dir: "ltr" });
    id.value = plan?.id || "";
    id.disabled = Boolean(plan);
    const name = textInput({ maxlength: "80" });
    name.value = plan?.name || "";
    const desc = el("textarea", { rows: "2", maxlength: "500" });
    desc.value = plan?.description || "";
    const cycle = optionsSelect(Object.entries(CYCLE_FA), plan?.cycle || "monthly");
    const price = el("input", { type: "number", min: "0" });
    price.value = String(plan?.price ?? 0);
    const currency = textInput({ dir: "ltr" });
    currency.value = plan?.currency || "IRT";
    const days = el("input", { type: "number", min: "1" });
    days.value = String(plan?.days ?? 30);
    const trial = el("input", { type: "number", min: "0" });
    trial.value = String(plan?.trialDays ?? 0);
    const rooms = el("input", { type: "number", min: "0", placeholder: "نامحدود" });
    rooms.value = plan?.quota?.["rooms.max"] != null ? String(plan.quota["rooms.max"]) : "";
    const features = el("textarea", { rows: "4", dir: "ltr", placeholder: "features.chat\nfeatures.realtimeEnabled" });
    features.value = (plan?.features || []).join("\n");
    const active = el("input", { type: "checkbox" });
    active.checked = plan?.active !== false;
    const popular = el("input", { type: "checkbox" });
    popular.checked = Boolean(plan?.popular);

    const body = el("div");
    body.append(
      el("p", { class: "ohint", text: "شناسه فقط لاتین/عدد/خط تیره است و بعد از ساخت تغییر نمی‌کند. کلید سهمیهٔ rooms.max روی ساخت اتاق اعمال می‌شود." }),
      formGrid(
        field("شناسه", id),
        field("نام", name),
        field("چرخه", cycle),
        field("قیمت", price),
        field("واحد پول", currency),
        field("مدت (روز)", days),
        field("روز آزمایشی", trial),
        field("سقف اتاق فعال", rooms),
        field("توضیح", desc, "span2"),
        field("ویژگی‌ها (هر خط یک کلید)", features, "span2"),
        field("فعال", active),
        field("پیشنهاد ویژه", popular)
      )
    );
    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: plan ? "ذخیرهٔ تغییرها" : "ساخت پلن" });
    save.addEventListener("click", async () => {
      const payload = {
        name: name.value.trim(),
        description: desc.value.trim(),
        cycle: cycle.value,
        price: Number(price.value) || 0,
        currency: currency.value.trim() || "IRT",
        days: Number(days.value) || 30,
        trialDays: Number(trial.value) || 0,
        features: features.value.split("\n").map((line) => line.trim()).filter(Boolean),
        quota: Number(rooms.value) > 0 ? { "rooms.max": Number(rooms.value) } : {},
        active: active.checked,
        popular: popular.checked
      };
      if (!plan) payload.id = id.value.trim().toLowerCase();
      if (!payload.name) return toast("نام پلن لازم است.", "error");
      save.disabled = true;
      try {
        if (plan) await api(`/admin/billing/plans/${encodeURIComponent(plan.id)}`, { method: "PATCH", body: payload });
        else await api("/admin/billing/plans", { method: "POST", body: payload });
        toast("پلن ذخیره شد.");
        center.closeModal();
        reload();
      } catch (err) {
        toast(err.message || "ذخیره نشد.", "error");
        save.disabled = false;
      }
    });
    center.showModal(plan ? `ویرایش ${plan.name}` : "پلن جدید", [body], [mkBtn("انصراف", () => center.closeModal()), save]);
  };

  const openCouponModal = () => {
    const code = textInput({ placeholder: "YALDA1405", dir: "ltr" });
    const kind = optionsSelect([["percent", "درصدی"], ["fixed", "مبلغ ثابت"]], "percent");
    const value = el("input", { type: "number", min: "1" });
    value.value = "20";
    const planSel = optionsSelect([["", "همهٔ پلن‌ها"], ...state.plans.map((p) => [p.id, p.name])], "");
    const maxUses = el("input", { type: "number", min: "0", placeholder: "نامحدود" });
    const until = el("input", { type: "date" });
    const body = el("div");
    body.append(
      el("p", { class: "ohint", text: "کد تخفیف پس از ساخت قابل ویرایش است؛ هر کاربر فقط یک بار می‌تواند آن را استفاده کند." }),
      formGrid(
        field("کد", code),
        field("نوع", kind),
        field("مقدار", value),
        field("پلن", planSel),
        field("سقف استفاده", maxUses),
        field("معتبر تا", until)
      )
    );
    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ساخت کد" });
    save.addEventListener("click", async () => {
      const payload = {
        code: code.value.trim().toUpperCase(),
        kind: kind.value,
        value: Number(value.value) || 0,
        planId: planSel.value || null,
        maxRedemptions: Number(maxUses.value) || 0,
        validUntil: until.value ? new Date(`${until.value}T23:59:59`).getTime() : null
      };
      if (!payload.code) return toast("کد لازم است.", "error");
      save.disabled = true;
      try {
        await api("/admin/billing/coupons", { method: "POST", body: payload });
        toast("کد تخفیف ساخته شد.");
        center.closeModal();
        reload();
      } catch (err) {
        toast(err.message || "ساخته نشد.", "error");
        save.disabled = false;
      }
    });
    center.showModal("کد تخفیف جدید", [body], [mkBtn("انصراف", () => center.closeModal()), save]);
  };

  const openVerify = (payment) => {
    const ref = textInput({ placeholder: "کد رهگیری درگاه (اختیاری)", dir: "ltr" });
    const go = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "تایید پرداخت" });
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        await api(`/admin/billing/payments/${encodeURIComponent(payment.id)}/verify`, {
          method: "POST",
          body: { providerRef: ref.value.trim(), confirm: true }
        });
        toast("پرداخت تایید و اشتراک فعال شد.");
        center.closeModal();
        reload();
      } catch (err) {
        toast(err.message || "تایید نشد.", "error");
        go.disabled = false;
      }
    });
    center.showModal("تایید دستی پرداخت", [
      el("p", { class: "ohint", text: `${fmtMoney(payment.amount, payment.currency)} برای @${payment.username || payment.user}. فعال‌سازی فقط بعد از این تایید انجام می‌شود.` }),
      field("کد رهگیری", ref)
    ], [mkBtn("انصراف", () => center.closeModal()), go]);
  };

  const openRefund = (payment) => {
    const reason = el("textarea", { rows: "2", maxlength: "300", placeholder: "دلیل بازگشت" });
    const go = el("button", { class: "mini-btn danger", type: "button", text: "ثبت بازگشت وجه" });
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        await api(`/admin/billing/payments/${encodeURIComponent(payment.id)}/refund`, {
          method: "POST",
          body: { reason: reason.value.trim(), confirm: true }
        });
        toast("بازگشت وجه ثبت و اشتراک لغو شد.");
        center.closeModal();
        reload();
      } catch (err) {
        toast(err.message || "ثبت نشد.", "error");
        go.disabled = false;
      }
    });
    center.showModal("بازگشت وجه", [
      el("p", { class: "ohint", text: "این اقدام پرداخت را بازگشت‌خورده علامت می‌زند، اشتراک مرتبط را لغو می‌کند و در گزارش رویدادها می‌ماند." }),
      field("دلیل", reason)
    ], [mkBtn("انصراف", () => center.closeModal()), go]);
  };

  const openSubAdjust = (sub) => {
    const action = optionsSelect([
      ["extend", "تمدید (روز)"],
      ["cancel_at_period_end", "لغو در پایان دوره"],
      ["resume", "فعال‌سازی دوباره"],
      ["cancel", "لغو فوری"],
      ["expire", "پایان دادن"],
      ["change_plan", "تغییر پلن"]
    ], "extend");
    const days = el("input", { type: "number", min: "1" });
    days.value = "30";
    const planSel = optionsSelect(state.plans.map((p) => [p.id, p.name]));
    const note = textInput({ maxlength: "300", placeholder: "یادداشت داخلی" });
    const go = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "اجرا" });
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        await api(`/admin/billing/subscriptions/${encodeURIComponent(sub.id)}/adjust`, {
          method: "POST",
          body: {
            action: action.value,
            days: action.value === "extend" ? Number(days.value) || 0 : undefined,
            planId: action.value === "change_plan" ? planSel.value : undefined,
            note: note.value.trim(),
            confirm: true
          }
        });
        toast("اشتراک به‌روز شد.");
        center.closeModal();
        reload();
      } catch (err) {
        toast(err.message || "انجام نشد.", "error");
        go.disabled = false;
      }
    });
    center.showModal(`اشتراک @${sub.username || sub.user}`, [
      el("p", { class: "ohint", text: `پلن ${sub.planId} · وضعیت ${SUB_STATUS_FA[sub.status] || sub.status}` }),
      formGrid(field("اقدام", action), field("روز", days), field("پلن جدید", planSel), field("یادداشت", note))
    ], [mkBtn("انصراف", () => center.closeModal()), go]);
  };

  const paint = () => {
    const view = el("div", { class: "og-page" });
    const totals = state.overview?.totals || {};
    const provider = state.overview?.provider || {};
    const grid = el("div", { class: "stat-grid" });
    grid.append(
      statCard("درآمد موفق", fmtMoney(totals.paidAmount, "IRT"), `${totals.paidOrders ?? 0} پرداخت`),
      statCard("بازگشت وجه", fmtMoney(totals.refundedAmount, "IRT"), "جمع بازگشتی‌ها"),
      statCard("سفارش در انتظار", totals.pendingOrders ?? 0, "پرداخت‌نشده"),
      statCard("اشتراک فعال", totals.activeSubscriptions ?? 0, "در حال استفاده"),
      statCard("کد تخفیف فعال", state.overview?.counts?.coupons ?? 0, "قابل استفاده"),
      statCard("پرداخت معلق", state.overview?.counts?.pendingPayments ?? 0, "نیازمند بررسی")
    );
    view.append(grid);

    const providerCard = card("درگاه پرداخت", "فعال‌سازی فقط بعد از تایید سمت سرور انجام می‌شود؛ پیام موفقیت مرورگر ملاک نیست.");
    providerCard.append(table(
      ["درگاه", "حالت", "آماده", "خارج از این پروژه لازم است"],
      [[provider.provider || "manual", provider.mode || "manual", provider.configured ? "بله" : "خیر", (provider.requirements || []).join("، ") || "—"]]
    ));
    providerCard.append(el("p", { class: "ohint", text: "برای درگاه واقعی، متغیرهای سروری PAYMENT_WEBHOOK_SECRET و PAYMENT_CHECKOUT_URL (و در صورت نیاز PAYMENT_MERCHANT_ID) باید با قرارداد درگاه هماهنگ شوند." }));
    view.append(providerCard);

    const plansCard = card("پلن‌ها", "ساخت، ویرایش، کپی، ترتیب، غیرفعال‌سازی و حذف امن بدون تغییر سورس.");
    plansCard.append(el("div", { class: "ow-toolbar" }, [
      mkBtn("پلن جدید", () => openPlanModal(null)),
      mkBtn("تازه‌سازی", reload)
    ]));
    plansCard.append(table(
      ["نام", "شناسه", "چرخه", "قیمت", "مدت", "آزمایشی", "سقف اتاق", "مشترک", "وضعیت", "اقدام"],
      state.plans.map((p) => {
        const actions = el("div", { class: "og-actions" }, [
          mkBtn("ویرایش", () => openPlanModal(p)),
          mkBtn("کپی", async () => {
            try {
              await api(`/admin/billing/plans/${encodeURIComponent(p.id)}/duplicate`, { method: "POST", body: {} });
              toast("پلن کپی شد.");
              reload();
            } catch (err) { toast(err.message || "کپی نشد.", "error"); }
          }),
          mkBtn(p.active ? "غیرفعال" : "فعال", async () => {
            try {
              await api(`/admin/billing/plans/${encodeURIComponent(p.id)}`, { method: "PATCH", body: { active: !p.active } });
              toast(p.active ? "پلن غیرفعال شد." : "پلن فعال شد.");
              reload();
            } catch (err) { toast(err.message || "تغییر نکرد.", "error"); }
          }),
          p.archived
            ? mkBtn("بازیابی", async () => {
                try {
                  await api(`/admin/billing/plans/restore/${encodeURIComponent(p.id)}`, { method: "POST", body: {} });
                  toast("پلن بازیابی شد.");
                  reload();
                } catch (err) { toast(err.message || "بازیابی نشد.", "error"); }
              })
            : mkBtn("حذف", () => {
                confirmThen(center, {
                  title: "حذف پلن",
                  text: "اگر پلنی مشترک فعال دارد فقط آرشیو می‌شود؛ در غیر این صورت حذف می‌شود. این اقدام بازگشت‌پذیر نیست.",
                  danger: true
                }, async () => {
                  const res = await api(`/admin/billing/plans/${encodeURIComponent(p.id)}`, { method: "DELETE", body: { confirm: true } });
                  toast(res.mode === "archived" ? "پلن مشترک دارد؛ آرشیو شد." : "پلن حذف شد.");
                  reload();
                });
              }, "mini-btn danger")
        ]);
        return [
          p.name,
          el("code", { text: p.id }),
          CYCLE_FA[p.cycle] || p.cycle,
          fmtMoney(p.price, p.currency),
          `${p.days} روز`,
          p.trialDays ? `${p.trialDays} روز` : "—",
          p.quota?.["rooms.max"] != null ? String(p.quota["rooms.max"]) : "نامحدود",
          String(p.subscribers ?? 0),
          p.archived ? tag("آرشیو", "warn") : p.active ? tag("فعال") : tag("غیرفعال", "warn"),
          actions
        ];
      })
    ));
    view.append(plansCard);

    const couponsCard = card("کدهای تخفیف", "درصدی یا مبلغ ثابت، قابل محدودکردن به یک پلن و سقف استفاده.");
    couponsCard.append(el("div", { class: "ow-toolbar" }, [mkBtn("کد جدید", openCouponModal)]));
    couponsCard.append(table(
      ["کد", "نوع", "مقدار", "پلن", "استفاده", "وضعیت", "اقدام"],
      state.coupons.map((c) => {
        const deactivate = c.active
          ? mkBtn("غیرفعال", () => {
              confirmThen(center, { title: "غیرفعال‌کردن کد", text: `کد ${c.code} دیگر پذیرفته نمی‌شود.`, danger: true }, async () => {
                await api(`/admin/billing/coupons/${encodeURIComponent(c.id)}`, { method: "DELETE", body: { confirm: true } });
                toast("کد غیرفعال شد.");
                reload();
              });
            }, "mini-btn danger")
          : el("span", { class: "hint-s", text: "—" });
        return [
          el("code", { text: c.code }),
          c.kind === "percent" ? "درصدی" : "ثابت",
          c.kind === "percent" ? `${c.value}%` : fmtMoney(c.value, "IRT"),
          c.planId || "همه",
          `${c.redemptions}${c.maxRedemptions ? ` از ${c.maxRedemptions}` : ""}`,
          c.active ? tag("فعال") : tag("غیرفعال", "warn"),
          deactivate
        ];
      })
    ));
    view.append(couponsCard);

    const payCard = card("پرداخت‌ها", "تایید دستی فقط برای پرداخت‌های واقعی و با مسئولیت مدیر؛ هر تایید در رویدادها ثبت می‌شود.");
    payCard.append(table(
      ["کاربر", "پلن", "مبلغ", "درگاه", "وضعیت", "زمان", "اقدام"],
      state.payments.map((p) => {
        const actions = el("div", { class: "og-actions" }, [
          p.status === "pending" ? mkBtn("تایید", () => openVerify(p)) : null,
          p.status === "paid" ? mkBtn("بازگشت وجه", () => openRefund(p), "mini-btn danger") : null
        ].filter(Boolean));
        return [
          `@${p.username || p.user || "—"}`,
          p.planId || "—",
          fmtMoney(p.amount, p.currency),
          p.provider || "manual",
          PAY_STATUS_FA[p.status] || p.status,
          fmtDate(p.createdAt),
          actions
        ];
      })
    ));
    view.append(payCard);

    const subCard = card("اشتراک‌ها", "تمدید، لغو، تغییر پلن و پایان دستی؛ تغییرها به کاربر اطلاع داده می‌شود.");
    subCard.append(table(
      ["کاربر", "پلن", "وضعیت", "تمدید", "شروع", "انقضا", "اقدام"],
      state.subs.map((s) => [
        `@${s.username || s.user || "—"}`,
        s.planId,
        SUB_STATUS_FA[s.status] || s.status,
        s.renewalStatus || "—",
        fmtDate(s.startedAt),
        fmtDate(s.expiresAt),
        mkBtn("مدیریت", () => openSubAdjust(s))
      ])
    ));
    view.append(subCard);

    section.replaceChildren(view);
  };

  reload();
}

/* ---------------- support queue ---------------- */

const TICKET_STATUS_FA = { open: "باز", pending: "در انتظار پاسخ", resolved: "حل شد", closed: "بسته" };
const TICKET_PRIORITY_FA = { low: "کم", normal: "عادی", high: "بالا", urgent: "فوری" };

function renderSupport(section, center) {
  const state = { status: "", priority: "", q: "", tickets: [], agents: [] };

  const openTicket = async (ticket) => {
    let full = ticket;
    try {
      const res = await api(`/admin/support/${encodeURIComponent(ticket.id)}`);
      full = res.ticket || ticket;
      state.agents = res.agents || state.agents;
    } catch {}
    const status = optionsSelect(Object.entries(TICKET_STATUS_FA), full.status || "open");
    const priority = optionsSelect(Object.entries(TICKET_PRIORITY_FA), full.priority || "normal");
    const agentLabel = (a) => (a.role ? `@${a.username} (${a.role})` : `@${a.username}`);
    const assignee = optionsSelect([["", "بدون مسئول"], ...state.agents.map((a) => [a.id, agentLabel(a)])], full.assignedTo || "");
    const resolution = el("textarea", { rows: "3", maxlength: "2000", placeholder: "پاسخ یا نتیجه" });
    resolution.value = full.resolution || "";
    const messages = el("div", { class: "ow-kv" });
    const list = full.messages || full.events || [];
    if (Array.isArray(list) && list.length) {
      for (const m of list.slice(0, 30)) {
        const row = el("div");
        row.append(el("span", { text: m.author || m.username || m.type || "—" }), el("b", { text: String(m.body || m.content || m.text || "").slice(0, 300) }));
        messages.append(row);
      }
    } else {
      messages.append(el("p", { class: "ohint", text: full.body || full.description || "بدنهٔ تیکت در دسترس نیست." }));
    }
    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ذخیره" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await api(`/admin/support/${encodeURIComponent(ticket.id)}`, {
          method: "PATCH",
          body: {
            status: status.value,
            priority: priority.value,
            assignedTo: assignee.value || null,
            resolution: resolution.value.trim()
          }
        });
        toast("تیکت به‌روز شد.");
        center.closeModal();
        reload();
      } catch (err) {
        toast(err.message || "ثبت نشد.", "error");
        save.disabled = false;
      }
    });
    center.showModal(`تیکت ${full.subject || ticket.subject}`, [
      el("p", { class: "ohint", text: `از @${full.username || ticket.username || "—"} · ${full.category || "support"}` }),
      messages,
      formGrid(field("وضعیت", status), field("اولویت", priority), field("مسئول", assignee), field("نتیجه", resolution, "span2"))
    ], [mkBtn("انصراف", () => center.closeModal()), save]);
  };

  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const qs = new URLSearchParams({ limit: "30" });
      if (state.status) qs.set("status", state.status);
      if (state.priority) qs.set("priority", state.priority);
      if (state.q) qs.set("q", state.q);
      const data = await api(`/admin/support?${qs.toString()}`);
      state.tickets = data.tickets || [];
      state.agents = data.agents || [];

      const view = el("div", { class: "og-page" });
      const bar = el("div", { class: "ow-toolbar" });
      const status = optionsSelect([["", "همهٔ وضعیت‌ها"], ...Object.entries(TICKET_STATUS_FA)], state.status);
      const priority = optionsSelect([["", "همهٔ اولویت‌ها"], ...Object.entries(TICKET_PRIORITY_FA)], state.priority);
      const q = el("input", { class: "ow-input", type: "search", placeholder: "جستجوی موضوع یا کاربر…" });
      q.value = state.q;
      const apply = mkBtn("اعمال", () => {
        state.status = status.value;
        state.priority = priority.value;
        state.q = q.value.trim();
        reload();
      });
      bar.append(status, priority, q, apply);
      view.append(card("صف پشتیبانی", "اولویت‌بندی، ارجاع و حل تیکت‌ها؛ تغییر وضعیت به کاربر اطلاع داده می‌شود."), bar);
      view.append(table(
        ["وضعیت", "اولویت", "موضوع", "کاربر", "مسئول", "آخرین تغییر", "اقدام"],
        state.tickets.map((t) => [
          tag(TICKET_STATUS_FA[t.status] || t.status, t.status === "open" ? "warn" : "ok"),
          TICKET_PRIORITY_FA[t.priority] || t.priority,
          t.subject,
          `@${t.username || "—"}`,
          t.assigneeName ? `@${t.assigneeName}` : "—",
          fmtDate(t.updatedAt),
          mkBtn("رسیدگی", () => openTicket(t))
        ])
      ));
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, reload);
    }
  };
  reload();
}

/* ---------------- website pages & automation & broadcast ---------------- */

function renderPages(section, center) {
  const showList = async () => {
    section.replaceChildren(loading());
    try {
      const data = await api("/admin/pages");
      const view = el("div", { class: "og-page" });
      const bar = el("div", { class: "ow-toolbar" });
      bar.append(
        mkBtn("+ صفحهٔ جدید", () => openEditor(null), "btn btn-primary btn-sm"),
        mkBtn("تازه‌سازی", showList)
      );
      view.append(card("سازندهٔ صفحه‌های سایت", "صفحه‌ها از بلوک‌های امن (متن، تصویر، دکمه، بنر، فرم، ناوبری…) ساخته می‌شوند و هیچ کد دلخواهی اجرا نمی‌شود. صفحهٔ منتشرشده از نشانی page.html?slug=… واقعاً روی سایت دیده می‌شود."), bar);
      const rows = (data.pages || []).map((p) => {
        const scheduled = p.scheduledAt && p.scheduledAt > Date.now();
        const statusTag = p.status === "published"
          ? scheduled
            ? tag(`انتشار ${fmtDate(p.scheduledAt)}`, "warn")
            : tag("منتشرشده")
          : p.status === "archived"
            ? tag("آرشیو", "neutral")
            : tag("پیش‌نویس", "warn");
        const actions = el("div", { class: "og-actions" }, [
          mkBtn("ویرایش", () => openEditor(p)),
          p.status === "published" && !scheduled ? mkBtn("دیدن", () => window.open(`page.html?slug=${encodeURIComponent(p.slug)}`, "_blank", "noopener")) : null,
          p.status !== "published" ? mkBtn("انتشار", () => quickStatus(p, "published")) : mkBtn("پیش‌نویس", () => quickStatus(p, "draft")),
          p.status !== "archived" ? mkBtn("آرشیو", () => quickStatus(p, "archived", true), "mini-btn danger") : mkBtn("خروج از آرشیو", () => quickStatus(p, "draft"))
        ].filter(Boolean));
        return [
          p.title,
          el("code", { dir: "ltr", text: p.slug }),
          statusTag,
          VISIBILITY_LABELS[p.visibility] || p.visibility,
          String(p.version),
          String(p.submissionCount || 0),
          fmtDate(p.updatedAt),
          actions
        ];
      });
      view.append(table(["عنوان", "نشانی", "وضعیت", "دسترسی", "نسخه", "فرم‌ها", "آخرین ویرایش", "اقدام"], rows));
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, showList);
    }
  };

  const quickStatus = async (page, status, danger = false) => {
    if (danger && !confirm(`صفحهٔ «${page.title}» آرشیو شود؟`)) return;
    try {
      await api(`/admin/pages/${encodeURIComponent(page.id)}`, { method: "PATCH", body: { status } });
      toast(status === "published" ? "صفحه منتشر شد." : status === "archived" ? "صفحه آرشیو شد." : "صفحه پیش‌نویس شد.");
      showList();
    } catch (err) {
      toast(err.message || "وضعیت تغییر نکرد.", "error");
    }
  };

  const openEditor = (page) => {
    const draft = draftFromPage(page);
    let isNew = !draft.id;
    let dirty = false;

    const statusLine = el("p", { class: "bld-status" });
    const dirtyHint = el("span", { class: "bld-dirty" });
    const updateStatusLine = () => {
      const scheduled = draft.scheduledAt && draft.scheduledAt > Date.now();
      statusLine.textContent = `${PAGE_STATUS_LABELS[draft.status] || draft.status}${scheduled ? ` · انتشار زمان‌دار: ${fmtDate(draft.scheduledAt)}` : ""} · نسخهٔ ${draft.version}${draft.id ? ` · شناسه ${draft.id.slice(0, 8)}` : ""}`;
      dirtyHint.textContent = dirty ? "تغییرات ذخیره‌نشده" : "ذخیره‌شده";
      dirtyHint.classList.toggle("is-dirty", dirty);
    };

    /* meta fields */
    const titleInput = textInput({ maxlength: "160", placeholder: "عنوان صفحه" });
    titleInput.value = draft.title;
    titleInput.addEventListener("input", () => { draft.title = titleInput.value; dirty = true; refreshPreview(); updateStatusLine(); });

    const slugInput = textInput({ dir: "ltr", maxlength: "64", placeholder: "about-us" });
    slugInput.value = draft.slug;
    slugInput.disabled = !isNew;
    slugInput.addEventListener("input", () => { draft.slug = slugInput.value.trim().toLowerCase(); dirty = true; updateStatusLine(); });

    const descInput = el("textarea", { rows: "2", maxlength: "400", placeholder: "توضیح کوتاه برای موتور جست‌وجو و اشتراک‌گذاری" });
    descInput.value = draft.description;
    descInput.addEventListener("input", () => { draft.description = descInput.value; dirty = true; refreshPreview(); updateStatusLine(); });

    const localeInput = optionsSelect([["fa", "فارسی"], ["en", "English"]], draft.locale);
    localeInput.addEventListener("change", () => { draft.locale = localeInput.value; dirty = true; updateStatusLine(); });

    const visibilityInput = optionsSelect(Object.entries(VISIBILITY_LABELS), draft.visibility);
    visibilityInput.addEventListener("change", () => { draft.visibility = visibilityInput.value; dirty = true; updateStatusLine(); });

    const navToggle = el("input", { type: "checkbox" });
    navToggle.checked = draft.showInNav;
    navToggle.addEventListener("change", () => { draft.showInNav = navToggle.checked; dirty = true; updateStatusLine(); });

    const navOrderInput = el("input", { type: "number", min: "0", max: "999", dir: "ltr" });
    navOrderInput.value = String(draft.navOrder || 0);
    navOrderInput.addEventListener("input", () => { draft.navOrder = Number(navOrderInput.value) || 0; dirty = true; updateStatusLine(); });

    const scheduleInput = el("input", { type: "datetime-local" });
    scheduleInput.value = toDateTimeInput(draft.scheduledAt);
    scheduleInput.addEventListener("change", () => {
      draft.scheduledAt = fromDateTimeInput(scheduleInput.value);
      dirty = true;
      updateStatusLine();
      syncPublish();
    });
    const clearSchedule = mkBtn("حذف زمان‌بندی", () => {
      scheduleInput.value = "";
      draft.scheduledAt = null;
      dirty = true;
      updateStatusLine();
      syncPublish();
    });

    /* preview */
    const previewTitle = el("h3", { class: "bld-preview-title" });
    const previewDesc = el("p", { class: "bld-preview-desc" });
    const previewBox = el("div", { class: "pub-blocks bld-preview-blocks" });
    const refreshPreview = () => {
      previewTitle.textContent = draft.title || "بدون عنوان";
      previewDesc.textContent = draft.description || "";
      previewDesc.classList.toggle("hidden", !draft.description);
      renderBlocks(previewBox, draft.blocks, { preview: true });
    };

    /* uploads inside blocks */
    const uploadInto = (block, key, srcInput) => {
      const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", class: "hidden" });
      const btn = mkBtn("بارگذاری تصویر", () => fileInput.click(), "mini-btn");
      const progress = uploadProgressRow("بارگذاری تصویر");
      progress.classList.add("hidden");
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        btn.disabled = true;
        progress.classList.remove("hidden");
        try {
          const data = await uploadFile(file, { kind: "page-image", token: ownerToken(), onProgress: (p) => progress.setProgress(p) });
          const abs = absoluteFileUrl(data.url);
          block[key] = /^https:\/\//i.test(abs) ? abs : data.url;
          srcInput.value = block[key];
          dirty = true;
          refreshPreview();
          updateStatusLine();
          toast("تصویر بارگذاری شد.");
        } catch (err) {
          toast(err.message || "بارگذاری نشد.", "error");
        } finally {
          btn.disabled = false;
          fileInput.value = "";
          setTimeout(() => progress.classList.add("hidden"), 1500);
        }
      });
      return el("div", { class: "bld-upload" }, [btn, fileInput, progress, el("small", { class: "ohint", text: "PNG/JPG/WebP تا ۵ مگابایت. بارگذاری از سهمیهٔ فضای حساب مالک کم می‌شود." })]);
    };

    const blockFields = (block) => {
      const nodes = [];
      const fieldText = (label, key, opts = {}) => {
        const control = opts.textarea
          ? el("textarea", { rows: String(opts.rows || 3), maxlength: String(opts.maxlength || 2000) })
          : textInput({ maxlength: String(opts.maxlength || 300), dir: opts.dir || "auto", placeholder: opts.placeholder || "" });
        control.value = block[key] ?? "";
        control.addEventListener("input", () => { block[key] = control.value; dirty = true; refreshPreview(); updateStatusLine(); });
        return field(label, control, opts.span2 ? "span2" : "");
      };
      switch (block.type) {
        case "heading": {
          nodes.push(fieldText("متن عنوان", "text", { span2: true, maxlength: 200 }));
          const level = optionsSelect([["1", "عنوان اصلی (H1)"], ["2", "عنوان (H2)"], ["3", "زیرعنوان (H3)"]], String(block.level || 2));
          level.addEventListener("change", () => { block.level = Number(level.value); dirty = true; refreshPreview(); updateStatusLine(); });
          nodes.push(field("سطح", level));
          break;
        }
        case "text":
          nodes.push(fieldText("متن", "text", { textarea: true, rows: 6, span2: true, maxlength: 5000 }));
          break;
        case "image": {
          const srcInput = textInput({ dir: "ltr", maxlength: "800", placeholder: "https://… یا /api/files/…" });
          srcInput.value = block.src || "";
          srcInput.addEventListener("input", () => { block.src = srcInput.value; dirty = true; refreshPreview(); updateStatusLine(); });
          nodes.push(field("نشانی تصویر", srcInput, "span2"));
          nodes.push(fieldText("متن جایگزین (alt)", "alt", { span2: true, maxlength: 200 }));
          nodes.push(fieldText("زیرنویس", "caption", { span2: true, maxlength: 300 }));
          nodes.push(uploadInto(block, "src", srcInput));
          break;
        }
        case "button": {
          nodes.push(fieldText("برچسب دکمه", "label", { maxlength: 80 }));
          nodes.push(fieldText("مقصد", "href", { dir: "ltr", maxlength: 500, placeholder: "/ یا https:// یا #anchor" }));
          const style = optionsSelect([["primary", "توپر"], ["ghost", "حاشیه‌دار"]], block.style === "ghost" ? "ghost" : "primary");
          style.addEventListener("change", () => { block.style = style.value; dirty = true; refreshPreview(); updateStatusLine(); });
          nodes.push(field("نمایش", style));
          break;
        }
        case "link": {
          nodes.push(fieldText("برچسب لینک", "label", { maxlength: 80 }));
          nodes.push(fieldText("مقصد", "href", { dir: "ltr", maxlength: 500 }));
          break;
        }
        case "banner": {
          nodes.push(fieldText("عنوان بنر", "title", { span2: true, maxlength: 160 }));
          nodes.push(fieldText("متن بنر", "text", { textarea: true, rows: 3, span2: true, maxlength: 1000 }));
          const tone = optionsSelect([["primary", "برند"], ["soft", "ملایم"], ["dark", "تیره"]], block.tone || "primary");
          tone.addEventListener("change", () => { block.tone = tone.value; dirty = true; refreshPreview(); updateStatusLine(); });
          nodes.push(field("رنگ بنر", tone));
          nodes.push(fieldText("برچسب دکمه", "ctaLabel", { maxlength: 60 }));
          nodes.push(fieldText("مقصد دکمه", "ctaHref", { dir: "ltr", maxlength: 500 }));
          const srcInput = textInput({ dir: "ltr", maxlength: "800", placeholder: "تصویر پس‌زمینه (اختیاری)" });
          srcInput.value = block.image || "";
          srcInput.addEventListener("input", () => { block.image = srcInput.value; dirty = true; refreshPreview(); updateStatusLine(); });
          nodes.push(field("تصویر پس‌زمینه", srcInput, "span2"));
          nodes.push(uploadInto(block, "image", srcInput));
          break;
        }
        case "form": {
          nodes.push(fieldText("عنوان فرم", "title", { span2: true, maxlength: 160 }));
          nodes.push(fieldText("توضیح فرم", "text", { textarea: true, rows: 2, span2: true, maxlength: 600 }));
          const checks = el("div", { class: "bld-checks span2" });
          for (const [id, label] of [["name", "نام"], ["email", "ایمیل"], ["phone", "شماره موبایل"], ["message", "پیام"]]) {
            const box = el("input", { type: "checkbox" });
            box.checked = (block.fields || []).includes(id);
            box.addEventListener("change", () => {
              const set = new Set(block.fields || []);
              if (box.checked) set.add(id);
              else set.delete(id);
              block.fields = [...set];
              dirty = true;
              refreshPreview();
              updateStatusLine();
            });
            checks.append(el("label", { class: "ow-chip" }, [box, el("span", { text: label })]));
          }
          nodes.push(el("div", { class: "span2" }, [el("span", { class: "bld-lbl", text: "فیلدهای فرم" }), checks]));
          nodes.push(fieldText("متن دکمهٔ ارسال", "submitLabel", { maxlength: 60 }));
          nodes.push(fieldText("پیام موفقیت", "successText", { maxlength: 300 }));
          break;
        }
        case "nav": {
          const box = el("div", { class: "bld-repeater span2" });
          const renderItems = () => {
            box.replaceChildren();
            (block.items || []).forEach((item, index) => {
              const label = textInput({ maxlength: "40", placeholder: "برچسب" });
              label.value = item.label || "";
              label.addEventListener("input", () => { item.label = label.value; dirty = true; refreshPreview(); updateStatusLine(); });
              const href = textInput({ dir: "ltr", maxlength: "300", placeholder: "/ یا https://" });
              href.value = item.href || "";
              href.addEventListener("input", () => { item.href = href.value; dirty = true; refreshPreview(); updateStatusLine(); });
              box.append(el("div", { class: "bld-inline" }, [
                label,
                href,
                mkBtn("حذف", () => {
                  block.items.splice(index, 1);
                  dirty = true;
                  renderItems();
                  refreshPreview();
                  updateStatusLine();
                }, "icon-btn danger")
              ]));
            });
            if ((block.items || []).length < 8) {
              box.append(mkBtn("+ آیتم", () => {
                block.items = block.items || [];
                block.items.push({ label: "آیتم", href: "/" });
                dirty = true;
                renderItems();
                refreshPreview();
                updateStatusLine();
              }, "mini-btn"));
            }
            if (!(block.items || []).length) box.append(el("p", { class: "ohint", text: "حداقل یک آیتم لازم است؛ ناوبری خالی ذخیره نمی‌شود." }));
          };
          renderItems();
          nodes.push(box);
          break;
        }
        case "spacer": {
          const size = optionsSelect([["sm", "کوچک"], ["md", "متوسط"], ["lg", "بزرگ"]], block.size || "md");
          size.addEventListener("change", () => { block.size = size.value; dirty = true; refreshPreview(); updateStatusLine(); });
          nodes.push(field("اندازه", size));
          break;
        }
        default:
          break;
      }
      return formGrid(...nodes);
    };

    const layoutRow = (block) => {
      const layout = block.layout || (block.layout = { width: "narrow", tone: "none", align: "start" });
      const width = optionsSelect([["narrow", "عرض محدود"], ["full", "عرض کامل"]], layout.width || "narrow");
      width.addEventListener("change", () => { layout.width = width.value; dirty = true; refreshPreview(); updateStatusLine(); });
      const tone = optionsSelect([["none", "بدون پس‌زمینه"], ["soft", "پس‌زمینه ملایم"], ["strong", "پس‌زمینه پررنگ"]], layout.tone || "none");
      tone.addEventListener("change", () => { layout.tone = tone.value; dirty = true; refreshPreview(); updateStatusLine(); });
      const align = optionsSelect([["start", "شروع"], ["center", "وسط"], ["end", "پایان"]], layout.align || "start");
      align.addEventListener("change", () => { layout.align = align.value; dirty = true; refreshPreview(); updateStatusLine(); });
      return el("div", { class: "bld-layout" }, [field("عرض", width), field("پس‌زمینه", tone), field("تراز", align)]);
    };

    const blocksWrap = el("div", { class: "bld-blocks" });
    const swapBlocks = (a, b) => {
      const list = draft.blocks;
      [list[a], list[b]] = [list[b], list[a]];
      dirty = true;
      renderList();
      refreshPreview();
      updateStatusLine();
    };
    const blockCard = (block, index) => {
      const node = el("section", { class: "bld-block" });
      const tools = el("div", { class: "bld-block-tools" });
      if (index > 0) tools.append(mkBtn("↑", () => swapBlocks(index, index - 1), "icon-btn"));
      if (index < draft.blocks.length - 1) tools.append(mkBtn("↓", () => swapBlocks(index, index + 1), "icon-btn"));
      tools.append(mkBtn("حذف", () => {
        draft.blocks.splice(index, 1);
        dirty = true;
        renderList();
        refreshPreview();
        updateStatusLine();
      }, "icon-btn danger"));
      node.append(el("div", { class: "bld-block-head" }, [
        el("strong", { text: `${index + 1}. ${BLOCK_LABELS[block.type] || block.type}` }),
        tools
      ]));
      node.append(blockFields(block));
      node.append(layoutRow(block));
      return node;
    };
    const renderList = () => {
      blocksWrap.replaceChildren();
      if (!draft.blocks.length) {
        blocksWrap.append(el("p", { class: "ohint", text: "هنوز بلوکی نداری؛ از دکمه‌های بالا یکی اضافه کن." }));
        return;
      }
      draft.blocks.forEach((block, index) => blocksWrap.append(blockCard(block, index)));
    };

    const palette = el("div", { class: "bld-palette" });
    for (const type of Object.keys(BLOCK_LABELS)) {
      palette.append(mkBtn(`+ ${BLOCK_LABELS[type]}`, () => {
        draft.blocks.push(newBlock(type));
        dirty = true;
        renderList();
        refreshPreview();
        updateStatusLine();
      }, "bld-chip"));
    }

    /* toolbar */
    const extras = el("div", { class: "bld-extras" });
    const publishBtn = el("button", { class: "btn btn-primary btn-sm", type: "button" });
    const syncPublish = () => {
      publishBtn.textContent = draft.scheduledAt && draft.scheduledAt > Date.now() ? "انتشار زمان‌دار" : "انتشار";
    };
    syncPublish();

    const save = async (status, btn) => {
      if (!draft.title.trim()) {
        toast("عنوان صفحه لازم است.", "error");
        return;
      }
      if (isNew && !/^[a-z0-9-]{2,64}$/.test(draft.slug)) {
        toast("نشانی صفحه فقط حروف لاتین کوچک، رقم و خط تیره باشد (۲ تا ۶۴ نویسه).", "error");
        return;
      }
      if (status === "published" && draft.blocks.some((block) => block.type === "image" && !block.src)) {
        toast("یکی از بلوک‌های تصویر نشانی ندارد؛ آن را کامل کن.", "error");
        return;
      }
      btn.disabled = true;
      try {
        const payload = {
          title: draft.title.trim(),
          description: draft.description,
          blocks: draft.blocks,
          locale: draft.locale,
          visibility: draft.visibility,
          showInNav: draft.showInNav,
          navOrder: draft.navOrder,
          scheduledAt: draft.scheduledAt,
          status
        };
        const data = isNew
          ? await api("/admin/pages", { method: "POST", body: { ...payload, slug: draft.slug } })
          : await api(`/admin/pages/${encodeURIComponent(draft.id)}`, { method: "PATCH", body: payload });
        const saved = data.page || {};
        if (isNew) {
          isNew = false;
          draft.id = saved.id || "";
          draft.slug = saved.slug || draft.slug;
          slugInput.disabled = true;
        }
        draft.status = saved.status || status;
        draft.version = Number(saved.version || draft.version);
        draft.updatedAt = saved.updatedAt;
        dirty = false;
        updateStatusLine();
        syncExtras();
        toast(
          status === "archived"
            ? "صفحه آرشیو شد."
            : status === "published"
              ? `صفحه منتشر شد (نسخهٔ ${draft.version}).`
              : `ذخیره شد (نسخهٔ ${draft.version}).`
        );
      } catch (err) {
        toast(err.message || "ذخیره نشد.", "error");
      } finally {
        btn.disabled = false;
      }
    };

    const openVersions = async () => {
      if (isNew) return;
      try {
        const data = await api(`/admin/pages/${encodeURIComponent(draft.id)}/versions`);
        const rows = (data.versions || []).map((v) => [
          String(v.version),
          PAGE_STATUS_LABELS[v.status] || v.status,
          fmtDate(v.createdAt),
          mkBtn("بازگردانی", () => {
            center.closeModal();
            setTimeout(() => {
              confirmThen(center, {
                title: "بازگردانی نسخه",
                text: `محتوای نسخهٔ ${v.version} به‌عنوان نسخهٔ تازه جایگزین می‌شود. نسخهٔ فعلی هم در تاریخچه می‌ماند.`,
                danger: true
              }, async () => {
                await api(`/admin/pages/${encodeURIComponent(draft.id)}/rollback`, { method: "POST", body: { version: v.version, confirm: true } });
                toast("نسخه بازگردانی شد.");
                const fresh = await api(`/admin/pages/${encodeURIComponent(draft.id)}`);
                openEditor(fresh.page);
              });
            }, 0);
          })
        ]);
        center.showModal("تاریخچهٔ نسخه‌ها", [table(["نسخه", "وضعیت", "زمان", "اقدام"], rows)], [mkBtn("بستن", () => center.closeModal())]);
      } catch (err) {
        toast(err.message || "نسخه‌ها خوانده نشد.", "error");
      }
    };

    const openSubmissions = async () => {
      if (isNew) return;
      try {
        const data = await api(`/admin/pages/${encodeURIComponent(draft.id)}/submissions?limit=100`);
        const rows = (data.submissions || []).map((item) => [item.name || "—", el("span", { dir: "ltr", text: item.email || "—" }), item.message || "—", fmtDate(item.createdAt)]);
        center.showModal("پیام‌های فرم", [table(["نام", "ایمیل", "متن", "زمان"], rows)], [mkBtn("بستن", () => center.closeModal())]);
      } catch (err) {
        toast(err.message || "فرم‌ها خوانده نشد.", "error");
      }
    };

    const syncExtras = () => {
      extras.replaceChildren();
      if (isNew) {
        extras.append(el("span", { class: "ohint", text: "بعد از اولین ذخیره، تاریخچه و فرم‌ها فعال می‌شوند." }));
        return;
      }
      extras.append(mkBtn("نسخه‌ها", openVersions));
      extras.append(mkBtn(`فرم‌ها${draft.submissionCount ? ` (${draft.submissionCount})` : ""}`, openSubmissions));
      if (draft.status === "published" && !(draft.scheduledAt && draft.scheduledAt > Date.now())) {
        extras.append(mkBtn("بازکردن صفحه", () => window.open(`page.html?slug=${encodeURIComponent(draft.slug)}`, "_blank", "noopener")));
      }
    };

    const saveBtn = el("button", { class: "mini-btn", type: "button", text: "ذخیره" });
    saveBtn.addEventListener("click", () => save(draft.status === "archived" ? "draft" : draft.status, saveBtn));
    publishBtn.addEventListener("click", () => save("published", publishBtn));
    const archiveBtn = el("button", { class: "mini-btn danger", type: "button", text: "آرشیو" });
    archiveBtn.addEventListener("click", async () => {
      if (isNew) return toast("اول صفحه را ذخیره کن.", "error");
      if (!confirm(`صفحهٔ «${draft.title}» آرشیو شود؟`)) return;
      await save("archived", archiveBtn);
      showList();
    });
    const backBtn = mkBtn("→ فهرست صفحه‌ها", () => {
      if (dirty && !confirm("تغییرات ذخیره‌نشده کنار گذاشته شود؟")) return;
      showList();
    });

    const toolbar = el("div", { class: "bld-toolbar" }, [backBtn, saveBtn, publishBtn, archiveBtn, extras, dirtyHint]);
    const metaCard = card("مشخصات صفحه");
    metaCard.append(formGrid(
      field("عنوان", titleInput, "span2"),
      field("نشانی ثابت (slug)", slugInput),
      field("زبان", localeInput),
      field("توضیح", descInput, "span2"),
      field("دسترسی", visibilityInput),
      field("ترتیب در ناوبری", navOrderInput),
      field("نمایش در ناوبری سایت", navToggle),
      field("انتشار زمان‌دار (اختیاری)", scheduleInput),
      el("div", { class: "span2" }, [clearSchedule])
    ));

    const blocksCard = card("بلوک‌های صفحه", "فقط همین بلوک‌های امن مجازند؛ متن و نشانی‌ها پیش از ذخیره روی سرور پاک‌سازی می‌شوند.");
    blocksCard.append(palette, blocksWrap);

    const previewCard = card("پیش‌نمایش زنده", "همان چیزی که بازدیدکننده می‌بیند (فرم‌ها در پیش‌نمایش ارسال واقعی نمی‌کنند).");
    previewCard.classList.add("bld-preview");
    previewCard.append(previewTitle, previewDesc, previewBox);

    const view = el("div", { class: "og-page bld" });
    view.append(toolbar, statusLine);
    view.append(el("div", { class: "bld-grid" }, [
      el("div", { class: "bld-col" }, [metaCard, blocksCard]),
      el("div", { class: "bld-col bld-col-side" }, [previewCard])
    ]));
    section.replaceChildren(view);

    renderList();
    refreshPreview();
    syncExtras();
    updateStatusLine();
  };

  showList();
}

function renderAutomation(section, center) {
  const runRow = (run) => {
    const duration = run.finishedAt && run.startedAt ? run.finishedAt - run.startedAt : null;
    return [
      run.workflowName || run.workflowId || "—",
      el("code", { dir: "ltr", text: run.trigger }),
      run.status === "ok" ? tag("موفق") : run.status === "running" ? tag("در حال اجرا", "neutral") : tag("ناموفق", "bad"),
      String(run.attempts || 1),
      duration == null ? "—" : `${(duration / 1000).toLocaleString("fa-IR", { maximumFractionDigits: 1 })} ثانیه`,
      fmtDate(run.startedAt),
      run.error || "—",
      run.status === "failed"
        ? mkBtn("تلاش دوباره", () => retryRun(run), "mini-btn")
        : null
    ];
  };

  const retryRun = (run) => {
    const btn = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "اجرای دوباره" });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await api(`/admin/automation/runs/${encodeURIComponent(run.id)}/retry`, { method: "POST", body: { confirm: true } });
        center.closeModal();
        toast(res.status === "ok" ? "اجرای دوباره موفق بود." : "اجرای دوباره انجام شد ولی ناموفق بود.", res.status === "ok" ? "info" : "error");
        reload();
      } catch (err) {
        toast(err.message || "اجرای دوباره شروع نشد.", "error");
        btn.disabled = false;
      }
    });
    center.showModal("اجرای دوباره", [
      el("p", { class: "ohint", text: `اجرای «${run.workflowName || run.trigger}» با همان رویداد اولیه دوباره اجرا می‌شود. اقدام‌ها واقعی‌اند.` })
    ], [mkBtn("انصراف", () => center.closeModal()), btn]);
  };

  const openRuns = async (meta) => {
    const box = el("div", { class: "aut-runs-box" });
    const filter = optionsSelect([["", "همه"], ["ok", "موفق"], ["failed", "ناموفق"], ["running", "در حال اجرا"]], "");
    const listBox = el("div");
    const load = async () => {
      listBox.replaceChildren(el("p", { class: "ohint", text: "در حال خواندن‌…" }));
      try {
        const qs = new URLSearchParams({ limit: "100" });
        if (filter.value) qs.set("status", filter.value);
        const data = await api(`/admin/automation/runs?${qs.toString()}`);
        listBox.replaceChildren(table(
          ["گردش‌کار", "محرک", "وضعیت", "تلاش", "مدت", "شروع", "خطا", "اقدام"],
          (data.runs || []).map(runRow)
        ));
      } catch (err) {
        listBox.replaceChildren(el("p", { class: "ohint", text: err.message || "خوانده نشد." }));
      }
    };
    filter.addEventListener("change", load);
    box.append(el("div", { class: "ow-toolbar" }, [field("وضعیت", filter)]), listBox);
    center.showModal("تاریخچهٔ اجراها", [box], [mkBtn("بستن", () => center.closeModal())]);
    load();
  };

  const openEditor = (workflow, meta) => {
    const wf = workflow
      ? JSON.parse(JSON.stringify(workflow))
      : { name: "", description: "", trigger: Object.keys(meta.triggers)[0] || "", conditions: { match: "all", rules: [] }, actions: [], enabled: false };
    wf.conditions = wf.conditions && typeof wf.conditions === "object" ? wf.conditions : { match: "all", rules: [] };
    wf.conditions.rules = Array.isArray(wf.conditions.rules) ? wf.conditions.rules : [];
    wf.actions = Array.isArray(wf.actions) ? wf.actions : [];

    const name = textInput({ maxlength: "120", placeholder: "مثلاً: یادآوری تمدید اشتراک" });
    name.value = wf.name || "";
    const description = el("textarea", { rows: "2", maxlength: "400", placeholder: "این گردش‌کار چه کاری انجام می‌دهد؟" });
    description.value = wf.description || "";
    const trigger = optionsSelect(Object.entries(meta.triggers), wf.trigger || Object.keys(meta.triggers)[0]);
    const enabled = el("input", { type: "checkbox" });
    enabled.checked = Boolean(wf.enabled);

    const condBox = el("div", { class: "aut-box span2" });
    const renderConditions = () => {
      condBox.replaceChildren();
      const match = optionsSelect([["all", "همهٔ شرط‌ها برقرار باشند"], ["any", "کافی است یکی برقرار باشد"]], wf.conditions.match || "all");
      match.addEventListener("change", () => { wf.conditions.match = match.value; });
      condBox.append(field("منطق شرط‌ها", match));
      const rows = el("div", { class: "aut-rows" });
      wf.conditions.rules.forEach((rule, index) => {
        const fieldName = textInput({ dir: "ltr", maxlength: "64", placeholder: "user.role" });
        fieldName.value = rule.field || "";
        fieldName.addEventListener("input", () => { rule.field = fieldName.value.trim(); });
        const op = optionsSelect(Object.entries(OP_LABELS), rule.op || "eq");
        op.addEventListener("change", () => { rule.op = op.value; });
        const value = textInput({ maxlength: "200", placeholder: "مقدار" });
        value.value = rule.value ?? "";
        value.addEventListener("input", () => { rule.value = /^-?\d+$/.test(value.value) ? Number(value.value) : value.value; });
        rows.append(el("div", { class: "aut-row" }, [
          field("فیلد رویداد", fieldName),
          field("عملگر", op),
          field("مقدار", value),
          mkBtn("حذف", () => {
            wf.conditions.rules.splice(index, 1);
            renderConditions();
          }, "icon-btn danger")
        ]));
      });
      if (!wf.conditions.rules.length) rows.append(el("p", { class: "ohint", text: "بدون شرط، همهٔ رویدادهای این محرک گردش‌کار را اجرا می‌کنند." }));
      if (wf.conditions.rules.length < 12) {
        rows.append(mkBtn("+ شرط", () => {
          wf.conditions.rules.push({ field: "", op: "eq", value: "" });
          renderConditions();
        }, "mini-btn"));
      }
      condBox.append(rows);
      condBox.append(el("p", { class: "ohint", text: "فیلدها با نقطه روی رویداد جست‌وجو می‌شوند؛ مثال: user.role، plan.id، room.capacity." }));
    };

    const actBox = el("div", { class: "aut-box span2" });
    const renderActions = () => {
      actBox.replaceChildren();
      wf.actions.forEach((action, index) => {
        const typeSelect = optionsSelect(Object.entries(meta.actions).map(([id, def]) => [id, def.label]), action.type);
        action.params = action.params && typeof action.params === "object" ? action.params : {};
        const paramsBox = el("div", { class: "aut-row" });
        const renderParams = () => {
          paramsBox.replaceChildren();
          const def = meta.actions[action.type];
          const keys = Object.keys(def?.params || {});
          if (!keys.length) {
            paramsBox.append(el("p", { class: "ohint", text: "این اقدام پارامتری ندارد." }));
            return;
          }
          for (const key of keys) {
            if (key === "kind") {
              const select = optionsSelect(Object.entries(NOTICE_KIND_LABELS), action.params.kind || "announcement");
              select.addEventListener("change", () => { action.params.kind = select.value; });
              paramsBox.append(field(PARAM_LABELS.kind || key, select));
            } else if (key === "role") {
              const select = optionsSelect(Object.entries(ROLE_LABELS), action.params.role || "member");
              select.addEventListener("change", () => { action.params.role = select.value; });
              paramsBox.append(field(PARAM_LABELS.role || key, select));
            } else {
              const control = key === "body" || key === "text"
                ? el("textarea", { rows: "2", maxlength: String(def.params[key]) })
                : textInput({ maxlength: String(def.params[key]), dir: key === "link" || key === "title" ? "auto" : "auto" });
              control.value = action.params[key] ?? "";
              control.addEventListener("input", () => { action.params[key] = control.value; });
              paramsBox.append(field(PARAM_LABELS[key] || key, control, key === "body" || key === "text" ? "span2" : ""));
            }
          }
        };
        typeSelect.addEventListener("change", () => {
          action.type = typeSelect.value;
          action.params = {};
          renderParams();
        });
        renderParams();
        const cardEl = el("div", { class: "aut-action" });
        cardEl.append(el("div", { class: "aut-action-head" }, [
          el("strong", { text: `اقدام ${index + 1}` }),
          typeSelect,
          mkBtn("حذف", () => {
            wf.actions.splice(index, 1);
            renderActions();
          }, "icon-btn danger")
        ]));
        cardEl.append(paramsBox);
        cardEl.append(el("p", { class: "ohint", text: meta.actions[action.type]?.fa || "" }));
        actBox.append(cardEl);
      });
      if (!wf.actions.length) actBox.append(el("p", { class: "ohint", text: "هنوز اقدامی اضافه نشده است. گردش‌کار بدون اقدام قابل فعال‌سازی نیست." }));
      if (wf.actions.length < 10) {
        actBox.append(mkBtn("+ اقدام", () => {
          wf.actions.push({ type: "notify_user", params: { title: "", body: "", kind: "announcement", link: "" } });
          renderActions();
        }, "mini-btn"));
      }
    };

    renderConditions();
    renderActions();

    const save = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ذخیره" });
    save.addEventListener("click", async () => {
      if (!name.value.trim()) return toast("نام گردش‌کار لازم است.", "error");
      const payload = {
        name: name.value.trim(),
        description: description.value.trim(),
        trigger: trigger.value,
        conditions: wf.conditions,
        actions: wf.actions,
        enabled: enabled.checked
      };
      save.disabled = true;
      try {
        if (workflow) await api(`/admin/automation/${encodeURIComponent(workflow.id)}`, { method: "PATCH", body: payload });
        else await api("/admin/automation", { method: "POST", body: payload });
        toast(workflow ? "گردش‌کار به‌روز شد." : "گردش‌کار ساخته شد.");
        center.closeModal();
        reload();
      } catch (err) {
        toast(err.message || "ذخیره نشد.", "error");
        save.disabled = false;
      }
    });

    const body = el("div", { class: "aut-editor" });
    body.append(formGrid(
      field("نام گردش‌کار", name),
      field("فعال باشد", enabled),
      field("توضیح", description, "span2"),
      field("رویداد محرک", trigger, "span2"),
      condBox,
      actBox
    ));
    body.append(el("p", { class: "ohint", text: "اقدام‌ها فقط از فهرست مجاز بالا انتخاب می‌شوند و روی همین سرور اجرا می‌شوند؛ هیچ کد دلخواهی پذیرفته نمی‌شود." }));
    const box = center.showModal(workflow ? `ویرایش ${workflow.name}` : "گردش‌کار جدید", [body], [mkBtn("انصراف", () => center.closeModal()), save]);
    box.classList.add("ow-modal-wide");
  };

  const simulate = (workflow, meta) => {
    const run = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "اجرای آزمایشی" });
    run.addEventListener("click", async () => {
      run.disabled = true;
      try {
        const res = await api(`/admin/automation/${encodeURIComponent(workflow.id)}/simulate`, { method: "POST", body: { confirm: true } });
        center.closeModal();
        setTimeout(() => {
          const rows = (res.actions || []).map((action) => [
            meta.actions[action.type]?.label || action.type,
            ACTION_STATUS_LABELS[action.status] || action.status,
            action.note || "—"
          ]);
          center.showModal("نتیجهٔ آزمایش", [
            el("p", { class: "ohint", text: res.matched ? "رویداد نمونه با شرط‌ها منطبق بود. اقدام‌ها فقط آزمایشی (بدون اثر واقعی) اجرا شدند." : "رویداد نمونه با شرط‌ها منطبق نبود؛ اقدامی اجرا نشد." }),
            table(["اقدام", "وضعیت", "توضیح"], rows)
          ], [mkBtn("بستن", () => center.closeModal())]);
        }, 0);
      } catch (err) {
        toast(err.message || "آزمایش اجرا نشد.", "error");
        run.disabled = false;
      }
    });
    center.showModal("آزمایش گردش‌کار", [
      el("p", { class: "ohint", text: `یک رویداد نمونه برای «${meta.triggers[workflow.trigger] || workflow.trigger}» ساخته می‌شود. اجرا آزمایشی است و اعلان/ایمیلی نمی‌فرستد.` })
    ], [mkBtn("انصراف", () => center.closeModal()), run]);
  };

  const toggle = async (workflow) => {
    try {
      await api(`/admin/automation/${encodeURIComponent(workflow.id)}`, { method: "PATCH", body: { enabled: !workflow.enabled } });
      toast(workflow.enabled ? "گردش‌کار خاموش شد." : "گردش‌کار روشن شد.");
      reload();
    } catch (err) {
      toast(err.message || "تغییر نکرد.", "error");
    }
  };

  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const data = await api("/admin/automation");
      const meta = data.runner || { triggers: {}, actions: {} };
      const workflows = data.workflows || [];
      const runs = data.runs || [];
      const view = el("div", { class: "og-page" });
      const grid = el("div", { class: "stat-grid" });
      grid.append(
        statCard("گردش‌کارها", workflows.length.toLocaleString("fa-IR"), `${workflows.filter((w) => w.enabled).length.toLocaleString("fa-IR")} فعال`),
        statCard("اقدام‌های تعریف‌شده", workflows.reduce((sum, w) => sum + (w.actions || []).length, 0).toLocaleString("fa-IR"), "روی همهٔ گردش‌کارها"),
        statCard("اجراهای اخیر", runs.length.toLocaleString("fa-IR"), "۲۵ اجرای آخر"),
        statCard("اجراهای ناموفق", runs.filter((r) => r.status === "failed").length.toLocaleString("fa-IR"), "در اجراهای اخیر")
      );
      const bar = el("div", { class: "ow-toolbar" });
      bar.append(
        mkBtn("+ گردش‌کار جدید", () => openEditor(null, meta), "btn btn-primary btn-sm"),
        mkBtn("تاریخچهٔ اجراها", () => openRuns(meta)),
        mkBtn("تازه‌سازی", reload)
      );
      view.append(grid, card("موتور خودکارسازی", "محرک‌ها و اقدام‌ها از فهرست مجاز انتخاب می‌شوند و همین سرور آن‌ها را با رعایت مجوز اجرا می‌کند. اجرای هر رویداد در تاریخچه ثبت می‌شود و اجرای ناموفق دو بار تلاش می‌کند."), bar);
      view.append(table(
        ["نام", "محرک", "شرط", "اقدام", "فعال", "آخرین اجرا", "خطا", "اقدام"],
        workflows.map((w) => [
          el("div", {}, [el("strong", { text: w.name }), w.description ? el("small", { text: w.description }) : null]),
          el("code", { dir: "ltr", text: w.trigger }),
          String((w.conditions?.rules || []).length),
          String((w.actions || []).length),
          w.enabled ? tag("فعال") : tag("خاموش", "warn"),
          w.lastRunAt ? el("span", {}, [tag(RUN_STATUS_LABELS[w.lastStatus] || w.lastStatus || "—", w.lastStatus === "failed" ? "bad" : "ok"), el("small", { text: fmtDate(w.lastRunAt) })]) : "—",
          String(w.errorCount || 0),
          el("div", { class: "og-actions" }, [
            mkBtn("ویرایش", () => openEditor(w, meta)),
            mkBtn(w.enabled ? "خاموش" : "روشن", () => toggle(w)),
            mkBtn("آزمایش", () => simulate(w, meta))
          ])
        ])
      ));
      view.append(el("h3", { class: "ow-h3", text: "اجراهای اخیر" }));
      view.append(table(
        ["گردش‌کار", "محرک", "وضعیت", "تلاش", "مدت", "شروع", "خطا", "اقدام"],
        runs.map(runRow)
      ));
      section.replaceChildren(view);
    } catch (err) {
      failure(section, err, reload);
    }
  };
  reload();
}

function renderBroadcast(section, center) {
  const view = el("div", { class: "og-page" });
  const title = textInput({ maxlength: "160" });
  const text = el("textarea", { rows: "4", maxlength: "600" });
  const audience = optionsSelect([["all", "همهٔ کاربران فعال"], ["role", "یک نقش مشخص"]], "all");
  const role = optionsSelect(Object.entries(ROLE_LABELS), "member");
  const link = textInput({ dir: "ltr", placeholder: "profile.html#planCard" });
  const result = el("p", { class: "ohint", text: "" });
  role.disabled = true;
  audience.addEventListener("change", () => { role.disabled = audience.value !== "role"; });

  const send = mkBtn("ارسال اعلان", () => {
    if (!title.value.trim()) return toast("عنوان لازم است.", "error");
    const ok = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "ارسال کن" });
    ok.addEventListener("click", async () => {
      ok.disabled = true;
      try {
        const res = await api("/admin/notifications/broadcast", {
          method: "POST",
          body: {
            title: title.value.trim(),
            body: text.value.trim(),
            audience: audience.value,
            role: audience.value === "role" ? role.value : "",
            link: link.value.trim(),
            confirm: true
          }
        });
        result.textContent = `برای ${res.delivered} کاربر ثبت شد. ${res.note || ""}`;
        toast("اعلان ارسال شد.");
        center.closeModal();
      } catch (err) {
        toast(err.message || "ارسال نشد.", "error");
        ok.disabled = false;
        return;
      }
      section.querySelector(".ow-modal-back")?.remove();
    });
    center.showModal("تایید ارسال اعلان", [
      el("p", { class: "ohint", text: `اعلان برای ${audience.value === "role" ? ROLE_LABELS[role.value] : "همهٔ کاربران فعال"} ارسال می‌شود و در مرکز اعلان همه دیده می‌شود.` })
    ], [mkBtn("انصراف", () => center.closeModal()), ok]);
  });

  view.append(card("اعلان همگانی", "ارسال اعلان داخل‌برنامه‌ای به همه یا یک نقش. ارسال دوبارهٔ متن یکسان در شش ساعت تکرار نمی‌شود."));
  view.append(formGrid(field("عنوان", title), field("مخاطب", audience), field("نقش", role), field("لینک (اختیاری)", link), field("متن", text, "span2")));
  view.append(el("div", { class: "ow-toolbar" }, [send]), result);
  section.replaceChildren(view);
}

/* ---------------- install ---------------- */

export function installGodPages(center) {
  const defs = [
    { id: "platform", view: "platform", label: "نمای پلتفرم", icon: "◉", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "نمای پلتفرم", sub: "وضعیت زندهٔ کاربران، اتاق‌ها، پیام‌ها، درآمد و سلامت سرویس‌ها.", keywords: "overview server پلتفرم" },
    { id: "accounts", view: "accounts", label: "حساب‌های سرور", icon: "☰", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "حساب‌های سرور", sub: "همهٔ کاربران واقعی با تغییر نقش و وضعیت.", keywords: "users accounts کاربران" },
    { id: "serRooms", view: "serRooms", label: "اتاق‌های سرور", icon: "▤", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "اتاق‌های سرور", sub: "لابی‌ها و اتاق‌های فعال همراه با ظرفیت و تعداد پیام.", keywords: "rooms servers channels اتاق" },
    { id: "serMessages", view: "serMessages", label: "پیام‌های سرور", icon: "✉", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "پیام‌های سرور", sub: "جستجو و مرور پیام‌های ذخیره‌شده.", keywords: "messages پیام" },
    { id: "serReports", view: "serReports", label: "گزارش‌های سرور", icon: "⚑", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "گزارش‌های سرور", sub: "پیام‌های گزارش‌شده و وضعیت رسیدگی.", keywords: "reports گزارش" },
    { id: "serFinance", view: "serFinance", label: "مالی سرور", icon: "₿", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "مالی سرور", sub: "درآمد، سفارش‌ها، اشتراک‌ها و پلن‌های واقعی.", keywords: "payments finance مالی" },
    { id: "billingAdmin", view: "billingAdmin", label: "اشتراک و پرداخت", icon: "◭", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "پلن، تخفیف و پرداخت", sub: "ساخت پلن، کد تخفیف، تایید پرداخت، بازگشت وجه و مدیریت اشتراک بدون تغییر سورس.", keywords: "plans coupons subscriptions billing پرداخت پلن تخفیف اشتراک" },
    { id: "godRoles", view: "godRoles", label: "نقش و مجوز", icon: "⛨", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "نقش‌ها و محدودیت‌ها", sub: "مجوزهای هر نقش، تعلیق‌ها و رفع مسدودی با ثبت رویداد.", keywords: "roles permissions restrictions نقش مجوز محدودیت" },
    { id: "support", view: "support", label: "صف پشتیبانی", icon: "☏", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "صف پشتیبانی", sub: "اولویت‌بندی، ارجاع و حل تیکت‌های پشتیبانی.", keywords: "support tickets پشتیبانی تیکت" },
    { id: "godPages", view: "godPages", label: "سازندهٔ صفحه", icon: "▥", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "سازندهٔ صفحه‌های سایت", sub: "ساخت و ویرایش صفحه با بلوک‌های امن، پیش‌نمایش زنده، انتشار، زمان‌بندی، نسخه‌ها و فرم‌ها.", keywords: "pages cms builder صفحه محتوا ساخت" },
    { id: "godAutomation", view: "godAutomation", label: "خودکارسازی", icon: "⟳", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "خودکارسازی", sub: "محرک، شرط و اقدام واقعی روی سرور؛ تاریخچهٔ اجرا، خطاها و تلاش دوباره.", keywords: "automation workflow خودکار گردش" },
    { id: "broadcast", view: "broadcast", label: "اعلان همگانی", icon: "◍", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "اعلان همگانی", sub: "ارسال اعلان داخل‌برنامه‌ای به همه یا یک نقش.", keywords: "notifications broadcast اعلان اطلاع" },
    { id: "serAnalytics", view: "serAnalytics", label: "آمار و گزارش", icon: "◔", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "آمار و گزارش", sub: "گزارش واقعی ثبت‌نام، فعالیت، درآمد، پشتیبانی، تخلف، ذخیره‌سازی و سیستم با بازهٔ زمانی و خروجی CSV.", keywords: "analytics report آمار گزارش" },
    { id: "governance", view: "governance", label: "کنترل قابلیت‌ها", icon: "◧", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "کنترل قابلیت‌ها", sub: "روشن/خاموش با دامنهٔ سراسری، کاربر، نقش، سرور، اتاق و پلن؛ همراه وابستگی، زمان‌بندی و تاریخچه.", keywords: "features flags قابلیت کنترل" },
    { id: "siteSettings", view: "siteSettings", label: "تنظیمات سایت", icon: "⚙", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "تنظیمات سایت", sub: "برندینگ، ظاهر، اتاق، چت، پخش، امنیت و پرداخت؛ ذخیرهٔ مستقیم روی سرور.", keywords: "settings configuration تنظیمات" },
    { id: "vault", view: "vault", label: "داده و پشتیبان", icon: "⛁", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "داده و پشتیبان", sub: "سلامت پایگاه داده، جدول‌ها، پشتیبان‌گیری، خروجی و پاک‌سازی قدیمی‌ها.", keywords: "storage backup storage ذخیره" },
    { id: "godFiles", view: "godFiles", label: "فایل و فضا", icon: "⛃", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "فایل و فضای ذخیره‌سازی", sub: "پایش مصرف و سهمیه، مرور فایل‌های بارگذاری‌شده، حذف و پاک‌سازی فایل‌های رهاشده.", keywords: "files uploads storage فایل آپلود فضا" },
    { id: "serverAudit", view: "serverAudit", label: "رویدادهای سرور", icon: "≡", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "رویدادهای سرور", sub: "گزارش کامل اقدامات مدیریتی سرور.", keywords: "audit log رویداد" }
  ];
  for (const def of defs) {
    const renderer = {
      platform: (section) => renderPlatform(section, center),
      accounts: (section) => renderAccounts(section, center),
      serRooms: (section) => renderServerRooms(section, center),
      serMessages: (section) => renderServerMessages(section),
      serReports: (section) => renderServerReports(section, center),
      serFinance: (section) => renderServerFinance(section),
      billingAdmin: (section) => renderBillingAdmin(section, center),
      godRoles: (section) => renderRoles(section, center),
      support: (section) => renderSupport(section, center),
      godPages: (section) => renderPages(section, center),
      godAutomation: (section) => renderAutomation(section, center),      broadcast: (section) => renderBroadcast(section, center),
      serAnalytics: (section) => renderServerAnalytics(section),
      governance: (section) => renderGovernance(section, center),
      siteSettings: (section) => renderSiteSettings(section),
      vault: (section) => renderVault(section),
      godFiles: (section) => renderFiles(section, center),
      serverAudit: (section) => renderServerAudit(section)
    }[def.id];
    center.registerPage(def, renderer);
  }
}
