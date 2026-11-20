import crypto from "node:crypto";
import { Plan } from "../models/Plan.js";
import { Order } from "../models/Order.js";
import { Subscription } from "../models/Subscription.js";
import { dbReady } from "../db.js";
import { requireAuth } from "./auth.js";
import { ensureStore } from "../userStore.js";
import {
  sqlPlans,
  sqlPlanById,
  sqlSubscriptionState,
  sqlCreateOrder,
  sqlStartTrial,
  sqlEnsurePayment,
  sqlActivateOrder,
  sqlMarkPaymentFailed,
  sqlValidateCoupon,
  sqlUserBilling,
  mapOrder,
  mapPayment
} from "../stores/billing.js";
import { paymentProviderState, paymentConfig, initiatePayment, verifyWebhook } from "../payments.js";
import { get, run } from "../database/index.js";
import { audit } from "../audit.js";
import { deliverNotice } from "../notify.js";
import { resolveFeatureState, isEnabled } from "../features.js";

const DEFAULT_PLANS = [
  {
    slug: "monthly",
    name: "ماهانه",
    cycle: "monthly",
    price: 49000,
    currency: "IRT",
    days: 30,
    popular: false
  },
  {
    slug: "yearly",
    name: "سالانه",
    cycle: "yearly",
    price: 490000,
    currency: "IRT",
    days: 365,
    popular: true
  }
];

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

const FAIL_MESSAGES = {
  coupon_unknown: "این کد تخفیف وجود ندارد.",
  coupon_inactive: "این کد تخفیف غیرفعال است.",
  coupon_expired: "این کد تخفیف منقضی شده است.",
  coupon_not_started: "این کد تخفیف هنوز شروع نشده است.",
  coupon_plan_mismatch: "این کد برای این پلن نیست.",
  coupon_exhausted: "ظرفیت استفاده از این کد پر شده است.",
  coupon_already_used: "این کد را قبلاً استفاده کرده‌ای.",
  coupon_missing: "کد تخفیف را وارد کن.",
  plan_missing: "این پلن پیدا نشد.",
  no_trial: "این پلن دورهٔ آزمایشی ندارد.",
  trial_used: "دورهٔ آزمایشی این پلن را قبلاً گرفته‌ای.",
  already_subscribed: "الان اشتراک فعال داری."
};

function failReason(reply, reason) {
  return fail(reply, 400, reason, FAIL_MESSAGES[reason] || "درخواست انجام نشد.");
}

async function ensurePlans() {
  if (!dbReady()) return DEFAULT_PLANS.map((plan) => ({ ...plan, id: plan.slug, active: true }));
  const count = await Plan.estimatedDocumentCount();
  if (!count) await Plan.insertMany(DEFAULT_PLANS);
  const plans = await Plan.find({ active: true }).sort({ price: 1 }).lean();
  return plans.map((plan) => ({ ...plan, id: plan.slug }));
}

async function orderPaymentInfo(order, plan) {
  if (!dbReady() && order?.id) {
    const payment = await sqlEnsurePayment({ order: { ...order, userId: order.user }, provider: paymentConfig().provider, amount: order.amount });
    return { payment, intent: initiatePayment({ order, plan }) };
  }
  return { payment: null, intent: initiatePayment({ order, plan }) };
}

