import { Plan } from "../models/Plan.js";
import { Order } from "../models/Order.js";
import { Subscription } from "../models/Subscription.js";
import { dbReady } from "../db.js";
import { requireAuth } from "./auth.js";
import { ensureStore } from "../userStore.js";
import { sqlPlans, sqlSubscriptionState, sqlCreateOrder } from "../stores/billing.js";
import { audit } from "../audit.js";
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

async function ensurePlans() {
  if (!dbReady()) return DEFAULT_PLANS.map((plan) => ({ ...plan, active: true }));
  const count = await Plan.estimatedDocumentCount();
  if (!count) await Plan.insertMany(DEFAULT_PLANS);
  const plans = await Plan.find({ active: true }).sort({ price: 1 }).lean();
  return plans.map((plan) => ({ ...plan, id: plan.slug }));
}

export default async function billingRoutes(app) {
  app.get("/plans", async (req, reply) => {
    if (!dbReady()) {
      if (!(await ensureStore())) return fail(reply, 503, "db_unavailable", "Database is not connected.");
      return { ok: true, plans: await sqlPlans() };
    }
    return { ok: true, plans: await ensurePlans() };
  });

  app.get("/me", { preHandler: requireAuth }, async (req, reply) => {
    if (!dbReady()) {
      if (!(await ensureStore())) return fail(reply, 503, "db_unavailable", "Database is not connected.");
      const state = await sqlSubscriptionState(req.auth.userId);
      return { ok: true, ...state };
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
    if (active) return { ok: true, state: "active", subscription: active };
    const pending = await Subscription.findOne({ user: userId, status: "pending" })
      .sort({ updatedAt: -1 })
      .lean();
    if (pending) return { ok: true, state: "pending", subscription: pending };
    const expired = await Subscription.findOne({ user: userId, status: "active" })
      .sort({ updatedAt: -1 })
      .lean();
    if (expired) {
      await Subscription.updateOne({ _id: expired._id }, { $set: { status: "expired" } });
      return { ok: true, state: "expired", subscription: { ...expired, status: "expired" } };
    }
    return { ok: true, state: "none", subscription: null };
  });

  app.post("/orders", { preHandler: requireAuth }, async (req, reply) => {
    const gate = await resolveFeatureState({ userId: req.auth.userId, role: req.auth.role });
    if (!isEnabled(gate, "features.subscriptionsEnabled")) {
      return fail(reply, 403, "subscriptions_closed", "Subscriptions are disabled by the site owner.");
    }
    const slug = String(req.body?.planId || req.body?.planSlug || "").trim().toLowerCase();
    if (!dbReady()) {
      if (!(await ensureStore())) return fail(reply, 503, "db_unavailable", "Database is not connected.");
      const plans = await sqlPlans();
      const plan = plans.find((item) => item.slug === slug);
      if (!plan) return fail(reply, 400, "unknown_plan", "That plan does not exist.");
      const result = await sqlCreateOrder({ userId: req.auth.userId, plan });
      await audit("billing.order", req, {
        targetType: "plan",
        targetId: plan.id,
        meta: { amount: plan.price, currency: plan.currency, duplicate: result.duplicate }
      });
      return { ok: true, duplicate: result.duplicate, order: result.order };
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
}
