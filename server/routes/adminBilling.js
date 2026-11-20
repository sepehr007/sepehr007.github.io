import crypto from "node:crypto";
import { dbReady } from "../db.js";
import { ensureStore } from "../userStore.js";
import { all, get, pageLimit } from "../database/index.js";
import { audit } from "../audit.js";
import { adminLimit, permissionOnly } from "../adminGuard.js";
import { emitEvent } from "../automation.js";
import {
  sqlPlansAdmin,
  sqlPlanById,
  sqlSavePlan,
  sqlDuplicatePlan,
  sqlReorderPlans,
  sqlDeletePlan,
  sqlCoupons,
  sqlSaveCoupon,
  sqlDeactivateCoupon,
  sqlAdminSubscriptions,
  sqlSubscriptionEvents,
  sqlAdjustSubscription,
  sqlAdminPayments,
  sqlVerifyPaymentManually,
  sqlRefundPayment,
  sqlAdminOrders,
  sqlCancelOrder,
  sqlRevenueSummary
} from "../stores/billing.js";
import { paymentProviderState } from "../payments.js";
import { deliverNotice } from "../notify.js";

const CYCLES = ["monthly", "yearly", "lifetime"];

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

async function ready(reply) {
  if (dbReady()) {
    fail(reply, 503, "sqlite_only", "Billing management needs the SQLite deployment.");
    return false;
  }
  if (await ensureStore()) return true;
  fail(reply, 503, "database_unavailable", "Database is not connected yet.");
  return false;
}

function body(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

function needConfirm(reply, req) {
  if (body(req).confirm === true) return true;
  fail(reply, 428, "confirmation_required", "Send confirm:true to run this action.");
  return false;
}

function cleanFeatures(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === "string" ? item : item?.key))
    .filter((key) => typeof key === "string" && key.trim())
    .map((key) => key.trim().slice(0, 80))
    .slice(0, 40);
}

function cleanQuota(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw).slice(0, 30)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) continue;
    out[String(key).slice(0, 60)] = Math.min(1_000_000, Math.floor(n));
  }
  return out;
}

function planInput(input, id) {
  const plan = {
    id,
    name: String(input.name || "").trim().slice(0, 80),
    description: String(input.description || "").slice(0, 500),
    cycle: CYCLES.includes(input.cycle) ? input.cycle : "monthly",
    price: Math.max(0, Math.floor(Number(input.price) || 0)),
    currency: String(input.currency || "IRT").slice(0, 8),
    days: Math.max(1, Math.min(3650, Math.floor(Number(input.days) || 30))),
    trialDays: Math.max(0, Math.min(365, Math.floor(Number(input.trialDays) || 0))),
    features: cleanFeatures(input.features),
    quota: cleanQuota(input.quota),
    active: input.active === undefined ? true : Boolean(input.active),
    archived: Boolean(input.archived),
    popular: Boolean(input.popular),
    position: Math.max(0, Math.floor(Number(input.position) || 0))
  };
  return plan;
}

async function notice(req, userId, title, text, key) {
  await deliverNotice(req.server, userId, {
    kind: "payment",
    title,
    body: text,
    link: "profile.html#planCard",
    dedupeKey: key,
    dedupeWindowMs: 60 * 60_000
  });
}

