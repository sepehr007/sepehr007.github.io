import { ENTITLEMENTS, normalizeEntitlements, UNLIMITED } from "./entitlements.js";

const STORE_KEY = "wt.billing";
const VERSION = 1;

export const CURRENCIES = {
  IRT: { id: "IRT", label: "تومان", fa: "تومان", en: "Toman", decimals: 0 },
  USD: { id: "USD", label: "دلار", fa: "دلار", en: "USD", decimals: 2 }
};

export const PLAN_STATUSES = {
  draft: "پیش‌نویس",
  published: "منتشرشده",
  disabled: "غیرفعال",
  archived: "بایگانی",
  deleted: "حذف‌شده"
};

export const BILLING_CYCLES = [
  { id: "monthly", label: "ماهانه", months: 1 },
  { id: "yearly", label: "سالانه", months: 12 },
  { id: "lifetime", label: "مادام‌العمر", months: 0 },
  { id: "custom", label: "دورهٔ سفارشی", months: 0 }
];

export const PAYMENT_STATUSES = {
  pending: "در انتظار",
  paid: "پرداخت‌شده",
  failed: "ناموفق",
  refunded: "بازگشت‌خورده",
  void: "باطل"
};

export const SUB_STATUSES = {
  trialing: "دورهٔ آزمایشی",
  active: "فعال",
  past_due: "پرداخت معوق",
  grace: "مهلت پرداخت",
  canceled: "لغوشده",
  expired: "منقضی"
};

export const SUB_ACTIONS = {
  activate: { label: "فعال‌سازی دستی", from: ["trialing", "past_due", "grace", "canceled", "expired"] },
  renew: { label: "تمدید", from: ["active", "past_due", "grace", "canceled", "expired"] },
  cancel: { label: "لغو", from: ["trialing", "active", "past_due", "grace"] },
  reactivate: { label: "بازفعال‌سازی", from: ["canceled", "expired", "grace"], needsPlan: false },
  expire: { label: "انقضا", from: ["trialing", "active", "past_due", "grace", "canceled"] },
  mark_past_due: { label: "ثبت پرداخت ناموفق", from: ["trialing", "active", "past_due"] },
  start_grace: { label: "شروع مهلت", from: ["past_due", "active"] },
  upgrade: { label: "ارتقا", from: ["trialing", "active", "past_due", "grace"], needsPlan: true },
  downgrade: { label: "تنزل", from: ["trialing", "active", "past_due", "grace"], needsPlan: true },
  override: { label: "بازنویسی دستی", from: ["trialing", "active", "past_due", "grace", "canceled", "expired"] }
};

const DAY = 86400000;

/* ---------------- storage ---------------- */

function readRaw() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

function normalizeStore(raw) {
  return {
    version: VERSION,
    coupons: Array.isArray(raw.coupons) ? raw.coupons : [],
    subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
    payments: Array.isArray(raw.payments) ? raw.payments : [],
    events: Array.isArray(raw.events) ? raw.events : [],
    providers: raw.providers && typeof raw.providers === "object" ? raw.providers : {},
    overrides: raw.overrides && typeof raw.overrides === "object" ? raw.overrides : {},
    counters: raw.counters && typeof raw.counters === "object" ? raw.counters : { invoice: 1000 }
  };
}

export function readBilling() {
  return normalizeStore(readRaw());
}

export function writeBilling(patch) {
  const next = { ...readBilling(), ...(patch || {}) };
  next.version = VERSION;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch {}
  return next;
}

export function clearBilling() {
  try { localStorage.removeItem(STORE_KEY); } catch {}
}

function pushEvent(store, event) {
  const events = Array.isArray(store.events) ? store.events.slice() : [];
  events.unshift({ at: event.at || Date.now(), actor: event.actor || "owner", ...event });
  return { ...store, events: events.slice(0, 1000) };
}

export function logBillingEvent(event) {
  const store = pushEvent(readBilling(), event);
  writeBilling(store);
}

/* ---------------- plans ---------------- */

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function slugify(value, fallback = "") {
  const base = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || fallback || uid("plan");
}

