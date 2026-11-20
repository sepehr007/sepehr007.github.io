import crypto from "node:crypto";
import { dbReady } from "../db.js";
import { ensureStore } from "../userStore.js";
import { run } from "../database/index.js";
import { createRateLimiter } from "../redis.js";
import { readAuth } from "./auth.js";

const EVENT_RE = /^[a-z0-9][a-z0-9._-]{1,40}$/;
const ingestLimit = createRateLimiter({ max: 60, windowMs: 60_000, prefix: "wt:rl:analytics:" });

function cleanPath(value) {
  const path = String(value || "").slice(0, 190);
  return path.startsWith("/") ? path : "/";
}

export default async function analyticsRoutes(app) {
  app.post("/events", { preHandler: [ingestLimit] }, async (req, reply) => {
    if (dbReady()) return reply.code(503).send({ error: "sqlite_only", message: "Analytics needs the SQLite deployment." });
    if (!(await ensureStore())) return reply.code(503).send({ error: "database_unavailable", message: "Database is not connected yet." });
    const input = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const event = String(input.event || "").trim().toLowerCase();
    if (!EVENT_RE.test(event)) return reply.code(400).send({ error: "invalid_event", message: "Event name is invalid." });
    const auth = readAuth(req);
    const props = input.props && typeof input.props === "object" && !Array.isArray(input.props) ? input.props : {};
    const ipHash = crypto
      .createHash("sha256")
      .update(`${req.ip || ""}wt-analytics`)
      .digest("hex")
      .slice(0, 32);
    try {
      run(
        "INSERT INTO analytics_events (id, user_id, session_id, event, path, props_json, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        auth?.sub ? String(auth.sub) : null,
        String(input.sessionId || "").slice(0, 60),
        event,
        cleanPath(input.path),
        JSON.stringify(props).slice(0, 4000),
        ipHash,
        Date.now()
      );
    } catch {
      return reply.code(500).send({ error: "ingest_failed", message: "Event could not be stored." });
    }
    return { ok: true };
  });
}