export default async function billingRoutes(app) {
  app.get("/provider", async () => {
    return { ok: true, ...paymentProviderState() };
  });

  app.get("/plans", async (req, reply) => {
    if (!dbReady()) {
      if (!(await ensureStore())) return fail(reply, 503, "db_unavailable", "Database is not connected.");
      return { ok: true, plans: await sqlPlans(), provider: paymentProviderState() };
    }
    return { ok: true, plans: await ensurePlans(), provider: paymentProviderState() };
  });

  app.post("/coupon", { preHandler: requireAuth }, async (req, reply) => {
    if (dbReady()) return fail(reply, 503, "sqlite_only", "Coupons need the SQLite deployment.");
    if (!(await ensureStore())) return fail(reply, 503, "db_unavailable", "Database is not connected.");
    const code = String(req.body?.code || "").trim();
    const planId = String(req.body?.planId || "").trim();
    const result = await sqlValidateCoupon({ code, planId, userId: req.auth.userId });
    if (!result.ok) return failReason(reply, result.reason);
    return { ok: true, ...result };
  });

  app.get("/me", { preHandler: requireAuth }, async (req, reply) => {
    if (!dbReady()) {
      if (!(await ensureStore())) return fail(reply, 503, "db_unavailable", "Database is not connected.");
      const state = await sqlSubscriptionState(req.auth.userId);
      return { ok: true, ...state, provider: paymentProviderState() };
    }
    const userId = req.auth.userId;
    const now = new Date();
    const active = await Subscription.findOne({
      user: userId,
      status: "active",
      expiresAt: { $gt: now }
    })
      .sort({ updatedAt: -1 })
      .lean();
    if (active) return { ok: true, state: "active", subscription: active, provider: paymentProviderState() };
    const pending = await Subscription.findOne({ user: userId, status: "pending" })
      .sort({ updatedAt: -1 })
      .lean();
    if (pending) return { ok: true, state: "pending", subscription: pending, provider: paymentProviderState() };
    const expired = await Subscription.findOne({ user: userId, status: "active" })
      .sort({ updatedAt: -1 })
      .lean();
    if (expired) {
      await Subscription.updateOne({ _id: expired._id }, { $set: { status: "expired" } });
      return { ok: true, state: "expired", subscription: { ...expired, status: "expired" }, provider: paymentProviderState() };
    }
    return { ok: true, state: "none", subscription: null, provider: paymentProviderState() };
  });

  app.get("/history", { preHandler: requireAuth }, async (req, reply) => {
    if (dbReady()) return fail(reply, 503, "sqlite_only", "Billing history needs the SQLite deployment.");
    if (!(await ensureStore())) return fail(reply, 503, "db_unavailable", "Database is not connected.");
    return { ok: true, ...(await sqlUserBilling(req.auth.userId)) };
  });

  app.post("/orders", { preHandler: requireAuth }, async (req, reply) => {
    const gate = await resolveFeatureState({ userId: req.auth.userId, role: req.auth.role });
    if (!isEnabled(gate, "features.subscriptionsEnabled")) {
      return fail(reply, 403, "subscriptions_closed", "Subscriptions are disabled by the site owner.");
    }
    const slug = String(req.body?.planId || req.body?.planSlug || "").trim().toLowerCase();
    const couponCode = String(req.body?.coupon || req.body?.couponCode || "").trim();
    const wantsTrial = Boolean(req.body?.trial);
    if (!dbReady()) {
      if (!(await ensureStore())) return fail(reply, 503, "db_unavailable", "Database is not connected.");
      const plans = await sqlPlans();
      const plan = plans.find((item) => item.slug === slug || item.id === slug);
      if (!plan) return fail(reply, 400, "unknown_plan", "That plan does not exist.");
      if (wantsTrial) {
        const trial = await sqlStartTrial({ userId: req.auth.userId, plan });
        if (!trial.ok) return failReason(reply, trial.reason);
        await audit("billing.trial.start", req, { targetType: "plan", targetId: plan.id, meta: { days: trial.trialDays } });
        await deliverNotice(req.server, req.auth.userId, {
          kind: "payment",
          title: "دورهٔ آزمایشی فعال شد",
          body: `پلن ${plan.name} برای ${trial.trialDays} روز فعال شد؛ بعد از آن برای ادامه تمدید کن.`,
          link: "profile.html#planCard",
          dedupeKey: `trial:${trial.order.id}`
        });
        return { ok: true, trial: true, trialDays: trial.trialDays, ...trial };
      }
      const result = await sqlCreateOrder({ userId: req.auth.userId, plan, couponCode });
      if (!result.ok) return failReason(reply, result.reason);
      const info = await orderPaymentInfo(result.order, plan);
      await audit("billing.order", req, {
        targetType: "plan",
        targetId: plan.id,
        meta: { amount: result.order.amount, discount: result.order.discount, coupon: result.order.couponCode, duplicate: result.duplicate }
      });
      if (!result.duplicate) {
        const money = `${Number(result.order.amount || 0).toLocaleString("fa-IR")} ${plan.currency === "IRT" ? "تومان" : plan.currency}`;
        await deliverNotice(req.server, req.auth.userId, {
          kind: "payment",
          title: "سفارش اشتراک ثبت شد",
          body: `پلن ${plan.name} · ${money} · وضعیت: در انتظار پرداخت.`,
          link: "profile.html#planCard",
          dedupeKey: `order:${result.order.id}`,
          dedupeWindowMs: 60 * 60_000
        });
      }
      return { ok: true, duplicate: result.duplicate, order: result.order, discount: result.discount, coupon: result.coupon, ...info };
    }
    const plans = await ensurePlans();
    const plan = plans.find((item) => item.slug === slug);
    if (!plan) return fail(reply, 400, "unknown_plan", "That plan does not exist.");
    const userId = req.auth.userId;
    const existing = await Order.findOne({ user: userId, planSlug: plan.slug, status: "pending" }).lean();
    if (existing) return { ok: true, duplicate: true, order: existing };
    const order = await Order.create({
      user: userId,
      planSlug: plan.slug,
      cycle: plan.cycle,
      amount: plan.price,
      currency: plan.currency,
      status: "pending"
    });
    await Subscription.create({
      user: userId,
      planSlug: plan.slug,
      cycle: plan.cycle,
      status: "pending",
      orderId: order._id
    });
    await audit("billing.order", req, {
      targetType: "plan",
      targetId: plan.slug,
      meta: { amount: plan.price, currency: plan.currency, duplicate: false }
    });
    return { ok: true, order };
  });

  app.post("/orders/:id/pay", { preHandler: requireAuth }, async (req, reply) => {
    if (dbReady()) return fail(reply, 503, "sqlite_only", "Payments need the SQLite deployment.");
    if (!(await ensureStore())) return fail(reply, 503, "db_unavailable", "Database is not connected.");
    const order = get("SELECT * FROM orders WHERE id = ? AND user_id = ?", String(req.params.id), req.auth.userId);
    if (!order) return fail(reply, 404, "order_missing", "Order not found.");
    if (order.status !== "pending") return fail(reply, 409, "order_closed", "This order is no longer payable.");
    const plan = await sqlPlanById(order.plan_id);
    if (!plan) return fail(reply, 404, "plan_missing", "Plan not found.");
    const mapped = mapOrder(order);
    const payment = await sqlEnsurePayment({ order: { ...mapped, userId: req.auth.userId }, provider: paymentConfig().provider, amount: mapped.amount });
    const intent = initiatePayment({ order: mapped, plan });
    await audit("billing.pay.intent", req, { targetType: "order", targetId: mapped.id, meta: { provider: intent.provider, mode: intent.mode } });
    return { ok: true, order: mapped, payment, intent };
  });

  app.post("/webhook/:provider", async (req, reply) => {
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const verdict = verifyWebhook({ provider: String(req.params.provider || ""), rawBody, headers: req.headers });
    if (!verdict.ok) {
      return fail(reply, verdict.status, verdict.reason, "Webhook rejected.");
    }
    if (!(await ensureStore())) return fail(reply, 503, "db_unavailable", "Database is not connected.");
    const { event } = verdict;
    const seen = get("SELECT 1 FROM payment_events WHERE provider = ? AND event_id = ?", req.params.provider, event.eventId);
    if (seen) return { ok: true, duplicate: true };
    const orderRow = get("SELECT * FROM orders WHERE id = ?", event.orderId);
    if (!orderRow) return fail(reply, 404, "order_missing", "Order not found.");
    if (event.amount != null && Number(event.amount) !== Number(orderRow.amount)) {
      return fail(reply, 409, "amount_mismatch", "Webhook amount does not match the order.");
    }
    if (event.status === "failed") {
      const result = await sqlMarkPaymentFailed({ orderId: event.orderId, reason: "webhook_failed", provider: req.params.provider, payload: event.payload });
      run(
        "INSERT OR IGNORE INTO payment_events (id, provider, event_id, payment_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        req.params.provider,
        event.eventId,
        result.payment?.id || null,
        JSON.stringify(event.payload),
        Date.now()
      );
      return { ok: true, failed: true };
    }
    const result = await sqlActivateOrder({
      orderId: event.orderId,
      provider: req.params.provider,
      providerRef: event.providerRef,
      eventId: event.eventId,
      source: "webhook"
    });
    if (!result.ok) return fail(reply, 409, result.reason, "Activation failed.");
    run(
      "INSERT OR IGNORE INTO payment_events (id, provider, event_id, payment_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      req.params.provider,
      event.eventId,
      result.payment?.id || null,
      JSON.stringify(event.payload),
      Date.now()
    );
    await audit("billing.webhook.paid", req, {
      targetType: "order",
      targetId: event.orderId,
      meta: { provider: req.params.provider, eventId: event.eventId, duplicate: Boolean(result.duplicate) }
    });
    if (!result.duplicate) {
      const order = result.order;
      await deliverNotice(req.server, order.user, {
        kind: "payment",
        title: "پرداخت تأیید شد",
        body: `اشتراک ${result.plan?.name || order.planId} فعال شد.`,
        link: "profile.html#planCard",
        dedupeKey: `paid:${order.id}`
      });
    }
    return { ok: true, activated: true, duplicate: Boolean(result.duplicate) };
  });
}
