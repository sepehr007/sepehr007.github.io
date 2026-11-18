import crypto from "node:crypto";
import { getDatabase, transaction } from "../database/index.js";

const DEFAULT_PLANS = [
  {
    id: "monthly",
    name: "ماهانه",
    cycle: "monthly",
    price: 49000,
    currency: "IRT",
    days: 30,
    popular: 0,
    position: 0
  },
  {
    id: "yearly",
    name: "سالانه",
    cycle: "yearly",
    price: 490000,
    currency: "IRT",
    days: 365,
    popular: 1,
    position: 1
  }
];

function parseFeatures(raw) {
  try {
    const value = JSON.parse(raw || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function toDate(value) {
  return value ? new Date(Number(value)) : null;
}

export function mapPlan(row) {
  return {
    id: row.id,
    slug: row.id,
    name: row.name,
    cycle: row.cycle,
    price: Number(row.price || 0),
    currency: row.currency || "IRT",
    days: Number(row.days || 30),
    features: parseFeatures(row.features_json),
    active: Boolean(row.active),
    popular: Boolean(row.popular),
    position: Number(row.position || 0)
  };
}

export function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    user: row.user_id,
    planSlug: row.plan_id,
    planId: row.plan_id,
    cycle: row.cycle,
    amount: Number(row.amount || 0),
    currency: row.currency || "IRT",
    status: row.status,
    provider: row.provider || "",
    providerRef: row.provider_ref || "",
    paidAt: toDate(row.paid_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

export function mapSubscription(row) {
  if (!row) return null;
  return {
    id: row.id,
    user: row.user_id,
    planSlug: row.plan_id,
    planId: row.plan_id,
    cycle: row.cycle,
    status: row.status,
    orderId: row.order_id || null,
    startedAt: toDate(row.started_at),
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

function seedPlans(db) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO subscription_plans
     (id, name, cycle, price, currency, days, features_json, active, popular, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', 1, ?, ?, ?, ?)`
  );
  for (const plan of DEFAULT_PLANS) {
    insert.run(plan.id, plan.name, plan.cycle, plan.price, plan.currency, plan.days, plan.popular, plan.position, now, now);
  }
}

export async function sqlPlans() {
  const db = await getDatabase();
  if (!db) return DEFAULT_PLANS.map((plan) => ({ ...plan, slug: plan.id, features: [], active: true, popular: Boolean(plan.popular) }));
  seedPlans(db);
  return db
    .prepare("SELECT * FROM subscription_plans WHERE active = 1 ORDER BY position ASC, price ASC")
    .all()
    .map(mapPlan);
}

export async function sqlSubscriptionState(userId) {
  const db = await getDatabase();
  if (!db) return { state: "none", subscription: null };
  const now = Date.now();
  const active = db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(String(userId), now);
  if (active) return { state: "active", subscription: mapSubscription(active) };

  const pending = db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'pending' ORDER BY updated_at DESC LIMIT 1")
    .get(String(userId));
  if (pending) return { state: "pending", subscription: mapSubscription(pending) };

  const expired = db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1")
    .get(String(userId));
  if (expired) {
    db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?").run(now, expired.id);
    return { state: "expired", subscription: { ...mapSubscription(expired), status: "expired" } };
  }
  return { state: "none", subscription: null };
}

export async function sqlCreateOrder({ userId, plan }) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const now = Date.now();
  const result = transaction((conn) => {
    const existing = conn
      .prepare("SELECT * FROM orders WHERE user_id = ? AND plan_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get(String(userId), plan.id);
    if (existing) return { duplicate: true, order: mapOrder(existing) };

    const orderId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    conn
      .prepare(
        `INSERT INTO orders
         (id, user_id, plan_id, cycle, amount, currency, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(orderId, String(userId), plan.id, plan.cycle, plan.price, plan.currency, now, now);
    conn
      .prepare(
        `INSERT INTO subscriptions
         (id, user_id, plan_id, cycle, status, order_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(subscriptionId, String(userId), plan.id, plan.cycle, orderId, now, now);
    return {
      duplicate: false,
      order: mapOrder(conn.prepare("SELECT * FROM orders WHERE id = ?").get(orderId))
    };
  });
  return result;
}
