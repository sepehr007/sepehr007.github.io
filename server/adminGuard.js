import { requireAuth } from "./routes/auth.js";
import { createRateLimiter } from "./redis.js";
import { databaseReady, get } from "./database/index.js";

export const adminLimit = createRateLimiter({
  max: Math.max(10, Number(process.env.ADMIN_RATE_LIMIT) || 90),
  windowMs: 60_000,
  prefix: "wt:rl:admin:"
});

export async function ownerOnly(req, reply) {
  await requireAuth(req, reply);
  if (reply.sent) return false;
  if (!["owner", "super_owner"].includes(req.auth.role)) {
    reply.code(403).send({ error: "forbidden", message: "Only the site owner can use this panel." });
    return false;
  }
  return true;
}

export function permissionGranted(role, userId, permission) {
  if (["owner", "super_owner"].includes(role)) return true;
  if (!databaseReady()) return false;
  try {
    const byRole = get("SELECT 1 AS ok FROM role_permissions WHERE role_id = ? AND permission_id = ?", role, permission);
    if (byRole) return true;
    const byUser = get(
      `SELECT 1 AS ok FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = ? AND rp.permission_id = ? LIMIT 1`,
      String(userId || ""),
      permission
    );
    return Boolean(byUser);
  } catch {
    return false;
  }
}

export async function permissionOnly(req, reply, permission) {
  await requireAuth(req, reply);
  if (reply.sent) return false;
  if (!permission) {
    reply.code(500).send({ error: "permission_required", message: "Missing permission key." });
    return false;
  }
  if (["owner", "super_owner"].includes(req.auth.role)) return true;
  if (permissionGranted(req.auth.role, req.auth.userId, permission)) return true;
  reply.code(403).send({ error: "forbidden", message: `The ${permission} permission is required for this action.` });
  return false;
}