export function emptyPlan(overrides = {}) {
  const now = Date.now();
  return {
    id: uid("plan"),
    name: "پلن جدید",
    slug: "",
    description: "",
    icon: "✦",
    color: "#3d6bff",
    order: 0,
    visibility: "hidden",
    status: "draft",
    badge: "",
    popular: false,
    recommended: false,
    ctaUrl: "",
    prices: { monthly: 0, yearly: 0, lifetime: 0, custom: { label: "", days: 30, amount: 0 } },
    trialDays: 0,
    graceDays: 3,
    setupFee: 0,
    originalPrice: 0,
    discountPercent: 0,
    promoPrice: 0,
    promoStart: "",
    promoEnd: "",
    entitlements: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

export function normalizePlan(raw, index = 0) {
  const plan = emptyPlan();
  const src = raw && typeof raw === "object" ? raw : {};
  const prices = src.prices && typeof src.prices === "object" ? src.prices : {};
  const custom = prices.custom && typeof prices.custom === "object" ? prices.custom : {};
  const merged = {
    ...plan,
    ...src,
    id: String(src.id || plan.id),
    slug: String(src.slug || "").trim(),
    prices: {
      monthly: money(prices.monthly ?? src.monthlyPrice ?? src.priceMonthly),
      yearly: money(prices.yearly ?? src.yearlyPrice ?? src.priceYearly),
      lifetime: money(prices.lifetime ?? src.lifetimePrice ?? src.priceLifetime),
      custom: { label: String(custom.label || src.customCycleLabel || ""), days: money(custom.days ?? src.customCycleDays ?? 30), amount: money(custom.amount ?? src.customCyclePrice) }
    },
    order: Number.isFinite(Number(src.order)) ? Number(src.order) : index,
    visibility: src.visibility === "public" ? "public" : "hidden",
    status: Object.prototype.hasOwnProperty.call(PLAN_STATUSES, src.status) ? src.status : (src.archived ? "archived" : (src.visibility === "public" ? "published" : "draft")),
    trialDays: money(src.trialDays),
    graceDays: money(src.graceDays),
    setupFee: money(src.setupFee),
    originalPrice: money(src.originalPrice),
    discountPercent: Math.min(100, money(src.discountPercent)),
    promoPrice: money(src.promoPrice),
    entitlements: normalizeEntitlements(src.entitlements || src.limits || {}),
    popular: Boolean(src.popular),
    recommended: Boolean(src.recommended),
    badge: String(src.badge || "").slice(0, 24),
    color: /^#[0-9a-f]{6}$/i.test(String(src.color || "")) ? src.color : plan.color,
    icon: String(src.icon || plan.icon).slice(0, 8)
  };
  merged.slug = merged.slug || slugify(merged.name, merged.id);
  return merged;
}

export function migrateLegacyPlan(raw, index = 0) {
  const legacy = raw && typeof raw === "object" ? raw : {};
  const benefits = Array.isArray(legacy.benefits) ? legacy.benefits.filter(Boolean) : [];
  return normalizePlan({
    id: legacy.id,
    name: legacy.name || "پریمیوم",
    description: [legacy.description, ...benefits].filter(Boolean).join(" • "),
    order: index,
    visibility: legacy.visibility === "public" ? "public" : "hidden",
    status: legacy.archived ? "archived" : "draft",
    prices: { monthly: 0, yearly: 0, lifetime: 0 },
    entitlements: {
      "room.max": Number.isFinite(Number(legacy.rooms)) ? Number(legacy.rooms) : UNLIMITED,
      "room.maxParticipants": Number.isFinite(Number(legacy.members)) ? Number(legacy.members) : 24,
      "storage.quotaMb": Number.isFinite(Number(legacy.storageMb)) ? Number(legacy.storageMb) : 0
    },
    createdAt: legacy.createdAt || Date.now()
  }, index);
}

export function sortPlans(plans) {
  return [...plans].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name), "fa"));
}

export function reindexPlans(plans) {
  return sortPlans(plans).map((plan, index) => ({ ...plan, order: index }));
}

