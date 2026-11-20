import { getDatabase } from "./database/index.js";
import { settingBool } from "./platformSettings.js";

const EXEMPT_ROLES = new Set(["owner", "super_owner"]);

export async function activeSubscription(userId) {
  const db = await getDatabase();
  if (!db || !userId) return null;
  const row = db
    .prepare(
      `SELECT plan_id, expires_at, status FROM subscriptions
       WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(String(userId), Date.now());
  if (!row) return null;
  return {
    planId: row.plan_id,
    expiresAt: row.expires_at ? Number(row.expires_at) : null
  };
}

export async function roomEntitlement(userId, role = "") {
  const staff = EXEMPT_ROLES.has(String(role || ""));
  const premiumRequired = await settingBool("plans.roomsRequirePremium", false);
  const subscription = premiumRequired && !staff ? await activeSubscription(userId) : null;
  return {
    premiumRequired,
    premium: !premiumRequired || staff || Boolean(subscription),
    exempt: staff,
    planId: subscription?.planId || null,
    expiresAt: subscription?.expiresAt || null
  };
}