export default async function adminBillingRoutes(app) {
  app.addHook("preHandler", adminLimit);

  app.get("/billing/overview", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const totals = await sqlRevenueSummary();
    const plans = await sqlPlansAdmin();
    const provider = paymentProviderState();
    return {
      ok: true,
      totals,
      plans,
      provider,
      counts: {
        coupons: all("SELECT COUNT(*) AS n FROM coupons WHERE active = 1")[0]?.n || 0,
        pendingPayments: all("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'")[0]?.n || 0
      }
    };
  });

  /* -------------------------------------------------------------- plans */
  app.get("/billing/plans", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    return { ok: true, plans: await sqlPlansAdmin() };
  });

  app.post("/billing/plans", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const input = body(req);
    const id = String(input.id || input.slug || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) {
      return fail(reply, 400, "invalid_id", "Plan id must be 2-41 latin letters, digits or dashes.");
    }
    const plan = planInput(input, id);
    if (!plan.name) return fail(reply, 400, "invalid_name", "A plan name is required.");
    const result = await sqlSavePlan(plan, { create: true });
    if (!result.ok) return fail(reply, 409, result.reason, "That plan id already exists.");
    await audit("admin.plan.create", req, { targetType: "plan", targetId: id, meta: { name: plan.name, price: plan.price } });
    return { ok: true, plan: result.plan };
  });

  app.patch("/billing/plans/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const existing = await sqlPlanById(req.params.id);
    if (!existing) return fail(reply, 404, "plan_missing", "That plan does not exist.");
    const input = body(req);
    if (input.cycle !== undefined && !CYCLES.includes(input.cycle)) {
      return fail(reply, 400, "invalid_cycle", "Cycle must be monthly, yearly or lifetime.");
    }
    if (input.name !== undefined && !String(input.name).trim()) return fail(reply, 400, "invalid_name", "Name cannot be empty.");
    const result = await sqlSavePlan({
      id: existing.id,
      name: input.name,
      description: input.description,
      cycle: input.cycle,
      price: input.price,
      currency: input.currency,
      days: input.days,
      trialDays: input.trialDays,
      features: input.features === undefined ? undefined : cleanFeatures(input.features),
      quota: input.quota === undefined ? undefined : cleanQuota(input.quota),
      active: input.active,
      archived: input.archived,
      popular: input.popular,
      position: input.position
    });
    if (!result.ok) return fail(reply, 404, result.reason, "Plan update failed.");
    await audit("admin.plan.update", req, {
      targetType: "plan",
      targetId: existing.id,
      meta: { fields: Object.keys(input).filter((key) => key !== "confirm") }
    });
    return { ok: true, plan: result.plan };
  });

  app.post("/billing/plans/:id/duplicate", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const source = await sqlPlanById(req.params.id);
    if (!source) return fail(reply, 404, "plan_missing", "That plan does not exist.");
    const input = body(req);
    const suffix = crypto.randomBytes(2).toString("hex");
    const newId = String(input.id || `${source.id}-copy-${suffix}`).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(newId)) return fail(reply, 400, "invalid_id", "New plan id is invalid.");
    const result = await sqlDuplicatePlan(source.id, newId, String(input.name || `${source.name} (کپی)`).slice(0, 80));
    if (!result.ok) return fail(reply, 409, result.reason, "Could not duplicate that plan.");
    await audit("admin.plan.duplicate", req, { targetType: "plan", targetId: newId, meta: { source: source.id } });
    return { ok: true, plan: result.plan };
  });

  app.post("/billing/plans/order", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const ids = Array.isArray(body(req).ids) ? body(req).ids.map(String).slice(0, 100) : [];
    if (!ids.length) return fail(reply, 400, "no_plans", "Send the ordered plan ids.");
    await sqlReorderPlans(ids);
    await audit("admin.plan.reorder", req, { targetType: "plan", meta: { ids } });
    return { ok: true, plans: await sqlPlansAdmin() };
  });

  app.delete("/billing/plans/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const result = await sqlDeletePlan(req.params.id);
    if (!result.ok) return fail(reply, 404, result.reason, "That plan does not exist.");
    await audit("admin.plan.delete", req, { targetType: "plan", targetId: req.params.id, meta: { mode: result.mode } });
    return { ok: true, mode: result.mode, plan: result.plan };
  });

  app.post("/billing/plans/restore/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const existing = await sqlPlanById(req.params.id);
    if (!existing) return fail(reply, 404, "plan_missing", "That plan does not exist.");
    const result = await sqlSavePlan({ id: existing.id, archived: false, active: true });
    await audit("admin.plan.restore", req, { targetType: "plan", targetId: existing.id });
    return { ok: true, plan: result.plan };
  });

  /* ------------------------------------------------------------ coupons */
  app.get("/billing/coupons", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    return { ok: true, coupons: await sqlCoupons() };
  });

  app.post("/billing/coupons", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const input = body(req);
    const code = String(input.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return fail(reply, 400, "invalid_code", "Code must be 3-40 latin uppercase letters, digits, _ or -.");
    const kind = input.kind === "fixed" ? "fixed" : "percent";
    const value = Math.floor(Number(input.value) || 0);
    if (value < 1 || (kind === "percent" && value > 100)) return fail(reply, 400, "invalid_value", "Discount value is out of range.");
    if (input.planId && !(await sqlPlanById(input.planId))) return fail(reply, 400, "plan_missing", "That plan does not exist.");
    const result = await sqlSaveCoupon({
      code,
      kind,
      value,
      planId: input.planId || null,
      maxRedemptions: Math.max(0, Math.floor(Number(input.maxRedemptions) || 0)),
      validFrom: input.validFrom ? Number(input.validFrom) : null,
      validUntil: input.validUntil ? Number(input.validUntil) : null,
      active: input.active === undefined ? true : Boolean(input.active)
    });
    if (!result.ok) return fail(reply, 409, result.reason, "Coupon could not be saved.");
    await audit("admin.coupon.create", req, { targetType: "coupon", targetId: result.coupon.id, meta: { code, kind, value } });
    return { ok: true, coupon: result.coupon };
  });

  app.patch("/billing/coupons/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const input = body(req);
    const result = await sqlSaveCoupon({
      id: String(req.params.id),
      code: input.code,
      kind: input.kind,
      value: input.value,
      planId: input.planId,
      maxRedemptions: input.maxRedemptions,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      active: input.active
    });
    if (!result.ok) return fail(reply, result.reason === "coupon_missing" ? 404 : 409, result.reason, "Coupon update failed.");
    await audit("admin.coupon.update", req, { targetType: "coupon", targetId: result.coupon.id, meta: { active: result.coupon.active } });
    return { ok: true, coupon: result.coupon };
  });

  app.delete("/billing/coupons/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const result = await sqlDeactivateCoupon(req.params.id);
    if (!result.ok) return fail(reply, 404, result.reason, "That coupon does not exist.");
    await audit("admin.coupon.deactivate", req, { targetType: "coupon", targetId: req.params.id });
    return { ok: true, coupon: result.coupon };
  });

  /* ------------------------------------------------------ subscriptions */
  app.get("/billing/subscriptions", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const data = await sqlAdminSubscriptions({
      status: String(req.query?.status || "").trim(),
      q: String(req.query?.q || "").trim(),
      limit: pageLimit(req.query?.limit, 25, 100),
      before: Number(req.query?.before) || 0
    });
    return { ok: true, ...data };
  });

  app.get("/billing/subscriptions/:id/events", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    return { ok: true, events: await sqlSubscriptionEvents(req.params.id) };
  });

  app.post("/billing/subscriptions/:id/adjust", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const input = body(req);
    const action = String(input.action || "");
    if (!["cancel", "cancel_at_period_end", "resume", "extend", "expire", "change_plan"].includes(action)) {
      return fail(reply, 400, "invalid_action", "Unsupported subscription action.");
    }
    if (action === "extend" && !(Number(input.days) > 0)) return fail(reply, 400, "invalid_days", "Send positive days.");
    if (action === "change_plan" && !input.planId) return fail(reply, 400, "plan_missing", "Send planId.");
    const sub = get("SELECT * FROM subscriptions WHERE id = ?", String(req.params.id));
    if (!sub) return fail(reply, 404, "subscription_missing", "That subscription does not exist.");
    const result = await sqlAdjustSubscription(sub.id, {
      action,
      days: input.days,
      planId: input.planId,
      actorId: req.auth.userId,
      note: String(input.note || "").slice(0, 300)
    });
    if (!result.ok) return fail(reply, 400, result.reason, "Subscription update failed.");
    await audit("admin.subscription.adjust", req, {
      targetType: "subscription",
      targetId: sub.id,
      meta: { action, days: input.days || 0, planId: input.planId || "" }
    });
    await notice(
      req,
      sub.user_id,
      "اشتراکت به‌روزرسانی شد",
      action === "extend"
        ? `مدت اشتراک ${Number(input.days)} روز افزایش یافت.`
        : action === "cancel" || action === "expire"
          ? "اشتراکت توسط مدیریت غیرفعال شد."
          : action === "change_plan"
            ? "پلن اشتراکت تغییر کرد."
            : "تنظیمات اشتراکت تغییر کرد.",
      `sub_adjust:${sub.id}:${action}:${crypto.randomInt(0, 1e6)}`
    );
    return { ok: true, ...result };
  });

  /* ----------------------------------------------------------- payments */
  app.get("/billing/payments", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const data = await sqlAdminPayments({
      status: String(req.query?.status || "").trim(),
      q: String(req.query?.q || "").trim(),
      limit: pageLimit(req.query?.limit, 25, 100),
      before: Number(req.query?.before) || 0
    });
    return { ok: true, ...data, provider: paymentProviderState() };
  });

  app.post("/billing/payments/:id/verify", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const input = body(req);
    const result = await sqlVerifyPaymentManually(req.params.id, {
      actorId: req.auth.userId,
      providerRef: String(input.providerRef || "").slice(0, 190)
    });
    if (!result.ok) return fail(reply, 409, result.reason, "Payment could not be verified.");
    await audit("admin.payment.verify", req, {
      targetType: "payment",
      targetId: req.params.id,
      meta: { orderId: result.order?.id || "", duplicate: Boolean(result.duplicate) }
    });
    if (!result.duplicate && result.order?.user) {
      await notice(req, result.order.user, "پرداختت تأیید شد", `اشتراک ${result.plan?.name || ""} فعال شد.`, `paid_admin:${result.order.id}`);
      emitEvent(req.server, "subscription.activated", {
        userId: result.order.user,
        orderId: result.order.id,
        planId: result.plan?.id || "",
        amount: result.order.amount,
        source: "manual_verify"
      });
    }
    return { ok: true, ...result };
  });

  app.post("/billing/payments/:id/refund", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const input = body(req);
    const result = await sqlRefundPayment(req.params.id, {
      actorId: req.auth.userId,
      reason: String(input.reason || "").slice(0, 300)
    });
    if (!result.ok) return fail(reply, 409, result.reason, "Refund could not be processed.");
    await audit("admin.payment.refund", req, {
      targetType: "payment",
      targetId: req.params.id,
      meta: { amount: result.payment?.amount || 0, reason: input.reason || "" }
    });
    if (result.payment?.user) {
      await notice(req, result.payment.user, "پرداختت بازگشت داده شد", "اشتراک مرتبط با این پرداخت لغو شد.", `refund:${result.payment.id}`);
    }
    return { ok: true, payment: result.payment };
  });

  /* ------------------------------------------------------------- orders */
  app.get("/billing/orders", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const data = await sqlAdminOrders({
      status: String(req.query?.status || "").trim(),
      limit: pageLimit(req.query?.limit, 25, 100),
      before: Number(req.query?.before) || 0
    });
    return { ok: true, ...data };
  });

  app.post("/billing/orders/:id/cancel", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const result = await sqlCancelOrder(req.params.id, { actorId: req.auth.userId, note: String(body(req).note || "").slice(0, 300) });
    if (!result.ok) return fail(reply, 409, result.reason, "Order could not be cancelled.");
    await audit("admin.order.cancel", req, { targetType: "order", targetId: req.params.id });
    return { ok: true, order: result.order };
  });

  /* ------------------------------------------------- quota visibility */
  app.get("/billing/quotas", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "billing.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const plans = await sqlPlansAdmin();
    return {
      ok: true,
      plans: plans.map((plan) => ({ id: plan.id, name: plan.name, quota: plan.quota, trialDays: plan.trialDays, archived: plan.archived })),
      note: "سهمیه‌ها از quota پلن خوانده می‌شوند؛ کلید rooms.max روی ساخت اتاق اعمال می‌شود."
    };
  });
}