export function publicPricingPlans(plans) {
  return sortPlans((plans || []).map(normalizePlan).filter((p) => p.status === "published" && p.visibility === "public"));
}

export function validatePlan(plan, all = []) {
  const errors = [];
  if (!String(plan.name || "").trim()) errors.push("نام پلن لازم است.");
  const slug = String(plan.slug || "").trim();
  if (!slug) errors.push("شناسهٔ یکتا (slug) لازم است.");
  else if (all.some((p) => p.id !== plan.id && p.slug === slug && p.status !== "deleted")) errors.push("این slug قبلاً استفاده شده است.");
  const prices = plan.prices || {};
  if (![prices.monthly, prices.yearly, prices.lifetime].some((v) => Number(v) > 0) && Number(prices.custom?.amount) <= 0) {
    errors.push("حداقل یکی از قیمت‌ها باید بزرگ‌تر از صفر باشد.");
  }
  if (Number(plan.discountPercent) > 0 && Number(plan.discountPercent) > 100) errors.push("درصد تخفیف معتبر نیست.");
  return { ok: errors.length === 0, errors };
}

export function promoWindowActive(plan, now = Date.now()) {
  const start = plan.promoStart ? Date.parse(plan.promoStart) : 0;
  const end = plan.promoEnd ? Date.parse(plan.promoEnd) : 0;
  if (start && Number.isFinite(start) && now < start) return false;
  if (end && Number.isFinite(end) && now > end) return false;
  return true;
}

export function basePriceFor(plan, cycle) {
  const prices = plan?.prices || {};
  if (cycle === "yearly") return Number(prices.yearly) || 0;
  if (cycle === "lifetime") return Number(prices.lifetime) || 0;
  if (cycle === "custom") return Number(prices.custom?.amount) || 0;
  return Number(prices.monthly) || 0;
}

export function effectivePrice(plan, cycle, now = Date.now()) {
  const base = basePriceFor(plan, cycle);
  const result = { amount: base, original: base, discountPercent: 0, promo: false };
  if (!promoWindowActive(plan, now)) return result;
  if (Number(plan.promoPrice) > 0 && Number(plan.promoPrice) < base) {
    result.amount = Number(plan.promoPrice);
    result.promo = true;
    result.discountPercent = base ? Math.round((1 - result.amount / base) * 100) : 0;
    return result;
  }
  if (Number(plan.discountPercent) > 0) {
    result.amount = Math.round(base * (1 - Number(plan.discountPercent) / 100));
    result.discountPercent = Number(plan.discountPercent);
    result.promo = true;
  }
  return result;
}

export function planCycleAmount(plan, cycle, now = Date.now()) {
  return effectivePrice(plan, cycle, now).amount;
}

export function planMonthlyEquivalent(sub, plan, now = Date.now()) {
  if (!plan) return 0;
  if (sub.cycle === "lifetime") return 0;
  if (sub.cycle === "yearly") return Math.round(planCycleAmount(plan, "yearly", now) / 12);
  if (sub.cycle === "custom") {
    const days = Number(plan.prices?.custom?.days) || 30;
    return Math.round((planCycleAmount(plan, "custom", now) * 30) / Math.max(1, days));
  }
  return planCycleAmount(plan, "monthly", now);
}

/* ---------------- coupons ---------------- */

export function normalizeCoupon(raw = {}) {
  const type = raw.type === "fixed" ? "fixed" : "percent";
  return {
    id: raw.id || uid("coupon"),
    code: String(raw.code || "").trim().toUpperCase().slice(0, 24),
    type,
    value: Math.max(0, Number(raw.value) || 0),
    maxUses: Math.max(0, Number(raw.maxUses) || 0),
    perUserLimit: Math.max(0, Number(raw.perUserLimit) || 0),
    usedCount: Math.max(0, Number(raw.usedCount) || 0),
    minAmount: Math.max(0, Number(raw.minAmount) || 0),
    startsAt: String(raw.startsAt || ""),
    expiresAt: String(raw.expiresAt || ""),
    planIds: Array.isArray(raw.planIds) ? raw.planIds.map(String) : [],
    status: raw.status === "disabled" ? "disabled" : "active",
    affiliate: String(raw.affiliate || "").slice(0, 60),
    createdAt: raw.createdAt || Date.now()
  };
}

