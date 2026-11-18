import { el, toast } from "./core.js";
import { apiFetch, ApiError } from "./api.js";
import { barChart } from "./charts.js";

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

const accountsState = { q: "", role: "", status: "", before: 0, users: [], more: true };

function renderAccounts(section) {
  section.replaceChildren();
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
      load();
    });
    bar.append(q, role, status, apply);

    const body = el("div");
    const moreWrap = el("div", { class: "ow-toolbar" });
    const more = el("button", { class: "mini-btn", type: "button", text: "نمایش بیشتر" });
    more.addEventListener("click", loadMore);
    moreWrap.append(more);

    view.append(
      card("حساب‌های سرور", "نقش و وضعیت را مستقیم عوض کن؛ تغییرها فوری روی دسترسی همان لحظه اثر می‌گذارند."),
      bar,
      body,
      moreWrap
    );
    section.replaceChildren(view);
    paintTable();
  };

  const paintTable = () => {
    const body = section.querySelector(".og-page > div:nth-of-type(2)");
    if (!body) return;
    body.replaceChildren(table(
      ["کاربر", "نقش", "وضعیت", "آخرین ورود", "عضویت"],
      accountsState.users.map((u) => {
        const roleSel = el("select", { class: "ow-perm-select" });
        for (const [id, label] of Object.entries(ROLE_LABELS)) roleSel.append(el("option", { value: id, text: label }));
        roleSel.value = u.role;
        roleSel.addEventListener("change", () => patchUser(u, { role: roleSel.value }, roleSel));
        const statusSel = el("select", { class: "ow-perm-select" });
        for (const [id, label] of Object.entries(STATUS_LABELS)) statusSel.append(el("option", { value: id, text: label }));
        statusSel.value = u.status || "active";
        statusSel.addEventListener("change", () => patchUser(u, { status: statusSel.value }, statusSel));
        return [
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

function renderServerRooms(section) {
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
        ["کد اتاق", "نام", "اعضا", "فعال", "آخرین فعالیت"],
        (data.rooms || []).map((r) => [r.room_code || r.roomCode, r.name, String(r.member_count ?? 0), r.is_active ? "بله" : "خیر", fmtDate(r.last_activity_at)])
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

function renderServerReports(section) {
  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const data = await api("/admin/reports");
      const view = el("div", { class: "og-page" });
      const bar = el("div", { class: "ow-toolbar" });
      const refresh = el("button", { class: "mini-btn", type: "button", text: "تازه‌سازی" });
      refresh.addEventListener("click", reload);
      bar.append(refresh);
      view.append(card("گزارش‌های کاربران", "پیام‌های گزارش‌شده به‌همراه وضعیت رسیدگی."), bar);
      view.append(table(
        ["وضعیت", "دلیل", "پیام", "گزارش‌دهنده", "اتاق", "زمان"],
        (data.reports || []).map((r) => [
          r.status === "open" ? tag("باز", "warn") : tag(r.status === "reviewed" ? "بررسی‌شده" : "رد‌شده"),
          r.reason || "—",
          String(r.message || "").slice(0, 120),
          r.reporter || "—",
          r.room || "—",
          fmtDate(r.createdAt)
        ])
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
  const reload = async () => {
    section.replaceChildren(loading());
    try {
      const data = await api("/admin/analytics");
      const view = el("div", { class: "og-page" });
      const grid = el("div", { class: "stat-grid" });
      grid.append(
        statCard("کاربران کل", data.totals?.users ?? 0, "بدون حساب‌های حذف‌شده"),
        statCard("ورودهای امروز", data.totals?.sessionsToday ?? 0, "نشست تازه"),
        statCard("پیام‌های امروز", data.totals?.messagesToday ?? 0, "از نیمه‌شب")
      );
      const chart = card("ثبت‌نام ۱۴ روز اخیر", "روند روزانهٔ ساخت حساب.");
      const chartBox = el("div", { class: "og-chart" });
      const sLabels = (data.signups || []).map((d) => String(d.date).slice(5));
      chartBox.append(barChart({ labels: sLabels, values: (data.signups || []).map((d) => d.value), color: "#3d6bff" }));
      chart.append(chartBox);
      const msgChart = card("پیام‌های ۱۴ روز اخیر", "فعالیت گفتگو در سرور.");
      const msgBox = el("div", { class: "og-chart" });
      msgBox.append(barChart({ labels: sLabels, values: (data.messages || []).map((d) => d.value), color: "#f5b23e" }));
      msgChart.append(msgBox);
      view.append(grid, chart, msgChart);
      if ((data.events || []).length) {
        view.append(el("h3", { class: "ow-h3", text: "رویدادهای پرتکرار" }), table(
          ["رویداد", "تعداد"],
          data.events.map((e) => [e.event, String(e.n)])
        ));
      }
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

/* ---------------- install ---------------- */

export function installGodPages(center) {
  const defs = [
    { id: "platform", view: "platform", label: "نمای پلتفرم", icon: "◉", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "نمای پلتفرم", sub: "وضعیت زندهٔ کاربران، اتاق‌ها، پیام‌ها، درآمد و سلامت سرویس‌ها.", keywords: "overview server پلتفرم" },
    { id: "accounts", view: "accounts", label: "حساب‌های سرور", icon: "☰", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "حساب‌های سرور", sub: "همهٔ کاربران واقعی با تغییر نقش و وضعیت.", keywords: "users accounts کاربران" },
    { id: "serRooms", view: "serRooms", label: "اتاق‌های سرور", icon: "▤", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "اتاق‌های سرور", sub: "لابی‌ها و اتاق‌های فعال همراه با ظرفیت و تعداد پیام.", keywords: "rooms servers channels اتاق" },
    { id: "serMessages", view: "serMessages", label: "پیام‌های سرور", icon: "✉", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "پیام‌های سرور", sub: "جستجو و مرور پیام‌های ذخیره‌شده.", keywords: "messages پیام" },
    { id: "serReports", view: "serReports", label: "گزارش‌های سرور", icon: "⚑", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "گزارش‌های سرور", sub: "پیام‌های گزارش‌شده و وضعیت رسیدگی.", keywords: "reports گزارش" },
    { id: "serFinance", view: "serFinance", label: "مالی سرور", icon: "₿", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "مالی سرور", sub: "درآمد، سفارش‌ها، اشتراک‌ها و پلن‌های واقعی.", keywords: "payments finance مالی" },
    { id: "serAnalytics", view: "serAnalytics", label: "آمار سرور", icon: "◔", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "آمار سرور", sub: "روند ثبت‌نام و پیام ۱۴ روز اخیر از پایگاه داده.", keywords: "analytics آمار" },
    { id: "governance", view: "governance", label: "کنترل قابلیت‌ها", icon: "◧", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "کنترل قابلیت‌ها", sub: "روشن/خاموش با دامنهٔ سراسری، کاربر، نقش، سرور، اتاق و پلن؛ همراه وابستگی، زمان‌بندی و تاریخچه.", keywords: "features flags قابلیت کنترل" },
    { id: "siteSettings", view: "siteSettings", label: "تنظیمات سایت", icon: "⚙", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "تنظیمات سایت", sub: "برندینگ، ظاهر، اتاق، چت، پخش، امنیت و پرداخت؛ ذخیرهٔ مستقیم روی سرور.", keywords: "settings configuration تنظیمات" },
    { id: "vault", view: "vault", label: "داده و پشتیبان", icon: "⛁", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "داده و پشتیبان", sub: "سلامت پایگاه داده، جدول‌ها، پشتیبان‌گیری، خروجی و پاک‌سازی قدیمی‌ها.", keywords: "storage backup storage ذخیره" },
    { id: "serverAudit", view: "serverAudit", label: "رویدادهای سرور", icon: "≡", group: GOD_GROUP, groupLabel: "کنترل سرور", title: "رویدادهای سرور", sub: "گزارش کامل اقدامات مدیریتی سرور.", keywords: "audit log رویداد" }
  ];
  for (const def of defs) {
    const renderer = {
      platform: (section) => renderPlatform(section, center),
      accounts: (section) => renderAccounts(section),
      serRooms: (section) => renderServerRooms(section),
      serMessages: (section) => renderServerMessages(section),
      serReports: (section) => renderServerReports(section),
      serFinance: (section) => renderServerFinance(section),
      serAnalytics: (section) => renderServerAnalytics(section),
      governance: (section) => renderGovernance(section, center),
      siteSettings: (section) => renderSiteSettings(section),
      vault: (section) => renderVault(section),
      serverAudit: (section) => renderServerAudit(section)
    }[def.id];
    center.registerPage(def, renderer);
  }
}
