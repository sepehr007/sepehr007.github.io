import { requireAuth } from "./routes/auth.js";
import { createRateLimiter } from "./redis.js";

export const adminLimit = createRateLimiter({ max: 90, windowMs: 60_000, prefix: "wt:rl:admin:" });

export async function ownerOnly(req, reply) {
  await requireAuth(req, reply);
  if (reply.sent) return false;
  if (!["owner", "super_owner"].includes(req.auth.role)) {
    reply.code(403).send({ error: "forbidden", message: "Only the site owner can use this panel." });
    return false;
  }
  return true;
}