export function validateCoupon(coupon, { planId = "", amount = 0, now = Date.now() } = {}) {
  if (!coupon) return { ok: false, reason: "کد یافت نشد." };
  const c = normalizeCoupon(coupon);
  if (c.status !== "active") return { ok: false, reason: "این کد غیرفعال است." };
  const start = c.startsAt ? Date.parse(c.startsAt) : 0;
  const end = c.expiresAt ? Date.parse(c.expiresAt) : 0;
  if (start && Number.isFinite(start) && now < start) return { ok: false, reason: "کد هنوز فعال نشده است." };
  if (end && Number.isFinite(end) && now > end) return { ok: false, reason: "کد منقضی شده است." };
  if (c.maxUses > 0 && c.usedCount >= c.maxUses) return { ok: false, reason: "ظرفیت استفاده از کد تکمیل شده است." };
  if (c.planIds.length && planId && !c.planIds.includes(planId)) return { ok: false, reason: "این کد برای این پلن معتبر نیست." };
  if (c.minAmount > 0 && Number(amount) < c.minAmount) return { ok: false, reason: "مبلغ سفارش از حداقل کد کمتر است." };
  if (c.type === "percent" && c.value > 100) return { ok: false, reason: "درصد تخفیف معتبر نیست." };
  const discount = c.type === "percent" ? Math.round(Number(amount) * c.value / 100) : Math.min(Number(amount), c.value);
  return { ok: true, discount, final: Math.max(0, Number(amount) - discount), coupon: c };
}

/* ---------------- subscriptions ---------------- */

function periodEndFor(cycle, from, plan) {
  const start = Number(from) || Date.now();
  if (cycle === "lifetime") return 0;
  if (cycle === "yearly") return start + 365 * DAY;
  if (cycle === "custom") return start + (Number(plan?.prices?.custom?.days) || 30) * DAY;
  return start + 30 * DAY;
}

export function createSubscription({ userKey, plan, cycle = "monthly", actor = "owner", now = Date.now(), overrides = {} }) {
  const status = Number(plan?.trialDays) > 0 ? "trialing" : "active";
  const trialEndsAt = status === "trialing" ? now + Number(plan.trialDays) * DAY : 0;
  return {
    id: uid("sub"),
    userKey: String(userKey || "").trim(),
    planId: plan.id,
    planName: plan.name,
    cycle,
    status,
    amount: planCycleAmount(plan, cycle, now),
    startedAt: now,
    trialEndsAt,
    currentPeriodEnd: status === "trialing" ? trialEndsAt : periodEndFor(cycle, now, plan),
    graceEndsAt: 0,
    canceledAt: 0,
    cancelReason: "",
    overrides,
    history: [{ at: now, action: "create", from: "", to: status, actor, note: "ایجاد دستی" }],
    createdAt: now,
    updatedAt: now
  };
}

