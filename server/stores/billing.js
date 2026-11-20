import crypto from "node:crypto";
import { getDatabase, transaction } from "../database/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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

function parseJson(raw, fallback) {
  try {
    const value = JSON.parse(raw || "null");
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function parseFeatures(raw) {
  const value = parseJson(raw, []);
  return Array.isArray(value) ? value : [];
}

function parseObject(raw) {
  const value = parseJson(raw, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toDate(value) {
  return value ? new Date(Number(value)) : null;
}

function nowMs() {
  return Date.now();
}

export function mapPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.id,
    name: row.name,
    description: row.description || "",
    cycle: row.cycle,
    price: Number(row.price || 0),
    currency: row.currency || "IRT",
    days: Number(row.days || 30),
    trialDays: Number(row.trial_days || 0),
    features: parseFeatures(row.features_json),
    quota: parseObject(row.quota_json),
    active: Boolean(row.active),
    archived: Boolean(row.archived),
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
    discount: Number(row.discount || 0),
    couponCode: row.coupon_code || "",
    trial: Boolean(row.trial),
    currency: row.currency || "IRT",
    status: row.status,
    provider: row.provider || "",
    providerRef: row.provider_ref || "",
    paidAt: toDate(row.paid_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

function renewalFor(row, now) {
  if (!row || row.status !== "active") return row?.status === "cancelled" ? "cancelled" : "inactive";
  if (row.trial_ends_at && Number(row.trial_ends_at) > now) return "trial";
  if (Number(row.cancel_at_period_end)) return "cancel_at_period_end";
  if (row.expires_at && Number(row.expires_at) - now <= 7 * DAY_MS) return "due";
  return "active";
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
    trialEndsAt: toDate(row.trial_ends_at),
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    renewalStatus: renewalFor(row, nowMs()),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

export function mapPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    user: row.user_id,
    orderId: row.order_id || null,
    subscriptionId: row.subscription_id || null,
    provider: row.provider || "",
    providerRef: row.provider_ref || "",
    amount: Number(row.amount || 0),
    currency: row.currency || "IRT",
    status: row.status,
    paidAt: toDate(row.paid_at),
    verifiedAt: toDate(row.verified_at),
    refundedAt: toDate(row.refunded_at),
    refundReason: row.refund_reason || "",
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

export function mapCoupon(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    value: Number(row.value || 0),
    planId: row.plan_id || "",
    maxRedemptions: Number(row.max_redemptions || 0),
    redemptions: Number(row.redemptions || 0),
    validFrom: toDate(row.valid_from),
    validUntil: toDate(row.valid_until),
    active: Boolean(row.active),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    userId: row.user_id,
    type: row.type,
    meta: parseObject(row.meta_json),
    actorId: row.actor_id || "",
    createdAt: toDate(row.created_at)
  };
}

function seedPlans(db) {
  const now = nowMs();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO subscription_plans
     (id, name, cycle, price, currency, days, features_json, active, popular, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', 1, ?, ?, ?, ?)`
  );
  for (const plan of DEFAULT_PLANS) {
    insert.run(plan.id, plan.name, plan.cycle, plan.price, plan.currency, plan.days, plan.popular, plan.position, now, now);
  }
}

function addEvent(conn, subscription, type, meta = {}, actorId = null) {
  conn
    .prepare(
      `INSERT INTO subscription_events (id, subscription_id, user_id, type, meta_json, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(crypto.randomUUID(), subscription.id, subscription.user_id, type, JSON.stringify(meta), actorId || null, nowMs());
}

function expireDue(conn) {
  const now = nowMs();
  const due = conn
    .prepare("SELECT * FROM subscriptions WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?")
    .all(now);
  for (const row of due) {
    conn.prepare("UPDATE subscriptions SET status = 'expired', renewal_status = 'expired', updated_at = ? WHERE id = ?").run(now, row.id);
    addEvent(conn, row, "expired", { expiresAt: row.expires_at });
  }
  return due.length;
}

export async function sqlPlans() {
  const db = await getDatabase();
  if (!db) {
    return DEFAULT_PLANS.map((plan) => ({
      ...plan,
      slug: plan.id,
      features: [],
      description: "",
      trialDays: 0,
      quota: {},
      active: true,
      archived: false,
      popular: Boolean(plan.popular)
    }));
  }
  seedPlans(db);
  return db
    .prepare("SELECT * FROM subscription_plans WHERE active = 1 AND archived = 0 ORDER BY position ASC, price ASC")
    .all()
    .map(mapPlan);
}

export async function sqlPlansAdmin() {
  const db = await getDatabase();
  if (!db) return [];
  seedPlans(db);
  const plans = db.prepare("SELECT * FROM subscription_plans ORDER BY archived ASC, position ASC, price ASC").all().map(mapPlan);
  const usage = db.prepare("SELECT plan_id, COUNT(*) AS n FROM subscriptions GROUP BY plan_id").all();
  const counts = new Map(usage.map((row) => [row.plan_id, Number(row.n)]));
  return plans.map((plan) => ({ ...plan, subscribers: counts.get(plan.id) || 0 }));
}

export async function sqlPlanById(id) {
  const db = await getDatabase();
  if (!db) return null;
  return mapPlan(db.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(String(id)));
}

export async function sqlSavePlan(input, { create = false } = {}) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const now = nowMs();
  return transaction((conn) => {
    const existing = conn.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(input.id);
    if (create && existing) return { ok: false, reason: "plan_exists" };
    if (!create && !existing) return { ok: false, reason: "plan_missing" };
    const merged = {
      name: input.name ?? existing?.name ?? input.id,
      description: input.description ?? existing?.description ?? "",
      cycle: input.cycle ?? existing?.cycle ?? "monthly",
      price: input.price ?? existing?.price ?? 0,
      currency: input.currency ?? existing?.currency ?? "IRT",
      days: input.days ?? existing?.days ?? 30,
      trialDays: input.trialDays ?? existing?.trial_days ?? 0,
      features: input.features ?? parseFeatures(existing?.features_json),
      quota: input.quota ?? parseObject(existing?.quota_json),
      active: input.active ?? (existing ? Boolean(existing.active) : true),
      archived: input.archived ?? (existing ? Boolean(existing.archived) : false),
      popular: input.popular ?? (existing ? Boolean(existing.popular) : false),
      position: input.position ?? existing?.position ?? 0
    };
    if (existing) {
      conn
        .prepare(
          `UPDATE subscription_plans SET name = ?, description = ?, cycle = ?, price = ?, currency = ?, days = ?,
             trial_days = ?, features_json = ?, quota_json = ?, active = ?, archived = ?, popular = ?, position = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          merged.name,
          merged.description,
          merged.cycle,
          Math.max(0, Number(merged.price) || 0),
          merged.currency,
          Math.max(1, Number(merged.days) || 1),
          Math.max(0, Number(merged.trialDays) || 0),
          JSON.stringify(merged.features),
          JSON.stringify(merged.quota),
          merged.active ? 1 : 0,
          merged.archived ? 1 : 0,
          merged.popular ? 1 : 0,
          Number(merged.position) || 0,
          now,
          input.id
        );
    } else {
      conn
        .prepare(
          `INSERT INTO subscription_plans
           (id, name, description, cycle, price, currency, days, trial_days, features_json, quota_json, active, archived, popular, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          merged.name,
          merged.description,
          merged.cycle,
          Math.max(0, Number(merged.price) || 0),
          merged.currency,
          Math.max(1, Number(merged.days) || 1),
          Math.max(0, Number(merged.trialDays) || 0),
          JSON.stringify(merged.features),
          JSON.stringify(merged.quota),
          merged.active ? 1 : 0,
          merged.archived ? 1 : 0,
          merged.popular ? 1 : 0,
          Number(merged.position) || 0,
          now,
          now
        );
    }
    return { ok: true, plan: mapPlan(conn.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(input.id)) };
  });
}

export async function sqlDuplicatePlan(sourceId, newId, name) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const source = db.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(sourceId);
  if (!source) return { ok: false, reason: "plan_missing" };
  const now = nowMs();
  return transaction((conn) => {
    if (conn.prepare("SELECT 1 FROM subscription_plans WHERE id = ?").get(newId)) return { ok: false, reason: "plan_exists" };
    conn
      .prepare(
        `INSERT INTO subscription_plans
         (id, name, description, cycle, price, currency, days, trial_days, features_json, quota_json, active, archived, popular, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`
      )
      .run(
        newId,
        name,
        source.description || "",
        source.cycle,
        source.price,
        source.currency,
        source.days,
        source.trial_days || 0,
        source.features_json || "[]",
        source.quota_json || "{}",
        Number(source.position || 0) + 1,
        now,
        now
      );
    return { ok: true, plan: mapPlan(conn.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(newId)) };
  });
}

export async function sqlReorderPlans(ids) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const now = nowMs();
  return transaction((conn) => {
    const update = conn.prepare("UPDATE subscription_plans SET position = ?, updated_at = ? WHERE id = ?");
    ids.forEach((id, index) => update.run(index, now, String(id)));
    return { ok: true, ordered: ids };
  });
}

export async function sqlDeletePlan(id) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const now = nowMs();
  return transaction((conn) => {
    const plan = conn.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(id);
    if (!plan) return { ok: false, reason: "plan_missing" };
    const used = conn.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE plan_id = ?").get(id);
    const ordered = conn.prepare("SELECT COUNT(*) AS n FROM orders WHERE plan_id = ?").get(id);
    if (Number(used?.n || 0) + Number(ordered?.n || 0) > 0) {
      conn.prepare("UPDATE subscription_plans SET archived = 1, active = 0, updated_at = ? WHERE id = ?").run(now, id);
      return { ok: true, mode: "archived", plan: mapPlan(conn.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(id)) };
    }
    conn.prepare("DELETE FROM coupons WHERE plan_id = ?").run(id);
    conn.prepare("DELETE FROM subscription_plans WHERE id = ?").run(id);
    return { ok: true, mode: "deleted", plan: mapPlan(plan) };
  });
}

export async function sqlCoupons() {
  const db = await getDatabase();
  if (!db) return [];
  return db.prepare("SELECT * FROM coupons ORDER BY active DESC, created_at DESC").all().map(mapCoupon);
}

export async function sqlSaveCoupon(input) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const now = nowMs();
  const code = String(input.code || "").trim().toUpperCase();
  return transaction((conn) => {
    const existing = input.id ? conn.prepare("SELECT * FROM coupons WHERE id = ?").get(input.id) : null;
    if (input.id && !existing) return { ok: false, reason: "coupon_missing" };
    const clash = conn.prepare("SELECT id FROM coupons WHERE code = ? COLLATE NOCASE AND id <> ?").get(code, input.id || "");
    if (clash) return { ok: false, reason: "coupon_exists" };
    const id = existing?.id || crypto.randomUUID();
    const values = {
      code,
      kind: input.kind || existing?.kind || "percent",
      value: input.value ?? existing?.value ?? 0,
      planId: input.planId === undefined ? existing?.plan_id || null : input.planId || null,
      maxRedemptions: input.maxRedemptions ?? existing?.max_redemptions ?? 0,
      validFrom: input.validFrom === undefined ? existing?.valid_from ?? null : input.validFrom || null,
      validUntil: input.validUntil === undefined ? existing?.valid_until ?? null : input.validUntil || null,
      active: input.active ?? (existing ? Boolean(existing.active) : true)
    };
    if (existing) {
      conn
        .prepare(
          `UPDATE coupons SET code = ?, kind = ?, value = ?, plan_id = ?, max_redemptions = ?, valid_from = ?, valid_until = ?, active = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(values.code, values.kind, Number(values.value) || 0, values.planId, Number(values.maxRedemptions) || 0, values.validFrom, values.validUntil, values.active ? 1 : 0, now, id);
    } else {
      conn
        .prepare(
          `INSERT INTO coupons (id, code, kind, value, plan_id, max_redemptions, redemptions, valid_from, valid_until, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
        )
        .run(id, values.code, values.kind, Number(values.value) || 0, values.planId, Number(values.maxRedemptions) || 0, values.validFrom, values.validUntil, values.active ? 1 : 0, now, now);
    }
    return { ok: true, coupon: mapCoupon(conn.prepare("SELECT * FROM coupons WHERE id = ?").get(id)) };
  });
}

export async function sqlDeactivateCoupon(id) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const row = db.prepare("SELECT * FROM coupons WHERE id = ?").get(String(id));
  if (!row) return { ok: false, reason: "coupon_missing" };
  db.prepare("UPDATE coupons SET active = 0, updated_at = ? WHERE id = ?").run(nowMs(), row.id);
  return { ok: true, coupon: mapCoupon(db.prepare("SELECT * FROM coupons WHERE id = ?").get(row.id)) };
}

function couponApply(conn, rawCode, plan, userId, now) {
  const code = String(rawCode || "").trim();
  if (!code) return { ok: false, reason: "coupon_missing" };
  const coupon = conn.prepare("SELECT * FROM coupons WHERE code = ? COLLATE NOCASE").get(code);
  if (!coupon) return { ok: false, reason: "coupon_unknown" };
  if (!coupon.active) return { ok: false, reason: "coupon_inactive" };
  if (coupon.valid_from && Number(coupon.valid_from) > now) return { ok: false, reason: "coupon_not_started" };
  if (coupon.valid_until && Number(coupon.valid_until) < now) return { ok: false, reason: "coupon_expired" };
  if (coupon.plan_id && coupon.plan_id !== plan.id) return { ok: false, reason: "coupon_plan_mismatch" };
  if (Number(coupon.max_redemptions || 0) > 0 && Number(coupon.redemptions || 0) >= Number(coupon.max_redemptions)) {
    return { ok: false, reason: "coupon_exhausted" };
  }
  const used = conn.prepare("SELECT 1 FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?").get(coupon.id, String(userId));
  if (used) return { ok: false, reason: "coupon_already_used" };
  const price = Number(plan.price || 0);
  const value = Number(coupon.value || 0);
  const discount = coupon.kind === "percent" ? Math.floor((price * Math.min(100, value)) / 100) : Math.min(price, value);
  return { ok: true, coupon, discount: Math.max(0, discount) };
}

export async function sqlValidateCoupon({ code, planId, userId }) {
  const db = await getDatabase();
  if (!db) return { ok: false, reason: "store_unavailable" };
  const plan = db.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(String(planId));
  if (!plan) return { ok: false, reason: "plan_missing" };
  const result = couponApply(db, code, plan, userId, nowMs());
  if (!result.ok) return result;
  return { ok: true, code: result.coupon.code, discount: result.discount, amount: Math.max(0, Number(plan.price) - result.discount) };
}

export async function sqlCreateOrder({ userId, plan, couponCode = "" }) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const now = nowMs();
  return transaction((conn) => {
    const existing = conn
      .prepare("SELECT * FROM orders WHERE user_id = ? AND plan_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get(String(userId), plan.id);
    if (existing) return { ok: true, duplicate: true, order: mapOrder(existing), discount: Number(existing.discount || 0) };

    let discount = 0;
    let coupon = null;
    if (couponCode) {
      const applied = couponApply(conn, couponCode, plan, userId, now);
      if (!applied.ok) return applied;
      discount = applied.discount;
      coupon = applied.coupon;
    }
    const amount = Math.max(0, Number(plan.price || 0) - discount);
    const orderId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    conn
      .prepare(
        `INSERT INTO orders
         (id, user_id, plan_id, cycle, amount, discount, coupon_code, currency, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(orderId, String(userId), plan.id, plan.cycle, amount, discount, coupon ? coupon.code : "", plan.currency, now, now);
    conn
      .prepare(
        `INSERT INTO subscriptions
         (id, user_id, plan_id, cycle, status, order_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(subscriptionId, String(userId), plan.id, plan.cycle, orderId, now, now);
    if (coupon) {
      conn
        .prepare("INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), coupon.id, String(userId), orderId, discount, now);
      conn.prepare("UPDATE coupons SET redemptions = redemptions + 1, updated_at = ? WHERE id = ?").run(now, coupon.id);
    }
    return {
      ok: true,
      duplicate: false,
      discount,
      coupon: coupon ? { code: coupon.code, kind: coupon.kind, value: Number(coupon.value) } : null,
      order: mapOrder(conn.prepare("SELECT * FROM orders WHERE id = ?").get(orderId))
    };
  });
}

export async function sqlStartTrial({ userId, plan }) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const trialDays = Number(plan.trialDays || plan.trial_days || 0);
  if (trialDays < 1) return { ok: false, reason: "no_trial" };
  const now = nowMs();
  return transaction((conn) => {
    const used = conn
      .prepare("SELECT 1 FROM orders WHERE user_id = ? AND plan_id = ? AND trial = 1")
      .get(String(userId), plan.id);
    if (used) return { ok: false, reason: "trial_used" };
    const active = conn
      .prepare("SELECT 1 FROM subscriptions WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)")
      .get(String(userId), now);
    if (active) return { ok: false, reason: "already_subscribed" };
    const orderId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const expiresAt = now + trialDays * DAY_MS;
    conn
      .prepare(
        `INSERT INTO orders (id, user_id, plan_id, cycle, amount, currency, status, trial, paid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, 'paid', 1, ?, ?, ?)`
      )
      .run(orderId, String(userId), plan.id, plan.cycle, plan.currency, now, now, now);
    conn
      .prepare(
        `INSERT INTO subscriptions
         (id, user_id, plan_id, cycle, status, order_id, started_at, expires_at, trial_ends_at, renewal_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, 'trial', ?, ?)`
      )
      .run(subscriptionId, String(userId), plan.id, plan.cycle, orderId, now, expiresAt, expiresAt, now, now);
    const sub = conn.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subscriptionId);
    addEvent(conn, sub, "trial_started", { days: trialDays, expiresAt });
    return {
      ok: true,
      order: mapOrder(conn.prepare("SELECT * FROM orders WHERE id = ?").get(orderId)),
      subscription: mapSubscription(sub),
      trialDays
    };
  });
}

export async function sqlSubscriptionState(userId) {
  const db = await getDatabase();
  if (!db) return { state: "none", subscription: null };
  expireDue(db);
  const now = nowMs();
  const active = db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(String(userId), now);
  if (active) {
    const plan = mapPlan(db.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(active.plan_id));
    const subscription = mapSubscription(active);
    const daysLeft = active.expires_at ? Math.max(0, Math.ceil((Number(active.expires_at) - now) / DAY_MS)) : null;
    return { state: subscription.renewalStatus === "trial" ? "trial" : "active", plan, subscription, daysLeft, renewalStatus: subscription.renewalStatus };
  }

  const pending = db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'pending' ORDER BY updated_at DESC LIMIT 1")
    .get(String(userId));
  if (pending) {
    const plan = mapPlan(db.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(pending.plan_id));
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(pending.order_id);
    return { state: "pending", plan, subscription: mapSubscription(pending), order: mapOrder(order) };
  }

  const expired = db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'expired' ORDER BY updated_at DESC LIMIT 1")
    .get(String(userId));
  if (expired) {
    return { state: "expired", plan: mapPlan(db.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(expired.plan_id)), subscription: mapSubscription(expired) };
  }
  return { state: "none", subscription: null, plan: null };
}

export async function sqlPaymentForOrder(orderId) {
  const db = await getDatabase();
  if (!db) return null;
  return mapPayment(db.prepare("SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1").get(String(orderId)));
}

export async function sqlEnsurePayment({ order, provider, amount }) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const existing = db.prepare("SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1").get(order.id);
  if (existing) return mapPayment(existing);
  const now = nowMs();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO payments (id, user_id, order_id, provider, amount, currency, status, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(id, String(order.userId || order.user_id || order.user), order.id, provider, Number(amount ?? order.amount), order.currency, `order:${order.id}`, now, now);
  return mapPayment(db.prepare("SELECT * FROM payments WHERE id = ?").get(id));
}

function activate(conn, { orderId, actorId = null, provider = "", providerRef = "", eventId = "", source = "manual" }) {
  const order = conn.prepare("SELECT * FROM orders WHERE id = ?").get(String(orderId));
  if (!order) return { ok: false, reason: "order_missing" };
  if (order.status === "paid") {
    const sub = conn.prepare("SELECT * FROM subscriptions WHERE order_id = ?").get(order.id);
    return { ok: true, duplicate: true, order: mapOrder(order), subscription: mapSubscription(sub) };
  }
  if (order.status !== "pending") return { ok: false, reason: "order_closed" };
  const plan = conn.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(order.plan_id);
  if (!plan) return { ok: false, reason: "plan_missing" };
  const now = nowMs();
  let payment = conn.prepare("SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1").get(order.id);
  if (!payment) {
    const paymentId = crypto.randomUUID();
    conn
      .prepare(
        `INSERT INTO payments (id, user_id, order_id, provider, provider_ref, amount, currency, status, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(paymentId, order.user_id, order.id, provider || "manual", providerRef || "", Number(order.amount), order.currency, `order:${order.id}`, now, now);
    payment = conn.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
  }
  conn
    .prepare(
      `UPDATE payments SET status = 'paid', provider = ?, provider_ref = ?, paid_at = ?, verified_at = ?, payload_json = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(provider || payment.provider || "manual", providerRef || payment.provider_ref || "", now, now, JSON.stringify({ source, eventId }), now, payment.id);
  conn
    .prepare("UPDATE orders SET status = 'paid', provider = ?, provider_ref = ?, paid_at = ?, updated_at = ? WHERE id = ?")
    .run(provider || payment.provider || "manual", providerRef || payment.provider_ref || "", now, now, order.id);

  let sub = conn.prepare("SELECT * FROM subscriptions WHERE order_id = ?").get(order.id);
  if (!sub) {
    const subscriptionId = crypto.randomUUID();
    conn
      .prepare(
        `INSERT INTO subscriptions (id, user_id, plan_id, cycle, status, order_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(subscriptionId, order.user_id, order.plan_id, order.cycle, order.id, now, now);
    sub = conn.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subscriptionId);
  }
  const isLifetime = plan.cycle === "lifetime";
  const base = Number(sub.expires_at) > now ? Number(sub.expires_at) : now;
  const expiresAt = isLifetime ? null : base + Math.max(1, Number(plan.days || 30)) * DAY_MS;
  conn
    .prepare(
      `UPDATE subscriptions SET status = 'active', started_at = COALESCE(started_at, ?), expires_at = ?, trial_ends_at = NULL,
         renewal_status = 'active', cancel_at_period_end = 0, updated_at = ? WHERE id = ?`
    )
    .run(now, expiresAt, now, sub.id);
  conn.prepare("UPDATE payments SET subscription_id = ? WHERE id = ?").run(sub.id, payment.id);

  conn.prepare("DELETE FROM entitlements WHERE subscription_id = ?").run(sub.id);
  const features = parseFeatures(plan.features_json);
  const insEnt = conn.prepare(
    `INSERT INTO entitlements (id, user_id, plan_id, subscription_id, feature_key, value_json, source, starts_at, ends_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'plan', ?, ?, ?)`
  );
  for (const raw of features) {
    const key = typeof raw === "string" ? raw : raw?.key;
    if (!key) continue;
    const value = typeof raw === "string" ? true : raw.value ?? true;
    insEnt.run(crypto.randomUUID(), order.user_id, plan.id, sub.id, String(key), JSON.stringify(value), now, expiresAt, now);
  }
  conn
    .prepare("INSERT INTO transactions (id, payment_id, user_id, kind, amount, currency, note, created_at) VALUES (?, ?, ?, 'charge', ?, ?, ?, ?)")
    .run(crypto.randomUUID(), payment.id, order.user_id, Number(order.amount), order.currency, `order ${order.id}`, now);

  const freshSub = conn.prepare("SELECT * FROM subscriptions WHERE id = ?").get(sub.id);
  addEvent(conn, freshSub, "activated", { plan: plan.id, amount: Number(order.amount), source }, actorId);
  return {
    ok: true,
    duplicate: false,
    order: mapOrder(conn.prepare("SELECT * FROM orders WHERE id = ?").get(order.id)),
    subscription: mapSubscription(freshSub),
    plan: mapPlan(plan),
    payment: mapPayment(conn.prepare("SELECT * FROM payments WHERE id = ?").get(payment.id))
  };
}

export async function sqlActivateOrder(params) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  return transaction((conn) => activate(conn, params));
}

export async function sqlMarkPaymentFailed({ orderId, reason = "", provider = "", payload = {} }) {
  const db = await getDatabase();
  if (!db) return { ok: false, reason: "store_unavailable" };
  const now = nowMs();
  const payment = db.prepare("SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1").get(String(orderId));
  if (!payment) return { ok: false, reason: "payment_missing" };
  if (payment.status === "paid") return { ok: false, reason: "already_paid" };
  db.prepare("UPDATE payments SET status = 'failed', provider = COALESCE(NULLIF(?, ''), provider), payload_json = ?, updated_at = ? WHERE id = ?")
    .run(provider, JSON.stringify({ reason, ...payload }), now, payment.id);
  return { ok: true, payment: mapPayment(db.prepare("SELECT * FROM payments WHERE id = ?").get(payment.id)) };
}

export async function sqlCancelOrder(orderId, { actorId = null, note = "" } = {}) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const now = nowMs();
  return transaction((conn) => {
    const order = conn.prepare("SELECT * FROM orders WHERE id = ?").get(String(orderId));
    if (!order) return { ok: false, reason: "order_missing" };
    if (order.status !== "pending") return { ok: false, reason: "order_closed" };
    conn.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, order.id);
    const sub = conn.prepare("SELECT * FROM subscriptions WHERE order_id = ?").get(order.id);
    if (sub && sub.status === "pending") {
      conn.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, renewal_status = 'cancelled', updated_at = ? WHERE id = ?").run(now, now, sub.id);
      addEvent(conn, sub, "cancelled", { note, order: order.id }, actorId);
    }
    const redemption = conn.prepare("SELECT * FROM coupon_redemptions WHERE order_id = ?").get(order.id);
    if (redemption) {
      conn.prepare("DELETE FROM coupon_redemptions WHERE id = ?").run(redemption.id);
      conn.prepare("UPDATE coupons SET redemptions = MAX(0, redemptions - 1), updated_at = ? WHERE id = ?").run(now, redemption.coupon_id);
    }
    return { ok: true, order: mapOrder(conn.prepare("SELECT * FROM orders WHERE id = ?").get(order.id)) };
  });
}

export async function sqlVerifyPaymentManually(paymentId, { actorId = null, providerRef = "" } = {}) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(String(paymentId));
  if (!payment) return { ok: false, reason: "payment_missing" };
  if (payment.status === "paid") {
    const sub = db.prepare("SELECT * FROM subscriptions WHERE order_id = ?").get(payment.order_id);
    return { ok: true, duplicate: true, order: mapOrder(db.prepare("SELECT * FROM orders WHERE id = ?").get(payment.order_id)), subscription: mapSubscription(sub) };
  }
  if (payment.status === "refunded") return { ok: false, reason: "payment_refunded" };
  if (!payment.order_id) return { ok: false, reason: "order_missing" };
  return sqlActivateOrder({
    orderId: payment.order_id,
    actorId,
    provider: payment.provider || "manual",
    providerRef: providerRef || payment.provider_ref,
    source: "admin_verify"
  });
}

export async function sqlRefundPayment(paymentId, { actorId = null, reason = "" } = {}) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const now = nowMs();
  return transaction((conn) => {
    const payment = conn.prepare("SELECT * FROM payments WHERE id = ?").get(String(paymentId));
    if (!payment) return { ok: false, reason: "payment_missing" };
    if (payment.status !== "paid") return { ok: false, reason: "payment_not_paid" };
    conn
      .prepare("UPDATE payments SET status = 'refunded', refunded_at = ?, refund_reason = ?, updated_at = ? WHERE id = ?")
      .run(now, String(reason || "").slice(0, 300), now, payment.id);
    if (payment.order_id) {
      conn.prepare("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?").run(now, payment.order_id);
      const sub = conn.prepare("SELECT * FROM subscriptions WHERE order_id = ?").get(payment.order_id);
      if (sub) {
        conn.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, renewal_status = 'refunded', updated_at = ? WHERE id = ?").run(now, now, sub.id);
        conn.prepare("DELETE FROM entitlements WHERE subscription_id = ?").run(sub.id);
        addEvent(conn, sub, "refunded", { amount: Number(payment.amount), reason }, actorId);
      }
    }
    conn
      .prepare("INSERT INTO transactions (id, payment_id, user_id, kind, amount, currency, note, created_at) VALUES (?, ?, ?, 'refund', ?, ?, ?, ?)")
      .run(crypto.randomUUID(), payment.id, payment.user_id, -Number(payment.amount), payment.currency, String(reason || "refund").slice(0, 200), now);
    return { ok: true, payment: mapPayment(conn.prepare("SELECT * FROM payments WHERE id = ?").get(payment.id)) };
  });
}

export async function sqlAdminPayments({ status = "", q = "", limit = 25, before = 0 } = {}) {
  const db = await getDatabase();
  if (!db) return { payments: [], nextBefore: 0 };
  const where = ["p.created_at < ?"];
  const params = [before || nowMs() + 1];
  if (status) {
    where.push("p.status = ?");
    params.push(status);
  }
  if (q) {
    where.push("(u.username LIKE ? OR p.id LIKE ? OR p.provider_ref LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = db
    .prepare(
      `SELECT p.*, u.username, o.plan_id FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN orders o ON o.id = p.order_id
       WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC LIMIT ?`
    )
    .all(...params, limit);
  return {
    payments: rows.map((row) => ({ ...mapPayment(row), username: row.username || "", planId: row.plan_id || "" })),
    nextBefore: rows.length ? Number(rows[rows.length - 1].created_at) : 0
  };
}

export async function sqlAdminSubscriptions({ status = "", q = "", limit = 25, before = 0 } = {}) {
  const db = await getDatabase();
  if (!db) return { subscriptions: [], nextBefore: 0 };
  expireDue(db);
  const where = ["s.created_at < ?"];
  const params = [before || nowMs() + 1];
  if (status) {
    where.push("s.status = ?");
    params.push(status);
  }
  if (q) {
    where.push("(u.username LIKE ? OR s.plan_id LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  const rows = db
    .prepare(
      `SELECT s.*, u.username FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id
       WHERE ${where.join(" AND ")} ORDER BY s.created_at DESC LIMIT ?`
    )
    .all(...params, limit);
  return {
    subscriptions: rows.map((row) => ({ ...mapSubscription(row), username: row.username || "" })),
    nextBefore: rows.length ? Number(rows[rows.length - 1].created_at) : 0
  };
}

export async function sqlAdminOrders({ status = "", limit = 25, before = 0 } = {}) {
  const db = await getDatabase();
  if (!db) return { orders: [], nextBefore: 0 };
  const where = ["o.created_at < ?"];
  const params = [before || nowMs() + 1];
  if (status) {
    where.push("o.status = ?");
    params.push(status);
  }
  const rows = db
    .prepare(
      `SELECT o.*, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id
       WHERE ${where.join(" AND ")} ORDER BY o.created_at DESC LIMIT ?`
    )
    .all(...params, limit);
  return {
    orders: rows.map((row) => ({ ...mapOrder(row), username: row.username || "" })),
    nextBefore: rows.length ? Number(rows[rows.length - 1].created_at) : 0
  };
}

export async function sqlAdjustSubscription(id, { action, days = 0, planId = "", actorId = null, note = "" } = {}) {
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const now = nowMs();
  return transaction((conn) => {
    const sub = conn.prepare("SELECT * FROM subscriptions WHERE id = ?").get(String(id));
    if (!sub) return { ok: false, reason: "subscription_missing" };
    if (action === "cancel") {
      conn.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, cancel_at_period_end = 0, renewal_status = 'cancelled', updated_at = ? WHERE id = ?").run(now, now, sub.id);
      addEvent(conn, sub, "cancelled", { note }, actorId);
    } else if (action === "cancel_at_period_end") {
      conn.prepare("UPDATE subscriptions SET cancel_at_period_end = 1, renewal_status = 'cancel_at_period_end', updated_at = ? WHERE id = ?").run(now, sub.id);
      addEvent(conn, sub, "cancel_scheduled", { expiresAt: sub.expires_at }, actorId);
    } else if (action === "resume") {
      conn.prepare("UPDATE subscriptions SET cancel_at_period_end = 0, renewal_status = 'active', updated_at = ? WHERE id = ?").run(now, sub.id);
      addEvent(conn, sub, "resumed", {}, actorId);
    } else if (action === "extend") {
      const addDays = Math.max(1, Math.min(3650, Number(days) || 0));
      const base = Number(sub.expires_at) > now ? Number(sub.expires_at) : now;
      const expiresAt = base + addDays * DAY_MS;
      conn.prepare("UPDATE subscriptions SET status = 'active', expires_at = ?, renewal_status = 'active', updated_at = ? WHERE id = ?").run(expiresAt, now, sub.id);
      addEvent(conn, sub, "extended", { days: addDays, expiresAt }, actorId);
    } else if (action === "expire") {
      conn.prepare("UPDATE subscriptions SET status = 'expired', renewal_status = 'expired', updated_at = ? WHERE id = ?").run(now, sub.id);
      addEvent(conn, sub, "expired", { manual: true }, actorId);
    } else if (action === "change_plan") {
      const plan = conn.prepare("SELECT * FROM subscription_plans WHERE id = ?").get(String(planId));
      if (!plan) return { ok: false, reason: "plan_missing" };
      if (plan.id === sub.plan_id) return { ok: false, reason: "same_plan" };
      conn.prepare("UPDATE subscriptions SET plan_id = ?, cycle = ?, updated_at = ? WHERE id = ?").run(plan.id, plan.cycle, now, sub.id);
      addEvent(conn, sub, "plan_changed", { from: sub.plan_id, to: plan.id }, actorId);
    } else {
      return { ok: false, reason: "invalid_action" };
    }
    return {
      ok: true,
      subscription: mapSubscription(conn.prepare("SELECT * FROM subscriptions WHERE id = ?").get(sub.id)),
      events: conn.prepare("SELECT * FROM subscription_events WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 50").all(sub.id).map(mapEvent)
    };
  });
}

export async function sqlSubscriptionEvents(subscriptionId) {
  const db = await getDatabase();
  if (!db) return [];
  return db
    .prepare("SELECT * FROM subscription_events WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 100")
    .all(String(subscriptionId))
    .map(mapEvent);
}

export async function sqlUserBilling(userId) {
  const db = await getDatabase();
  if (!db) return { orders: [], subscriptions: [], payments: [], events: [] };
  expireDue(db);
  const orders = db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 30").all(String(userId)).map(mapOrder);
  const subscriptions = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30").all(String(userId)).map(mapSubscription);
  const payments = db.prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 30").all(String(userId)).map(mapPayment);
  const events = db
    .prepare("SELECT * FROM subscription_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(String(userId))
    .map(mapEvent);
  return { orders, subscriptions, payments, events };
}

export async function sqlPlanQuota(userId, key) {
  const db = await getDatabase();
  if (!db || !key) return null;
  const row = db
    .prepare(
      `SELECT sp.quota_json FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id
       WHERE s.user_id = ? AND s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > ?)
       ORDER BY s.updated_at DESC LIMIT 1`
    )
    .get(String(userId), nowMs());
  if (!row) return null;
  const quota = parseObject(row.quota_json);
  const value = Number(quota[key]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export async function sqlRevenueSummary() {
  const db = await getDatabase();
  if (!db) return { paidAmount: 0, paidOrders: 0, refundedAmount: 0, pendingOrders: 0, activeSubscriptions: 0 };
  const paid = db.prepare("SELECT COALESCE(SUM(amount),0) AS n, COUNT(*) AS c FROM payments WHERE status = 'paid'").get();
  const refunded = db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE status = 'refunded'").get();
  const pending = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").get();
  const active = db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)").get(nowMs());
  return {
    paidAmount: Number(paid?.n || 0),
    paidOrders: Number(paid?.c || 0),
    refundedAmount: Number(refunded?.n || 0),
    pendingOrders: Number(pending?.n || 0),
    activeSubscriptions: Number(active?.n || 0)
  };
}
