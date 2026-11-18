import { dbGet, dbGetAll, dbGetByIndex, dbPut, uid, recordActivity } from "./db.js";

export const PLANS = [
  { id: "monthly", cycle: "monthly", price: 49000, currency: "IRT", days: 30, popular: false },
  { id: "yearly", cycle: "yearly", price: 490000, currency: "IRT", days: 365, popular: true }
];

function userKey(user) {
  return String(user?.username || user || "").toLowerCase();
}

export function getPlan(id) {
  return PLANS.find((plan) => plan.id === id) || null;
}

export async function seedPlans() {
  for (const plan of PLANS) {
    const existing = await dbGet("plans", plan.id);
    if (!existing) {
      await dbPut("plans", { ...plan, active: true, updatedAt: Date.now() });
    }
  }
  return PLANS.length;
}

export async function listPlans() {
  await seedPlans();
  const rows = await dbGetAll("plans");
  return PLANS.filter((plan) => rows.some((row) => row.id === plan.id && row.active !== false));
}

export async function subscriptionStatus(user) {
  const username = userKey(user);
  if (!username) return { state: "none", subscription: null, plan: null };
  const now = Date.now();
  const rows = (await dbGetByIndex("subscriptions", "user", username))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const active = rows.find((row) => row.status === "active" && Number(row.expiresAt) > now);
  if (active) return { state: "active", subscription: active, plan: getPlan(active.planId) };
  const expired = rows.find((row) => row.status === "active");
  if (expired) {
    const next = { ...expired, status: "expired", updatedAt: now };
    await dbPut("subscriptions", next);
    return { state: "expired", subscription: next, plan: getPlan(expired.planId) };
  }
  const pending = rows.find((row) => row.status === "pending");
  if (pending) return { state: "pending", subscription: pending, plan: getPlan(pending.planId) };
  return { state: "none", subscription: null, plan: null };
}

export async function requestPlan(user, planId) {
  const plan = getPlan(planId);
  const username = userKey(user);
  if (!plan) return { ok: false, reason: "unknown" };
  if (!username) return { ok: false, reason: "auth" };
  const now = Date.now();
  const orders = await dbGetByIndex("orders", "user", username);
  const open = orders.find((order) => order.status === "pending" && order.planId === plan.id);
  if (open) return { ok: true, duplicate: true, order: open };
  const order = {
    id: uid("ord"),
    user: username,
    planId: plan.id,
    cycle: plan.cycle,
    amount: plan.price,
    currency: plan.currency,
    status: "pending",
    createdAt: now,
    updatedAt: now
  };
  await dbPut("orders", order);
  await dbPut("subscriptions", {
    id: uid("sub"),
    user: username,
    planId: plan.id,
    cycle: plan.cycle,
    status: "pending",
    orderId: order.id,
    startedAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now
  });
  try {
    await recordActivity(user, "plan.request", { plan: plan.id, amount: plan.price });
  } catch {}
  return { ok: true, order, days: plan.days };
}