export function applySubscriptionAction(sub, action, opts = {}) {
  const meta = SUB_ACTIONS[action];
  const now = Number(opts.now) || Date.now();
  if (!meta) return { ok: false, reason: "اقدام ناشناخته است." };
  if (!meta.from.includes(sub.status)) return { ok: false, reason: `از وضعیت «${SUB_STATUSES[sub.status] || sub.status}» این اقدام مجاز نیست.` };
  if (meta.needsPlan && !opts.plan) return { ok: false, reason: "پلن مقصد را انتخاب کن." };

  const plan = opts.plan || null;
  const next = { ...sub, history: Array.isArray(sub.history) ? sub.history.slice() : [] };
  const record = (to, note = "") => {
    next.history.push({ at: now, action, from: sub.status, to, actor: opts.actor || "owner", note });
    next.status = to;
    next.updatedAt = now;
  };

  if (action === "activate") {
    next.currentPeriodEnd = Math.max(Number(next.currentPeriodEnd) || 0, periodEndFor(next.cycle, now, plan || next.planMeta));
    record("active", opts.note || "فعال‌سازی دستی توسط مالک");
  } else if (action === "renew") {
    const base = Math.max(now, Number(next.currentPeriodEnd) || 0);
    next.currentPeriodEnd = periodEndFor(next.cycle, base, plan || next.planMeta);
    next.graceEndsAt = 0;
    record("active", opts.note || "تمدید دستی");
  } else if (action === "cancel") {
    next.canceledAt = now;
    next.cancelReason = String(opts.note || "").slice(0, 120);
    record("canceled", opts.note || "لغو دستی");
  } else if (action === "reactivate") {
    next.canceledAt = 0;
    next.cancelReason = "";
    if (!next.currentPeriodEnd || next.currentPeriodEnd < now) next.currentPeriodEnd = periodEndFor(next.cycle, now, plan || next.planMeta);
    record("active", opts.note || "بازفعال‌سازی");
  } else if (action === "expire") {
    record("expired", opts.note || "انقضای دستی");
  } else if (action === "mark_past_due") {
    record("past_due", opts.note || "پرداخت ناموفق");
  } else if (action === "start_grace") {
    next.graceEndsAt = now + Math.max(0, Number(opts.graceDays ?? 3)) * DAY;
    record("grace", opts.note || "مهلت پرداخت");
  } else if (action === "upgrade" || action === "downgrade") {
    next.prevPlanId = sub.planId;
    next.planId = plan.id;
    next.planName = plan.name;
    next.amount = planCycleAmount(plan, next.cycle, now);
    next.currentPeriodEnd = periodEndFor(next.cycle, now, plan);
    record("active", opts.note || `${meta.label} به ${plan.name}`);
  } else if (action === "override") {
    next.overrides = { ...(next.overrides || {}), ...normalizeEntitlements(opts.overrides || {}) };
    record(sub.status, opts.note || "بازنویسی دسترسی");
  }

  return { ok: true, subscription: next };
}

export function subscriptionAlerts(sub, now = Date.now()) {
  const alerts = [];
  if (sub.status === "trialing" && Number(sub.trialEndsAt) && Number(sub.trialEndsAt) - now < 3 * DAY) alerts.push("پایان دورهٔ آزمایشی نزدیک است.");
  if (sub.status === "active" && Number(sub.currentPeriodEnd) && Number(sub.currentPeriodEnd) - now < 3 * DAY) alerts.push("تمدید نزدیک است.");
  if (sub.status === "past_due") alerts.push("پرداخت معوق؛ ارسال یادآوری لازم است.");
  if (sub.status === "grace" && Number(sub.graceEndsAt) && Number(sub.graceEndsAt) < now) alerts.push("مهلت پرداخت گذشته است.");
  return alerts;
}

/* ---------------- payments ---------------- */

export function recordPayment({ subscription = null, plan = null, amount = 0, currency = "IRT", provider = "manual", status = "paid", actor = "owner", note = "" }, now = Date.now()) {
  const store = readBilling();
  const invoice = Number(store.counters.invoice || 1000) + 1;
  const payment = {
    id: uid("pay"),
    invoiceNo: `INV-${invoice}`,
    subscriptionId: subscription?.id || "",
    userKey: subscription?.userKey || "",
    planId: subscription?.planId || plan?.id || "",
    planName: subscription?.planName || plan?.name || "",
    amount: Math.max(0, Number(amount) || 0),
    currency,
    provider,
    status: Object.prototype.hasOwnProperty.call(PAYMENT_STATUSES, status) ? status : "pending",
    note: String(note || "").slice(0, 160),
    providerRef: "",
    createdAt: now,
    paidAt: status === "paid" ? now : 0
  };
  const next = pushEvent({ ...store, counters: { ...store.counters, invoice }, payments: [payment, ...store.payments] }, {
    kind: "payment", action: `ثبت پرداخت ${payment.invoiceNo}`, subId: payment.subscriptionId, amount: payment.amount, actor
  });
  writeBilling(next);
  return payment;
}

export function updatePaymentStatus(id, status, actor = "owner") {
  const store = readBilling();
  const target = store.payments.find((p) => p.id === id);
  if (!target) return null;
  const updated = { ...target, status: PAYMENT_STATUSES[status] ? status : target.status, paidAt: status === "paid" ? (target.paidAt || Date.now()) : target.paidAt };
  const payments = store.payments.map((p) => (p.id === id ? updated : p));
  writeBilling(pushEvent({ ...store, payments }, { kind: "payment", action: `تغییر وضعیت ${target.invoiceNo} به ${PAYMENT_STATUSES[updated.status]}`, subId: target.subscriptionId, amount: target.amount, actor }));
  return updated;
}

/* ---------------- analytics ---------------- */

function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function lastMonths(count, now = Date.now()) {
  const out = [];
  const d = new Date(now);
  d.setDate(1);
  for (let i = count - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ key: monthKey(m.getTime()), label: m.toLocaleDateString("fa-IR", { month: "short" }) });
  }
  return out;
}

export function computeMetrics({ plans = [], billing = readBilling() } = {}, now = Date.now()) {
  const planById = new Map(plans.map((p) => [p.id, p]));
  const subs = billing.subscriptions || [];
  const payments = billing.payments || [];
  const events = billing.events || [];
  const billable = subs.filter((s) => ["active", "trialing", "past_due", "grace"].includes(s.status));
  let mrr = 0;
  for (const sub of billable) mrr += planMonthlyEquivalent(sub, planById.get(sub.planId), now);

  const month30 = now - 30 * DAY;
  const newSubs = subs.filter((s) => Number(s.startedAt) >= month30).length;
  const canceled30 = subs.filter((s) => s.status === "canceled" && Number(s.canceledAt || s.updatedAt) >= month30).length;
  const failed30 = payments.filter((p) => p.status === "failed" && Number(p.createdAt) >= month30).length;
  const paid = payments.filter((p) => p.status === "paid");
  const revenueTotal = paid.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const months = lastMonths(6, now);
  const revenueSeries = months.map((m) => ({ label: m.label, value: paid.filter((p) => monthKey(Number(p.paidAt || p.createdAt)) === m.key).reduce((s, p) => s + Number(p.amount || 0), 0) }));
  const distribution = sortPlans(plans)
    .filter((p) => subs.some((s) => s.planId === p.id))
    .map((p) => ({ label: p.name, value: billable.filter((s) => s.planId === p.id).length, color: p.color }));
  const upgrades = events.filter((e) => e.kind === "subscription" && /ارتقا/.test(e.action) && Number(e.at) >= month30).length;
  const downgrades = events.filter((e) => e.kind === "subscription" && /تنزل/.test(e.action) && Number(e.at) >= month30).length;
  const churnRate = billable.length ? Math.round((canceled30 / (billable.length + canceled30)) * 1000) / 10 : 0;
  const growth = newSubs && billable.length ? Math.min(0.5, newSubs / Math.max(1, billable.length)) : 0.08;
  const forecast = Math.round(mrr * (1 + growth));
  const invoiceNext = Number(billing.counters?.invoice || 1000) + 1;

  return {
    mrr,
    arr: mrr * 12,
    active: billable.length,
    newSubs,
    canceled30,
    failed30,
    churnRate,
    revenueTotal,
    revenueSeries,
    distribution,
    upgrades,
    downgrades,
    forecast,
    invoiceNext,
    totalSubs: subs.length,
    totalPayments: payments.length
  };
}

export function formatMoney(amount, currency = "IRT") {
  const meta = CURRENCIES[currency] || CURRENCIES.IRT;
  const n = Number(amount) || 0;
  const text = meta.decimals ? n.toLocaleString("fa-IR", { minimumFractionDigits: meta.decimals, maximumFractionDigits: meta.decimals }) : Math.round(n).toLocaleString("fa-IR");
  return `${text} ${meta.fa}`;
}

export function daysLeft(target, now = Date.now()) {
  if (!target) return null;
  return Math.ceil((Number(target) - now) / DAY);
}

export { ENTITLEMENTS };
